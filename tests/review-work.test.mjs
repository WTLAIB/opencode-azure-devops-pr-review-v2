import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, shardFiles, shardFindings, locationPath, runPool } from '../src/review-work.mjs';
import { createCommentData } from '../src/comment-data.mjs';
import { createAzureClient, parsePullRequestUrl } from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { ROLES } from '../src/config.mjs';
import { validateSettings } from '../src/config.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';

const finding = (id, path = '/src/a.ts') => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: `head:${path}:3`, severity: 'medium', suggestion: 's' });

test('shard helpers keep directories together and group findings by file', () => {
  assert.deepEqual(shardFiles(['/b/2', '/a/1', '/b/1', '/a/2', '/c'], 2), [['/a/1', '/a/2'], ['/b/1', '/b/2'], ['/c']]);
  assert.deepEqual(shardFiles([], 5), [[]]);
  assert.equal(locationPath('head:/src/a.ts:12-14'), '/src/a.ts');
  assert.equal(locationPath('nonsense'), '');
  const groups = shardFindings([finding('R-1', '/z.ts'), finding('F-2', '/a.ts'), finding('F-1', '/a.ts')], 2);
  assert.deepEqual(groups.map(group => group.map(f => f.id)), [['F-1', 'F-2'], ['R-1']]);
  assert.deepEqual(shardFindings([], 3), [[]]);
});

test('runPool keeps order and bounds parallelism', async () => {
  let active = 0, peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async value => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return value * 2; });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

async function context(t, { files, workflow = {}, behave }) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-review-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const azure = fakeAzure({ files });
  const client = createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 3, timeoutMs: 1000 }), fetch: azure.fetch, retryDelayMs: 1 });
  const settings = validateSettings({ version: 2, models: { review: { functional: 'p/f', risk: 'p/r', verifier: 'p/v' } }, workflow, azure: { organization: 'org', pat: FAKE_PAT } });
  const store = await createCommentData({ root: directory });
  const calls = [], notices = [];
  const run = { id: 'run12345', profile: 'review', active: true, controller: new AbortController(), stages: [] };
  const runStage = async (stageRun, role, payload, handler, options) => {
    calls.push({ role, payload, label: options.label });
    let evaluation, text;
    for (let turn = 0; ; turn++) {
      text = await behave({ role, payload, turn, calls });
      evaluation = await handler.evaluate(text, evaluation?.result);
      if (!evaluation.issues?.length || turn >= settings.workflow.repairAttempts) break;
    }
    return evaluation.result;
  };
  const ctx = { azure: client, runStage, progress: (_run, message) => notices.push(message), settings, dataFor: async () => store };
  return { ctx, run, azure, calls, notices, request: { prUrl: azure.prUrl(), userContext: '', target: parsePullRequestUrl(azure.prUrl()) } };
}

const initial = (payload, findings) => JSON.stringify({ status: 'COMPLETE', coverage: { files: payload.assignment.files, gaps: [] }, findings, report: `Shard ${payload.assignment.shard}` });
const verdicts = payload => JSON.stringify({ status: 'COMPLETE', confirmed: [], merged: [], needsInfo: [], newFindings: [], report: `Verified ${payload.assignment.shard}`,
  rejected: payload.assignment.findingIds.map(id => ({ id, reason: 'Guarded.' })) });

test('initial reviews are sharded per role with disjoint ID ranges, then verified per finding shard', async t => {
  const files = ['/a/1.ts', '/a/2.ts', '/b/1.ts', '/b/2.ts', '/c.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 2, shardFindings: 3 }, behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'initial') {
      const prefix = ROLES[role].prefix, first = Number(payload.assignment.firstFindingId.split('-')[1]);
      return initial(payload, [finding(`${prefix}-${first}`, payload.assignment.files[0])]);
    }
    return verdicts(payload);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  const initials = f.calls.filter(call => ROLES[call.role].format === 'initial');
  assert.equal(initials.length, 6);
  assert.deepEqual(initials.filter(call => call.role === 'azpr-review-functional').map(call => call.payload.assignment.files),
    [['/a/1.ts', '/a/2.ts'], ['/b/1.ts', '/b/2.ts'], ['/c.ts']]);
  assert.deepEqual(final.findings.map(x => x.id).sort(), ['F-1', 'F-1001', 'F-2001', 'R-1', 'R-1001', 'R-2001']);
  const verifiers = f.calls.filter(call => call.role === 'azpr-review-verifier');
  assert.equal(verifiers.length, 2);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.dispositions.length, 6);
  assert.ok(final.dispositions.every(d => d.status === 'REJECTED'));
  assert.match(final.report, /Verification shard 1\/2/);
  assert.equal(final.coverage['azpr-review-risk'].covered, 5);
  assert.ok(f.notices.some(message => /6 session\(s\)/.test(message)));
});

