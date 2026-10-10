import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_TOOL_NAMES, reviewToolDefinitions, resolveVersion, renderDiff, renderFile, renderListing, renderThreads, runReviewTool, READ_LINES } from '../src/review-tools.mjs';
import { zipFiles } from './fake-azure.mjs';

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
    ['azpr_read_file', { path: ' ' }, /path must be a repository path/],
    ['azpr_read_file', { path: '/a', startLine: 0 }, /startLine must be a positive integer/],
    ['azpr_read_file', { path: '/a', startLine: 5, endLine: 2 }, /endLine must not be smaller/],
    ['azpr_list_files', { recursive: 'yes' }, /recursive must be true or false/],
    ['azpr_pr_threads', { threadId: -1 }, /threadId must be a positive integer/],
    ['azpr_unknown', {}, /Unknown AZPR tool/],
  ]) await assert.rejects(runReviewTool(name, input, context), message);
  const read = await runReviewTool('azpr_read_file', { path: 'src/a.ts', version: 'base' }, { ...context, azure: { readFile: async (_run, _snapshot, path, version) => ({ path, version, text: 'x\n', size: 2 }) } });
  assert.deepEqual(read.observation, { path: '/src/a.ts', version: snapshot.base, text: 'x\n' });
  // Optional arguments sent as null or blank text count as not given.
  const listed = [];
  const lenient = { ...context, azure: { readFile: async (_run, _snapshot, path, version) => ({ path, version, text: 'x\n', size: 2 }), threads: async () => [],
    listItems: async (_run, _snapshot, path, version, recursive) => { listed.push([path, version, recursive]); return []; } } };
  assert.match((await runReviewTool('azpr_read_file', { path: '/a', version: '', startLine: null, endLine: null }, lenient)).text, /^\/a at HEAD/);
  await runReviewTool('azpr_list_files', { path: '', version: null, recursive: null }, lenient);
  await runReviewTool('azpr_find_files', { pattern: '*.py', path: ' ' }, lenient);
  assert.deepEqual(listed, [['/', snapshot.head, false], ['/', snapshot.head, true]]);
  assert.match((await runReviewTool('azpr_pr_threads', { path: '', threadId: null }, lenient)).text, /^0 live thread\(s\)\./);
});

test('diffs show both sides of every change and whole content for added or deleted files', async () => {
  const sources = {
    [`${snapshot.base}:/src/a.ts`]: 'function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}\n',
    [`${snapshot.head}:/src/a.ts`]: 'function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.qty;\n  return sum;\n}\n',
    [`${snapshot.head}:/src/new.ts`]: 'export const flag = true;\n',
    [`${snapshot.base}:/src/old.ts`]: 'export const legacy = 1;\nexport const more = 2;\n',
    [`${snapshot.base}:/src/before.ts`]: 'a\nb\n', [`${snapshot.head}:/src/after.ts`]: 'a\nB\n',
    [`${snapshot.base}:/src/same.ts`]: 'x\n', [`${snapshot.head}:/src/same.ts`]: 'x\n',
  };
  const reads = [];
  const azure = { readFile: async (_run, _snapshot, path, version) => {
    reads.push(`${version.slice(0, 1)}:${path}`);
    if (path === '/src/image.png') return { path, version, binary: true, size: 40 };
    const text = sources[`${version}:${path}`];
    if (text === undefined) throw Object.assign(new Error('missing'), { kind: 'not-found' });
    return { path, version, text, size: text.length };
  } };
  const changes = [{ path: '/src/a.ts', changeType: ['edit'] }, { path: '/src/new.ts', changeType: ['add'] }, { path: '/src/old.ts', changeType: ['delete'] },
    { path: '/src/after.ts', changeType: ['rename', 'edit'], originalPath: '/src/before.ts' }, { path: '/src/image.png', changeType: ['edit'] }];
  const context = { azure, run: {}, snapshot: { ...snapshot, changes } };
  const edit = await runReviewTool('azpr_read_diff', { path: '/src/a.ts' }, context);
  assert.match(edit.text, /^\/src\/a\.ts — BASE aaaaaaaaaaaa → HEAD bbbbbbbbbbbb \(edit\): 1 hunk\(s\); BASE 5 lines, HEAD 5 lines\./);
  assert.match(edit.text, /\n- 3   \|   for \(const item of items\) sum \+= item\.price;\n\+   3 \|   for \(const item of items\) sum \+= item\.price \* item\.qty;\n/);
  assert.deepEqual(edit.observation, { path: '/src/a.ts', version: snapshot.head, text: sources[`${snapshot.head}:/src/a.ts`] }, 'HEAD text stays available for comment anchors.');
  reads.length = 0;
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/new.ts' }, context)).text, /\(add\): the whole file \(1 lines\) is new in HEAD\.[\s\S]*\n\+   1 \| export const flag = true;$/);
  assert.deepEqual(reads, ['b:/src/new.ts'], 'An added file has no BASE to read.');
  const deleted = await runReviewTool('azpr_read_diff', { path: '/src/old.ts' }, context);
  assert.match(deleted.text, /\(delete\): the whole file \(2 lines\) exists only in BASE\.[\s\S]*\n- 1   \| export const legacy = 1;\n- 2   \| export const more = 2;$/);
  assert.equal(deleted.observation, undefined);
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/after.ts' }, context)).text, /\(rename, edit from \/src\/before\.ts\): 1 hunk/);
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/same.ts' }, context)).text, /\(not in the PR's changed files\): no differences between BASE and HEAD\./);
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/image.png' }, context)).text, /binary at BASE; no diff is shown\./);
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/gone.ts' }, context)).text, /the file exists in neither version\./);
  await assert.rejects(runReviewTool('azpr_read_diff', { path: '/src/a.ts', context: 99 }, context), /context must be an integer from 0 to 50/);
  await assert.rejects(runReviewTool('azpr_read_diff', { path: '/src/a.ts', fromHunk: 0 }, context), /fromHunk must be a positive integer/);
  // Many hunks are paged by characters.
  const many = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'z'.repeat(40)}`);
  sources[`${snapshot.base}:/src/big.ts`] = many.join('\n');
  sources[`${snapshot.head}:/src/big.ts`] = many.map((line, i) => i % 20 === 0 ? `${line} changed${i}` : line).join('\n');
  const first = await runReviewTool('azpr_read_diff', { path: '/src/big.ts' }, context);
  const next = Number(/call again with fromHunk (\d+)\./.exec(first.text)[1]);
  assert.ok(first.text.length < 65000 && next > 1);
  assert.match((await runReviewTool('azpr_read_diff', { path: '/src/big.ts', fromHunk: next }, context)).text, new RegExp(`@@ #${next} BASE ${(next - 1) * 20 - 4}-`));
  // The same edit repeated through a file is folded and explained.
  sources[`${snapshot.head}:/src/big.ts`] = many.map((line, i) => i % 20 === 0 ? `${line} changed` : line).join('\n');
  context.run = {};
  const repeated = (await runReviewTool('azpr_read_diff', { path: '/src/big.ts' }, context)).text;
  assert.match(repeated, /: 200 hunk\(s\), 199 folded;/);
  assert.match(repeated, /199 hunk\(s\) repeat an earlier change and are folded to one line/);
  assert.match(repeated, /\n@@ #2 BASE 21-21 → HEAD 21-21 @@ folded: 2 changed line\(s\) repeating #1 with 0→20, 0→20\n/);
  assert.ok(repeated.length < 30000);
});

