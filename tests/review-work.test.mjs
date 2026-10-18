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
  // Shards end between files: two reviewers' findings on one file stay together (PR #3 split worker_capacity.py).
  const live = Array.from({ length: 24 }, (_, file) => ['F', 'R'].map(role => finding(`${role}-${1001 + file}`, `/p/f${String(file).padStart(2, '0')}.py`))).flat();
  const shards = shardFindings(live, 15);
  assert.deepEqual(shards.map(group => group.length), [14, 14, 14, 6]);
  for (const group of shards) assert.ok(group.every(f => live.filter(other => locationPath(other.location) === locationPath(f.location)).every(other => group.includes(other))));
  // Only a single file with more findings than a shard is split.
  const crowded = [...Array.from({ length: 5 }, (_, i) => finding(`F-${i + 1}`, '/big.py')), finding('R-1', '/small.py')];
  assert.deepEqual(shardFindings(crowded, 2).map(group => group.map(f => f.id)), [['F-1', 'F-2'], ['F-3', 'F-4'], ['F-5'], ['R-1']]);
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
  // Two findings per file and three per shard: each file's findings stay in one verification session.
  assert.equal(verifiers.length, 3);
  for (const call of verifiers) assert.equal(new Set(call.payload.assignment.findings.map(x => locationPath(x.location))).size, 1);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.dispositions.length, 6);
  assert.ok(final.dispositions.every(d => d.status === 'REJECTED'));
  assert.match(final.report, /Verification shard 1\/3/);
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

