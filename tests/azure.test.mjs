import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  API_VERSION, buildSnapshot, changeTypes, createAzureClient, isBinary, latestIteration, markersInThreads, prStatus, prVersions, restBaseUrl,
} from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { fakeAzure, azureError, FAKE_PAT } from './fake-azure.mjs';

const target = { organization: 'org', project: 'proj', repository: 'repo', pullRequestId: 123 };
const H = 'A'.repeat(40), M = 'B'.repeat(40), T = 'C'.repeat(40);
const pr = (extra = {}) => ({ pullRequestId: 123, status: 'active', title: 'T', description: 'D', isDraft: false,
  repository: { id: 'rid', name: 'repo', project: { id: 'pid', name: 'proj' } },
  lastMergeSourceCommit: { commitId: H }, lastMergeTargetCommit: { commitId: T }, sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/main', ...extra });
const iterations = [{ id: 1, sourceRefCommit: { commitId: 'd'.repeat(40) }, commonRefCommit: { commitId: M } },
  { id: 2, sourceRefCommit: { commitId: H }, commonRefCommit: { commitId: M }, targetRefCommit: { commitId: T } }];
const run = () => ({ id: 'run1', controller: new AbortController() });
const client = (azure, options = {}) => createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 2, timeoutMs: options.timeoutMs ?? 2000 }),
  retryDelayMs: 1, fetch: options.fetch ?? azure.fetch, onCall: options.onCall, maxArchiveBytes: options.maxArchiveBytes });

test('snapshot: latest iteration head against its merge base, lowercased SHAs, normalized unique paths and change types', () => {
  const snapshot = buildSnapshot({ pr: pr(), iterations, complete: true, changes: [
    { changeTrackingId: 1, item: { path: '/src/a.ts' }, changeType: 'edit' },
    { changeTrackingId: 2, item: { path: 'src/b.ts' }, changeType: 'rename, edit', originalPath: '/src/old-b.ts' },
    { item: { path: '/src', isFolder: true, gitObjectType: 'tree' }, changeType: 'edit' },
    { item: { path: '/src/a.ts' }, changeType: 'edit' },
  ] }, target);
  assert.equal(snapshot.head, H.toLowerCase());
  assert.equal(snapshot.base, M.toLowerCase());
  assert.equal(snapshot.baseKind, 'merge-base');
  assert.equal(snapshot.iteration, 2);
  assert.deepEqual(snapshot.files, ['/src/a.ts', '/src/b.ts']);
  assert.deepEqual(snapshot.changes[1], { path: '/src/b.ts', changeType: ['rename', 'edit'], originalPath: '/src/old-b.ts' });
  assert.equal(snapshot.filesComplete, true);
  assert.deepEqual([snapshot.projectId, snapshot.repositoryId, snapshot.status], ['pid', 'rid', 'active']);
  assert.deepEqual(snapshot.snapshotWarnings, []);
});

test('snapshot warnings: no merge base falls back to the target tip; a lagging merge and multiple merge bases are named', () => {
  const noBase = buildSnapshot({ pr: pr({ lastMergeSourceCommit: { commitId: 'e'.repeat(40) }, hasMultipleMergeBases: true }),
    iterations: [{ id: 1, sourceRefCommit: { commitId: H } }], changes: [], complete: true }, target);
  assert.equal(noBase.base, T.toLowerCase());
  assert.equal(noBase.baseKind, 'target');
  assert.equal(noBase.snapshotWarnings.length, 3);
  assert.match(noBase.snapshotWarnings.join(' '), /not finished merging the latest push[\s\S]*no merge base[\s\S]*multiple merge bases/);
  assert.throws(() => buildSnapshot({ pr: pr({ pullRequestId: 9 }), iterations, changes: [], complete: true }, target), /returned PR 9 instead of 123/);
  assert.throws(() => buildSnapshot({ pr: pr({ lastMergeSourceCommit: null, lastMergeTargetCommit: null }), iterations: [], changes: [], complete: true }, target), /no source\/base commit yet/);
});

