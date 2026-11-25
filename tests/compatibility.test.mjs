import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { PACKAGE_NAME, REPOSITORY, validateSettings } from '../src/config.mjs';
import { hostCapabilities, isInstructionLoad, isInstructionUpdate, turnState, withoutHostMessages, withoutPlaceInstructions, claudeInstructions, HOST_FACT_SOURCES, CLAUDE_INSTRUCTIONS_OPTION, CLAUDE_PROVIDER, isHostContinuation, isSessionNotFound, isUntitledSession, listOf, packageNamed, pluginEntries, pluginSourceLabel, recordOf, sessionProgress, tokenUsage, usageTotals, withoutCredentials, HOST_CONTINUATION_TEXT, PROGRESS_EVENT_TYPES, TESTED_HOST_VERSION } from '../src/host.mjs';

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
});

test('what the host wrote of instructions into a session is told by the session\'s own messages: a load by the paths it names, an update by its type', () => {
  // OpenCode 2.3.0 through 2.4.1, after the native read tool read a file below a directory that holds one, and
  // after a source changed while the session ran.
  const load = { id: 'msg_load', type: 'synthetic', text: 'Instructions from: /work/sub/AGENTS.md\nNESTED', description: 'Loaded sub/AGENTS.md', metadata: { instruction: { paths: ['/work/sub/AGENTS.md'] } } };
  const update = { id: 'msg_update', type: 'system', text: 'Instructions from: /work/AGENTS.md\nCHANGED' };
  assert.deepEqual([isInstructionLoad(load), isInstructionUpdate(load), isInstructionLoad(update), isInstructionUpdate(update)], [true, false, false, true]);
  for (const other of [undefined, {}, { type: 'synthetic', text: load.text }, { ...load, metadata: {} }, { ...load, metadata: { instruction: {} } }, { ...load, metadata: { instruction: { paths: [] } } },
    { ...load, metadata: { instruction: { paths: [''] } } }, { ...load, metadata: { instruction: { paths: [1] } } }, { ...load, metadata: { instruction: { paths: '/work/sub/AGENTS.md' } } }, { ...load, metadata: { azpr: {} } },
    // Not the host's, whatever it carries: no ID to know it by, a person's message, an assistant's, or what a request holds of it.
    { ...load, id: undefined }, { ...load, id: '' }, { ...load, id: 7 }, { ...load, type: 'user' }, { ...load, type: 'assistant' },
    { id: 'msg_load', role: 'user', content: load.text, metadata: load.metadata }, { ...update, id: undefined }, { ...update, id: '' }, { ...update, text: undefined },
    { role: 'system', content: [{ type: 'text', text: update.text }] }]) {
    assert.deepEqual([isInstructionLoad(other), isInstructionUpdate(other)], [false, false], JSON.stringify(other));
  }
});

