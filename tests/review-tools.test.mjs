import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_TOOL_NAMES, reviewToolDefinitions, resolveVersion, renderFile, renderListing, renderThreads, runReviewTool, READ_LINES } from '../src/review-tools.mjs';

const snapshot = { head: 'b'.repeat(40), base: 'a'.repeat(40), baseKind: 'merge-base' };
const file = (text, extra = {}) => ({ path: '/src/a.ts', version: snapshot.head, text, size: text.length, ...extra });

test('definitions are read-only tools with strict JSON schemas', () => {
  const definitions = reviewToolDefinitions();
  assert.deepEqual(definitions.map(tool => tool.name), [...REVIEW_TOOL_NAMES]);
  for (const tool of definitions) {
    assert.equal(tool.input.type, 'object');
    assert.equal(tool.input.additionalProperties, false);
    assert.ok(tool.description.length > 20);
  }
  assert.deepEqual(definitions[0].input.required, ['path']);
});

test('versions resolve to the snapshot; anything else is refused', () => {
  assert.deepEqual(resolveVersion(undefined, snapshot), { sha: snapshot.head, label: 'HEAD (PR source)' });
  assert.deepEqual(resolveVersion('BASE', snapshot), { sha: snapshot.base, label: 'BASE (merge base)' });
  assert.deepEqual(resolveVersion('A'.repeat(40), snapshot), { sha: snapshot.base, label: 'BASE (merge base)' });
  assert.equal(resolveVersion('c'.repeat(40), snapshot).label, 'commit');
  assert.equal(resolveVersion('base', { ...snapshot, baseKind: 'target' }).label, 'BASE (target branch)');
  for (const bad of ['main', 'abc123', 42]) assert.throws(() => resolveVersion(bad, snapshot), /version/);
});

test('file reads are numbered with real line numbers and bounded by lines and characters', () => {
  const long = Array.from({ length: READ_LINES + 5 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const first = renderFile(file(long), { label: 'HEAD (PR source)' }).text;
  assert.match(first, new RegExp(`lines 1-${READ_LINES} of ${READ_LINES + 5}\\. Continue with startLine ${READ_LINES + 1}\\.`));
  assert.match(first, /\n1 \| l1\n2 \| l2\n/);
  assert.match(renderFile(file(long), { label: 'x', startLine: READ_LINES + 4 }).text, /lines 1004-1005 of 1005\.\n[\s\S]*1005 \| l1005$/);
  assert.match(renderFile(file('a\r\nb\r\n'), { label: 'x' }).text, /lines 1-2 of 2\.\n[\s\S]*1 \| a\n2 \| b$/);
  assert.match(renderFile(file(''), { label: 'x' }).text, /is empty\./);
  assert.match(renderFile(file('a\n'), { label: 'x', startLine: 5 }).text, /has 1 lines; startLine 5 is past the end/);
  const wide = Array.from({ length: 50 }, () => 'y'.repeat(2000)).join('\n');
  const bounded = renderFile(file(wide), { label: 'x' }).text;
  assert.ok(bounded.length < 65000);
  assert.match(bounded, /lines 1-29 of 50\. Continue with startLine 30\./);
  assert.match(renderFile(file('', { text: undefined, binary: true, size: 9 }), { label: 'x' }).text, /binary file \(9 bytes\)/);
});

test('listings and threads are compact, sorted and exclude deleted or system comments', () => {
  const listing = renderListing([{ path: '/src', isFolder: true }, { path: '/src/b.ts' }, { path: '/src/a', isFolder: true }], { path: '/src', label: 'HEAD', version: snapshot.head }).text;
  assert.equal(listing, `/src at HEAD ${'b'.repeat(12)} — 2 entries.\n/src/a/\n/src/b.ts`);
  const threads = [
    { id: 1, status: 'active', threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 3 }, rightFileEnd: { line: 4 } },
      comments: [{ content: 'Real note <!-- azpr-comment:' + 'f'.repeat(32) + ' -->', commentType: 'text', author: { displayName: 'Ann' } }, { content: 'voted', commentType: 'system' }] },
    { id: 2, isDeleted: true, comments: [{ content: 'gone' }] },
    { id: 3, comments: [{ content: 'removed', isDeleted: true }] },
    { id: 4, status: 'fixed', comments: [{ content: 'z'.repeat(3000), commentType: 'text' }] },
  ];
  const all = renderThreads(threads, {}).text;
  assert.match(all, /^2 live thread\(s\)\./);
  const rows = JSON.parse(all.slice(all.indexOf('\n') + 1));
  assert.deepEqual(rows[0], { threadId: 1, status: 'active', path: '/src/a.ts', startLine: 3, endLine: 4, side: 'right', azpr: true, comments: [{ author: 'Ann', published: null, content: 'Real note' }] });
  assert.match(rows[1].comments[0].content, /shortened; read threadId 4 for the full text\]$/);
  assert.equal(JSON.parse(renderThreads(threads, { threadId: 4 }).text.split('\n').slice(1).join('\n'))[0].comments[0].content.length, 3000);
  assert.match(renderThreads(threads, { path: '/src/a.ts' }).text, /^1 live thread\(s\) on \/src\/a\.ts\./);
  assert.match(renderThreads(threads, { threadId: 2 }).text, /Thread 2 does not exist on this PR or has no live comments/);
});

test('tool arguments are validated before any Azure call', async () => {
  const azure = { readFile: async () => { throw new Error('must not be called'); }, listItems: async () => [], threads: async () => [] };
  const context = { azure, run: {}, snapshot };
  for (const [name, input, message] of [
    ['azpr_read_file', {}, /path must be a repository path/],
    ['azpr_read_file', { path: '/a', startLine: 0 }, /startLine must be a positive integer/],
    ['azpr_read_file', { path: '/a', startLine: 5, endLine: 2 }, /endLine must not be smaller/],
    ['azpr_list_files', { recursive: 'yes' }, /recursive must be true or false/],
    ['azpr_pr_threads', { threadId: -1 }, /threadId must be a positive integer/],
    ['azpr_unknown', {}, /Unknown AZPR tool/],
  ]) await assert.rejects(runReviewTool(name, input, context), message);
  const read = await runReviewTool('azpr_read_file', { path: 'src/a.ts', version: 'base' }, { ...context, azure: { readFile: async (_run, _snapshot, path, version) => ({ path, version, text: 'x\n', size: 2 }) } });
  assert.deepEqual(read.observation, { path: '/src/a.ts', version: snapshot.base, text: 'x\n' });
});
