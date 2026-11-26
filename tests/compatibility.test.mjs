import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { PACKAGE_NAME, REPOSITORY, validateSettings } from '../src/config.mjs';
import { hostCapabilities, retriesSteps, hostInstructions, isInstructionLoad, isInstructionUpdate, promptOf, turnState, withoutHostMessages, withoutPlaceInstructions, withPart, withoutTools, requestSlots, claudeInstructions, claudeOption, HOST_FACT_SOURCES, CLAUDE_INSTRUCTIONS_OPTION, CLAUDE_PROVIDER, isHostContinuation, isSessionNotFound, isUntitledSession, listOf, packageNamed, pluginEntries, pluginSourceLabel, recordOf, sessionProgress, tokenUsage, usageTotals, withoutCredentials, HOST_CONTINUATION_TEXT, PROGRESS_EVENT_TYPES, TESTED_HOST_VERSION } from '../src/host.mjs';

test('request parser preserves Unicode, multiline text, quotes and literal metacharacters', () => {
  const url = 'https://dev.azure.com/org/project/_git/repo/pullrequest/12';
  const context = '重點檢查 API "compatibility"\n@../doc !`literal` ${value} \'single quotes\'\n';
  const parsed = parseReviewRequest(`${url} ${context}`);
  assert.equal(parsed.request, `${url} ${context}`);
  assert.equal(parsed.prUrl, url);
  assert.equal(parsed.userContext, context);
  assert.deepEqual({ ...parsed.target, url: undefined }, { organization: 'org', project: 'project', repository: 'repo', pullRequestId: 12, url: undefined });
  assert.equal(parseReviewRequest(url).userContext, '');
  for (const raw of ['', 'not-a-url instructions', url.replace('https:', 'http:'), url.replace('https://', 'https://user:password@'), url + '\0', url + ' ' + 'x'.repeat(16000)]) {
    assert.throws(() => parseReviewRequest(raw));
  }
});

test('one flag right after the PR URL sets afterReview for that run; anything else there that looks like an option is refused', () => {
  const url = 'https://dev.azure.com/org/project/_git/repo/pullrequest/12';
  for (const [flag, mode] of [['--preview', 'preview'], ['--publish', 'publish'], ['--no-comment', 'none']]) {
    const parsed = parseReviewRequest(`${url} ${flag} 重點檢查 --publish 的行為\n第二行`);
    assert.equal(parsed.flag, flag);
    assert.equal(parsed.afterReview, mode);
    assert.equal(parsed.userContext, '重點檢查 --publish 的行為\n第二行', 'Context starts after the flag and keeps later dashes literal.');
    assert.equal(parseReviewRequest(`${url}\n${flag}`).userContext, '');
  }
  const plain = parseReviewRequest(`${url} please check --publish handling`);
  assert.equal(plain.afterReview, undefined, 'Without a flag the setting applies.');
  assert.equal(plain.flag, undefined);
  assert.equal(plain.userContext, 'please check --publish handling');
  assert.equal(parseReviewRequest(`${url} - focus on retries`).userContext, '- focus on retries', 'A lone dash starts a list item, not an option.');
  for (const raw of [`${url} --no-coment`, `${url} --pubish focus`, `${url} -p`, `${url} \u2014publish`, `${url} \u2013preview`, `${url} --Preview`]) {
    assert.throws(() => parseReviewRequest(raw), /Unknown option after the PR URL\. Use --preview, --publish or --no-comment/, raw);
  }
  for (const raw of [`${url} --preview --publish`, `${url} --publish --no-comment`, `${url} --preview --typo context`]) {
    assert.throws(() => parseReviewRequest(raw), /at most one of --preview, --publish or --no-comment/, raw);
  }
  assert.throws(() => parseReviewRequest(`--publish ${url}`), /Put the PR URL first, then at most one of/);
  // A command that makes no comments takes no option.
  assert.throws(() => parseReviewRequest(`${url} --preview`, { flags: false }), /makes no comments and takes no option after the PR URL/);
  assert.throws(() => parseReviewRequest(`${url} --typo`, { flags: false }), /takes no option/);
  assert.equal(parseReviewRequest(`${url} check --preview later`, { flags: false }).userContext, 'check --preview later');
});

test('URL identity separates organization, project and repository and rejects unsupported layouts', () => {
  const cases = [
    ['https://dev.azure.com/team/Project%20A/_git/Repo%2BOne/pullrequest/12/', { organization: 'team', project: 'Project A', repository: 'Repo+One', pullRequestId: 12 }],
    ['https://team.visualstudio.com/Project%20A/_git/Repo%2520One/pullrequest/12', { organization: 'team', project: 'Project A', repository: 'Repo%20One', pullRequestId: 12 }],
    ['https://team.visualstudio.com/DefaultCollection/P/_git/R/pullrequest/7', { organization: 'team', project: 'P', repository: 'R', pullRequestId: 7 }],
  ];
  for (const [url, expected] of cases) {
    const { target } = parseReviewRequest(url + ' Treat the organization as the project.');
    assert.deepEqual({ organization: target.organization, project: target.project, repository: target.repository, pullRequestId: target.pullRequestId }, expected);
  }
  for (const url of [
    'https://server.example/tfs/collection/project/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/%ZZ/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/project/_git/repo%0Aname/pullrequest/12',
    'https://dev.azure.com:8443/org/project/_git/repo/pullrequest/12',
  ]) assert.throws(() => parseReviewRequest(url), /\[AZPR\]/, url);
});

test('removed settings cannot configure a V1 transport; the retired mcp section names its replacement', async () => {
  const s = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
  s.models = { review: { reviewers: ['fixture/a', 'fixture/b'] } };
  s.azure = { organization: 'org', pat: 'fixture-pat-0123456789abcdef' };
  for (const key of ['structuredOutput', 'steps', 'maxStageCharacters']) {
    assert.throws(() => validateSettings({ ...s, [key]: false }), /Unknown setting/);
  }
  assert.throws(() => validateSettings({ ...s, mcp: { server: 'ado' } }), /settings\.mcp is no longer used/);
});