test('a merge into a finding that another verification shard rejected is shown as UNREVIEWED with a warning', async t => {
  // One file with more findings than a shard holds is the only way a file's findings reach two verifiers.
  const f = await context(t, { files: ['/a.ts'], workflow: { shardFindings: 1 }, behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'initial') return initial(payload, [finding(`${ROLES[role].prefix}-1`)]);
    const [id] = payload.assignment.findingIds;
    const row = id === 'R-1' ? { id, status: 'MERGED', mergedInto: 'F-1', reason: 'Same cause as F-1.' } : { id, status: 'REJECTED', reason: 'Guarded.' };
    return JSON.stringify({ status: 'COMPLETE', dispositions: [row], newFindings: [], report: 'r' });
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.calls.filter(call => call.role === 'azpr-review-verifier').length, 2);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}`), ['F-1:REJECTED', 'R-1:UNREVIEWED']);
  assert.match(final.dispositions[1].reason, /merged into F-1, which is REJECTED/);
  assert.ok(final.reviewWarnings.some(w => /R-1 → F-1 \(REJECTED\)/.test(w)));
  assert.equal(final.status, 'COMPLETE');
});

test('a verifier that moves a finding to another file confirms the move in a correction turn', async t => {
  const f = await context(t, { files: ['/src/a.ts', '/tests/a.test.ts'], behave: async ({ role, payload, turn }) => {
    if (ROLES[role].format === 'initial') return initial(payload, role.endsWith('-risk') ? [finding('R-1', '/tests/a.test.ts')] : []);
    const moved = { ...finding('R-1'), location: 'head:/src/a.ts:18' };
    if (turn === 0) return JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...moved, reason: 'Verified.' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'r' });
    return JSON.stringify({ dispositions: [{ id: 'R-1', status: 'CONFIRMED', reason: 'The defect stated in summary is in a.ts.', verifiedFinding: { ...moved, movedFrom: 'head:/tests/a.test.ts:3' } }] });
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  const [decision] = final.dispositions;
  assert.equal(decision.status, 'CONFIRMED');
  assert.equal(decision.verifiedFinding.location, 'head:/src/a.ts:18');
  assert.equal(decision.verifiedFinding.movedFrom, 'head:/tests/a.test.ts:3');
  assert.equal(final.reviewWarnings.some(message => /without confirming the move/.test(message)), false);
  assert.equal(f.calls.filter(call => call.role === 'azpr-review-verifier').length, 1, 'The correction stays in the same verifier stage.');
});

// F-1 is found in /src/a.ts and R-1 in /tests/a.test.ts, so with one finding per
// verification shard they are verified apart; R-1's verifier then moves it (and
// adds V-1001) into /src/a.ts, which F-1's verifier never saw.
const crossShard = (dedupe, { moveInto = '/src/a.ts' } = {}) => async ({ role, payload }) => {
  const format = ROLES[role].format;
  if (format === 'initial') return initial(payload, role.endsWith('-risk') ? [finding('R-1', '/tests/a.test.ts')] : [finding('F-1', '/src/a.ts')]);
  if (format === 'final') {
    const [own] = payload.assignment.findings;
    if (own.id !== 'R-1') return JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...own, reason: 'Verified.' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'r1' });
    return JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...own, location: `head:${moveInto}:3`, movedFrom: own.location, reason: 'The defect is in a.ts.' }],
      merged: [], rejected: [], needsInfo: [], newFindings: [{ ...finding('V-1001', moveInto), location: `head:${moveInto}:9` }], report: 'r2' });
  }
  return dedupe(payload);
};

test('findings that different verifiers confirmed in one file get a duplicate check', async t => {
  const f = await context(t, { files: ['/src/a.ts', '/tests/a.test.ts'], workflow: { shardFindings: 1 }, behave: crossShard(payload => {
    assert.equal(payload.assignment.file, '/src/a.ts');
    assert.deepEqual(payload.assignment.findingIds, ['F-1', 'R-1', 'V-1001']);
    assert.deepEqual(payload.assignment.findings.map(x => x.verificationShard), ['1/2', '2/2', '2/2']);
    assert.equal(payload.assignment.findings[1].movedFrom, 'head:/tests/a.test.ts:3');
    return JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'R-1', mergedInto: 'F-1', reason: 'Same cause and fix.' }, { id: 'V-1001', mergedInto: 'F-1', reason: 'Same guard.' }], report: 'Two duplicates of F-1.' });
  }) });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}${d.mergedInto ? '>' + d.mergedInto : ''}`), ['F-1:CONFIRMED', 'R-1:MERGED>F-1', 'V-1001:MERGED>F-1']);
  assert.match(final.dispositions[1].reason, /^Same cause and fix\. \[Runtime: merged by the same-file duplicate check/);
  assert.deepEqual(final.newFindings, []);
  assert.equal(f.calls.filter(call => call.role === 'azpr-review-dedupe').length, 1);
  assert.match(final.report, /### Duplicate check: \/src\/a\.ts\n\nTwo duplicates of F-1\./);
  assert.equal(final.shards.duplicateChecks, 1);
  assert.ok(f.notices.some(message => /Duplicate check: 1 file\(s\) hold findings that different verification shards confirmed/.test(message)));
});