test('a shard that overflows its context is split in half and retried', async t => {
  const files = ['/a.ts', '/b.ts', '/c.ts', '/d.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 4 }, behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'initial') {
      if (role.endsWith('-functional') && payload.assignment.files.length > 2) throw Object.assign(new Error('compaction refused'), { failureClass: 'overflow' });
      return initial(payload, []);
    }
    return verdicts(payload);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  const functional = f.calls.filter(call => call.role === 'azpr-review-functional').map(call => call.payload.assignment.files.length);
  assert.deepEqual(functional, [4, 2, 2]);
  assert.equal(final.coverage['azpr-review-functional'].covered, 4);
  assert.ok(f.notices.some(message => /splitting the shard/.test(message)));
});

test('only a changed source commit makes a review STALE; a moved base is a warning', async t => {
  const behave = async ({ role, payload }) => ROLES[role].format === 'initial' ? initial(payload, [finding(`${ROLES[role].prefix}-1`)]) : verdicts(payload);
  const moved = await context(t, { files: ['/src/a.ts'], behave });
  moved.azure.state.afterVersions = { base: 'd'.repeat(40) };
  const drift = await runReview(moved.ctx, moved.run, moved.request);
  assert.equal(drift.status, 'COMPLETE');
  assert.ok(drift.reviewWarnings.some(message => /PR base moved during the review/.test(message)));
  const changed = await context(t, { files: ['/src/a.ts'], behave });
  changed.azure.state.afterVersions = { head: 'c'.repeat(40) };
  const stale = await runReview(changed.ctx, changed.run, changed.request);
  assert.equal(stale.status, 'STALE');
  assert.match(stale.reviewWarnings[0], /source changed during the review/);
});

test('failed shards degrade per item; a review with no structured verification is PARTIAL', async t => {
  const files = ['/a.ts', '/b.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 1, shardFindings: 1 }, behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'initial') {
      if (role.endsWith('-risk') && payload.assignment.files[0] === '/b.ts') throw new Error('provider 401');
      return initial(payload, role.endsWith('-functional') ? [finding(payload.assignment.firstFindingId, payload.assignment.files[0])] : []);
    }
    if (payload.assignment.findingIds.includes('F-1001')) throw new Error('verifier crashed');
    return verdicts(payload);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(final.status, 'COMPLETE');
  assert.deepEqual(Object.fromEntries(final.dispositions.map(d => [d.id, d.status])), { 'F-1': 'REJECTED', 'F-1001': 'UNREVIEWED' });
  assert.deepEqual(final.coverage['azpr-review-risk'].failedFiles, ['/b.ts']);
  assert.ok(final.reviewWarnings.some(message => /risk shard 2\/2 failed/.test(message)));
  const none = await context(t, { files: ['/a.ts'], behave: async ({ role, payload }) => ROLES[role].format === 'initial' ? initial(payload, [finding('F-1')]) : 'Prose only, no JSON.' });
  const partial = await runReview(none.ctx, none.run, none.request);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.initialObservations.length, 2);
  const broken = await context(t, { files: ['/a.ts'], behave: async () => { throw new Error('all down'); } });
  await assert.rejects(runReview(broken.ctx, broken.run, broken.request), /Every initial review session failed: all down/);
});

test('repair turns fix a verifier that missed decisions', async t => {
  const f = await context(t, { files: ['/a.ts'], behave: async ({ role, payload, turn }) => {
    if (ROLES[role].format === 'initial') return initial(payload, [finding(`${ROLES[role].prefix}-1`)]);
    if (turn === 0) return JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...finding('F-1'), reason: 'Verified.' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'r' });
    return JSON.stringify({ dispositions: [{ id: 'R-1', status: 'MERGED', mergedInto: 'F-1', reason: 'Same cause.' }] });
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}`), ['F-1:CONFIRMED', 'R-1:MERGED']);
  assert.equal(f.calls.filter(call => call.role === 'azpr-review-verifier').length, 1);
});

test('an incomplete Azure file list asks reviewers to discover paths and records them', async t => {
  const f = await context(t, { files: ['/a.ts'], behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'initial') {
      assert.equal(payload.assignment.discoverFiles, true);
      return JSON.stringify({ status: 'COMPLETE', coverage: { files: ['/a.ts'], gaps: [] }, additionalFiles: ['/hidden.ts'], findings: [], report: 'r' });
    }
    return verdicts(payload);
  } });
  // The REST inventory is complete unless it exceeds the paging bound; simulate that.
  const snapshot = f.ctx.azure.snapshot;
  f.ctx.azure = { ...f.ctx.azure, snapshot: async (...args) => ({ ...(await snapshot(...args)), filesComplete: false }) };
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.discoveredFiles, ['/hidden.ts']);
  assert.ok(final.reviewWarnings.some(message => /incomplete changed-file list/.test(message)));
});
