import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewStore, createReviewWrites, serializeReview, deserializeReview, stateRoot } from '../src/store.mjs';
import { createCommentData } from '../src/comment-data.mjs';

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const review = (id, completedAt, extra = {}) => ({ id, origin: 'ses_origin', completedAt, reportSessions: new Set(['ses_a']), publication: new Map([['m', { state: 'POSTED' }]]), final: { dispositions: [] }, ...extra });

test('state root follows XDG_STATE_HOME', () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: '/x/state' }), '/x/state/opencode/azpr-v2');
  assert.match(stateRoot({ XDG_STATE_HOME: 'relative' }), /\.local\/state\/opencode\/azpr-v2$/);
});

test('reviews round-trip with Sets and Maps and survive a new store instance', async t => {
  const directory = await root(t);
  const store = await createReviewStore({ root: directory });
  await store.save(review('aaaaaaaa', '2026-01-01T00:00:00Z'));
  const loaded = await (await createReviewStore({ root: directory })).load();
  assert.equal(loaded.length, 1);
  assert.deepEqual([...loaded[0].reportSessions], ['ses_a']);
  assert.deepEqual([...loaded[0].publication], [['m', { state: 'POSTED' }]]);
  assert.deepEqual(deserializeReview(serializeReview(loaded[0])).reportSessions, loaded[0].reportSessions);
  const info = await stat(join(directory, 'reviews', 'aaaaaaaa.json'));
  assert.equal(info.mode & 0o777, 0o600);
});