test('a request loses what the host wrote of instructions by the session\'s own record, and proves that its model saw none of it only where it is the session\'s messages one for one', () => {
  // What a session holds, and what OpenCode makes of it in a request: every user message has the ID of the
  // message it was made of, and an update is a system message of its text as one part, without an ID.
  const stored = [{ id: 'msg_prompt', type: 'user', text: 'PROMPT' }, { id: 'msg_step', type: 'assistant', content: [] },
    { id: 'msg_load', type: 'synthetic', text: 'Instructions from: /work/sub/CLAUDE.md\nNESTED', metadata: { instruction: { paths: ['/work/sub/CLAUDE.md'] } } },
    { id: 'msg_update', type: 'system', text: 'Instructions from: /work/AGENTS.md\nCHANGED' }, { id: 'msg_notice', type: 'synthetic', text: 'a notice', metadata: { source: 'shell', shellID: 'sh_1', state: 'completed' } }];
  const prompt = { id: 'msg_prompt', role: 'user', content: [{ type: 'text', text: 'PROMPT' }] }, step = { id: 'msg_step', role: 'assistant', content: [] };
  const load = { id: 'msg_load', role: 'user', content: stored[2].text, metadata: stored[2].metadata }, update = { role: 'system', content: [{ type: 'text', text: stored[3].text }] };
  const notice = { id: 'msg_notice', role: 'user', content: 'a notice', metadata: stored[4].metadata }, effort = { role: 'system', content: [{ type: 'effort', effort: 'high', previous: 'low' }] };
  const requested = [prompt, step, load, update, notice, effort];
  const frozen = JSON.stringify(requested);
  assert.deepEqual(withoutHostMessages(requested, stored), { messages: [prompt, step, notice, effort], hidden: ['msg_load', 'msg_update'], trusted: true });
  assert.equal(JSON.stringify(requested), frozen, 'The request that was handed over is not changed.');
  // A session without such messages: nothing is taken out, and the request is the session's own.
  assert.deepEqual(withoutHostMessages([prompt, step], stored.slice(0, 2)), { messages: [prompt, step], hidden: [], trusted: true });
  // A load is known by the session's record, whatever a hook before this one made of it in the request: without
  // its metadata, or as another role, it is taken out all the same.
  for (const [name, rewritten] of [['its metadata taken away', { id: 'msg_load', role: 'user', content: load.content }], ['another role', { ...load, role: 'assistant' }]]) {
    const result = withoutHostMessages([prompt, step, rewritten, update, notice], stored);
    assert.deepEqual([result.messages, result.hidden, result.trusted], [[prompt, step, notice], ['msg_load', 'msg_update'], true], name);
  }
  // No proof where the request is not the session's messages one for one: a user message without an ID, with an
  // ID the session does not have, or twice; a load that is not among the request's messages (it may have been
  // joined to another message, under that message's ID); an update that is not there in the host's form.
  const joined = { ...prompt, content: [{ type: 'text', text: `PROMPT\n\n${load.content}` }] };
  for (const [name, messages, shown, hidden] of [
    ['a user message without an ID', [prompt, step, { role: 'user', content: 'who knows' }, load, update, notice], 4, ['msg_load', 'msg_update']],
    ['a user message of another ID', [prompt, step, { ...notice, id: 'msg_invented' }, load, update], 3, ['msg_load', 'msg_update']],
    ['a user message twice', [prompt, step, load, update, notice, notice], 4, ['msg_load', 'msg_update']],
    ['a load joined to the message before it', [joined, step, update, notice], 3, ['msg_update']],
    ['a load that is not there', [prompt, step, update, notice], 3, ['msg_update']],
    ['an update written as a plain string', [prompt, step, load, { role: 'system', content: stored[3].text }, notice], 4, ['msg_load']],
    ['an update with another text', [prompt, step, load, { role: 'system', content: [{ type: 'text', text: 'something else' }] }, notice], 4, ['msg_load']],
    ['an update that is not there', [prompt, step, load, notice], 3, ['msg_load']],
  ]) {
    const result = withoutHostMessages(messages, stored);
    assert.deepEqual([result.trusted, result.messages.length, result.hidden], [false, shown, hidden], name);
  }
  // Another hook's own system message stays, also in the host's form, where the session holds no update of that
  // text; and of two updates with one text, each stored one answers for one message.
  const directive = { role: 'system', content: [{ type: 'text', text: 'Answer briefly.' }] };
  assert.deepEqual(withoutHostMessages([prompt, step, load, update, directive, notice], stored).messages, [prompt, step, directive, notice]);
  const twice = [...stored, { id: 'msg_update_2', type: 'system', text: stored[3].text }];
  assert.deepEqual([withoutHostMessages([prompt, step, load, update, update, update, notice], twice).messages.length, withoutHostMessages([prompt, step, load, update, update, notice], twice).hidden,
    withoutHostMessages([prompt, step, load, update, notice], twice).trusted], [4, ['msg_load', 'msg_update', 'msg_update_2'], false]);
});

test('where a turn stands is told by the session\'s messages: before its prompt is one of them, running, or ended at the first idle marker after it', () => {
  const prompt = { id: 'msg_prompt', type: 'user', text: 'PROMPT' }, answer = { id: 'msg_answer', type: 'assistant' }, idle = id => ({ id, type: 'idle', outcome: 'succeeded' });
  const earlier = [{ id: 'msg_first', type: 'user', text: 'FIRST' }, { id: 'msg_first_answer', type: 'assistant' }, idle('msg_idle_1')];
  for (const [messages, state] of [
    [[], 'before'], [earlier, 'before'], [[...earlier, { id: 'msg_notice', type: 'synthetic', text: 'woke the session' }, { id: 'msg_idle_w', type: 'idle', outcome: 'failed' }], 'before'],
    [[...earlier, prompt], 'running'], [[...earlier, prompt, answer], 'running'], [[...earlier, prompt, answer, { id: 'msg_notice', type: 'synthetic', text: 'reached it while it went idle' }, answer], 'running'],
    [[...earlier, prompt, answer, idle('msg_idle_2')], 'ended'], [[...earlier, prompt, { id: 'msg_idle_2', type: 'idle', outcome: 'interrupted' }], 'ended'],
    [[...earlier, prompt, answer, idle('msg_idle_2'), { id: 'msg_notice', type: 'synthetic', text: 'woke it' }], 'ended'],
  ]) assert.equal(turnState(messages, 'msg_prompt'), state, JSON.stringify(messages.map(message => message.id)));
  // A host that does not say which message the prompt became: the turn is never known to have begun.
  for (const id of [undefined, '', 7]) assert.equal(turnState([...earlier, prompt, answer], id), 'before');
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
