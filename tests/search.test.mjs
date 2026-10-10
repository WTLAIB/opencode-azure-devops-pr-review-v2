import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readZip, repositoryArchive, searchArchive } from '../src/search.mjs';
import { zipFiles } from './fake-azure.mjs';

const repo = () => zipFiles([
  ['pydantic/_internal/_generate_schema.py', 'MAP = {\n    collections.abc.MutableSequence: lambda self, obj: self._sequence_schema(Any),\n    list: lambda self, obj: self._list_schema(Any),\n}\n'],
  ['tests/types/test_list.py', 'from collections.abc import MutableSequence\n\ndef test_bare_mutable_sequence():\n    ta = TypeAdapter(MutableSequence)\n'],
  ['docs/notes.md', 'mutablesequence is a word here\nImmutableSequenceX\n'],
  ['assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
  ['folder/', ''],
]);

test('zip archives yield text files under absolute paths; binary files are skipped', () => {
  const archive = readZip(repo());
  assert.deepEqual([...archive.files.keys()].sort(), ['/docs/notes.md', '/folder/', '/pydantic/_internal/_generate_schema.py', '/tests/types/test_list.py'].filter(path => !path.endsWith('/')));
  assert.equal(archive.skipped.binary, 1);
  const small = readZip(repo(), { fileBytes: 60, textBytes: 1e9, files: 100 });
  assert.equal(small.skipped.large, 2, 'Files over the per-file limit are not inflated.');
  const capped = readZip(repo(), { fileBytes: 1e6, textBytes: 150, files: 100 });
  assert.equal(capped.truncated, true);
});

test('damaged, ZIP64 and encrypted archives are refused with a reason', () => {
  assert.throws(() => readZip(Buffer.from('not a zip')), /not a zip file/);
  const zip64 = Buffer.from(repo());
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => readZip(zip64), /ZIP64/);
  const encrypted = Buffer.from(repo());
  const directory = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(0x0801, directory + 8);
  assert.throws(() => readZip(encrypted), /encrypted/);
});

test('search finds literal text case-insensitively by default, whole words on request, within a path filter', () => {
  const archive = readZip(repo());
  const all = searchArchive(archive, { query: 'MutableSequence' });
  assert.deepEqual(all.matches.map(match => `${match.path}:${match.line}`), ['/docs/notes.md:1', '/docs/notes.md:2', '/pydantic/_internal/_generate_schema.py:2', '/tests/types/test_list.py:1', '/tests/types/test_list.py:4']);
  assert.equal(all.matches[2].text, 'collections.abc.MutableSequence: lambda self, obj: self._sequence_schema(Any),');
  assert.equal(searchArchive(archive, { query: 'MutableSequence', caseSensitive: true }).total, 3, '"ImmutableSequenceX" holds a lowercase m.');
  assert.deepEqual(searchArchive(archive, { query: 'MutableSequence', wholeWord: true }).matches.map(match => `${match.path}:${match.line}`),
    ['/docs/notes.md:1', '/pydantic/_internal/_generate_schema.py:2', '/tests/types/test_list.py:1', '/tests/types/test_list.py:4'], 'Not inside ImmutableSequenceX.');
  assert.equal(searchArchive(archive, { query: 'MutableSequence', include: path => path.startsWith('/tests/') }).total, 2);
  assert.equal(searchArchive(archive, { query: 'self._list_schema(Any)' }).total, 1, 'Regular-expression characters are literal.');
  const many = readZip(zipFiles(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, '0')}.py`, 'hit\n'.repeat(25)])));
  const bounded = searchArchive(many, { query: 'hit' });
  assert.equal(bounded.total, 750);
  assert.equal(bounded.matches.length, 100);
  assert.ok(bounded.matches.slice(0, 20).every(match => match.path === '/f00.py'), 'At most 20 lines per file.');
});

test('one archive per run and commit; an archive over the limit is remembered as unavailable', async () => {
  let downloads = 0;
  const azure = { archive: async () => { downloads++; return downloads === 1 ? { bytes: repo() } : { tooLarge: true, size: 9e9 }; } };
  const run = {};
  const first = await repositoryArchive(run, azure, {}, 'a'.repeat(40));
  assert.equal((await repositoryArchive(run, azure, {}, 'a'.repeat(40))), first);
  assert.equal(downloads, 1);
  const other = await repositoryArchive(run, azure, {}, 'b'.repeat(40));
  assert.match(other.unavailable, /larger than the azure\.archiveMegabytes setting allows \(9000000000 bytes\)/);
});

test('a long line is shown around its match', () => {
  const line = 'a'.repeat(5000) + 'NEEDLE' + 'b'.repeat(5000);
  const { matches } = searchArchive({ files: new Map([['/min.js', line]]) }, { query: 'needle' });
  assert.match(matches[0].text, /^…a+NEEDLEb+…$/);
  assert.ok(matches[0].text.length <= 242);
});