test('Azure DevOps REST paths and the api-version live only in azure.mjs; no MCP tool names remain', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(name => /\.m?js$/.test(name));
  for (const file of files) {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"`]repo_(?:pull_request|file)\w*['"`]/, file);
    if (file !== 'azure.mjs') assert.doesNotMatch(source, /_apis\/|api-version=/, file);
  }
});

test('a rejected session call that names a missing session is told from other failures', () => {
  // The shape OpenCode 2.2.4 and 2.3.0 reject with: an Error whose _tag and name are the tag, with the session ID.
  assert.equal(isSessionNotFound(Object.assign(new Error(''), { _tag: 'Session.NotFoundError', name: 'Session.NotFoundError', sessionID: 'ses_gone' })), true);
  assert.equal(isSessionNotFound({ _tag: 'Session.NotFoundError' }), true);
  assert.equal(isSessionNotFound(Object.assign(new Error('x'), { name: 'Session.NotFoundError' })), true);
  for (const other of [new Error('Timed out.'), { _tag: 'Session.MessageNotFoundError' }, { _tag: 'Session.AgentNotFoundError' }, { name: 'NotFoundError' }, 'Session.NotFoundError', null, undefined]) {
    assert.equal(isSessionNotFound(other), false, String(other?._tag ?? other?.name ?? other));
  }
});

test('host helpers normalize response shapes and detect capabilities', () => {
  assert.deepEqual(listOf({ data: [1] }), [1]);
  assert.deepEqual(listOf([2]), [2]);
  assert.equal(listOf({}), null);
  assert.deepEqual(recordOf({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(recordOf({ a: 1 }), { a: 1 });
  const capabilities = hostCapabilities({ app: { version: '2.4.1' }, permission: { hook() {} }, tool: { transform() {} } });
  assert.equal(capabilities.tested, true);
  assert.equal(TESTED_HOST_VERSION, '2.4.1');
  for (const version of ['2.0.32', '2.1.4', '2.2.4', '2.2.7', '2.3.0', '2.3.1', '2.3.2', '2.4.0', '2.4.2']) assert.equal(hostCapabilities({ app: { version } }).tested, false, version);
  assert.equal(capabilities.permissionHook, true);
  assert.equal(capabilities.toolTransform, true);
  assert.equal(capabilities.eventSubscribe, false);
  assert.equal(hostCapabilities({ event: { subscribe() {} } }).eventSubscribe, true);
  assert.equal(hostCapabilities({}).version, 'unknown');
  // A host retries the step of a stream that broke from 2.3.0 on, and queues a message that asks the model to
  // continue before that. A host that does not say its version is taken for a current one: that message is
  // known by its text alone, so it is accepted only where the host is known to write it.
  // Only a version that names a release of the earlier protocol says so: a development build and a text that is no
  // version say no more than no version: a number with a leading zero, a suffix that is empty or has an empty
  // part, a version without its last number.
  assert.deepEqual(['2.0.32', '2.2.7', '2.2.7-beta.1', '2.1.4+build.5', '2.2.0-rc.1+sha.5114f85', '2.3.0', '2.3.2', '2.4.1', '2.10.0', '2.20.1', '3.0.0', '1.14.0', '0.0.0-dev', '0.0.0-dev-202611260101',
    '2.2.', '2.2', '2.2.x', 'v2.2.7', ' 2.2.7', '2.2.7 ', '2.2.07', '2.02.7', '2.2.7+', '2.2.7-', '2.2.7+build..5', '2.2.7-beta..1', '2.2.7-01', '2.2.7+a+b', '2.2.7.1', 'unknown', '', undefined, null, 2.2]
    .map(version => [version, retriesSteps(version)]).filter(([, steps]) => !steps).map(([version]) => version), ['2.0.32', '2.2.7', '2.2.7-beta.1', '2.1.4+build.5', '2.2.0-rc.1+sha.5114f85']);
  assert.deepEqual([hostCapabilities({ app: { version: '2.2.7' } }).stepRetries, capabilities.stepRetries, hostCapabilities({}).stepRetries], [false, true, true]);
  assert.equal(hostCapabilities({}).pluginList, false);
  assert.equal(hostCapabilities({ plugin: { list() {} } }).pluginList, true);
  assert.equal(hostCapabilities({}).sessionUpdate, false);
  assert.equal(hostCapabilities({ session: { update() {} } }).sessionUpdate, true);
  // A conversation nobody named: OpenCode 2.3.0 leaves its title out and shows "New session"; earlier releases
  // stored those words with the time. A name a person or the host's model gave is a title.
  for (const session of [{}, { title: undefined }, { title: null }, { title: '' }, { title: 'New session - 2026-11-18T16:05:20.644Z' }, undefined]) assert.equal(isUntitledSession(session), true, JSON.stringify(session));
  for (const title of ['Fix the parser', 'New session', 'New session - custom', 'Child session - 2026-11-18T16:05:20.644Z', 'AZPR: PR #2 (repo)', 'New session - 2026-11-18T16:05:20.644Z again', 7]) {
    assert.equal(isUntitledSession({ title }), false, String(title));
  }
  const errored = { type: 'assistant', error: { type: 'provider.api' }, retry: { attempt: 1 } };
  assert.equal(isHostContinuation({ type: 'synthetic', text: HOST_CONTINUATION_TEXT }), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, errored), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, { type: 'assistant' }), false);
  assert.equal(isHostContinuation({ type: 'user', text: HOST_CONTINUATION_TEXT }), false);
});

test('plugin list entries: the running entry, other entries of the plugin or its packages, and path-free labels', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PACKAGE_NAME, pkg.name);
  assert.equal(pkg.repository.url, `git+https://github.com/${REPOSITORY}.git`);
  const own = target => packageNamed(target, PACKAGE_NAME, REPOSITORY);
  for (const target of ['opencode-azure-devops-pr-review', 'opencode-azure-devops-pr-review@0.3.0', 'opencode-azure-devops-pr-review@^0.3.0',
    'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.3.0', 'git+https://github.com/wtlaib/opencode-azure-devops-pr-review-v2.git#6dcb4d2',
    'WTLAIB/opencode-azure-devops-pr-review-v2', 'git+https://***@github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git?ref=x#main']) assert.equal(own(target), true, target);
  for (const target of ['opencode-azure-devops-pr-review-v2@1.0.0', 'other-plugin@1.0.0', 'github:someone/opencode-azure-devops-pr-review-v2-fork#main', undefined]) {
    assert.equal(own(target), false, String(target));
  }
  const running = { id: 'azpr', source: { type: 'package', target: 'opencode-azure-devops-pr-review@0.3.0', version: '0.3.0' }, state: { status: 'active' }, features: { server: true } };
  const duplicate = { id: 'azpr', source: { type: 'package', target: 'opencode-azure-devops-pr-review@0.3.1', version: '0.3.1' }, state: { status: 'failed', error: 'Duplicate plugin ID: azpr' } };
  const unloaded = { source: { type: 'package', target: 'opencode-azure-devops-pr-review@9.9.9' }, state: { status: 'failed', error: 'Plugin failed to load' } };
  const unrelated = [{ id: 'other', source: { type: 'builtin' }, state: { status: 'active' } }, { source: { type: 'package', target: 'other-plugin@1' }, state: { status: 'failed', error: 'x' } }];
  assert.deepEqual(pluginEntries({ data: [...unrelated, running, duplicate, unloaded, 'not a record'] }, { id: 'azpr', ownPackage: own }), { running, others: [duplicate, unloaded] });
  assert.deepEqual(pluginEntries([duplicate], { id: 'azpr', ownPackage: own }), { running: null, others: [duplicate] });
  assert.equal(pluginEntries({}, { id: 'azpr', ownPackage: own }), null);
  assert.equal(pluginSourceLabel(running.source), 'opencode-azure-devops-pr-review@0.3.0');
  assert.equal(pluginSourceLabel({ type: 'package', target: 'opencode-azure-devops-pr-review', version: '0.3.0' }), 'opencode-azure-devops-pr-review (version 0.3.0)');
  assert.equal(pluginSourceLabel({ type: 'package', target: 'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.3.0', version: '6dcb4d2b2bd4c4f01c0c515062f5b0fcc84eecfd' }),
    'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.3.0 (commit 6dcb4d2)');
  assert.equal(pluginSourceLabel({ type: 'local', path: '/home/someone/.config/opencode/plugins/azpr-v2' }), 'a local source installation');
  assert.equal(pluginSourceLabel({ type: 'package', target: 'git+file:///fixture/package#6dcb4d2b2bd4c4f01c0c515062f5b0fcc84eecfd', version: '6dcb4d2b2bd4c4f01c0c515062f5b0fcc84eecfd' }), 'git+file:///fixture/package#6dcb4d2b2bd4c4f01c0c515062f5b0fcc84eecfd');
  assert.equal(pluginSourceLabel({ type: 'sdk' }), 'an entry of unknown origin');
  // Credentials and query strings in a URL never reach a label or a quoted host message.
  for (const [text, masked] of [
    ['git+https://oauth2:SECRET_TOKEN@github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git#v0.3.0', 'git+https://***@github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git#v0.3.0'],
    ['https://SECRET_TOKEN@example.com/pkg.tgz?token=SECRET_QUERY#part', 'https://***@example.com/pkg.tgz?***#part'],
    ['Plugin entrypoint not found: git+https://SECRET_TOKEN@github.com/a/b.git#main', 'Plugin entrypoint not found: git+https://***@github.com/a/b.git#main'],
    ['ssh://git@github.com/a/b.git and https://example.com/x?y=1 z', 'ssh://***@github.com/a/b.git and https://example.com/x?*** z'],
  ]) assert.equal(withoutCredentials(text), masked);
  for (const text of ['opencode-azure-devops-pr-review@0.3.0', 'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.3.0',
    'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz', 'Duplicate plugin ID: azpr', 'Did you mean this?']) assert.equal(withoutCredentials(text), text);
  assert.equal(pluginSourceLabel({ type: 'package', target: 'git+https://user:SECRET_TOKEN@github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git#v0.3.0', version: '6dcb4d2b2bd4c4f01c0c515062f5b0fcc84eecfd' }),
    'git+https://***@github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git#v0.3.0 (commit 6dcb4d2)');
});