test('a duplicate check may merge confirmed findings into a surviving verifier-added finding', async t => {
  const f = await context(t, { files: ['/src/a.ts', '/tests/a.test.ts'], workflow: { shardFindings: 1 }, behave: crossShard(() =>
    JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-1', mergedInto: 'V-1001', reason: 'V-1001 states it completely.' }, { id: 'R-1', mergedInto: 'V-1001', reason: 'Same guard.' }], report: 'Kept V-1001.' })) });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}${d.mergedInto ? '>' + d.mergedInto : ''}`), ['F-1:MERGED>V-1001', 'R-1:MERGED>V-1001']);
  assert.deepEqual(final.newFindings.map(x => x.id), ['V-1001']);
  assert.ok(!final.reviewWarnings.some(w => /not confirmed|UNREVIEWED/.test(w)), JSON.stringify(final.reviewWarnings));
  assert.equal(final.status, 'COMPLETE');
});

test('a failed duplicate check keeps every finding; findings one verifier saw together are not rechecked', async t => {
  const failed = await context(t, { files: ['/src/a.ts', '/tests/a.test.ts'], workflow: { shardFindings: 1 }, behave: crossShard(() => { throw new Error('dedupe crashed'); }) });
  const kept = await runReview(failed.ctx, failed.run, failed.request);
  assert.deepEqual(kept.dispositions.map(d => `${d.id}:${d.status}`), ['F-1:CONFIRMED', 'R-1:CONFIRMED']);
  assert.equal(kept.newFindings.length, 1);
  assert.ok(kept.reviewWarnings.some(message => /duplicate check of \/src\/a\.ts failed \(dedupe crashed\); its 3 findings stay confirmed/.test(message)));
  // With room for both findings in one verification shard, the same verifier already compared them.
  const together = await context(t, { files: ['/src/a.ts', '/tests/a.test.ts'], workflow: { shardFindings: 15 }, behave: async ({ role, payload }) => {
    if (ROLES[role].format === 'final') return JSON.stringify({ status: 'COMPLETE', confirmed: payload.assignment.findings.map(x => ({ ...x, location: 'head:/src/a.ts:3', movedFrom: x.location, reason: 'ok' })),
      merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'r' });
    return crossShard(() => { throw new Error('must not run'); })({ role, payload });
  } });
  const same = await runReview(together.ctx, together.run, together.request);
  assert.equal(together.calls.filter(call => call.role === 'azpr-review-dedupe').length, 0);
  assert.equal(same.shards.duplicateChecks, 0);
  assert.deepEqual(same.dispositions.map(d => d.status), ['CONFIRMED', 'CONFIRMED']);
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

// ------------------------------------------------------------------ quick review

/**
 * A quick-review harness: `behave({ payload, turn, repair, read })` answers each
 * turn and calls `read(path, side)` for what this session's own tools showed.
 */
async function quickContext(t, { files, workflow = {}, changes, missing, binary, sources, behave }) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-quick-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const azure = fakeAzure({ files, changes, missing, binary, sources });
  const client = createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 3, timeoutMs: 1000 }), fetch: azure.fetch, retryDelayMs: 1 });
  const settings = validateSettings({ version: 2, models: { review: { functional: 'p/f', risk: 'p/r', verifier: 'p/v' }, quick: { reviewer: 'p/q' } }, workflow, azure: { organization: 'org', pat: FAKE_PAT } });
  const store = await createCommentData({ root: directory });
  const calls = [], notices = [];
  const run = { id: 'run12345', profile: 'quick', active: true, controller: new AbortController(), stages: [] };
  const runStage = async (stageRun, role, payload, handler, options) => {
    const call = { role, payload, label: options.label, reads: new Set(), repairs: [] };
    calls.push(call);
    const read = (path, side = 'head') => call.reads.add(`${side === 'base' ? azure.state.base : azure.state.head}\n${path}`);
    let evaluation;
    for (let turn = 0; ; turn++) {
      const text = await behave({ role, payload, turn, repair: evaluation?.repairPrompt, read, calls });
      evaluation = await handler.evaluate(text, evaluation?.result, { reads: call.reads });
      if (!evaluation.issues?.length || turn >= settings.workflow.repairAttempts) break;
      call.repairs.push(evaluation.repairPrompt);
    }
    return evaluation.result;
  };
  const ctx = { azure: client, runStage, progress: (_run, message) => notices.push(message), settings, dataFor: async () => store };
  return { ctx, run, azure, calls, notices, request: { prUrl: azure.prUrl(), userContext: '', target: parsePullRequestUrl(azure.prUrl()) } };
}
const quickAnswer = (payload, findings, extra = {}) => JSON.stringify({ status: 'COMPLETE', coverage: { files: payload.assignment.files, gaps: [] }, additionalFiles: [], findings, report: `Checked ${payload.assignment.shard}`, ...extra });
const quickFinding = (id, location, summary = `Defect ${id}`) => ({ id, summary, location, evidence: 'HEAD `x` drops the guard; BASE kept it.', counterevidence: 'No caller re-checks.', severity: 'medium', suggestion: 'Restore the guard; add a regression case.' });

