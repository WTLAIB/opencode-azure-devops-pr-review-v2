import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURE_TOOLS, buildSnapshot, changeTypes, createAzureClient, decodeToolResult, markersInThreads, parsePullRequestUrl,
  prStatus, selectAzureServer, targetKey, transientAzureError, toolText,
} from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { fakeAzure } from './fake-azure.mjs';

const target = parsePullRequestUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/123');
const pr = (extra = {}) => ({
  pullRequestId: 123, status: 1, title: 'T', description: 'D', url: 'https://dev.azure.com/org/pid/_apis/git/repositories/rid/pullRequests/123',
  repository: { id: 'rid', name: 'repo', project: { id: 'pid', name: 'proj' } },
  lastMergeSourceCommit: { commitId: 'B'.repeat(40) }, lastMergeTargetCommit: { commitId: 'a'.repeat(40) },
  changedFilesSummary: { changeEntries: [
    { changeType: 2, item: { path: '/src/a.ts' } },
    { changeType: 'delete', item: { path: 'src/gone.ts' } },
    { changeType: 10, item: { path: '/src/new.ts' }, originalPath: '/src/old.ts' },
    { changeType: 1, item: { path: '/src', isFolder: true } },
    { changeType: 2, item: { path: '/src/a.ts' } },
  ], fileCount: 5 },
  ...extra,
});

test('snapshot comes from one PR read: identity, lowercased SHAs, normalized unique paths and change types', () => {
  const snapshot = buildSnapshot(pr(), target);
  assert.equal(snapshot.head, 'b'.repeat(40));
  assert.equal(snapshot.repositoryId, 'rid');
  assert.equal(snapshot.projectId, 'pid');
  assert.equal(snapshot.status, 'active');
  assert.deepEqual(snapshot.files, ['/src/a.ts', '/src/gone.ts', '/src/new.ts']);
  assert.deepEqual(snapshot.changes[2], { path: '/src/new.ts', changeType: ['edit', 'rename'], originalPath: '/src/old.ts' });
  assert.equal(snapshot.filesComplete, true);
  assert.equal(buildSnapshot(pr({ changedFilesSummary: { changeEntries: [], nextSkip: 100, nextTop: 100 } }), target).filesComplete, false);
  assert.equal(buildSnapshot(pr({ changedFilesSummary: {} }), target).filesComplete, false);
});

test('snapshot refuses a different PR, a missing merge evaluation or another organization', () => {
  assert.throws(() => buildSnapshot(pr({ pullRequestId: 9 }), target), /returned PR 9/);
  assert.throws(() => buildSnapshot(pr({ lastMergeSourceCommit: undefined }), target), /no source\/target commit yet/);
  assert.throws(() => buildSnapshot(pr({ url: 'https://dev.azure.com/other/pid/_apis/git/repositories/rid/pullRequests/123' }), target), /organization "other"/);
  assert.throws(() => buildSnapshot(null, target), /no pull request object/);
});

test('enum helpers understand numeric and string forms', () => {
  assert.deepEqual(changeTypes(18), ['edit', 'delete']);
  assert.deepEqual(changeTypes('rename, edit'), ['rename', 'edit']);
  assert.equal(prStatus(3), 'completed');
  assert.equal(prStatus('Abandoned'), 'abandoned');
  assert.equal(targetKey(target), targetKey(parsePullRequestUrl('https://dev.azure.com/ORG/Proj/_git/REPO/pullrequest/123')));
});

test('server selection finds the one Azure namespace, honours mcpServer and requires codemode:false', () => {
  const tools = (namespace, codemode = false) => Object.values(AZURE_TOOLS).map(name => ({ id: `${namespace}_${name}`, name, namespace, codemode, execute() {} }));
  assert.equal(selectAzureServer(tools('ado')).namespace, 'ado');
  assert.throws(() => selectAzureServer([]), /No connected MCP server exposes Azure DevOps/);
  assert.throws(() => selectAzureServer([...tools('a'), ...tools('b')]), /Set "mcpServer"/);
  assert.equal(selectAzureServer([...tools('a'), ...tools('my_ado')], 'my.ado').namespace, 'my_ado');
  assert.throws(() => selectAzureServer(tools('a'), 'missing'), /does not expose/);
  assert.throws(() => selectAzureServer(tools('ado').slice(0, 1)), /lacks/);
  assert.throws(() => selectAzureServer(tools('ado', true)), /codemode:false/);
});