test('token usage reads each assistant message of a session context and totals the cached share', () => {
  const messages = [
    { type: 'user', text: 'payload', tokens: { input: 99 } },
    { type: 'assistant', tokens: { input: 4507, output: 23, reasoning: 0, cache: { read: 0, write: 0 } } },
    { type: 'assistant', tokens: { input: 778, output: 82, reasoning: 5, cache: { read: 4352, write: 0 } } },
    { type: 'assistant', content: [] },
    { type: 'assistant', tokens: { input: -1, output: Number.NaN, cache: { write: 128 } } },
    { type: 'idle', outcome: 'succeeded' },
  ];
  const requests = tokenUsage(messages);
  assert.deepEqual(requests, [
    { input: 4507, cacheRead: 0, cacheWrite: 0, output: 23, reasoning: 0 },
    { input: 778, cacheRead: 4352, cacheWrite: 0, output: 82, reasoning: 5 },
    { input: 0, cacheRead: 0, cacheWrite: 128, output: 0, reasoning: 0 },
  ]);
  assert.deepEqual(usageTotals(requests), { input: 5285, cacheRead: 4352, cacheWrite: 128, output: 105, reasoning: 5, cachedInputShare: 0.4457 });
  assert.equal(usageTotals([]).cachedInputShare, null);
  assert.deepEqual(tokenUsage(undefined), []);
});

test('session progress events: streamed text, reasoning and tool-call input, tool progress and steps; nothing else', () => {
  const data = { sessionID: 'ses_1', assistantMessageID: 'msg_1', delta: 'x' };
  assert.deepEqual(sessionProgress({ type: 'session.text.delta', data }), { sessionID: 'ses_1', activity: 'model output was streamed' });
  assert.equal(sessionProgress({ type: 'session.reasoning.delta', data }).activity, 'model reasoning was streamed');
  assert.equal(sessionProgress({ type: 'session.tool.input.delta', data }).activity, 'a tool call was streamed');
  assert.equal(sessionProgress({ type: 'session.tool.progress', data }).activity, 'a tool reported progress');
  assert.equal(sessionProgress({ type: 'session.step.started', data }).activity, 'a model step started');
  for (const type of ['session.status', 'session.usage.updated', 'session.inbox.enqueued', 'session.synthetic', 'message.part.delta']) assert.equal(sessionProgress({ type, data }), null, type);
  assert.equal(sessionProgress({ type: 'session.text.delta', data: {} }), null);
  assert.equal(sessionProgress(undefined), null);
  // The subscription asks for exactly these types; each one is progress.
  assert.deepEqual(PROGRESS_EVENT_TYPES, ['text', 'reasoning', 'tool.input'].flatMap(kind => ['started', 'delta', 'ended'].map(phase => `session.${kind}.${phase}`))
    .concat(['session.tool.progress', 'session.step.started', 'session.step.streamed', 'session.step.ended']));
  for (const type of PROGRESS_EVENT_TYPES) assert.ok(sessionProgress({ type, data }), type);
});