test('a quick review runs one reviewer per shard, no verifier, and reports checked findings', async t => {
  const f = await quickContext(t, { files: ['/a/1.ts', '/a/2.ts', '/b/1.ts'], workflow: { shardFiles: 2 }, behave: async ({ payload, read }) => {
    for (const path of payload.assignment.files) read(path);
    return quickAnswer(payload, [quickFinding(payload.assignment.firstFindingId, `head:${payload.assignment.files[0]}:1`)]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(f.calls.map(call => call.role), ['azpr-quick-reviewer', 'azpr-quick-reviewer']);
  assert.deepEqual(f.calls.map(call => call.payload.assignment.firstFindingId), ['Q-1', 'Q-1001']);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.verification, 'none');
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}:${d.inline}`), ['Q-1:REPORTED:true', 'Q-1001:REPORTED:true']);
  assert.ok(final.dispositions.every(d => !d.verifiedFinding && d.finding.location && !Object.hasOwn(d.finding, 'id')));
  assert.deepEqual(final.coverageSummary, { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [] });
  assert.match(final.report, /### shard 1\/2\n\nChecked 1\/2[\s\S]*### shard 2\/2\n\nChecked 2\/2/);
  assert.deepEqual(final.shards, { initial: 2, verification: 0, duplicateChecks: 0 });
  assert.ok(f.notices.some(message => /Quick review: 2 session\(s\) for 2 shard\(s\); no independent verification follows/.test(message)));
});

test('quick findings on the same line stay separate; only identical records are removed', async t => {
  const f = await quickContext(t, { files: ['/src/pay.ts'], behave: async ({ payload, read }) => {
    read('/src/pay.ts');
    const authz = quickFinding('Q-1', 'head:/src/pay.ts:1', 'The permission check runs after the charge');
    return quickAnswer(payload, [authz, quickFinding('Q-2', 'head:/src/pay.ts:1', 'A retry charges the card twice'), { ...authz, id: 'Q-3' }]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}${d.mergedInto ? `>${d.mergedInto}` : ''}`), ['Q-1:REPORTED', 'Q-2:REPORTED', 'Q-3:MERGED>Q-1']);
  assert.match(final.dispositions[2].reason, /exact duplicate/);
  assert.ok(final.reviewWarnings.some(message => /Removed 1 exact duplicate finding/.test(message)));
});