test('tool results decode JSON text and keep plain text', () => {
  assert.deepEqual(decodeToolResult({ output: { a: 1 } }), { a: 1 });
  assert.deepEqual(decodeToolResult({ output: '[1,2]' }), [1, 2]);
  assert.equal(decodeToolResult({ output: 'source\ntext' }), 'source\ntext');
  assert.deepEqual(decodeToolResult({ output: null, content: [{ type: 'text', text: '{"b":2}' }] }), { b: 2 });
});

test('markers are found in live comments only', () => {
  const marker = '<!-- azpr-comment:' + 'a'.repeat(32) + ' -->';
  const found = markersInThreads([
    { id: 1, comments: [{ content: `text\n\n${marker}` }] },
    { id: 2, isDeleted: true, comments: [{ content: '<!-- azpr-comment:' + 'b'.repeat(32) + ' -->' }] },
    { id: 3, comments: [{ isDeleted: true, content: '<!-- azpr-comment:' + 'c'.repeat(32) + ' -->' }] },
  ]);
  assert.deepEqual([...found], [[marker, 1]]);
});

function client(azure, options = {}) {
  const tools = new Map(azure.definitions().map(tool => [tool.name, { ...tool, namespace: 'ado' }]));
  const queue = createToolQueue({ concurrency: 2, timeoutMs: options.timeoutMs ?? 1000 });
  const run = { id: 'run1', runtimeSessionID: 'ses_runtime', controller: new AbortController() };
  const records = [];
  return { run, records, api: createAzureClient({ server: () => ({ namespace: 'ado', tools }), queue, agent: 'azpr-runtime', retryDelayMs: 1,
    onCall: (_run, record) => records.push(record) }) };
}

test('client reads the snapshot, pages threads to the end and creates exact threads', async () => {
  const azure = fakeAzure({ files: ['/src/Main.java'] });
  const { run, api } = client(azure);
  const snapshot = await api.snapshot(run, parsePullRequestUrl(azure.prUrl()));
  assert.equal(snapshot.prId, 123);
  assert.equal(azure.state.calls[0].execution.agent, 'azpr-runtime');
  assert.equal(azure.state.calls[0].execution.sessionID, 'ses_runtime');
  for (let i = 0; i < 205; i++) azure.state.threads.push({ id: i + 1, comments: [{ content: `c${i}` }] });
  const threads = await api.threads(run, snapshot);
  assert.equal(threads.length, 205);
  assert.deepEqual(azure.state.calls.filter(c => c.name === 'repo_pull_request_thread').map(c => [c.args.skip, c.args.top]), [[0, 1000]], 'One call fetches every thread.');
  for (let i = 205; i < 1500; i++) azure.state.threads.push({ id: i + 1, comments: [{ content: `c${i}` }] });
  assert.equal((await api.threads(run, snapshot)).length, 1500);
  assert.deepEqual(azure.state.calls.filter(c => c.name === 'repo_pull_request_thread').slice(1).map(c => c.args.skip), [0, 1000], 'A full page continues.');
  const created = await api.createThread(run, snapshot, { kind: 'inline', path: '/src/Main.java', startLine: 2, endLine: 2, startOffset: 1, endOffset: 4, content: 'Exact text' });
  assert.deepEqual(created, { threadId: 1000, contentMatches: true });
  const write = azure.state.calls.at(-1);
  assert.equal(write.args.rightFileStartLine, 2);
  assert.equal(write.args.filePath, '/src/Main.java');
  const summary = await api.createThread(run, snapshot, { kind: 'summary', content: 'Summary' });
  assert.equal(azure.state.calls.at(-1).args.filePath, undefined);
  assert.equal(summary.threadId, 1001);
  const versions = await api.versions(run, snapshot);
  assert.deepEqual(versions, { head: 'b'.repeat(40), base: 'a'.repeat(40), status: 'active' });
});