test('a request\'s instructions part is rebuilt from the host\'s own facts, and left alone where it cannot be told apart', () => {
  // The shape of OpenCode 2.3.0 through 2.4.1: the agent's system prompt, a part a host plugin adds, then the
  // instructions part, whose text is its sources joined by a blank line.
  const sources = [{ key: 'core/codemode', text: 'CODEMODE' }, { key: 'core/mcp-guidance', text: 'MCP SAYS' }, { key: 'core/instructions', text: 'Instructions from: /work/AGENTS.md\nLOCAL RULES' },
    { key: 'core/date', text: "Today's date: Wed Nov 25 2026" }, { key: 'core/environment', text: 'Here is some useful information…\n<env>\n</env>' }, { key: 'other.plugin/notes', text: 'PLUGIN NOTES' }];
  const part = { type: 'text', text: sources.map(source => source.text).join('\n\n'), metadata: { experimental: { instructions: sources } } };
  const system = [{ type: 'text', text: 'AZPR ROLE' }, { type: 'text', text: '# Your Model' }, part, { type: 'text', text: 'TRAILER' }];
  const before = JSON.stringify(system);
  const lean = withoutPlaceInstructions(system);
  assert.deepEqual(lean.removed.map(source => source.key), ['core/codemode', 'core/mcp-guidance', 'core/instructions', 'other.plugin/notes'], 'Everything but the date and the environment tells of the place or of what is configured there.');
  assert.deepEqual(lean.removed.map(source => source.text), ['CODEMODE', 'MCP SAYS', 'Instructions from: /work/AGENTS.md\nLOCAL RULES', 'PLUGIN NOTES'], 'The sources that go are handed back whole, in their order.');
  assert.deepEqual(lean.system.map(item => item.text), ['AZPR ROLE', '# Your Model', "Today's date: Wed Nov 25 2026\n\nHere is some useful information…\n<env>\n</env>", 'TRAILER']);
  assert.deepEqual(lean.system[2].metadata.experimental.instructions.map(source => source.key), HOST_FACT_SOURCES, 'The part still says what it is made of.');
  assert.equal(JSON.stringify(system), before, 'The parts the host handed over are not changed in place.');
  // Nothing to leave out: the same list comes back.
  const facts = sources.filter(source => HOST_FACT_SOURCES.includes(source.key));
  const plain = [{ type: 'text', text: 'AZPR ROLE' }, { type: 'text', text: facts.map(source => source.text).join('\n\n'), metadata: { experimental: { instructions: facts } } }];
  assert.deepEqual(withoutPlaceInstructions(plain), { system: plain, removed: [] });
  // No source is a fact of the host: the part goes.
  const placeOnly = [{ type: 'text', text: 'AZPR ROLE' }, { type: 'text', text: 'LOCAL', metadata: { experimental: { instructions: [{ key: 'core/instructions', text: 'LOCAL' }] } } }];
  assert.deepEqual(withoutPlaceInstructions(placeOnly).system, [{ type: 'text', text: 'AZPR ROLE' }]);
  // Anything else is not told apart: no such part, two of them, a text another hook edited, sources of another form.
  for (const unknown of [undefined, 'text', [], [{ type: 'text', text: 'AZPR ROLE' }], [part, part],
    [{ ...part, text: part.text + '\n\nEDITED' }], [{ ...part, metadata: { experimental: { instructions: [{ key: 'core/date' }] } } }],
    [{ type: 'text', text: 'x', metadata: { experimental: { instructions: 'x' } } }]]) {
    assert.equal(withoutPlaceInstructions(unknown), null, JSON.stringify(unknown)?.slice(0, 80));
  }
  // What a hook added to the part, its metadata or a source in plain sight stays with them where the part is
  // made anew, and with the sources that are kept.
  const marked = [system[0], { ...part, cache: { type: 'ephemeral' }, metadata: { note: 'of a hook', experimental: { also: true, instructions: sources.map(source => source.key === 'core/date' ? { ...source, seen: 1 } : source) } } }];
  const kept = withoutPlaceInstructions(marked).system[1];
  assert.deepEqual([kept.cache, kept.metadata.note, kept.metadata.experimental.also, kept.metadata.experimental.instructions.map(source => [source.key, source.seen])],
    [{ type: 'ephemeral' }, 'of a hook', true, [['core/date', 1], ['core/environment', undefined]]]);
  // The parts are plain data as the host builds them. A list, a part, its metadata or a source that is not (one
  // of a class of its own, with a field that is not listed, under a symbol or read through an accessor, or one
  // that answers for another object) is not looked into, so nothing of its own is called; the instructions part
  // cannot be told apart then, and everything stays as it is. A part of another plugin's that is no plain data
  // changes nothing for the part that is.
  class Tagged extends Array {}
  let asked = 0;
  const lazy = make => Object.defineProperty({ type: 'text', text: part.text }, 'metadata', { enumerable: true, get() { asked++; return make(); } });
  const refusing = new Proxy({}, new Proxy({}, { get() { asked++; throw new Error('not for you'); } }));
  for (const [name, unknown] of Object.entries({
    'the list is an array of a class of its own': Tagged.from(system),
    'the list carries something more': Object.assign([...system], { note: 'of a hook' }),
    'the list answers for another object': new Proxy([...system], {}),
    'the part is an instance of a class': [system[0], Object.assign(new (class SystemPart {})(), part)],
    'the part has a field that is not listed': [system[0], Object.defineProperty({ ...part }, 'name', { value: 'of a hook' })],
    'the part has a field under a symbol': [system[0], { ...part, [Symbol('mark')]: true }],
    'the part answers for another object': [system[0], new Proxy({ ...part }, {})],
    'the metadata is read through an accessor': [system[0], lazy(() => part.metadata)],
    'the metadata is an instance of a class': [system[0], { ...part, metadata: Object.assign(new (class Metadata {})(), part.metadata) }],
    'the sources are an array of a class of their own': [system[0], { ...part, metadata: { experimental: { instructions: Tagged.from(sources) } } }],
    'the sources carry something more': [system[0], { ...part, metadata: { experimental: { instructions: Object.assign([...sources], { note: 'of a hook' }) } } }],
    'a source is an instance of a class': [system[0], { ...part, metadata: { experimental: { instructions: sources.map((source, at) => at ? source : Object.assign(new (class Source {})(), source)) } } }],
    'a source has its text under an accessor': [system[0], { ...part, metadata: { experimental: { instructions: sources.map((source, at) => at ? source : Object.defineProperty({ key: source.key }, 'text', { enumerable: true, get() { asked++; return source.text; } })) } } }],
    'a source has a text that is not listed': [system[0], { ...part, metadata: { experimental: { instructions: sources.map((source, at) => at ? source : Object.defineProperty({ key: source.key }, 'text', { value: source.text })) } } }],
  })) assert.equal(withoutPlaceInstructions(unknown), null, name);
  // Where no source is kept the whole part goes, so only a part that holds nothing but what the host gave it:
  // one that a hook marked, on the part, its metadata or beside the sources, would lose the mark with it.
  const local = [{ key: 'core/instructions', text: 'LOCAL' }], bare = { type: 'text', text: 'LOCAL', metadata: { experimental: { instructions: local } } };
  assert.deepEqual(withoutPlaceInstructions([system[0], bare]).system, [system[0]]);
  for (const [name, marked] of Object.entries({ 'the part': { ...bare, cache: { type: 'ephemeral' } }, 'its metadata': { ...bare, metadata: { ...bare.metadata, note: 'of a hook' } },
    'beside the sources': { ...bare, metadata: { experimental: { instructions: local, also: true } } } })) assert.equal(withoutPlaceInstructions([system[0], marked]), null, `a mark on ${name}`);
  // A source that goes takes what it holds with it, so only one that holds nothing but its key and its text: a
  // mark on one that goes leaves everything as it is, and a mark on one that stays, stays with it.
  const origin = at => [system[0], { ...part, metadata: { experimental: { instructions: sources.map((source, index) => index === at ? { ...source, origin: 'of a hook' } : source) } } }];
  assert.equal(withoutPlaceInstructions(origin(2)), null, 'A source that would go carries a mark.');
  assert.deepEqual(withoutPlaceInstructions(origin(3)).system[1].metadata.experimental.instructions.map(source => source.origin), ['of a hook', undefined], 'A source that stays keeps its mark.');
  assert.equal(withoutPlaceInstructions([system[0], { ...bare, metadata: { experimental: { instructions: [{ ...local[0], origin: 'of a hook' }] } } }]), null, 'The only source carries a mark: the part does not go.');
  // A value that was revoked throws at any question, also whether it is a list: it is asked none.
  const gone = target => { const made = Proxy.revocable(target, {}); made.revoke(); return made.proxy; };
  assert.equal(withoutPlaceInstructions(gone([...system])), null);
  assert.equal(withoutPlaceInstructions([system[0], { ...part, metadata: gone({}) }]), null);
  assert.equal(withoutPlaceInstructions([system[0], { ...part, metadata: { experimental: { instructions: gone([...sources]) } } }]), null);
  assert.deepEqual(withoutPlaceInstructions([system[0], gone({}), { type: 'text', text: 'OTHER', metadata: gone({}) }, part]).system.length, 4, 'A part that was revoked, or holds something that was, is another part.');
  // A part of AZPR's own is added as a new list, where the parts are an ordinary list (also one that cannot be
  // changed): the list that was handed over is not touched and none of its methods is called. Where they are
  // not, nothing is made of them.
  const note = { type: 'text', text: 'NOTE' }, fixed = Object.freeze([...system]);
  class Parts extends Array { push() { asked++; return super.push(...arguments); } }
  assert.deepEqual([withPart(system, note), system.length, withPart(fixed, note).at(-1), fixed.length, withPart([], note)], [[...system, note], 4, note, 4, [note]]);
  for (const other of [Parts.from(system), Object.assign([...system], { cache: true }), new Proxy([...system], {}), gone([...system]), undefined, 'parts', { 0: system[0], length: 1 }]) assert.equal(withPart(other, note), undefined);
  const beside = [system[0], refusing, lazy(() => { throw new Error('not for you'); }), part];
  assert.deepEqual(withoutPlaceInstructions(beside).system.slice(0, 3), beside.slice(0, 3), 'A part that refuses to be read is another part, left where it is.');
  assert.equal(asked, 0, 'Nothing of a part\'s own was called.');
});

test('a tool is taken out of a request\'s list where the list is an ordinary object and lets it; nothing is asked of a list that answers for another, and nothing is thrown', () => {
  const unwanted = name => name.startsWith('azpr_') || name === 'edit';
  const tools = { read: {}, edit: {}, azpr_read_file: {}, [Symbol('mark')]: 'of a hook' };
  assert.equal(withoutTools(tools, unwanted), true);
  assert.deepEqual([Object.keys(tools), Object.getOwnPropertySymbols(tools).length], [['read'], 1], 'The tools that are not wanted are gone, and nothing else.');
  // A list that cannot be changed keeps its tools, and one of them that cannot be taken out stays: the request
  // goes on either way.
  const fixed = Object.freeze({ read: {}, edit: {} }), partly = Object.defineProperty({ read: {}, azpr_read_file: {} }, 'edit', { value: {}, enumerable: true });
  assert.deepEqual([withoutTools(fixed, unwanted), withoutTools(partly, unwanted), withoutTools(Object.freeze({ read: {} }), unwanted)], [false, false, true], 'It says whether a tool that is not wanted is left listed.');
  assert.deepEqual([Object.keys(fixed), Object.keys(partly)], [['read', 'edit'], ['read', 'edit']]);
  // A list that answers for another object is asked nothing, also one that was revoked; and what is no list of
  // tools is left alone.
  let asked = 0;
  const watched = new Proxy({ edit: {} }, new Proxy({}, { get() { asked++; return undefined; } })), revoked = Proxy.revocable({ edit: {} }, {});
  revoked.revoke();
  assert.deepEqual([watched, revoked.proxy, 'tools', 7].map(other => withoutTools(other, unwanted)), [false, false, false, false], 'Of a list that is not looked into nothing is known.');
  assert.deepEqual([withoutTools(undefined, unwanted), withoutTools(null, unwanted)], [true, true], 'No list holds no tool.');
  assert.equal(asked, 0);
});