test('enum, iteration and binary helpers', () => {
  assert.deepEqual(changeTypes(2), ['edit']);
  assert.deepEqual(changeTypes(8 | 2), ['edit', 'rename']);
  assert.deepEqual(changeTypes('rename, edit'), ['rename', 'edit']);
  assert.equal(prStatus(1), 'active');
  assert.equal(prStatus('Completed'), 'completed');
  assert.equal(latestIteration([{ id: 3 }, { id: 7 }, { id: 5 }]).id, 7);
  assert.equal(latestIteration([]), null);
  assert.deepEqual(prVersions(pr(), iterations), { head: H.toLowerCase(), base: M.toLowerCase(), baseKind: 'merge-base', iteration: 2, status: 'active' });
  assert.equal(isBinary(Buffer.from('text\nonly')), false);
  assert.equal(isBinary(Buffer.from([0x47, 0x00, 0x48])), true);
});

test('markers are found in live comments only', () => {
  const marker = id => `<!-- azpr-comment:${id.repeat(32)} -->`;
  const found = markersInThreads([
    { id: 1, comments: [{ content: `a ${marker('a')}` }] },
    { id: 2, isDeleted: true, comments: [{ content: marker('b') }] },
    { id: 3, comments: [{ content: marker('c'), isDeleted: true }, { content: `${marker('d')}` }] },
  ]);
  assert.deepEqual([...found.entries()], [[marker('a'), 1], [marker('d'), 3]]);
});

test('base URL overrides are accepted only for loopback test servers', () => {
  assert.equal(restBaseUrl(), 'https://dev.azure.com');
  assert.equal(restBaseUrl('http://127.0.0.1:4100/'), 'http://127.0.0.1:4100');
  for (const bad of ['https://evil.example', 'http://10.0.0.1:80', 'http://user:p@127.0.0.1:1', 'ftp://127.0.0.1']) assert.throws(() => restBaseUrl(bad), /loopback test server/);
});