test('client errors name the tool; timeouts are uncertain; missing thread IDs are uncertain writes', async () => {
  const azure = fakeAzure();
  const { run, api } = client(azure, { timeoutMs: 50 });
  azure.state.fail.repo_pull_request = 'TF401180: The requested pull request was not found.';
  await assert.rejects(api.snapshot(run, parsePullRequestUrl(azure.prUrl())), error => /repo_pull_request failed: TF401180/.test(error.message) && error.uncertain === false);
  azure.state.fail.repo_pull_request = () => new Promise(() => {});
  await assert.rejects(api.snapshot(run, parsePullRequestUrl(azure.prUrl())), error => /failed after 3 attempts: .*did not finish within/.test(error.message) && error.uncertain === true);
  azure.state.fail.repo_pull_request_thread_write = () => ({ output: { comments: [] } });
  await assert.rejects(api.createThread(run, { repositoryId: 'rid', projectId: 'pid', prId: 123 }, { kind: 'summary', content: 'x' }), error => error.uncertain === true);
  azure.state.fail.repo_pull_request_thread = () => ({ output: 'not a list' });
  await assert.rejects(api.threads(run, { repositoryId: 'rid', projectId: 'pid', prId: 123 }), /unexpected response/);
});

test('transient read failures are retried; deterministic failures and writes are not', async () => {
  assert.equal(transientAzureError(new Error('Error with pull request thread operation: ')), true, 'An empty detail is a network-level failure.');
  assert.equal(transientAzureError(Object.assign(new Error('slow'), { timeout: true })), true);
  assert.equal(transientAzureError(new Error('read ECONNRESET')), true);
  for (const message of ['TF401180: The requested pull request was not found.', 'Request failed (403) Forbidden', 'repositoryId is required for get', 'No items found at path: /']) {
    assert.equal(transientAzureError(new Error(message)), false, message);
  }
  const azure = fakeAzure();
  const { run, api, records } = client(azure);
  const snapshot = { repositoryId: 'rid', projectId: 'pid', prId: 123 };
  let failures = 2;
  azure.state.fail.repo_pull_request_thread = () => { if (failures-- > 0) throw Object.assign(new Error('Error with pull request thread operation: '), { _tag: 'Tool.Error' }); };
  assert.deepEqual(await api.threads(run, snapshot), []);
  assert.equal(run.azureRetries, 2);
  assert.deepEqual(records.map(r => [r.tool, r.attempt, r.ok, r.willRetry ?? null]),
    [['repo_pull_request_thread', 1, false, true], ['repo_pull_request_thread', 2, false, true], ['repo_pull_request_thread', 3, true, null]]);
  assert.deepEqual(records[2].args, { action: 'list', pullRequestId: 123, top: 1000, skip: 0 });
  azure.state.fail.repo_pull_request_thread = 'TF401027: You need the Git permission.';
  const before = azure.state.calls.length;
  await assert.rejects(api.threads(run, snapshot), /TF401027/);
  assert.equal(azure.state.calls.length, before + 1, 'Permission errors are not retried.');
  let writes = 0;
  azure.state.fail.repo_pull_request_thread_write = () => { writes++; throw new Error('Error with pull request thread write operation: '); };
  await assert.rejects(api.createThread(run, snapshot, { kind: 'summary', content: 'x' }));
  assert.equal(writes, 1, 'Writes are never retried.');
  assert.equal(records.at(-1).args.contentCharacters, 1, 'Logs never contain comment bodies.');
});

test('file content keeps the literal text even when it looks like JSON', async () => {
  const azure = fakeAzure({ sources: { '/package.json': '{\n  "name": "x"\n}\n' } });
  const { run, api } = client(azure);
  azure.state.fail.repo_file = args => ({ output: JSON.parse(azure.state.sources[args.path]), content: [{ type: 'text', text: azure.state.sources[args.path] }] });
  assert.equal(await api.fileContent(run, { repositoryId: 'rid', projectId: 'pid', prId: 123 }, '/package.json', 'b'.repeat(40)), '{\n  "name": "x"\n}\n');
  assert.equal(toolText({ output: { a: 1 } }), '{"a":1}');
});