test('the places of a request are taken once from the event\'s own descriptors: what each holds and whether it can be given another value', () => {
  const system = [{ type: 'text', text: 'ROLE' }], messages = [], options = { maxTokens: 1 }, tools = { read: {} };
  const place = (value, writable = true, unread = false) => ({ value, writable, unread });
  // As OpenCode hands it over: a plain object whose places are listed data that can be written.
  assert.deepEqual(requestSlots({ sessionID: 'ses_1', system, messages, options, tools }), { system: place(system), messages: place(messages), options: place(options), tools: place(tools) });
  // A place that is not there holds nothing and cannot be written; one that cannot be written says so and still
  // holds its value; a frozen event holds every value and lets none be replaced.
  assert.deepEqual(requestSlots({ system }), { system: place(system), messages: place(undefined, false), options: place(undefined, false), tools: place(undefined, false) });
  assert.deepEqual(requestSlots(Object.defineProperty({ messages }, 'system', { value: system, enumerable: true })).system, place(system, false));
  assert.deepEqual(Object.values(requestSlots(Object.freeze({ system, messages, options, tools }))).map(slot => [slot.value !== undefined, slot.writable]), Array(4).fill([true, false]));
  // A place behind an accessor is not asked: something is there, and nothing is known of it. An event that
  // answers for another object, or is none, has no places.
  let asked = 0;
  const lazy = Object.defineProperty({ messages }, 'system', { enumerable: true, get() { asked++; return system; } });
  assert.deepEqual([requestSlots(lazy).system, requestSlots(lazy).messages], [place(undefined, false, true), place(messages)]);
  const revoked = Proxy.revocable({ system }, {}); revoked.revoke();
  for (const event of [new Proxy({ system }, new Proxy({}, { get() { asked++; return undefined; } })), revoked.proxy, undefined, null, 'event']) {
    assert.deepEqual(requestSlots(event), { system: place(undefined, false), messages: place(undefined, false), options: place(undefined, false), tools: place(undefined, false) });
  }
  // What an event inherits is not its own.
  assert.deepEqual(requestSlots(Object.create({ system })).system, place(undefined, false));
  assert.equal(asked, 0);
});

test('the Claude provider\'s option is the text an ordinary object holds of its own, with whether it can be written', () => {
  const key = CLAUDE_INSTRUCTIONS_OPTION;
  const held = (text, writable = true) => ({ text, writable });
  assert.deepEqual([claudeOption({ [key]: 'TEXT', maxTokens: 1 }), claudeOption({ [key]: '' }), claudeOption(Object.assign(Object.create(null), { [key]: 'TEXT' }))], [held('TEXT'), held(''), held('TEXT')]);
  // Its text is there to compare where it cannot be written, and the option says so: it is not emptied then.
  assert.deepEqual([claudeOption(Object.freeze({ [key]: 'TEXT' })), claudeOption(Object.defineProperty({}, key, { value: 'TEXT', enumerable: true, configurable: true }))], [held('TEXT', false), held('TEXT', false)]);
  let asked = 0;
  const revoked = Proxy.revocable({ [key]: 'TEXT' }, {}); revoked.revoke();
  for (const [name, options] of Object.entries({
    'an option behind an accessor': Object.defineProperty({}, key, { enumerable: true, get() { asked++; return 'TEXT'; } }),
    'an option that is inherited': Object.create({ [key]: 'TEXT' }),
    'an option that is no text': { [key]: ['TEXT'] },
    'no such option': { maxTokens: 1 },
    'options that answer for another object': new Proxy({ [key]: 'TEXT' }, new Proxy({}, { get() { asked++; return undefined; } })),
    'options that were revoked': revoked.proxy,
    'no options': undefined, 'a text for options': 'TEXT', 'nothing': null,
  })) assert.equal(claudeOption(options), undefined, name);
  assert.equal(asked, 0, 'Nothing of the options\' own was called.');
});

