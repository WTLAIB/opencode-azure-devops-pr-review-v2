import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { validateSettings } from '../src/config.mjs';
import { hostCapabilities, isHostContinuation, listOf, recordOf, HOST_CONTINUATION_TEXT } from '../src/host.mjs';

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
  const capabilities = hostCapabilities({ app: { version: '2.0.22' }, permission: { hook() {} }, tool: { transform() {} } });
  assert.equal(capabilities.tested, true);
  assert.equal(capabilities.permissionHook, true);
  assert.equal(capabilities.toolTransform, true);
  assert.equal(hostCapabilities({}).version, 'unknown');
  const errored = { type: 'assistant', error: { type: 'provider.api' }, retry: { attempt: 1 } };
  assert.equal(isHostContinuation({ type: 'synthetic', text: HOST_CONTINUATION_TEXT }), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, errored), true);
  assert.equal(isHostContinuation({ type: 'synthetic', text: 'Stream interrupted, continue please.' }, { type: 'assistant' }), false);
  assert.equal(isHostContinuation({ type: 'user', text: HOST_CONTINUATION_TEXT }), false);
});