test('a parsed quick answer is not automatically usable: bad items degrade and no usable shard is PARTIAL', async t => {
  const f = await quickContext(t, { files: ['/src/a.ts'], behave: async ({ payload, read }) => {
    read('/src/a.ts');
    const { location: _missing, ...noLocation } = quickFinding('Q-2', '');
    return quickAnswer(payload, [quickFinding('Q-1', 'head:/src/a.ts:2'), noLocation]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.calls[0].repairs.length, 2, 'The missing location got both correction turns.');
  assert.match(f.calls[0].repairs[0], /findings\[1\] \(Q-2\): missing location/);
  assert.equal(final.status, 'COMPLETE');
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}`), ['Q-1:REPORTED', 'Q-2:NEEDS_INFO']);
  assert.match(final.dispositions[1].reason, /missing location after the correction turns/);
  // JSON that parses but carries no usable review never becomes a commentable COMPLETE.
  const g = await quickContext(t, { files: ['/src/a.ts'], behave: async () => JSON.stringify({ status: 'COMPLETE', findings: { summary: 'not a list' }, coverage: 'everything', report: 'Looked around.' }) });
  const partial = await runReview(g.ctx, g.run, g.request);
  assert.equal(partial.status, 'PARTIAL');
  assert.ok(partial.dispositions.every(d => d.status === 'NEEDS_INFO'));
  assert.deepEqual(partial.coverageSummary, { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'] });
  assert.deepEqual(partial.unstructuredInitials, ['Looked around.']);
});

test('zero quick findings never hide incomplete coverage', async t => {
  // A failed shard: the number of unreviewed files is known.
  const failed = await quickContext(t, { files: ['/a.ts', '/b.ts', '/c.ts'], workflow: { shardFiles: 2 }, behave: async ({ payload, read }) => {
    if (payload.assignment.files.includes('/c.ts')) throw new Error('provider unavailable');
    for (const path of payload.assignment.files) read(path);
    return quickAnswer(payload, []);
  } });
  const one = await runReview(failed.ctx, failed.run, failed.request);
  assert.equal(one.status, 'COMPLETE');
  assert.deepEqual(one.coverageSummary, { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'] });
  assert.deepEqual(one.coverage['azpr-quick-reviewer'].failedFiles, ['/c.ts']);
  // Every file reviewed, but the reviewer could not finish a check.
  const gaps = await quickContext(t, { files: ['/a.ts'], behave: async ({ payload, read }) => {
    read('/a.ts');
    return quickAnswer(payload, [], { status: 'PARTIAL', coverage: { files: ['/a.ts'], gaps: ['The caller in /lib/x.ts could not be read.'] } });
  } });
  const two = await runReview(gaps.ctx, gaps.run, gaps.request);
  assert.deepEqual(two.coverageSummary, { complete: false, unreviewedFiles: 0, filesComplete: true, reasons: ['reviewer-gaps'] });
  // Azure returned part of the change list: the total is not known.
  const partialList = await quickContext(t, { files: ['/a.ts'], behave: async ({ payload, read }) => { read('/a.ts'); return quickAnswer(payload, []); } });
  const snapshot = partialList.ctx.azure.snapshot;
  partialList.ctx.azure = { ...partialList.ctx.azure, snapshot: async (...args) => ({ ...(await snapshot(...args)), filesComplete: false }) };
  const three = await runReview(partialList.ctx, partialList.run, partialList.request);
  assert.deepEqual(three.coverageSummary, { complete: false, unreviewedFiles: 0, filesComplete: false, reasons: ['partial-file-list'] });
});

test('quick locations: deleted, renamed, unchanged and binary files, line ranges and the session\'s own reads', async t => {
  const head = 'b'.repeat(40), base = 'a'.repeat(40);
  const f = await quickContext(t, {
    files: ['/src/edit.ts', '/src/gone.ts', '/src/new-name.ts', '/assets/logo.png'],
    changes: { '/src/gone.ts': { changeType: 'delete' }, '/src/new-name.ts': { changeType: 'rename', originalPath: '/src/old-name.ts' } },
    missing: [`${head}:/src/gone.ts`], binary: ['/assets/logo.png'],
    sources: { [`${base}:/src/old-name.ts`]: 'old line 1\nold line 2\n', '/src/util.ts': 'export const util = 1;\n' },
    behave: async ({ payload, turn, repair, read }) => {
      read('/src/edit.ts'); read('/src/gone.ts', 'base'); read('/src/new-name.ts');
      if (turn === 0) {
        return quickAnswer(payload, [
          quickFinding('Q-1', 'head:/src/edit.ts:1'), quickFinding('Q-2', 'head:/src/gone.ts:1'), quickFinding('Q-3', 'head:/src/old-name.ts:1'),
          quickFinding('Q-4', 'head:/assets/logo.png:1'), quickFinding('Q-5', 'head:/src/edit.ts:99'), quickFinding('Q-6', 'head:/src/util.ts:1')]);
      }
      if (turn === 1) {
        assert.match(repair, /Q-2: \/src\/gone\.ts does not exist at HEAD\. It is deleted in this PR: use base:\/src\/gone\.ts:<line>/);
        assert.match(repair, /Q-3: \/src\/old-name\.ts does not exist at HEAD\. It was renamed to \/src\/new-name\.ts in HEAD/);
        assert.match(repair, /Q-4: \/assets\/logo\.png is a binary file at HEAD, so its lines cannot be read/);
        assert.match(repair, /Q-5: lines 99 are outside \/src\/edit\.ts at HEAD, which has 2 line\(s\)/);
        assert.match(repair, /Q-6: this session did not read \/src\/util\.ts at HEAD/);
      }
      if (turn >= 1) read('/src/util.ts');
      return quickAnswer(payload, [
        quickFinding('Q-1', 'head:/src/edit.ts:1'), quickFinding('Q-2', 'base:/src/gone.ts:1'), quickFinding('Q-3', 'head:/src/new-name.ts:1'),
        quickFinding('Q-4', 'head:/assets/logo.png'), quickFinding('Q-5', 'head:/src/edit.ts:2'), quickFinding('Q-6', 'head:/src/util.ts:1')]);
    },
  });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.calls[0].repairs.length, 2);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}${d.status === 'REPORTED' ? `:${d.inline}` : ''}`),
    ['Q-1:REPORTED:true', 'Q-2:REPORTED:false', 'Q-3:REPORTED:true', 'Q-4:NEEDS_INFO', 'Q-5:REPORTED:true', 'Q-6:REPORTED:false']);
  // Only the unreadable message was received for the binary file: it is not evidence.
  assert.match(final.dispositions[3].reason, /binary file at HEAD, so its lines cannot be read/);
});