test('client: pinned api-version and Basic PAT, paged change list, threads and exact thread bodies', async () => {
  const azure = fakeAzure({ files: Array.from({ length: 2500 }, (_, i) => `/src/f${String(i).padStart(4, '0')}.ts`) });
  const c = client(azure), r = run();
  const snapshot = await c.snapshot(r, target);
  assert.equal(snapshot.files.length, 2500);
  assert.equal(snapshot.filesComplete, true);
  assert.deepEqual(azure.callsTo('changes').map(call => [call.query.$top, call.query.$skip]), [['2000', undefined], ['2000', '2000']]);
  assert.ok(azure.state.calls.every(call => call.query['api-version'] === API_VERSION));
  assert.equal(snapshot.base, azure.state.base);
  assert.deepEqual(await c.versions(r, snapshot), { head: azure.state.head, base: azure.state.base, baseKind: 'merge-base', iteration: 1, status: 'active' });
  const summary = await c.createThread(r, snapshot, { kind: 'summary', content: 'Summary <!-- azpr-comment:' + 'a'.repeat(32) + ' -->' });
  const inline = await c.createThread(r, snapshot, { kind: 'inline', path: '/src/f0001.ts', startLine: 2, startOffset: 1, endLine: 3, endOffset: 9, content: 'Inline' });
  assert.deepEqual([summary.contentMatches, inline.contentMatches], [true, true]);
  const [first, second] = azure.callsTo('createThread').map(call => call.body);
  assert.deepEqual(first, { comments: [{ parentCommentId: 0, content: 'Summary <!-- azpr-comment:' + 'a'.repeat(32) + ' -->', commentType: 1 }], status: 1 });
  assert.deepEqual(second.threadContext, { filePath: '/src/f0001.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 3, offset: 9 } });
  assert.equal(second.pullRequestThreadContext, undefined, 'Azure DevOps fills the iteration context itself.');
  assert.equal((await c.threads(r, snapshot)).length, 2);
  assert.equal(r.azureCalls, azure.state.calls.length);
});

test('client errors: a rejected PAT and not-found are permanent; 5xx, throttling and network failures retry reads only', async () => {
  const records = [];
  const azure = fakeAzure();
  const c = client(azure, { onCall: (_run, record) => records.push(record) });
  const r = run();
  const snapshot = await c.snapshot(r, target);

  azure.state.fail.threads = () => azureError(503, 'ServiceUnavailableException', 'Busy.');
  await assert.rejects(c.threads(r, snapshot), error => error.kind === 'server' && /HTTP 503 ServiceUnavailableException: Busy\.\) after 3 attempts\.$/.test(error.message));
  assert.equal(azure.callsTo('threads').length, 3);
  let throttled = 0;
  azure.state.fail.threads = () => (throttled++ ? undefined : { ...azureError(429, 'RequestBlockedException', 'Slow down.'), headers: { 'content-type': 'application/json', 'retry-after': '0' } });
  assert.equal((await c.threads(r, snapshot)).length, 0);
  delete azure.state.fail.threads;

  azure.state.fail.createThread = () => azureError(503, 'ServiceUnavailableException', 'Busy.');
  await assert.rejects(c.createThread(r, snapshot, { kind: 'summary', content: 'x' }), error => error.transient && !error.uncertain);
  assert.equal(azure.callsTo('createThread').length, 1, 'Writes are never retried.');
  delete azure.state.fail.createThread;

  await assert.rejects(c.fileContent(r, snapshot, '/missing.txt', snapshot.head), error => error.kind === 'not-found' && /HTTP 404 GitItemNotFoundException: TF401174/.test(error.message));
  assert.equal(azure.callsTo('items').length, 1);

  azure.state.pat = 'another-valid-token-0123456789abc';
  await assert.rejects(c.threads(r, snapshot), error => error.kind === 'auth' && /rejected the PAT for organization "org" \(HTTP 203\)/.test(error.message));
  assert.equal(azure.callsTo('threads').length, 6, 'Authentication failures are not retried.');
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes(FAKE_PAT) && !serialized.includes(Buffer.from(':' + FAKE_PAT).toString('base64')));
  assert.ok(records.some(record => record.call === 'PR threads' && record.status === 503 && record.willRetry === true));

  let failures = 0;
  const flaky = async (url, init) => {
    if (failures++ < 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return azure.fetch(url, init);
  };
  const d = client(azure, { fetch: flaky });
  azure.state.pat = FAKE_PAT;
  assert.equal((await d.threads(r, snapshot)).length, 0);
  failures = 0;
  await assert.rejects(d.createThread(r, snapshot, { kind: 'summary', content: 'x' }), error => error.kind === 'network' && error.uncertain === true);
});

test('client timeouts abort the request, retry reads and mark writes uncertain', async () => {
  const azure = fakeAzure();
  const c = client(azure, { timeoutMs: 30 });
  const r = run();
  const snapshot = await c.snapshot(r, target);
  let aborted = 0;
  const hang = (_call, _state) => new Promise(() => {});
  azure.state.fail.threads = hang;
  const original = azure.fetch;
  const watching = client(azure, { timeoutMs: 30, fetch: (url, init) => { init.signal.addEventListener('abort', () => aborted++); return original(url, init); } });
  await assert.rejects(watching.threads(r, snapshot), error => error.kind === 'timeout' && error.transient);
  assert.equal(aborted, 3, 'Each timed-out attempt aborts its HTTP request.');
  azure.state.fail.createThread = hang;
  await assert.rejects(c.createThread(r, snapshot, { kind: 'summary', content: 'x' }), error => error.kind === 'timeout' && error.uncertain === true);
});

test('file reads: exact text, binary detection, oversized files and a per-run cache', async () => {
  const azure = fakeAzure({ files: ['/a.json', '/logo.png'], binary: ['/logo.png'], sources: { '/a.json': '{"literal": true}\n' } });
  const c = client(azure), r = run();
  const snapshot = await c.snapshot(r, target);
  assert.equal(await c.fileContent(r, snapshot, '/a.json', snapshot.head), '{"literal": true}\n');
  assert.equal(await c.fileContent(r, snapshot, 'a.json', snapshot.head), '{"literal": true}\n');
  assert.equal(azure.callsTo('items').length, 1, 'The second read is served from the run cache.');
  const binary = await c.readFile(r, snapshot, '/logo.png', snapshot.head);
  assert.deepEqual([binary.binary, binary.size], [true, 8]);
  await assert.rejects(c.fileContent(r, snapshot, '/logo.png', snapshot.head), /binary file/);
  const big = client(azure, { fetch: async () => new Response('x', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(11 * 1024 * 1024) } }) });
  assert.equal((await big.readFile(run(), snapshot, '/a.json', snapshot.head)).tooLarge, true);
  const listing = await c.listItems(r, snapshot, '/', snapshot.head);
  assert.deepEqual(listing.map(item => item.path), ['/', '/a.json', '/logo.png']);
});

