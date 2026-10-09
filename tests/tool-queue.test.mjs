import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolQueue } from '../src/tool-queue.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrency limits simultaneous calls but never total work', async () => {
  const queue = createToolQueue({ concurrency: 3, timeoutMs: 1000 });
  const gates = Array.from({ length: 10 }, deferred);
  let active = 0, peak = 0;
  const calls = gates.map((gate, index) => queue.run(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; return index; }));
  await tick();
  assert.equal(peak, 3);
  assert.deepEqual(queue.stats().queued, 7);
  gates.forEach(gate => gate.resolve());
  assert.deepEqual(await Promise.all(calls), [...Array(10).keys()]);
  assert.equal(queue.stats().active, 0);
});

test('a hung call times out and releases its slot for the next call', async () => {
  const queue = createToolQueue({ concurrency: 1, timeoutMs: 30 });
  const hung = queue.run(() => new Promise(() => {}), { label: 'hung tool' });
  const next = queue.run(async () => 'next');
  await assert.rejects(hung, error => error.timeout === true && /hung tool did not finish within/.test(error.message));
  assert.equal(await next, 'next');
});

test('errors release the slot; late results after a timeout are ignored', async () => {
  const queue = createToolQueue({ concurrency: 1, timeoutMs: 20 });
  await assert.rejects(queue.run(async () => { throw new Error('boom'); }), /boom/);
  const late = deferred();
  await assert.rejects(queue.run(() => late.promise), /did not finish/);
  late.reject(new Error('late failure must not be unhandled'));
  assert.equal(await queue.run(async () => 7), 7);
});

test('cancellation rejects queued and running calls and frees capacity', async () => {
  const queue = createToolQueue({ concurrency: 1, timeoutMs: 0 });
  const controller = new AbortController();
  const gate = deferred();
  const running = queue.run(() => gate.promise, { signal: controller.signal });
  const queued = queue.run(async () => 'never', { signal: controller.signal });
  await tick();
  controller.abort(new Error('stopped'));
  await assert.rejects(running, /stopped/);
  await assert.rejects(queued, /stopped/);
  assert.equal(await queue.run(async () => 'free'), 'free');
  gate.resolve();
  await assert.rejects(queue.run(async () => 'x', { signal: controller.signal }), /stopped/);
});

test('configure changes limits for later calls', async () => {
  const queue = createToolQueue({ concurrency: 1, timeoutMs: 1000 });
  queue.configure({ concurrency: 4, timeoutMs: 10 });
  assert.equal(queue.stats().concurrency, 4);
  await assert.rejects(queue.run(() => new Promise(() => {})), /did not finish within 0 seconds|did not finish/);
});