test('what the host wrote of instructions into a session is told by the session\'s own messages: an update by its type, a load by the paths it names after a native read of the session', () => {
  // OpenCode 2.3.0 through 2.4.1, after the native read tool read a file below a directory that holds one, and
  // after a source changed while the session ran.
  const load = { id: 'msg_load', type: 'synthetic', text: 'Instructions from: /work/sub/AGENTS.md\nNESTED', description: 'Loaded sub/AGENTS.md', metadata: { instruction: { paths: ['/work/sub/AGENTS.md'] } } };
  const update = { id: 'msg_update', type: 'system', text: 'The instructions from /work/AGENTS.md no longer apply.', description: 'Instructions updated: core/instructions', metadata: { notice: 'instructions', instructionSources: ['core/instructions'] } };
  assert.deepEqual([isInstructionLoad(load), isInstructionUpdate(load), isInstructionLoad(update), isInstructionUpdate(update)], [true, false, false, true]);
  // The host goes by the metadata, and so does this: the text is whatever the files hold. A later host may mark
  // an update another way; a message of its type is the host's.
  assert.deepEqual([isInstructionLoad({ ...load, text: 'anything' }), isInstructionUpdate({ ...update, metadata: undefined })], [true, true]);
  for (const other of [undefined, {}, { type: 'synthetic', text: load.text }, { ...load, metadata: {} }, { ...load, metadata: { instruction: {} } }, { ...load, metadata: { instruction: { paths: [] } } },
    { ...load, metadata: { instruction: { paths: [''] } } }, { ...load, metadata: { instruction: { paths: [1] } } }, { ...load, metadata: { instruction: { paths: '/work/sub/AGENTS.md' } } }, { ...load, metadata: { azpr: {} } },
    // Not the host's, whatever it carries: no ID to know it by, a person's message, an assistant's, or what a request holds of it.
    { ...load, id: undefined }, { ...load, id: '' }, { ...load, id: 7 }, { ...load, type: 'user' }, { ...load, type: 'assistant' },
    { id: 'msg_load', role: 'user', content: load.text, metadata: load.metadata }, { ...update, id: undefined }, { ...update, id: '' }, { ...update, text: undefined },
    { role: 'system', content: [{ type: 'text', text: update.text }] }]) {
    assert.deepEqual([isInstructionLoad(other), isInstructionUpdate(other)], [false, false], JSON.stringify(other));
  }
  // A load is the late result of the session's own tool call: it counts only after an assistant message of the
  // session called the native read tool. An update needs no call.
  const prompt = { id: 'msg_prompt', type: 'user', text: 'PROMPT' }, answer = { id: 'msg_answer', type: 'assistant', content: [{ type: 'text', text: 'answer' }] };
  const calling = (name, id = `msg_${name}`) => ({ id, type: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool', id: `call_${name}`, name, state: { status: 'completed' } }] });
  const ids = messages => { const { loads, updates } = hostInstructions(messages); return [loads.map(message => message.id), updates.map(message => message.id)]; };
  const second = { ...load, id: 'msg_load_2' };
  for (const [name, messages, expected] of [
    ['after a native read', [prompt, calling('read'), load, answer], [['msg_load'], []]],
    ['two after one read, and an update', [prompt, calling('read'), load, update, second, answer], [['msg_load', 'msg_load_2'], ['msg_update']]],
    ['after a read of an earlier turn', [prompt, calling('read'), answer, { id: 'msg_idle', type: 'idle' }, { ...prompt, id: 'msg_prompt_2' }, load], [['msg_load'], []]],
    ['in a session that did not read', [prompt, load, update, answer], [[], ['msg_update']]],
    ['before the read', [prompt, load, calling('read'), answer], [[], []]],
    ['after the calls of other tools', [prompt, calling('azpr_read_file'), calling('shell'), calling('glob'), load, answer], [[], []]],
    ['after a person\'s message that names the tool', [prompt, { id: 'msg_user', type: 'user', content: [{ type: 'tool', name: 'read' }] }, load], [[], []]],
    ['an assistant message without parts', [prompt, { id: 'msg_plain', type: 'assistant' }, load], [[], []]],
    ['no messages', [], [[], []]],
  ]) assert.deepEqual(ids(messages), expected, name);
});

test('a request loses what the host wrote of instructions where it is as the host builds it, by the session\'s own record; anything else stays as it is', () => {
  // What a session holds, and what OpenCode makes of it in a request: every user message has the ID of the
  // message it was made of, and an update is a system message of its text as one part, without an ID.
  const stored = [{ id: 'msg_prompt', type: 'user', text: 'PROMPT' }, { id: 'msg_step', type: 'assistant', content: [{ type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed' } }] },
    { id: 'msg_load', type: 'synthetic', text: 'Instructions from: /work/sub/CLAUDE.md\nNESTED', metadata: { instruction: { paths: ['/work/sub/CLAUDE.md'] } } },
    { id: 'msg_update', type: 'system', text: 'The instructions changed:\nInstructions from: /work/AGENTS.md\nCHANGED', metadata: { notice: 'instructions' } },
    { id: 'msg_notice', type: 'synthetic', text: 'a notice', metadata: { source: 'shell', shellID: 'sh_1', state: 'completed' } }];
  const prompt = { id: 'msg_prompt', role: 'user', content: [{ type: 'text', text: 'PROMPT' }] }, step = { id: 'msg_step', role: 'assistant', content: [] };
  const load = { id: 'msg_load', role: 'user', content: [{ type: 'text', text: stored[2].text }] }, update = { role: 'system', content: [{ type: 'text', text: stored[3].text }] };
  const notice = { id: 'msg_notice', role: 'user', content: 'a notice', metadata: stored[4].metadata }, effort = { role: 'system', content: [{ type: 'effort', effort: 'high', previous: 'low' }] };
  const requested = [prompt, step, load, update, notice, effort];
  const frozen = JSON.stringify(requested);
  assert.deepEqual(withoutHostMessages(requested, stored), { messages: [prompt, step, notice, effort], loads: ['msg_load'], updates: ['msg_update'], changed: false });
  assert.equal(JSON.stringify(requested), frozen, 'The request that was handed over is not changed.');
  // A session without such messages gets its request back as it is, whatever another hook made of it.
  const plain = [prompt, step, { role: 'user', content: 'added by a hook' }];
  assert.deepEqual(withoutHostMessages(plain, stored.slice(0, 2)), { messages: plain, loads: [], updates: [], changed: false });
  assert.equal(withoutHostMessages(plain, stored.slice(0, 2)).messages, plain);
  // A load as the host builds it is the user message with its ID and its text as one text part, with the
  // stored message's metadata (the same data, however its keys are ordered) or without it, and with no other
  // field. An update is taken out wherever a system message of the host's form holds its text, every
  // copy of it; of two updates with one text, as many are counted as the request held, in their order. Another
  // hook's own system message stays, and so does a message that a hook added.
  const directive = { role: 'system', content: [{ type: 'text', text: 'Answer briefly.' }] };
  const twice = [...stored, { ...stored[3], id: 'msg_update_again' }];
  const wide = stored.map(message => message.id === 'msg_load' ? { ...message, metadata: { instruction: { paths: ['/work/sub/CLAUDE.md'], kind: 'nested' }, source: 'read' } } : message);
  for (const [name, messages, kept, updates = ['msg_update'], session = stored] of [
    ['a load with its metadata', [prompt, step, { ...load, metadata: stored[2].metadata }, update, notice], [prompt, step, notice]],
    ['a load with its metadata as other objects of the same data', [prompt, step, { ...load, metadata: { ...JSON.parse(JSON.stringify(stored[2].metadata)), absent: undefined } }, update, notice], [prompt, step, notice]],
    ['a load with its metadata as data without a prototype', [prompt, step, { ...load, metadata: Object.assign(Object.create(null), { instruction: Object.assign(Object.create(null), { paths: ['/work/sub/CLAUDE.md'] }) }) }, update, notice], [prompt, step, notice]],
    ['an update that is an instance of a class, as the host builds it', [prompt, step, load, Object.assign(new (class SystemMessage {})(), update), notice], [prompt, step, notice]],
    ['a load with its metadata in another order of keys', [prompt, step, { ...load, metadata: { source: 'read', instruction: { kind: 'nested', paths: ['/work/sub/CLAUDE.md'] } } }, update, notice], [prompt, step, notice], ['msg_update'], wide],
    ['messages that name something they do not have', [prompt, step, { ...load, metadata: undefined, providerMetadata: undefined }, { ...update, id: undefined, name: undefined, tools: undefined }, notice], [prompt, step, notice]],
    ['parts that name something they do not have', [prompt, step, { ...load, content: [{ type: 'text', text: stored[2].text, providerMetadata: undefined }] }, { role: 'system', content: [{ type: 'text', text: stored[3].text, cache: undefined }] }, notice], [prompt, step, notice]],
    ['the update twice', [prompt, step, load, update, update, notice], [prompt, step, notice]],
    ['two updates of one text', [prompt, step, load, update, update, notice], [prompt, step, notice], ['msg_update', 'msg_update_again'], twice],
    ['two updates of one text, of which the request holds one', [prompt, step, load, update, notice], [prompt, step, notice], ['msg_update'], twice],
    ['another hook\'s system message', [prompt, step, load, update, directive, notice], [prompt, step, directive, notice]],
    ['a user message that a hook added', [prompt, step, load, update, notice, { role: 'user', content: 'added by a hook' }], [prompt, step, notice, { role: 'user', content: 'added by a hook' }]],
  ]) {
    assert.deepEqual(withoutHostMessages(messages, session), { messages: kept, loads: ['msg_load'], updates, changed: false }, name);
  }
  assert.deepEqual(withoutHostMessages([prompt, step, notice], stored), { messages: [prompt, step, notice], loads: [], updates: [], changed: false }, 'What was not there was not taken out.');
  // A message of a load's form in a session that did not read natively is not the host's: it stays, like any
  // message of someone else's, and the update is taken out all the same.
  const unread = stored.map(message => message.id === 'msg_step' ? { ...message, content: [] } : message);
  assert.deepEqual(withoutHostMessages(requested, unread), { messages: [prompt, step, load, notice, effort], loads: [], updates: ['msg_update'], changed: false });
  // What is not such a message as the host builds it stays as it is: it may hold what is not the host's, and it
  // is not this function's to take a message apart or to look through a request for a text. A message with a
  // load's ID that a hook before this one changed (its text as a string or in two parts, something joined to
  // it, another role, a part that is no text, metadata that is other data, a field of the hook's own) stays,
  // and the result says so; where the load has another ID or none, or an update another form or a field more,
  // nothing says that it is one.
  const shell = 'The command ended: exit 0';
  const longer = ['/work/sub/CLAUDE.md']; longer.length = 2;
  class Tagged extends Array {}
  for (const [name, messages, changed] of [
    ['the load\'s text as a string', [prompt, step, { id: 'msg_load', role: 'user', content: stored[2].text }, notice], true],
    ['the load\'s text in two parts', [prompt, step, { ...load, content: [{ type: 'text', text: stored[2].text.slice(0, 9) }, { type: 'text', text: stored[2].text.slice(9), annotation: 'of a hook' }] }, notice], true],
    ['something joined to the load', [prompt, step, { ...load, content: [{ type: 'text', text: `${shell}\n\n${stored[2].text}` }] }, notice], true],
    ['the load as another role', [prompt, step, { ...load, role: 'assistant' }, notice], true],
    ['the load with a part that is no text', [prompt, step, { ...load, content: [...load.content, { type: 'media', data: 'AAAA' }] }, notice], true],
    ['the load without its content', [prompt, step, { id: 'msg_load', role: 'user' }, notice], true],
    ['the load under another ID', [prompt, step, { ...load, id: 'msg_renamed' }, notice], false],
    ['the load without an ID', [prompt, step, { role: 'user', content: load.content }, notice], false],
    ['the load joined to the prompt', [{ ...prompt, content: [{ type: 'text', text: `PROMPT\n\n${stored[2].text}` }] }, step, notice], false],
    ['an update written as a plain string', [prompt, step, { role: 'system', content: stored[3].text }, notice], false],
    ['an update with another hook\'s mark', [prompt, step, { ...update, metadata: { plugin: 'other' } }, notice], false],
    ['an update whose text part carries another hook\'s mark', [prompt, step, { role: 'system', content: [{ type: 'text', text: stored[3].text, metadata: { plugin: 'other' } }] }, notice], false],
    ['the load whose text part carries another hook\'s mark', [prompt, step, { ...load, content: [{ type: 'text', text: stored[2].text, cache: 'ephemeral' }] }, notice], true],
    ['an update with something added', [prompt, step, { role: 'system', content: [{ type: 'text', text: `${stored[3].text}\nAnd answer briefly.` }] }, notice], false],
    ['an update with a name', [prompt, step, { ...update, name: 'another-plugin' }, notice], false],
    ['an update with an ID', [prompt, step, { ...update, id: 'msg_of_a_hook' }, notice], false],
    ['an update with tools', [prompt, step, { ...update, tools: { add: [], remove: [] } }, notice], false],
    ['the load with a field of another hook\'s', [prompt, step, { ...load, providerMetadata: { anthropic: { cacheControl: { type: 'ephemeral' } } } }, notice], true],
    ['the load whose metadata carries another hook\'s mark', [prompt, step, { ...load, metadata: { ...stored[2].metadata, cache: { type: 'ephemeral' } } }, notice], true],
    ['the load whose metadata names other files', [prompt, step, { ...load, metadata: { instruction: { paths: ['/work/other/AGENTS.md'] } } }, notice], true],
    ['the load whose metadata lacks what the stored one has', [prompt, step, { ...load, metadata: {} }, notice], true],
    ['the load whose list of files has an empty place more', [prompt, step, { ...load, metadata: { instruction: { paths: longer } } }, notice], true],
    ['the load whose list of files has a place without a value', [prompt, step, { ...load, metadata: { instruction: { paths: [null] } } }, notice], true],
    ['the load whose metadata only inherits what the stored one has', [prompt, step, { ...load, metadata: Object.assign(Object.create(stored[2].metadata), { own: undefined }) }, notice], true],
    ['the load whose metadata inherits one key and has another', [prompt, step, { ...load, metadata: Object.assign(Object.create(stored[2].metadata), { cache: 'ephemeral' }) }, notice], true],
    ['the load whose metadata has only what every object inherits', [prompt, step, { ...load, metadata: { toString: Object.prototype.toString } }, notice], true],
    ['the load whose list of files is an array of a class of its own', [prompt, step, { ...load, metadata: { instruction: { paths: Tagged.from(['/work/sub/CLAUDE.md']) } } }, notice], true],
    ['the load whose list of files carries something more', [prompt, step, { ...load, metadata: { instruction: { paths: Object.assign(['/work/sub/CLAUDE.md'], { note: 'of a hook' }) } } }, notice], true],
    ['the load whose content is an array of a class of its own', [prompt, step, { ...load, content: Tagged.from(load.content) }, notice], true],
    ['the load whose content carries something more', [prompt, step, { ...load, content: Object.assign([...load.content], { cache: 'ephemeral' }) }, notice], true],
    ['the load whose text part is an instance of a class', [prompt, step, { ...load, content: [Object.assign(new (class Part {})(), load.content[0])] }, notice], true],
    ['the load that is an instance of a class', [prompt, step, Object.assign(new (class UserMessage {})(), load), notice], true],
    ['the load with a field that is not listed', [prompt, step, Object.defineProperty({ ...load }, 'name', { value: 'of a hook' }), notice], true],
    ['the load with a field that is an accessor', [prompt, step, Object.defineProperty({ ...load }, 'name', { get: () => 'of a hook', enumerable: true }), notice], true],
    ['the load whose list of files has an empty place and something more', [prompt, step, { ...load, metadata: { instruction: { paths: Object.assign(['/work/sub/CLAUDE.md', undefined].slice(0, 1).concat(new Array(1)), { note: 'of a hook' }) } } }, notice], true],
    ['the load with a field under a symbol', [prompt, step, { ...load, [Symbol('mark')]: 'of a hook' }, notice], true],
    ['the load whose content is read through an accessor', [prompt, step, Object.defineProperty({ id: load.id, role: 'user' }, 'content', { get: () => load.content, enumerable: true }), notice], true],
    ['the load whose metadata refuses to be read', [prompt, step, { ...load, metadata: new Proxy({}, { ownKeys() { throw new Error('not for you'); } }) }, notice], true],
    ['the load that answers for another object', [prompt, step, new Proxy({ ...load }, {}), notice], false],
    ['the load that refuses to be read', [prompt, step, new Proxy({ ...load }, { ownKeys() { throw new Error('not for you'); }, getOwnPropertyDescriptor() { throw new Error('not for you'); }, get() { throw new Error('not for you'); } }), notice], false],
    ['the load whose metadata answers for another object', [prompt, step, { ...load, metadata: new Proxy(stored[2].metadata, {}) }, notice], true],
    ['the load whose content answers for another object', [prompt, step, { ...load, content: new Proxy(load.content, {}) }, notice], true],
    ['the load whose text part answers for another object', [prompt, step, { ...load, content: [new Proxy(load.content[0], {})] }, notice], true],
    ['the load whose ID is not listed', [prompt, step, Object.defineProperty({ role: 'user', content: load.content }, 'id', { value: load.id }), notice], true],
    ['the load whose content is not listed', [prompt, step, Object.defineProperty({ id: load.id, role: 'user' }, 'content', { value: load.content }), notice], true],
    ['the load whose text is not listed', [prompt, step, { ...load, content: [Object.defineProperty({ type: 'text' }, 'text', { value: stored[2].text })] }, notice], true],
    ['the load whose list of files has a place that is not listed', [prompt, step, { ...load, metadata: { instruction: { paths: Object.defineProperty([], '0', { value: '/work/sub/CLAUDE.md', writable: true, configurable: true }) } } }, notice], true],
    ['an update whose text is not listed', [prompt, step, { role: 'system', content: [Object.defineProperty({ type: 'text' }, 'text', { value: stored[3].text })] }, notice], false],
    ['an update whose role is not listed', [prompt, step, Object.defineProperty({ content: update.content }, 'role', { value: 'system' }), notice], false],
    ['an update that answers for another object', [prompt, step, new Proxy({ ...update }, {}), notice], false],
    ['an update with a field that is not listed', [prompt, step, Object.defineProperty({ ...update }, 'name', { value: 'another-plugin' }), notice], false],
    ['an update with a field under a symbol', [prompt, step, { ...update, [Symbol('mark')]: 'of a hook' }, notice], false],
    ['an update whose content is an array of a class of its own', [prompt, step, { role: 'system', content: Tagged.from(update.content) }, notice], false],
    ['an update whose text part has a field that is not listed', [prompt, step, { role: 'system', content: [Object.defineProperty({ ...update.content[0] }, 'cache', { value: 'ephemeral' })] }, notice], false],
    ['an update whose text is read through an accessor', [prompt, step, { role: 'system', content: [Object.defineProperty({ type: 'text' }, 'text', { get: () => stored[3].text, enumerable: true })] }, notice], false],
    ['an update that refuses to be read', [prompt, step, new Proxy({ ...update }, { ownKeys() { throw new Error('not for you'); }, getOwnPropertyDescriptor() { throw new Error('not for you'); }, get() { throw new Error('not for you'); } }), notice], false],
    ['the load whose metadata is no plain data', [prompt, step, { ...load, metadata: new (class Marked { constructor() { this.instruction = { paths: ['/work/sub/CLAUDE.md'] }; } })() }, notice], true],
    ['the load whose metadata holds a value that is no plain data', [prompt, step, { ...load, metadata: { instruction: Object.assign(new Date(0), { paths: ['/work/sub/CLAUDE.md'] }) } }, notice], true],
  ]) {
    assert.deepEqual(withoutHostMessages(messages, stored), { messages, loads: [], updates: [], changed }, name);
  }
  // The list of messages is looked at like everything in it. One that is no ordinary list (of a class of its
  // own, with something more on it, with an item behind an accessor, one that answers for another object, also
  // one that was revoked) is left as it is, whole: the very list comes back, nothing of its own is called, and
  // the request is counted, since what the host wrote may be in it.
  const revoked = target => { const made = Proxy.revocable(target, {}); made.revoke(); return made.proxy; };
  let read = 0;
  class Listed extends Array { filter() { read++; return super.filter(...arguments); } }
  for (const [name, list] of Object.entries({
    'a list of a class of its own': Listed.from(requested),
    'a list that carries something more': Object.assign([...requested], { cache: 'ephemeral' }),
    'a list with an item behind an accessor': Object.defineProperty([prompt, step, , update, notice], 2, { enumerable: true, configurable: true, get() { read++; return load; } }),
    'a list that answers for another object': new Proxy([...requested], new Proxy({}, { get() { read++; return undefined; } })),
    'a list that was revoked': revoked([...requested]),
    'no list at all': { 0: load, length: 1 },
  })) {
    const result = withoutHostMessages(list, stored);
    assert.equal(result.messages, list, name);
    assert.deepEqual([result.loads, result.updates, result.changed], [[], [], true], name);
  }
  assert.equal(read, 0, 'Nothing of a list\'s own was called.');
  // Where nothing is taken out, the list that was handed over comes back.
  const untouched = [prompt, step, notice];
  assert.equal(withoutHostMessages(untouched, stored).messages, untouched);
  // And nothing in a request is asked what it is before it is known not to answer for another object: one that
  // was revoked throws at any question. As a message, a content, a part, metadata or a place in it, it is
  // something that is not the host's, and stays.
  for (const [name, messages, changed] of [
    ['a message that was revoked', [prompt, step, revoked({ ...load }), notice], false],
    ['a content that was revoked', [prompt, step, { ...load, content: revoked([...load.content]) }, notice], true],
    ['a text part that was revoked', [prompt, step, { ...load, content: [revoked({ ...load.content[0] })] }, notice], true],
    ['metadata that was revoked', [prompt, step, { ...load, metadata: revoked({}) }, notice], true],
    ['a list of files that was revoked', [prompt, step, { ...load, metadata: { instruction: { paths: revoked([]) } } }, notice], true],
    ['an update whose content was revoked', [prompt, step, { role: 'system', content: revoked([...update.content]) }, notice], false],
  ]) assert.deepEqual(withoutHostMessages(messages, stored), { messages, loads: [], updates: [], changed }, name);
  // Looking at a message calls nothing of its own and changes nothing. An ID that would work itself out when it
  // is asked for is not asked: the message stays as it was, and nothing says that it is a load.
  let asked = 0;
  const lazy = Object.defineProperty({ role: 'user', content: load.content }, 'id', { enumerable: true, configurable: true,
    get() { asked++; Object.defineProperty(this, 'id', { value: load.id, enumerable: true, writable: true, configurable: true }); return load.id; } });
  assert.deepEqual(withoutHostMessages([prompt, step, lazy, notice], stored), { messages: [prompt, step, lazy, notice], loads: [], updates: [], changed: false });
  assert.deepEqual([asked, typeof Object.getOwnPropertyDescriptor(lazy, 'id').get], [0, 'function'], 'The ID was not asked for, and is still to be worked out.');
  const traps = [];
  const watched = new Proxy({ ...load }, new Proxy({}, { get: (_, trap) => { traps.push(trap); return undefined; } }));
  withoutHostMessages([prompt, step, watched, update, notice], stored);
  assert.deepEqual(traps, [], 'An object that answers for another is not asked anything.');
  // What a request holds of a session's messages as the host builds it is what `hostInstructions` names for no
  // one else's input, whatever plain data a load's metadata is: both go by the same record, so a load that is
  // kept from the model here is one that fails no turn there, and the other way round. Metadata is compared to
  // its end however deep it goes.
  const nested = depth => { let value = { paths: ['/work/sub/CLAUDE.md'] }; for (let level = 0; level < depth; level++) value = { paths: ['/work/sub/CLAUDE.md'], inner: value }; return { instruction: value }; };
  const lists = depth => { let value = ['/work/sub/CLAUDE.md']; for (let level = 0; level < depth; level++) value = [value, level]; return { instruction: { paths: ['/work/sub/CLAUDE.md'], within: value } }; };
  const copy = value => JSON.parse(JSON.stringify(value));
  for (const [name, metadata] of Object.entries({ 'as the host writes it': stored[2].metadata, 'two hundred levels deep': nested(200), 'two hundred thousand levels deep': nested(200000), 'two hundred thousand lists deep': lists(200000),
    'with other data beside the files': { instruction: { paths: ['/work/sub/CLAUDE.md'], sizes: [0, 1.5, -2], flags: { read: true, cut: false, none: null }, empty: {}, list: [[], [[]], ['']] }, note: '' } })) {
    const session = stored.map(message => message.id === 'msg_load' ? { ...message, metadata } : message);
    // As OpenCode builds the request: the load with a copy of the stored message's metadata, the update as an
    // object of its own class.
    const built = [prompt, step, { ...load, metadata: name.includes('lists') ? lists(200000) : name.includes('thousand') ? nested(200000) : copy(metadata) }, Object.assign(new (class SystemMessage {})(), update), notice];
    const written = hostInstructions(session);
    assert.deepEqual([written.loads.map(message => message.id), written.updates.map(message => message.id)], [['msg_load'], ['msg_update']], name);
    assert.deepEqual(withoutHostMessages(built, session), { messages: [prompt, step, notice], loads: ['msg_load'], updates: ['msg_update'], changed: false }, name);
  }
});

test('a turn\'s prompt is the session\'s one message with its nonce, and the turn stands before it, runs, or has ended at the first idle marker after it', () => {
  const prompt = { id: 'msg_prompt', type: 'user', text: 'PROMPT', metadata: { azprGrant: 'nonce-2' } }, answer = { id: 'msg_answer', type: 'assistant' }, idle = id => ({ id, type: 'idle', outcome: 'succeeded' });
  const earlier = [{ id: 'msg_first', type: 'user', text: 'FIRST', metadata: { azprGrant: 'nonce-1' } }, { id: 'msg_first_answer', type: 'assistant' }, idle('msg_idle_1')];
  for (const [messages, state] of [
    [[], 'before'], [earlier, 'before'], [[...earlier, { id: 'msg_notice', type: 'synthetic', text: 'woke the session' }, { id: 'msg_idle_w', type: 'idle', outcome: 'failed' }], 'before'],
    [[...earlier, prompt], 'running'], [[...earlier, prompt, answer], 'running'], [[...earlier, prompt, answer, { id: 'msg_notice', type: 'synthetic', text: 'reached it while it went idle' }, answer], 'running'],
    [[...earlier, prompt, answer, idle('msg_idle_2')], 'ended'], [[...earlier, prompt, { id: 'msg_idle_2', type: 'idle', outcome: 'interrupted' }], 'ended'],
    [[...earlier, prompt, answer, idle('msg_idle_2'), { id: 'msg_notice', type: 'synthetic', text: 'woke it' }], 'ended'],
  ]) {
    const found = promptOf(messages, 'nonce-2');
    assert.deepEqual([found?.id, turnState(messages, found)], [state === 'before' ? undefined : 'msg_prompt', state], JSON.stringify(messages.map(message => message.id)));
  }
  // Nothing else is the prompt: a message of another type with that nonce, one without an ID, two with it, no nonce.
  for (const messages of [[{ ...prompt, type: 'synthetic' }], [{ ...prompt, id: undefined }], [prompt, { ...prompt, id: 'msg_again' }]]) assert.equal(promptOf(messages, 'nonce-2'), undefined);
  for (const nonce of [undefined, '', 7]) assert.equal(promptOf([prompt, { id: 'msg_x', type: 'user', text: 'x' }], nonce), undefined);
  assert.equal(turnState([prompt], undefined), 'before');
});

test('what the Claude Code provider keeps for a request is its instruction sources but the date and the environment, joined', () => {
  // Measured on OpenCode 2.3.0 and 2.4.1: that provider's hook runs when the instructions part is the only one
  // after the agent's prompt, so the option holds these texts and nothing else.
  assert.deepEqual([CLAUDE_PROVIDER, CLAUDE_INSTRUCTIONS_OPTION], ['claude-agent', 'claudeCodeInstructions']);
  const sources = [{ key: 'core/mcp-guidance', text: 'MCP SAYS' }, { key: 'core/date', text: 'DATE' }, { key: 'core/instructions', text: 'LOCAL RULES\n\nA second paragraph.' }, { key: 'core/environment', text: 'ENVIRONMENT' }];
  const system = [{ type: 'text', text: 'AGENT PROMPT' }, { type: 'text', text: sources.map(source => source.text).join('\n\n'), metadata: { experimental: { instructions: sources } } }];
  const lean = withoutPlaceInstructions(system);
  assert.equal(claudeInstructions(lean.removed), 'MCP SAYS\n\nLOCAL RULES\n\nA second paragraph.');
  assert.equal(claudeInstructions([]), '', 'Nothing to leave out: the option of such a request is empty.');
});