test('reads of another session do not count, and a location the runtime cannot check is not repaired', async t => {
  const f = await quickContext(t, { files: ['/a.ts', '/b.ts'], workflow: { shardFiles: 1 }, behave: async ({ payload, read }) => {
    read(payload.assignment.files[0]);
    // The second shard reports a defect in the first shard's file without reading it.
    return quickAnswer(payload, payload.assignment.files[0] === '/b.ts' ? [quickFinding('Q-1001', 'head:/a.ts:1')] : []);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}`), ['Q-1001:NEEDS_INFO']);
  assert.match(final.dispositions[0].reason, /this session did not read \/a\.ts at HEAD/);
  const { checkQuickLocation } = await import('../src/review-work.mjs');
  const failing = { readFile: async () => { throw Object.assign(new Error('timeout'), { kind: 'timeout' }); } };
  const check = await checkQuickLocation({ location: 'head:/a.ts:1' }, { snapshot: { head: 'h', base: 'b', changes: [] }, azure: failing, run: { active: true }, reads: new Set(['h\n/a.ts']) });
  assert.deepEqual(check, { problem: 'the runtime could not check /a.ts at HEAD (timeout).', repairable: false });
});

test('a quick finding needs a read that showed the file: answers past the end do not count', async t => {
  const { runReviewTool } = await import('../src/review-tools.mjs');
  const path = '/src/a.ts', head = 'b'.repeat(40), base = 'a'.repeat(40);
  const outcomes = {};
  for (const [name, input] of [['past-end-line', { tool: 'azpr_read_file', args: { path, startLine: 99 } }], ['past-end-hunk', { tool: 'azpr_read_diff', args: { path, fromHunk: 99 } }],
    ['shown', { tool: 'azpr_read_file', args: { path } }]]) {
    const f = await quickContext(t, { files: [path], sources: { [`${base}:${path}`]: 'export const enabled = false;\n', [`${head}:${path}`]: 'export const enabled = true;\n' },
      behave: async ({ payload, read }) => {
        // The session's own tool call decides what it read, as executeReviewTool does.
        const outcome = await runReviewTool(input.tool, input.args, { azure: f.ctx.azure, run: f.run, snapshot: f.run.snapshot });
        for (const shown of outcome.reads) read(shown.path, shown.version === base ? 'base' : 'head');
        return quickAnswer(payload, [quickFinding('Q-1', `head:${path}:1`)]);
      } });
    const final = await runReview(f.ctx, f.run, f.request);
    outcomes[name] = `${final.dispositions[0].status}:${f.calls[0].repairs.length}`;
  }
  assert.deepEqual(outcomes, { 'past-end-line': 'NEEDS_INFO:2', 'past-end-hunk': 'NEEDS_INFO:2', shown: 'REPORTED:0' });
});
