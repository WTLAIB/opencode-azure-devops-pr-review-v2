import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { validateSettings } from '../src/config.mjs';
import { hostCapabilities, isHostContinuation, listOf, recordOf, sessionProgress, tokenUsage, usageTotals, HOST_CONTINUATION_TEXT, TESTED_HOST_VERSION } from '../src/host.mjs';

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
  const capabilities = hostCapabilities({ app: { version: '2.1.2' }, permission: { hook() {} }, tool: { transform() {} } });
  assert.equal(capabilities.tested, true);
  assert.equal(TESTED_HOST_VERSION, '2.1.2');
  for (const version of ['2.0.32', '2.1.1', '2.1.3']) assert.equal(hostCapabilities({ app: { version } }).tested, false, version);
  assert.equal(capabilities.permissionHook, true);
  assert.equal(capabilities.toolTransform, true);
  assert.equal(capabilities.eventSubscribe, false);
  assert.equal(hostCapabilities({ event: { subscribe() {} } }).eventSubscribe, true);
  assert.equal(hostCapabilities({}).version, 'unknown');
  const errored = { type: 'assistant', error: { type: 'provider.api' }, retry: { attempt: 1 } };
  assert.equal(isHostContinuation({ type: 'synthetic', text: HOST_CONTINUATION_TEXT }), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, errored), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, { type: 'assistant' }), false);
  assert.equal(isHostContinuation({ type: 'user', text: HOST_CONTINUATION_TEXT }), false);
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
});