test('content search covers unchanged files at one commit, filtered by folder or glob', async () => {
  const archives = [];
  const trees = {
    [snapshot.head]: [['src/parse.py', 'def parse(value):\n    return MutableSequence(value)\n'], ['src/util.py', 'from collections.abc import MutableSequence\n'], ['tests/test_parse.py', 'def test_parse():\n    assert parse([1]) == [1]\n']],
    [snapshot.base]: [['src/parse.py', 'def parse(value):\n    return list(value)\n']],
  };
  const azure = { archive: async (_run, _snapshot, version) => { archives.push(version); return { bytes: zipFiles(trees[version]) }; } };
  const context = { azure, run: {}, snapshot };
  const search = async args => (await runReviewTool('azpr_search_code', args, context)).text;
  assert.equal(await search({ query: 'MutableSequence' }),
    `2 match(es) for "MutableSequence" in 2 file(s) (searched 3 text file(s) at HEAD (PR source) ${'b'.repeat(12)}).\n/src/parse.py:2: return MutableSequence(value)\n/src/util.py:1: from collections.abc import MutableSequence`);
  assert.match(await search({ query: 'parse(', path: '/tests' }), /^2 match\(es\)[\s\S]*\/tests\/test_parse\.py:1: def test_parse\(\):/);
  assert.match(await search({ query: 'parse(', path: '/tests', wholeWord: true }), /^1 match\(es\) for "parse\(" in 1 file\(s\) \(searched 1 text file\(s\)[\s\S]*\n\/tests\/test_parse\.py:2: assert parse\(\[1\]\) == \[1\]$/);
  assert.match(await search({ query: 'def ', path: 'test_*.py' }), /^1 match\(es\)[\s\S]*\/tests\/test_parse\.py:1: def test_parse\(\):$/);
  assert.match(await search({ query: 'MutableSequence', path: '', caseSensitive: null }), /^2 match\(es\) for "MutableSequence" in 2 file\(s\) \(searched 3 text/, 'A blank path searches everything.');
  assert.match(await search({ query: 'mutablesequence', caseSensitive: true }), /^No match for "mutablesequence" in 3 text file\(s\) at HEAD[^.]*\. Try a shorter or different name/);
  assert.match(await search({ query: 'MutableSequence', version: 'BASE' }), /^No match for "MutableSequence" in 1 text file\(s\) at BASE \(merge base\) a{12}\./, 'BASE is searched in its own archive.');
  await search({ query: 'parse' });
  assert.deepEqual(archives, [snapshot.head, snapshot.base], 'One archive per commit and run.');
  const unavailable = { azure: { archive: async () => ({ tooLarge: true, size: 123456789 }) }, run: {}, snapshot };
  assert.match((await runReviewTool('azpr_search_code', { query: 'parse' }, unavailable)).text,
    /^Content search is unavailable for this repository: the repository archive is larger than the azure\.archiveMegabytes setting allows \(123456789 bytes\)\. Find files with azpr_find_files/);
  const refused = { azure: { archive: async () => assert.fail('Invalid input reaches Azure DevOps.') }, run: {}, snapshot };
  for (const [args, message] of [[{}, /query must be literal text/], [{ query: ' x ' }, /query must be literal text/], [{ query: 'a\nb' }, /query must be literal text/], [{ query: 'x'.repeat(201) }, /query must be literal text/],
    [{ query: 'parse', wholeWord: 'yes' }, /wholeWord must be true or false/], [{ query: 'parse', path: '/src\n/tests' }, /path must be a folder/], [{ query: 'parse', version: 'main' }, /version/]])
    await assert.rejects(runReviewTool('azpr_search_code', args, refused), message);
});

test('files are found by glob or plain text in one cached recursive listing', async () => {
  let listings = 0;
  const items = ['/', '/src', '/src/app.ts', '/src/config.ts', '/src/lib', '/src/lib/config.yml', '/src/lib/myconfig.ts', '/tests', '/tests/test_app.py', '/tests/unit/test_config.py', '/docs/Routing.md']
    .map(path => ({ path, isFolder: !/\.\w+$/.test(path) }));
  const azure = { listItems: async (run, _snapshot, path, version, recursive) => {
    assert.equal(recursive, true);
    const cache = run.listCache ??= new Map(), key = `${version}\n${path}`;
    if (!cache.has(key)) { listings++; cache.set(key, Promise.resolve(items)); }
    return cache.get(key);
  } };
  const context = { azure, run: {}, snapshot };
  const find = async (pattern, extra = {}) => (await runReviewTool('azpr_find_files', { pattern, ...extra }, context)).text.split('\n').slice(1);
  assert.deepEqual(await find('test_*.py'), ['/tests/test_app.py', '/tests/unit/test_config.py']);
  assert.deepEqual(await find('/src/**/config*'), ['/src/config.ts', '/src/lib/config.yml'], '"**/" spans whole folders only.');
  assert.deepEqual(await find('tests/*.py'), ['/tests/test_app.py']);
  assert.deepEqual(await find('routing'), ['/docs/Routing.md'], 'Plain text is a case-insensitive substring.');
  assert.deepEqual(await find('lib'), ['/src/lib/', '/src/lib/config.yml', '/src/lib/myconfig.ts']);
  assert.match((await runReviewTool('azpr_find_files', { pattern: '*.rs' }, context)).text, /^0 path\(s\) under \/ at HEAD \(PR source\) bbbbbbbbbbbb match "\*\.rs"\. Check the folder/);
  assert.equal(listings, 1, 'One recursive listing serves every search of the same folder and commit.');
  await assert.rejects(runReviewTool('azpr_find_files', { pattern: ' ' }, context), /pattern must be a glob/);
});

test('one oversized thread is cut inside instead of looping forever', () => {
  const long = [{ id: 7, comments: [{ content: 'x'.repeat(41000), author: { displayName: 'A' } }] }];
  const text = renderThreads(long, { threadId: 7 }).text;
  assert.ok(text.length < 41000);
  assert.match(text, /shortened: this thread is longer than AZPR shows/);
  const chatty = [{ id: 8, comments: Array.from({ length: 400 }, (_, i) => ({ content: `reply ${i} ${'y'.repeat(200)}`, author: { displayName: 'B' } })) }];
  const shown = JSON.parse(renderThreads(chatty, {}).text.split('\n').slice(1).join('\n'));
  assert.equal(shown.length, 1);
  assert.ok(shown[0].omittedComments > 0 && shown[0].comments.length > 0);
});

test('a single very long source line is bounded in reads and diffs', () => {
  const line = 'z'.repeat(2_200_000);
  const read = renderFile(file(`${line}\nnext\n`), { label: 'HEAD (PR source)' }).text;
  assert.ok(read.length < 61000);
  assert.match(read, /\[line 1 has 2200004 characters; the rest is not shown\. azpr_search_code shows any part of it/);
  assert.match(read, /lines 1-1 of 2\. Continue with startLine 2\./, 'Reading continues with the next line.');
  const diff = renderDiff({ path: '/min.js', change: { changeType: ['edit'] }, snapshot,
    base: { path: '/min.js', version: snapshot.base, text: 'short\n' }, head: { path: '/min.js', version: snapshot.head, text: `${line}\n` } });
  assert.ok(diff.length < 62000, `diff is ${diff.length} characters`);
});