test('corrupted or tampered review files are ignored', async t => {
  const directory = await root(t);
  const store = await createReviewStore({ root: directory });
  await store.save(review('aaaaaaaa', '2026-01-01T00:00:00Z'));
  const file = join(directory, 'reviews', 'aaaaaaaa.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.body = envelope.body.replace('ses_origin', 'ses_attacker');
  await writeFile(file, JSON.stringify(envelope));
  await writeFile(join(directory, 'reviews', 'bbbbbbbb.json'), '{not json');
  assert.deepEqual(await store.load(), []);
});

test('the newest reviews are kept; evicted reviews lose their data directory', async t => {
  const directory = await root(t);
  const store = await createReviewStore({ root: directory, limit: 2 });
  const data = await createCommentData({ root: store.dirs.data });
  await store.save(review('aaaaaaaa', '2026-01-01T00:00:00Z', { dataDirectory: data.directory }));
  await store.save(review('bbbbbbbb', '2026-01-02T00:00:00Z'));
  await store.save(review('cccccccc', '2026-01-03T00:00:00Z'));
  assert.deepEqual(await store.enforceLimit(), ['aaaaaaaa']);
  assert.deepEqual((await store.load()).map(r => r.id), ['bbbbbbbb', 'cccccccc']);
  await assert.rejects(stat(data.directory));
});

test('evicted reviews are reported once for session cleanup', async t => {
  const directory = await root(t);
  const removed = [];
  const store = await createReviewStore({ root: directory, limit: 1, onRemove: async old => { removed.push([old.id, [...old.reportSessions]]); throw new Error('ignored'); } });
  await store.save(review('aaaaaaaa', '2026-01-01T00:00:00Z'));
  await store.save(review('bbbbbbbb', '2026-01-02T00:00:00Z'));
  assert.deepEqual(await store.enforceLimit(), ['aaaaaaaa']);
  assert.deepEqual(removed, [['aaaaaaaa', ['ses_a']]]);
  await store.enforceLimit();
  assert.equal(removed.length, 1);
});

test('sessions kept from unfinished runs are bounded; older runs release theirs', async t => {
  const directory = await root(t);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = await createReviewStore({ root: directory, limit: 2, now: () => clock++ });
  assert.deepEqual(await store.keepSessions('run00001', ['ses_1']), []);
  assert.deepEqual(await store.keepSessions('run00002', ['ses_2', 'ses_3']), []);
  assert.deepEqual(await store.keepSessions('run00003', ['ses_4']), ['ses_1']);
  assert.equal((await readdir(store.dirs.sessions)).length, 2);
});

test('publication attempts are shared per PR, re-read before writes and expire after 90 days', async t => {
  const directory = await root(t);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = await createReviewStore({ root: directory, now: () => clock });
  const one = await store.attempts('["org","p","r",1]'), other = await store.attempts('["org","p","r",1]');
  await one.set('m1', { state: 'SENDING', at: new Date(clock).toISOString() });
  await other.set('m2', { state: 'CREATED', threadId: 5, at: new Date(clock).toISOString() });
  assert.equal(other.get('m1').state, 'SENDING', 'A write re-reads what another instance saved.');
  assert.equal((await store.attempts('["org","p","r",2]')).get('m1'), undefined, 'Another PR has its own record.');
  await one.remove(['m1']);
  assert.equal((await store.attempts('["org","p","r",1]')).get('m1'), undefined);
  clock += 91 * 24 * 3600 * 1000;
  assert.equal((await store.attempts('["org","p","r",1]')).get('m2'), undefined);
  await writeFile(join(store.dirs.attempts, (await readdir(store.dirs.attempts))[0]), 'not json');
  await assert.rejects(store.attempts('["org","p","r",1]'));
});

test('sweep removes only stale unreferenced data', async t => {
  const directory = await root(t);
  const now = Date.now();
  const store = await createReviewStore({ root: directory, now: () => now });
  const referenced = await createCommentData({ root: store.dirs.data });
  const stale = await createCommentData({ root: store.dirs.data });
  const fresh = await createCommentData({ root: store.dirs.data });
  await store.save(review('aaaaaaaa', '2026-01-01T00:00:00Z', { dataDirectory: referenced.directory }));
  const old = (now - 48 * 3600 * 1000) / 1000;
  await utimes(referenced.directory, old, old);
  await utimes(stale.directory, old, old);
  const removed = await store.sweep();
  assert.ok(removed.includes(stale.directory));
  await stat(referenced.directory);
  await stat(fresh.directory);
});

test('receipts are written privately and bounded', async t => {
  const directory = await root(t);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = await createReviewStore({ root: directory, now: () => clock++ });
  for (let i = 0; i < 55; i++) await store.writeReceipt(`run${String(i).padStart(5, '0')}`, `receipt ${i}`);
  const files = await readdir(store.dirs.receipts);
  assert.equal(files.length, 50);
  assert.equal(await readFile(join(store.dirs.receipts, files.at(-1)), 'utf8'), 'receipt 54');
});

test('comment data reopens after a restart and still verifies hashes', async t => {
  const directory = await root(t);
  await mkdir(join(directory, 'data'), { recursive: true });
  const first = await createCommentData({ root: join(directory, 'data') });
  const reference = await first.put('saved text');
  const reopened = await createCommentData({ directory: first.directory });
  assert.equal(await reopened.read(reference), 'saved text');
  await writeFile(reference.file, 'tampered');
  await assert.rejects(reopened.read(reference), /changed/);
  await assert.rejects(reopened.read({ ...reference, file: '/etc/passwd' }), /Unknown private comment data reference/);
});

// A save the test finishes by hand, recording what it read when it started.
function gate(log, name, read = () => name) {
  let finish, fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  return { action: () => { log.push(`start ${name}: ${read()}`); return done.then(value => { log.push(`end ${name}`); return value; }); }, finish, fail };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('writes of one review run one at a time and in order; another review does not wait', async () => {
  const writes = createReviewWrites(), log = [];
  const first = gate(log, 'a1'), second = gate(log, 'a2'), other = gate(log, 'b1');
  const results = [writes.write('a', first.action), writes.write('a', second.action), writes.write('b', other.action)];
  await settle();
  assert.deepEqual(log, ['start a1: a1', 'start b1: b1'], 'The second write of a waits; b runs beside it.');
  second.finish(); await settle();
  assert.deepEqual(log, ['start a1: a1', 'start b1: b1'], 'Finishing out of order changes nothing: a2 has not started.');
  first.finish('one'); other.finish(); await settle();
  assert.deepEqual(log, ['start a1: a1', 'start b1: b1', 'end a1', 'end b1', 'start a2: a2', 'end a2']);
  assert.deepEqual(await Promise.all(results), ['one', undefined, undefined]);
});

test('a failed write rejects only its own request, and the next write of the review still runs', async () => {
  const writes = createReviewWrites(), log = [];
  const failing = gate(log, 'a1'), next = gate(log, 'a2');
  const failed = writes.write('a', failing.action), later = writes.write('a', next.action);
  failing.fail(new Error('disk full')); await settle();
  await assert.rejects(failed, /disk full/);
  next.finish('kept');
  assert.equal(await later, 'kept');
});

test('the latest state is written: a request joins a save that has not started, and one made during a save gets a save after it', async () => {
  const writes = createReviewWrites(), log = [];
  let state = 'A1';
  const saves = [];
  // Each save reads the state when it starts, as a save of a review record does.
  const save = () => { const g = gate(log, `save${saves.length + 1}`, () => state); saves.push(g); return g.action(); };
  // A write already under way, such as the record of a review that has just completed.
  const busy = gate(log, 'busy');
  const before = writes.write('a', busy.action);
  // Two choices while the save they need has not started: one save carries both.
  const first = writes.latest('a', save);
  state = 'A2';
  assert.equal(writes.latest('a', save), first, 'A request joins the save that waits in the queue.');
  busy.finish(); await settle();
  assert.deepEqual(log, ['start busy: busy', 'end busy', 'start save1: A2'], 'The joined save read the state when it started.');
  // A choice made while that save writes: it read the state already, so the new choice gets a save of its own after it.
  state = 'A3';
  const second = writes.latest('a', save);
  assert.notEqual(second, first);
  await settle();
  assert.equal(saves.length, 1, 'The new save waits for the one under way.');
  saves[0].finish(); await settle();
  assert.deepEqual(log.slice(3), ['end save1', 'start save2: A3']);
  saves[1].finish();
  await Promise.all([before, first, second]);
  assert.equal(log.at(-1), 'end save2');
  assert.match(log.filter(entry => entry.startsWith('start save')).at(-1), /A3$/, 'The last save wrote the last state.');
});