test('commits: messages reach the snapshot shortened; an unreadable list is a warning, not a failure', async () => {
  const long = 'Use list schema for bare MutableSequence\n\n' + 'detail '.repeat(200);
  const azure = fakeAzure({ commits: [{ commitId: 'c'.repeat(40), comment: long }, { commitId: 'd'.repeat(40), comment: 'Second', commentTruncated: true }, { commitId: 'e'.repeat(40), comment: '  ' }] });
  const snapshot = await client(azure).snapshot(run(), { ...target, organization: 'org' });
  assert.equal(snapshot.commits.length, 2, 'Empty messages are left out.');
  assert.equal(snapshot.commits[0].id, 'c'.repeat(12));
  assert.match(snapshot.commits[0].message, /^Use list schema for bare MutableSequence\n\ndetail [\s\S]* \[…\]$/);
  assert.ok(snapshot.commits[0].message.length < 620);
  assert.equal(snapshot.commits[1].message, 'Second […]');
  assert.equal(azure.callsTo('commits')[0].query.$top, '100');
  const failing = fakeAzure();
  failing.state.fail.commits = () => azureError(500, 'ServerException', 'boom');
  const degraded = await client(failing).snapshot(run(), target);
  assert.deepEqual(degraded.commits, []);
  assert.ok(degraded.snapshotWarnings.some(message => /commit list could not be read/.test(message)));
  assert.equal(failing.callsTo('commits').length, 3, 'A transient failure is retried like any read.');
});

test('repository archives download as zip at a commit and stop at the size limit without reading the rest', async () => {
  const azure = fakeAzure({ files: ['/src/a.ts'], sources: { '/src/a.ts': 'export const a = 1;\n' } });
  const snapshot = azure.snapshot();
  const archive = await client(azure).archive(run(), { projectId: 'pid', repositoryId: 'rid', ...snapshot }, snapshot.head);
  assert.ok(archive.bytes.length > 22);
  const [call] = azure.callsTo('items');
  assert.equal(call.query.$format, 'zip');
  assert.equal(call.query.recursionLevel, 'Full');
  assert.equal(call.query['versionDescriptor.version'], snapshot.head);
  let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(8 * 1024 * 1024)); } });
  const huge = await client(azure, { fetch: async () => new Response(endless, { status: 200, headers: { 'content-type': 'application/zip' } }) })
    .archive(run(), { projectId: 'pid', repositoryId: 'rid', ...snapshot }, snapshot.head);
  assert.equal(huge.tooLarge, true);
  assert.ok(pulled < 20, 'Reading stops right after the limit.');
  const capped = await client(azure, { maxArchiveBytes: 22 }).archive(run(), { projectId: 'pid', repositoryId: 'rid', ...snapshot }, snapshot.head);
  assert.equal(capped.tooLarge, true, 'The limit comes from azure.archiveMegabytes.');
});
