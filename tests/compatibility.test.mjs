import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { PACKAGE_NAME, REPOSITORY, validateSettings } from '../src/config.mjs';
import { hostCapabilities, isHostContinuation, listOf, packageNamed, pluginEntries, pluginSourceLabel, recordOf, sessionProgress, tokenUsage, usageTotals, withoutCredentials, HOST_CONTINUATION_TEXT, PROGRESS_EVENT_TYPES, TESTED_HOST_VERSION } from '../src/host.mjs';

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
  s.models = { review: { functional: 'fixture/a', risk: 'fixture/b', verifier: 'fixture/c' } };
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

test('host helpers normalize response shapes and detect capabilities', () => {
  assert.deepEqual(listOf({ data: [1] }), [1]);
  assert.deepEqual(listOf([2]), [2]);
  assert.equal(listOf({}), null);
  assert.deepEqual(recordOf({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(recordOf({ a: 1 }), { a: 1 });
  const capabilities = hostCapabilities({ app: { version: '2.2.4' }, permission: { hook() {} }, tool: { transform() {} } });
  assert.equal(capabilities.tested, true);
  assert.equal(TESTED_HOST_VERSION, '2.2.4');
  for (const version of ['2.0.32', '2.1.4', '2.2.3', '2.2.5']) assert.equal(hostCapabilities({ app: { version } }).tested, false, version);
  assert.equal(capabilities.permissionHook, true);
  assert.equal(capabilities.toolTransform, true);
  assert.equal(capabilities.eventSubscribe, false);
  assert.equal(hostCapabilities({ event: { subscribe() {} } }).eventSubscribe, true);
  assert.equal(hostCapabilities({}).version, 'unknown');
  assert.equal(hostCapabilities({}).pluginList, false);
  assert.equal(hostCapabilities({ plugin: { list() {} } }).pluginList, true);
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
