import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, shardFiles, locationPath, runPool, duplicateGroups, checkLocation, evaluateReview, usableAnswer, renameReferences, REPORTED_REASON } from '../src/review-work.mjs';
import { createCommentData } from '../src/comment-data.mjs';
import { runReviewTool } from '../src/review-tools.mjs';
import { createAzureClient, parsePullRequestUrl } from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { ROLES, reviewerRoles, validateSettings } from '../src/config.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';

test('shard helpers keep directories together', () => {
  assert.deepEqual(shardFiles(['/b/2', '/a/1', '/b/1', '/a/2', '/c'], 2), [['/a/1', '/a/2'], ['/b/1', '/b/2'], ['/c']]);
  assert.deepEqual(shardFiles([], 5), [[]]);
  assert.equal(locationPath('head:/src/a.ts:12-14'), '/src/a.ts');
  assert.equal(locationPath('nonsense'), '');
});

test('runPool keeps order and bounds parallelism', async () => {
  let active = 0, peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async value => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return value * 2; });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

// ------------------------------------------------------------------ harness

const ratings = (payload, severity = 'medium') => JSON.stringify({ status: 'COMPLETE', report: '',
  ratings: payload.assignment.findingIds.map(id => ({ id, severity, reason: 'Fixture rating.' })) });
const noDuplicates = async () => JSON.stringify({ status: 'COMPLETE', merged: [], report: '' });

/**
 * One review with scripted sessions. `behave({ role, pass, payload, turn, repair, read, calls })` answers a
 * reviewer's turn and calls `read(path, side)` for what that session's own tools showed; `dedupe` answers the
 * duplicate check (none merged unless a test says so) and `rate` the severity rating (every finding stays
 * medium, as the fixtures file it). `models` is the mode's entry of settings.models; one reviewer by default.
 */
async function context(t, { files, workflow = {}, mode = 'review', models = { reviewers: ['p/a'] }, changes, missing, binary, sources, behave, dedupe = noDuplicates, rate = async ({ payload }) => ratings(payload) }) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-review-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const azure = fakeAzure({ files, changes, missing, binary, sources });
  const client = createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 3, timeoutMs: 1000 }), fetch: azure.fetch, retryDelayMs: 1 });
  const settings = validateSettings({ version: 3, models: { review: { reviewers: ['p/review'] }, [mode]: models }, workflow, azure: { organization: 'org', pat: FAKE_PAT } });
  const store = await createCommentData({ root: directory });
  const calls = [], notices = [];
  const run = { id: 'run12345', profile: mode, active: true, controller: new AbortController(), stages: [] };
  const answers = { review: behave, dedupe, rating: rate };
  const runStage = async (stageRun, role, payload, handler, options) => {
    const call = { role, payload, label: options.label, reads: new Set(), repairs: [] };
    calls.push(call);
    const read = (path, side = 'head') => call.reads.add(`${side === 'base' ? azure.state.base : azure.state.head}\n${path}`);
    let evaluation;
    for (let turn = 0; ; turn++) {
      const text = await answers[ROLES[role].kind]({ role, pass: reviewerRoles(settings, mode).indexOf(role), payload, turn, repair: evaluation?.repairPrompt, read, calls });
      evaluation = await handler.evaluate(text, evaluation?.result, { reads: call.reads });
      if (!evaluation.issues?.length || turn >= settings.workflow.repairAttempts) break;
      call.repairs.push(evaluation.repairPrompt);
    }
    return evaluation.result;
  };
  const ctx = { azure: client, runStage, progress: (_run, message) => notices.push(message), settings, dataFor: async () => store };
  const of = kind => calls.filter(call => ROLES[call.role].kind === kind);
  return { ctx, run, azure, calls, of, notices, request: { prUrl: azure.prUrl(), userContext: '', target: parsePullRequestUrl(azure.prUrl()) } };
}
const answer = (payload, findings, extra = {}) => JSON.stringify({ status: 'COMPLETE', coverage: { files: payload.assignment.files, gaps: [] }, additionalFiles: [], findings, report: `Checked ${payload.assignment.shard}`, ...extra });
const finding = (id, location, summary = `Defect ${id}`, extra = {}) => ({ id, summary, location, evidence: 'HEAD `x` drops the guard; BASE kept it.', counterevidence: 'No caller re-checks.', severity: 'medium', suggestion: 'Restore the guard; add a regression case.', ...extra });
/** A reviewer that reads its files and files what `find(payload, pass)` returns. */
const reviewer = find => async ({ payload, pass, read }) => {
  for (const path of payload.assignment.files) read(path);
  return answer(payload, find(payload, pass));
};
const rows = final => final.dispositions.map(d => `${d.id}:${d.status}${d.mergedInto ? `>${d.mergedInto}` : ''}`);
const lines = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

// ------------------------------------------------------------------ passes, sessions and IDs

test('one pass: one reviewer session per shard, findings reported as their reviewer checked them, nothing verified', async t => {
  const f = await context(t, { mode: 'quick', models: { reviewers: ['p/q'] }, files: ['/a/1.ts', '/a/2.ts', '/b/1.ts'], workflow: { shardFiles: 2 },
    behave: reviewer(payload => [finding('F-1', `head:${payload.assignment.files[0]}:1`)]) });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(f.calls.map(call => [call.role, call.label]), [['azpr-quick-reviewer', 'shard 1/2'], ['azpr-quick-reviewer', 'shard 2/2'], ['azpr-quick-rating', '']]);
  // Every session numbers its own findings in its shard's range; the review's IDs are the runtime's.
  assert.deepEqual(f.of('review').map(call => [call.payload.assignment.shard, call.payload.assignment.firstFindingId]), [['1/2', 'F-1001'], ['2/2', 'F-2001']]);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.verification, 'none');
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}:${d.inline}:${d.shard}:${d.pass}:${d.localId}`), ['F-1:REPORTED:true:1/2:1:F-1', 'F-2:REPORTED:true:2/2:1:F-1']);
  assert.deepEqual(final.dispositions.map(d => d.sessions), [['1/2'], ['2/2']]);
  assert.ok(final.dispositions.every(d => !d.verifiedFinding && d.finding.location && !Object.hasOwn(d.finding, 'id') && d.reason === REPORTED_REASON && d.reviewerSeverity === 'medium'));
  assert.match(REPORTED_REASON, /^Reported by its reviewer, which checked it against the source it read; .* No separate verification ran\.$/);
  assert.deepEqual(final.findings.map(x => [x.id, x.origin, x.location]), [['F-1', 'azpr-quick-reviewer', 'head:/a/1.ts:1'], ['F-2', 'azpr-quick-reviewer', 'head:/b/1.ts:1']]);
  assert.deepEqual(final.newFindings, []);
  assert.deepEqual(final.coverageSummary, { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [], files: 3, passes: 1, reviewedOnce: 3, reviewedByAll: 3, failedSessions: 0 });
  assert.deepEqual(final.coverage, { 'azpr-quick-reviewer': { assigned: 3, covered: 3, failedFiles: [], gaps: [] } });
  assert.match(final.report, /^### shard 1\/2\n\nChecked 1\/2\n\n### shard 2\/2\n\nChecked 2\/2$/);
  // Each file's findings come from one session: nothing to compare, so no duplicate check. The rating runs.
  assert.deepEqual(final.shards, { initial: 2, passes: 1, duplicateChecks: 0, ratings: 1 });
  assert.deepEqual(final.method, { kind: 'reviewers', version: 1, requested: ['p/q'], passes: [{ pass: 1, model: 'p/q', sessions: 2, failed: 0 }],
    duplicateCheck: { groups: 0, failed: 0, merged: 0, refused: 0 }, rating: { state: 'first', model: 'p/q', sessions: 1, failed: 0, rated: 2, kept: 0 } });
  assert.deepEqual(f.notices.filter(message => /^Review/.test(message)), ['Review: 2 session(s) for 2 shard(s); no separate verification follows.',
    'Review finished: 2 reported finding(s), 0 need more information; 3/3 file(s) reviewed.']);
  assert.deepEqual(final.reviewWarnings, []);
  assert.deepEqual(final.initialObservations, [], 'A complete review needs no draft of unchecked observations.');
});

test('several passes: every pass reviews every shard in a session of its own, with the model of its position', async t => {
  const files = ['/a/1.ts', '/a/2.ts', '/b/1.ts', '/b/2.ts', '/c.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 2 }, models: { reviewers: ['p/a', 'q/b#high'] },
    behave: reviewer((payload, pass) => [finding('F-1', `head:${payload.assignment.files[0]}:1`, `Pass ${pass + 1} on ${payload.assignment.files[0]}`)]) });
  const final = await runReview(f.ctx, f.run, f.request);
  const sessions = f.of('review');
  assert.deepEqual(sessions.map(call => [call.role, call.label]), [
    ['azpr-review-reviewer', 'pass 1/2 shard 1/3'], ['azpr-review-reviewer', 'pass 1/2 shard 2/3'], ['azpr-review-reviewer', 'pass 1/2 shard 3/3'],
    ['azpr-review-reviewerb', 'pass 2/2 shard 1/3'], ['azpr-review-reviewerb', 'pass 2/2 shard 2/3'], ['azpr-review-reviewerb', 'pass 2/2 shard 3/3']]);
  for (const role of ['azpr-review-reviewer', 'azpr-review-reviewerb']) {
    assert.deepEqual(sessions.filter(call => call.role === role).map(call => call.payload.assignment.files), [['/a/1.ts', '/a/2.ts'], ['/b/1.ts', '/b/2.ts'], ['/c.ts']], role);
  }
  // A pass receives the same input as any other: nothing says which pass it is or what another one found.
  assert.deepEqual(sessions[3].payload, sessions[0].payload);
  assert.deepEqual(Object.keys(sessions[0].payload.assignment).sort(), ['changes', 'discoverFiles', 'files', 'firstFindingId', 'shard']);
  // The findings are numbered by place, then by pass: both passes' findings on a file are neighbours.
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}:${d.finding.location}:${d.shard}:${d.pass}`), [
    'F-1:REPORTED:head:/a/1.ts:1:1/3 pass 1:1', 'F-2:REPORTED:head:/a/1.ts:1:1/3 pass 2:2', 'F-3:REPORTED:head:/b/1.ts:1:2/3 pass 1:1',
    'F-4:REPORTED:head:/b/1.ts:1:2/3 pass 2:2', 'F-5:REPORTED:head:/c.ts:1:3/3 pass 1:1', 'F-6:REPORTED:head:/c.ts:1:3/3 pass 2:2']);
  assert.deepEqual(final.findings.map(x => x.origin), ['azpr-review-reviewer', 'azpr-review-reviewerb', 'azpr-review-reviewer', 'azpr-review-reviewerb', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.verification, 'none');
  assert.deepEqual(final.coverage, { 'azpr-review-reviewer': { assigned: 5, covered: 5, failedFiles: [], gaps: [] }, 'azpr-review-reviewerb': { assigned: 5, covered: 5, failedFiles: [], gaps: [] } });
  assert.deepEqual(final.coverageSummary, { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [], files: 5, passes: 2, reviewedOnce: 5, reviewedByAll: 5, failedSessions: 0 });
  // Three files hold findings of two sessions each: one duplicate check per file, by the first reviewer's model.
  assert.deepEqual(f.of('dedupe').map(call => [call.role, call.label, call.payload.assignment.file]), [['azpr-review-dedupe', '1/3', '/a/1.ts'], ['azpr-review-dedupe', '2/3', '/b/1.ts'], ['azpr-review-dedupe', '3/3', '/c.ts']]);
  assert.deepEqual(final.shards, { initial: 3, passes: 2, duplicateChecks: 3, ratings: 1 });
  assert.deepEqual(final.method, { kind: 'reviewers', version: 1, requested: ['p/a', 'q/b#high'],
    passes: [{ pass: 1, model: 'p/a', sessions: 3, failed: 0 }, { pass: 2, model: 'q/b#high', sessions: 3, failed: 0 }],
    duplicateCheck: { groups: 3, failed: 0, merged: 0, refused: 0 }, rating: { state: 'first', model: 'p/a', sessions: 1, failed: 0, rated: 6, kept: 0 } });
  assert.match(final.report, /^### pass 1\/2 shard 1\/3\n\nChecked 1\/3\n\n[\s\S]*### pass 2\/2 shard 3\/3\n\nChecked 3\/3$/);
  assert.deepEqual(f.notices.filter(message => /^Review/.test(message)), ['Review: 6 session(s) for 3 shard(s) in 2 independent passes; no separate verification follows.',
    'Review finished: 6 reported finding(s), 0 need more information; 5/5 file(s) reviewed, 5/5 in every pass.']);
  assert.deepEqual(final.initialReports.map(report => [report.role, report.shard, report.pass, report.files, report.usable]).slice(2, 4), [['azpr-review-reviewer', '3/3', 1, 1, true], ['azpr-review-reviewerb', '1/3', 2, 2, true]]);
});

test('the session limit holds for the whole review, not per pass; four passes of one model are four independent sessions per shard', async t => {
  let active = 0, peak = 0;
  const f = await context(t, { files: ['/a.ts', '/b.ts', '/c.ts'], workflow: { shardFiles: 1, parallelSessions: 2 }, models: { reviewers: ['p/a', 'p/a', 'p/a', 'p/a'], rater: false },
    behave: async ({ payload, read }) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 3));
      active--;
      read(payload.assignment.files[0]);
      return answer(payload, []);
    } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.of('review').length, 12);
  assert.equal(peak, 2, 'workflow.parallelSessions bounds the sessions of all passes together.');
  assert.deepEqual(f.of('review').map(call => call.role).filter((role, index, all) => all.indexOf(role) === index), ['azpr-review-reviewer', 'azpr-review-reviewerb', 'azpr-review-reviewerc', 'azpr-review-reviewerd']);
  assert.deepEqual(final.method.passes.map(pass => [pass.pass, pass.model, pass.sessions]), [[1, 'p/a', 3], [2, 'p/a', 3], [3, 'p/a', 3], [4, 'p/a', 3]]);
  assert.deepEqual(final.method.requested, ['p/a', 'p/a', 'p/a', 'p/a']);
  assert.deepEqual([final.status, final.dispositions, final.coverageSummary.reviewedByAll], ['COMPLETE', [], 3]);
});

test('finding IDs follow place and source: neither the order sessions finish in nor the IDs a model wrote changes them', async t => {
  const files = ['/src/a.ts', '/src/b.ts', '/src/gone.ts'];
  const options = delays => ({ files, workflow: { shardFiles: 2 }, models: { reviewers: ['p/a', 'p/b'] }, changes: { '/src/gone.ts': { changeType: 'delete' } },
    missing: [`${'b'.repeat(40)}:/src/gone.ts`], sources: { '/src/a.ts': lines(20), '/src/b.ts': lines(20) },
    behave: async ({ payload, pass, read }) => {
      for (const path of payload.assignment.files) read(path, path === '/src/gone.ts' ? 'base' : 'head');
      await new Promise(resolve => setTimeout(resolve, delays[`${pass}:${payload.assignment.shard}`]));
      // What the models call their findings is theirs: repeated, foreign and missing IDs.
      const found = payload.assignment.shard === '2/2' ? [finding('F-1', 'base:/src/gone.ts:1', `Removed guard, pass ${pass + 1}`)]
        : pass === 0 ? [finding('F-7', 'head:/src/b.ts:4', 'b4 pass 1'), finding('F-7', 'head:/src/a.ts:9-12', 'a9-12 pass 1'), finding(undefined, 'head:/src/a.ts:9', 'a9 pass 1, second in its answer'), finding('X-1', 'head:/src/a.ts:9', 'a9 pass 1, first in its answer... listed third')]
          : [finding('Q-1001', 'head:/src/a.ts:9', 'a9 pass 2'), finding('F-2', 'head:/src/a.ts:2-30', 'a2-30 pass 2: out of range'), finding('F-3', 'head:/src/b.ts:4', 'b4 pass 2'), finding('F-4', 'somewhere in the service', 'no location pass 2')];
      return answer(payload, found);
    } });
  const expected = [
    // HEAD before BASE; within a side by path, first line, last line, pass, shard, then the place in the answer.
    ['F-1', 'head:/src/a.ts:2-30', 'a2-30 pass 2: out of range', 'NEEDS_INFO'],
    ['F-2', 'head:/src/a.ts:9', 'a9 pass 1, second in its answer', 'REPORTED'],
    ['F-3', 'head:/src/a.ts:9', 'a9 pass 1, first in its answer... listed third', 'REPORTED'],
    ['F-4', 'head:/src/a.ts:9', 'a9 pass 2', 'REPORTED'],
    ['F-5', 'head:/src/a.ts:9-12', 'a9-12 pass 1', 'REPORTED'],
    ['F-6', 'head:/src/b.ts:4', 'b4 pass 1', 'REPORTED'],
    ['F-7', 'head:/src/b.ts:4', 'b4 pass 2', 'REPORTED'],
    ['F-8', 'base:/src/gone.ts:1', 'Removed guard, pass 1', 'REPORTED'],
    ['F-9', 'base:/src/gone.ts:1', 'Removed guard, pass 2', 'REPORTED'],
    // A finding whose location cannot be read as one comes last.
    ['F-10', 'somewhere in the service', 'no location pass 2', 'NEEDS_INFO'],
  ];
  const results = [];
  for (const delays of [{ '0:1/2': 1, '0:2/2': 9, '1:1/2': 18, '1:2/2': 27 }, { '0:1/2': 27, '0:2/2': 18, '1:1/2': 9, '1:2/2': 1 }, { '0:1/2': 9, '0:2/2': 1, '1:1/2': 1, '1:2/2': 18 }]) {
    const f = await context(t, options(delays));
    const final = await runReview(f.ctx, f.run, f.request);
    assert.deepEqual(final.dispositions.map(d => [d.id, (d.finding ?? d.partialFinding).location, (d.finding ?? d.partialFinding).summary, d.status]), expected);
    assert.deepEqual(final.findings.map(x => x.id), expected.map(([id]) => id));
    results.push({ dispositions: final.dispositions, findings: final.findings, method: final.method, coverageSummary: final.coverageSummary,
      dedupe: f.of('dedupe').map(call => call.payload.assignment), rating: f.of('rating').map(call => call.payload.assignment) });
  }
  assert.deepEqual(results[1], results[0], 'The same answers give the same review, whatever order they arrive in.');
  assert.deepEqual(results[2], results[0]);
  // The duplicate checks and the rating receive the review's IDs in that order as well.
  assert.deepEqual(results[0].dedupe.map(assignment => [assignment.side, assignment.file, assignment.findingIds]), [['base', '/src/gone.ts', ['F-8', 'F-9']], ['head', '/src/a.ts', ['F-2', 'F-3', 'F-4', 'F-5']], ['head', '/src/b.ts', ['F-6', 'F-7']]]);
  assert.deepEqual(results[0].rating.map(assignment => assignment.findingIds), [['F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9']]);
  // The IDs the answers used stay on record, as each answer's own (a repeated, foreign or missing one was renumbered within its answer).
  assert.deepEqual(results[0].dispositions.map(d => d.localId), ['F-2', 'F-2', 'F-3', 'F-1', 'F-1', 'F-7', 'F-3', 'F-1', 'F-1', 'F-4']);
});

test('a shard that overflows its context is split in half, and both halves stay parts of their pass', async t => {
  const files = ['/a.ts', '/b.ts', '/c.ts', '/d.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 4 }, models: { reviewers: ['p/a', 'p/b'], rater: false }, behave: async ({ role, payload, pass, read }) => {
    if (role === 'azpr-review-reviewer' && payload.assignment.files.length > 2) throw Object.assign(new Error('compaction refused'), { failureClass: 'overflow' });
    for (const path of payload.assignment.files) read(path);
    return answer(payload, [finding('F-1', `head:${payload.assignment.files.at(-1)}:1`, `Pass ${pass + 1} ${payload.assignment.shard}`)]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(f.calls.filter(call => call.role === 'azpr-review-reviewer').map(call => [call.label, call.payload.assignment.shard, call.payload.assignment.files.length]),
    [['pass 1/2', '1/1', 4], ['pass 1/2 shard 1/1a', '1/1a', 2], ['pass 1/2 shard 1/1b', '1/1b', 2]]);
  assert.deepEqual(f.calls.filter(call => call.role === 'azpr-review-reviewerb').map(call => [call.label, call.payload.assignment.files.length]), [['pass 2/2', 4]]);
  assert.deepEqual(final.coverage['azpr-review-reviewer'], { assigned: 4, covered: 4, failedFiles: [], gaps: [] });
  assert.deepEqual(final.coverageSummary, { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [], files: 4, passes: 2, reviewedOnce: 4, reviewedByAll: 4, failedSessions: 0 });
  assert.deepEqual(final.method.passes, [{ pass: 1, model: 'p/a', sessions: 2, failed: 0 }, { pass: 2, model: 'p/b', sessions: 1, failed: 0 }]);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.finding.location}:${d.shard}`), ['F-1:head:/b.ts:1:1/1a pass 1', 'F-2:head:/d.ts:1:1/1b pass 1', 'F-3:head:/d.ts:1:1/1 pass 2']);
  assert.ok(f.notices.includes('Review pass 1/2 reached its context limit on 4 files; splitting the shard in two.'), JSON.stringify(f.notices));
  // A single file cannot be split: its session fails like any other.
  const one = await context(t, { files: ['/a.ts'], behave: async () => { throw Object.assign(new Error('compaction refused'), { failureClass: 'overflow' }); } });
  await assert.rejects(runReview(one.ctx, one.run, one.request), /Every review session failed: compaction refused/);
});

test('a shard whose answer reaches the model\'s output limit is split in half as well; one file is not split', async t => {
  const files = ['/a.ts', '/b.ts', '/c.ts', '/d.ts'];
  const limit = () => Object.assign(new Error('A response of this turn reached the model\'s output limit (finish=length).'), { failureClass: 'output-limit' });
  const f = await context(t, { files, workflow: { shardFiles: 4 }, models: { reviewers: ['p/a', 'p/b'], rater: false }, behave: async ({ role, payload, pass, read }) => {
    if (role === 'azpr-review-reviewer' && payload.assignment.files.length > 2) throw limit();
    for (const path of payload.assignment.files) read(path);
    return answer(payload, [finding('F-1', `head:${payload.assignment.files.at(-1)}:1`, `Pass ${pass + 1} ${payload.assignment.shard}`)]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(f.calls.filter(call => call.role === 'azpr-review-reviewer').map(call => [call.label, call.payload.assignment.files.length]),
    [['pass 1/2', 4], ['pass 1/2 shard 1/1a', 2], ['pass 1/2 shard 1/1b', 2]]);
  assert.deepEqual(final.coverage['azpr-review-reviewer'], { assigned: 4, covered: 4, failedFiles: [], gaps: [] });
  assert.ok(f.notices.includes('Review pass 1/2 reached the model\'s output limit in its answer on 4 files; splitting the shard in two.'), JSON.stringify(f.notices));
  const one = await context(t, { files: ['/a.ts'], behave: async () => { throw limit(); } });
  await assert.rejects(runReview(one.ctx, one.run, one.request), /Every review session failed: A response of this turn reached the model's output limit/);
  assert.equal(one.calls.filter(call => call.role === 'azpr-review-reviewer').length, 1, 'One file is not split.');
});

test('only a changed source commit makes a review STALE; a moved base is a warning', async t => {
  const behave = reviewer(() => [finding('F-1', 'head:/src/a.ts:1')]);
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
  assert.deepEqual(rows(stale), ['F-1:REPORTED'], 'The findings stay on record; the status keeps them from being commented on.');
  assert.equal(stale.initialObservations.length, 1);
});

test('a session that fails costs its files in its pass only; a review whose every session fails has no result', async t => {
  const files = ['/a.ts', '/b.ts'];
  const f = await context(t, { files, workflow: { shardFiles: 1 }, models: { reviewers: ['p/a', 'p/b'] }, behave: async ({ payload, pass, read }) => {
    if (pass === 1 && payload.assignment.files[0] === '/b.ts') throw new Error('provider 401');
    read(payload.assignment.files[0]);
    return answer(payload, pass === 0 ? [finding('F-1', `head:${payload.assignment.files[0]}:1`)] : []);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(final.status, 'COMPLETE');
  assert.deepEqual(rows(final), ['F-1:REPORTED', 'F-2:REPORTED'], 'The other sessions\' work is kept.');
  assert.deepEqual(final.coverage['azpr-review-reviewerb'], { assigned: 2, covered: 1, failedFiles: ['/b.ts'], gaps: [] });
  assert.deepEqual(final.reviewWarnings, ['The review pass 2/2 shard 2/2 failed (provider 401); its 1 file(s) were not reviewed in this pass.']);
  // /b.ts was reviewed once: no file is unreviewed, and the numbers say that one pass missed it.
  assert.deepEqual(final.coverageSummary, { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [], files: 2, passes: 2, reviewedOnce: 2, reviewedByAll: 1, failedSessions: 1 });
  assert.deepEqual(final.method.passes, [{ pass: 1, model: 'p/a', sessions: 2, failed: 0 }, { pass: 2, model: 'p/b', sessions: 2, failed: 1 }]);
  assert.ok(f.notices.includes('Review finished: 2 reported finding(s), 0 need more information; 2/2 file(s) reviewed, 1/2 in every pass.'));
  // Every session of one pass fails: the review is the other pass's.
  const lost = await context(t, { files, models: { reviewers: ['p/a', 'p/b'], rater: false }, behave: async ({ payload, pass, read }) => {
    if (pass === 0) throw new Error('model unavailable');
    for (const path of payload.assignment.files) read(path);
    return answer(payload, [finding('F-1', 'head:/a.ts:2')]);
  } });
  const half = await runReview(lost.ctx, lost.run, lost.request);
  assert.deepEqual([half.status, rows(half), half.coverageSummary.complete, half.coverageSummary.reviewedOnce, half.coverageSummary.reviewedByAll], ['COMPLETE', ['F-1:REPORTED'], true, 2, 0]);
  assert.deepEqual(half.method.passes, [{ pass: 1, model: 'p/a', sessions: 1, failed: 1 }, { pass: 2, model: 'p/b', sessions: 1, failed: 0 }]);
  assert.deepEqual(half.reviewWarnings, ['The review pass 1/2 failed (model unavailable); its 2 file(s) were not reviewed in this pass.']);
  const broken = await context(t, { files: ['/a.ts'], models: { reviewers: ['p/a', 'p/b'] }, behave: async () => { throw new Error('all down'); } });
  await assert.rejects(runReview(broken.ctx, broken.run, broken.request), /^Error: Every review session failed: all down$/);
  assert.deepEqual(broken.of('dedupe').length + broken.of('rating').length, 0);
});

// ------------------------------------------------------------------ duplicates

// Pass 1 files two findings in /src/a.ts (lines 1 and 2); pass 2 files one on line 1 in other words.
const twice = (extra = {}) => ({ files: ['/src/a.ts'], models: { reviewers: ['p/a', 'p/b'] }, ...extra,
  behave: reviewer((payload, pass) => pass === 0
    ? [finding('F-1', 'head:/src/a.ts:1', 'The guard is dropped'), finding('F-2', 'head:/src/a.ts:2', 'The retry runs twice', { severity: 'low' })]
    : [finding('F-1', 'head:/src/a.ts:1', 'Missing guard before the call', { severity: 'high' })]) });

test('findings that different sessions reported in one file get a duplicate check, which only merges', async t => {
  const f = await context(t, twice({ dedupe: async ({ payload, role }) => {
    assert.equal(role, 'azpr-review-dedupe');
    assert.deepEqual({ ...payload.assignment, findings: undefined }, { kind: 'duplicates', file: '/src/a.ts', side: 'head', findingIds: ['F-1', 'F-2', 'F-3'], findings: undefined });
    // Each finding as its reviewer wrote it, with the review's ID and the session that reported it.
    assert.deepEqual(payload.assignment.findings.map(x => [x.id, x.session, x.summary, x.location]), [['F-1', '1/1 pass 1', 'The guard is dropped', 'head:/src/a.ts:1'],
      ['F-2', '1/1 pass 2', 'Missing guard before the call', 'head:/src/a.ts:1'], ['F-3', '1/1 pass 1', 'The retry runs twice', 'head:/src/a.ts:2']]);
    assert.deepEqual(Object.keys(payload).sort(), ['assignment', 'outputLanguage', 'prUrl', 'snapshot', 'userContext']);
    return JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same cause and fix.' }], report: 'F-2 repeats F-1.' });
  } }));
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(rows(final), ['F-1:REPORTED', 'F-2:MERGED>F-1', 'F-3:REPORTED']);
  const [kept, merged, other] = final.dispositions;
  assert.equal(merged.reason, 'Same cause and fix. [Runtime: merged by the duplicate check of independent reviewer sessions.]');
  assert.equal(merged.mergedFinding.summary, 'Missing guard before the call');
  assert.deepEqual([Object.hasOwn(merged, 'finding'), Object.hasOwn(merged, 'inline')], [false, false]);
  // The finding that stays keeps its own text and says what it stands for: the other report, its session and the level it had.
  assert.equal(kept.finding.summary, 'The guard is dropped');
  assert.deepEqual(kept.sessions, ['1/1 pass 1', '1/1 pass 2']);
  assert.deepEqual(kept.alsoReported, [{ id: 'F-2', sessions: ['1/1 pass 2'], severity: 'high' }]);
  assert.deepEqual([other.sessions, other.alsoReported], [['1/1 pass 1'], undefined]);
  assert.deepEqual(f.of('dedupe').map(call => [call.role, call.label, call.repairs.length]), [['azpr-review-dedupe', '', 0]]);
  assert.match(final.report, /### Duplicate check: \/src\/a\.ts\n\nF-2 repeats F-1\./);
  assert.deepEqual(final.method.duplicateCheck, { groups: 1, failed: 0, merged: 1, refused: 0 });
  assert.equal(final.shards.duplicateChecks, 1);
  assert.deepEqual(f.notices.filter(message => /^Duplicate check/.test(message)), ['Duplicate check: 1 file(s) hold findings from more than one reviewer session.',
    'Duplicate check finished: 1 finding(s) merged into another session\'s finding.']);
  // Only what is still reported is rated: the merged finding is not.
  assert.deepEqual(f.of('rating')[0].payload.assignment.findingIds, ['F-1', 'F-3']);
  assert.deepEqual(final.reviewWarnings, []);
  assert.equal(final.status, 'COMPLETE');
});

test('the duplicate check never puts two findings of one session into one finding; what it gets wrong is left unmerged', async t => {
  // F-1 and F-3 are pass 1's two findings. The check insists on merging them, in every correction turn.
  const direct = await context(t, twice({ dedupe: async () => JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-3', mergedInto: 'F-1', reason: 'Both are about the call.' }], report: '' }) }));
  const kept = await runReview(direct.ctx, direct.run, direct.request);
  assert.deepEqual(rows(kept), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED']);
  const [check] = direct.of('dedupe');
  assert.equal(check.repairs.length, 2, 'The refused merge got both correction turns.');
  assert.match(check.repairs[0], /^AZPR runtime: your duplicate check needs correction\.\n- F-3 into F-1: F-3 and F-1 were both reported by the session "1\/1 pass 1", which filed them as separate findings/);
  assert.deepEqual(kept.method.duplicateCheck, { groups: 1, failed: 0, merged: 0, refused: 1 });
  assert.deepEqual(kept.reviewWarnings, ['Duplicate check of /src/a.ts: Some duplicate-check merges were invalid and were not applied (1 would have joined two findings of one reviewer session); those findings stay reported.']);
  // Through a third finding: pass 2's finding joins F-1, so pass 1's other finding may not join it afterwards.
  const through = await context(t, twice({ dedupe: async () => JSON.stringify({ status: 'COMPLETE', report: '',
    merged: [{ id: 'F-1', mergedInto: 'F-2', reason: 'Same guard.' }, { id: 'F-3', mergedInto: 'F-2', reason: 'Same call.' }] }) }));
  const partly = await runReview(through.ctx, through.run, through.request);
  assert.deepEqual(rows(partly), ['F-1:MERGED>F-2', 'F-2:REPORTED', 'F-3:REPORTED'], 'The merge that is allowed is applied; the other finding stays.');
  assert.deepEqual(partly.dispositions[1].alsoReported, [{ id: 'F-1', sessions: ['1/1 pass 1'], severity: 'medium' }]);
  assert.deepEqual(partly.method.duplicateCheck, { groups: 1, failed: 0, merged: 1, refused: 1 });
  // A correction turn that drops the refused merge leaves no warning.
  const corrected = await context(t, twice({ dedupe: async ({ turn }) => JSON.stringify({ status: 'COMPLETE', report: '',
    merged: turn ? [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same guard.' }] : [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same guard.' }, { id: 'F-3', mergedInto: 'F-1', reason: 'Same call.' }] }) }));
  const clean = await runReview(corrected.ctx, corrected.run, corrected.request);
  assert.deepEqual([rows(clean), clean.reviewWarnings, clean.method.duplicateCheck], [['F-1:REPORTED', 'F-2:MERGED>F-1', 'F-3:REPORTED'], [], { groups: 1, failed: 0, merged: 1, refused: 0 }]);
});

test('a failed duplicate check keeps every finding; findings of one session alone are not checked', async t => {
  const failed = await context(t, twice({ dedupe: async () => { throw new Error('dedupe crashed'); } }));
  const kept = await runReview(failed.ctx, failed.run, failed.request);
  assert.deepEqual(rows(kept), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED']);
  assert.deepEqual(kept.reviewWarnings, ['The duplicate check of /src/a.ts failed (dedupe crashed); its 3 findings stay reported and may include duplicates.']);
  assert.deepEqual(kept.method.duplicateCheck, { groups: 1, failed: 1, merged: 0, refused: 0 });
  assert.equal(kept.status, 'COMPLETE');
  assert.equal(failed.of('rating').length, 1, 'The rating still runs.');
  // Prose instead of JSON, also after the correction turns: nothing is merged, and the report says so.
  const prose = await context(t, twice({ dedupe: async () => 'F-2 repeats F-1.' }));
  const unmerged = await runReview(prose.ctx, prose.run, prose.request);
  assert.deepEqual(rows(unmerged), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED']);
  assert.deepEqual(unmerged.reviewWarnings, ['Duplicate check of /src/a.ts: The duplicate check gave no usable answer; no finding was merged.']);
  assert.deepEqual(unmerged.method.duplicateCheck, { groups: 1, failed: 1, merged: 0, refused: 0 }, 'An answer without usable JSON compared nothing: the check failed.');
  // JSON without a list of merges, also after the correction turns, decided nothing either: an empty list would
  // have said that nothing repeats, a missing one says nothing.
  const silent = await context(t, twice({ dedupe: async () => JSON.stringify({ status: 'COMPLETE' }) }));
  const undecided = await runReview(silent.ctx, silent.run, silent.request);
  assert.deepEqual([rows(undecided), undecided.method.duplicateCheck, silent.of('dedupe').length, silent.of('dedupe')[0].repairs.length],
    [['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED'], { groups: 1, failed: 1, merged: 0, refused: 0 }, 1, 2]);
  assert.match(silent.of('dedupe')[0].repairs[0], /"merged" must be an array/);
  // A merge written as a single object, or as a list inside a string, is no list of merges either: it merges nothing,
  // however it could be read as one.
  for (const merged of [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same defect.' }, JSON.stringify([{ id: 'F-2', mergedInto: 'F-1', reason: 'Same defect.' }])]) {
    const odd = await context(t, twice({ dedupe: async () => JSON.stringify({ status: 'COMPLETE', merged, report: '' }) }));
    const kept = await runReview(odd.ctx, odd.run, odd.request);
    assert.deepEqual([rows(kept), kept.method.duplicateCheck, odd.of('dedupe')[0].repairs.length],
      [['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED'], { groups: 1, failed: 1, merged: 0, refused: 0 }, 2], typeof merged);
  }
  // A reason that is not text is none: that merge is left out, and the check stands for what it decided.
  for (const reason of [false, [], { why: 'same' }]) {
    const odd = await context(t, twice({ dedupe: async () => JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-2', mergedInto: 'F-1', reason }], report: '' }) }));
    const kept = await runReview(odd.ctx, odd.run, odd.request);
    assert.deepEqual([rows(kept), kept.method.duplicateCheck], [['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED'], { groups: 1, failed: 0, merged: 0, refused: 0 }], JSON.stringify(reason));
    assert.match(odd.of('dedupe')[0].repairs[0], /merged\[0\]: give a concrete reason\./);
  }
  // A check whose input cannot be prepared (its private data write fails) fails alone: every finding stays and the rating runs.
  const unwritable = await context(t, twice({ dedupe: async () => { throw new Error('must not run'); } }));
  const store = await unwritable.ctx.dataFor();
  unwritable.ctx.dataFor = async () => ({ ...store, pack: async (value, size) => { if (size === 40000) throw new Error('disk full'); return store.pack(value, size); } });
  const prepared = await runReview(unwritable.ctx, unwritable.run, unwritable.request);
  assert.deepEqual([rows(prepared), prepared.method.duplicateCheck, unwritable.of('dedupe').length, unwritable.of('rating').length],
    [['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED'], { groups: 1, failed: 1, merged: 0, refused: 0 }, 0, 1]);
  assert.deepEqual(prepared.reviewWarnings, ['The duplicate check of /src/a.ts failed (disk full); its 3 findings stay reported and may include duplicates.']);
  // One session's two findings in a file are that reviewer's two findings: no check, whatever the number of passes.
  const alone = await context(t, { files: ['/src/a.ts', '/src/b.ts'], models: { reviewers: ['p/a', 'p/b'] }, dedupe: async () => { throw new Error('must not run'); },
    behave: reviewer((payload, pass) => pass === 0 ? [finding('F-1', 'head:/src/a.ts:1'), finding('F-2', 'head:/src/a.ts:1', 'Another defect on that line')] : [finding('F-1', 'head:/src/b.ts:1')]) });
  const same = await runReview(alone.ctx, alone.run, alone.request);
  assert.equal(alone.of('dedupe').length, 0);
  assert.deepEqual([same.shards.duplicateChecks, same.method.duplicateCheck, rows(same)], [0, { groups: 0, failed: 0, merged: 0, refused: 0 }, ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED']]);
  assert.equal(alone.notices.some(message => /Duplicate check/.test(message)), false);
});

test('a record merged as an exact duplicate into a finding the duplicate check merged in turn names the finding that stays', async t => {
  // Passes 1 and 2 file the very same record; pass 3 files the defect in other words. The runtime keeps one of the
  // identical records, and the duplicate check merges it into pass 3's.
  const f = await context(t, { files: ['/src/a.ts'], models: { reviewers: ['p/a', 'p/a', 'p/b'] },
    behave: reviewer((payload, pass) => [finding('F-1', 'head:/src/a.ts:1', pass < 2 ? 'The guard is dropped' : 'Missing guard before the call')]),
    dedupe: async ({ payload }) => {
      assert.deepEqual(payload.assignment.findings.map(x => [x.id, x.session]), [['F-1', '1/1 pass 1 + 1/1 pass 2'], ['F-3', '1/1 pass 3']]);
      return JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-1', mergedInto: 'F-3', reason: 'Same guard.' }], report: '' });
    } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(rows(final), ['F-1:MERGED>F-3', 'F-2:MERGED>F-3', 'F-3:REPORTED']);
  assert.equal(final.dispositions[1].reason, 'Identical in every field to F-1. [Runtime: exact duplicate.]', 'The reason still says what the record was identical to.');
  assert.deepEqual(final.dispositions[2].sessions, ['1/1 pass 3', '1/1 pass 1', '1/1 pass 2']);
});

test('duplicateGroups: reported findings on one side of one file, where two could be merged at all', () => {
  const row = (id, location, sessions, status = 'REPORTED') => ({ id, status, ...(status === 'REPORTED' ? { finding: { location } } : status === 'MERGED' ? { mergedFinding: { location } } : { partialFinding: { location } }), sessions });
  const groups = duplicateGroups([
    row('F-1', 'head:/src/b.ts:4', ['1/1 pass 1']), row('F-2', 'head:/src/b.ts:90-95', ['1/1 pass 2']),
    // BASE and HEAD of a path are different texts: their findings are never compared.
    row('F-3', 'base:/src/b.ts:4', ['1/1 pass 1']), row('F-4', 'head:/src/a.ts:1', ['1/1 pass 1']), row('F-5', 'base:/src/a.ts:1', ['1/1 pass 1']), row('F-6', 'base:/src/a.ts:7', ['1/1 pass 2']),
    // One session's findings alone, and findings that are not reported, make no group.
    row('F-7', 'head:/src/c.ts:1', ['1/1 pass 1']), row('F-8', 'head:/src/c.ts:2', ['1/1 pass 1']),
    row('F-9', 'head:/src/d.ts:1', ['1/1 pass 1']), row('F-10', 'head:/src/d.ts:1', ['1/1 pass 2'], 'NEEDS_INFO'), row('F-11', 'head:/src/d.ts:1', ['1/1 pass 2'], 'MERGED'),
    // A location without a side is HEAD's.
    row('F-12', '/src/e.ts:3', ['1/2']), row('F-13', 'head:/src/e.ts:8', ['2/2']),
  ]);
  assert.deepEqual(groups.map(group => [group.side, group.path, group.items.map(item => item.id)]), [['base', '/src/a.ts', ['F-5', 'F-6']], ['head', '/src/b.ts', ['F-1', 'F-2']], ['head', '/src/e.ts', ['F-12', 'F-13']]]);
  // A finding that stands for identical reports of two sessions shares each of them.
  const stands = row('F-1', 'head:/src/a.ts:1', ['1/1 pass 1', '1/1 pass 2']);
  assert.deepEqual(duplicateGroups([stands, row('F-2', 'head:/src/a.ts:2', ['1/1 pass 2'])]), [], 'Nothing here could be merged: no check.');
  assert.deepEqual(duplicateGroups([stands, row('F-2', 'head:/src/a.ts:2', ['1/1 pass 2']), row('F-3', 'head:/src/a.ts:3', ['1/1 pass 3'])]).map(group => group.items.map(item => item.id)), [['F-1', 'F-2', 'F-3']]);
  assert.deepEqual(duplicateGroups([]), []);
  assert.deepEqual(duplicateGroups([row('F-1', 'no place', ['1/1 pass 1']), row('F-2', 'no place', ['1/1 pass 2'])]), []);
});

test('where an answer names one of its own findings, it names that finding\'s review ID afterwards; code stays as written', async t => {
  // Two passes over one file; each pass's first finding names its second by the ID the answer gave it, in its text and
  // in quoted source, and its notes and gaps name both.
  const f = await context(t, { files: ['/src/a.ts'], sources: { '/src/a.ts': lines(20) }, models: { reviewers: ['p/a', 'p/b'] }, behave: async ({ payload, pass, read }) => {
    read('/src/a.ts');
    const [first, second] = [payload.assignment.firstFindingId, `F-${Number(payload.assignment.firstFindingId.slice(2)) + 1}`];
    assert.equal(first, 'F-1001', 'Every pass of the shard gets its range.');
    return answer(payload, [finding(first, `head:/src/a.ts:${pass ? 9 : 3}`, `Pass ${pass + 1}: the cause of ${second}`,
      { evidence: `See ${second}; the source has \`case "F-1001":\`, and the table has "F-1002" as a key.\n\n\`\`\`ts\nconst next = F-1002;\n\`\`\`` }),
    finding(second, `head:/src/a.ts:${pass ? 12 : 6}`, `Pass ${pass + 1}: the effect`)], { report: `${first} and ${second} are one chain.`, status: 'PARTIAL', coverage: { files: payload.assignment.files, gaps: [`The callers of ${second} were not read.`] } });
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  // By place: pass 1's findings on lines 3 and 6 are F-1 and F-2, pass 2's on lines 9 and 12 are F-3 and F-4. Each
  // answer's references name its own findings' review IDs; a code span, a fenced block and an ID between quotes stay
  // as written, and the answer's own IDs stay on record beside the review's.
  const quoted = '; the source has `case "F-1001":`, and the table has "F-1002" as a key.\n\n```ts\nconst next = F-1002;\n```';
  assert.deepEqual(final.dispositions.map(d => [d.id, d.localId, d.finding.summary, d.finding.evidence]), [
    ['F-1', 'F-1001', 'Pass 1: the cause of F-2', `See F-2${quoted}`],
    ['F-2', 'F-1002', 'Pass 1: the effect', 'HEAD `x` drops the guard; BASE kept it.'],
    ['F-3', 'F-1001', 'Pass 2: the cause of F-4', `See F-4${quoted}`],
    ['F-4', 'F-1002', 'Pass 2: the effect', 'HEAD `x` drops the guard; BASE kept it.']]);
  assert.deepEqual(final.findings.map(row => row.summary), ['Pass 1: the cause of F-2', 'Pass 1: the effect', 'Pass 2: the cause of F-4', 'Pass 2: the effect']);
  assert.match(final.report, /### pass 1\/2\n\nF-1 and F-2 are one chain\.\n\n### pass 2\/2\n\nF-3 and F-4 are one chain\./);
  assert.deepEqual(Object.values(final.coverage).map(entry => entry.gaps), [['The callers of F-2 were not read.'], ['The callers of F-4 were not read.']]);
  // What the later stages are given names the review's IDs too.
  assert.deepEqual(f.of('rating')[0].payload.assignment.findings.map(row => row.summary), ['Pass 1: the cause of F-2', 'Pass 1: the effect', 'Pass 2: the cause of F-4', 'Pass 2: the effect']);
  assert.ok(final.dispositions.every(d => !/^F-1\d{3}$/.test(d.id)), 'No review ID is one of a range.');
  // An answer that left its range and numbered from F-1 names its own findings by IDs that others have in the review:
  // they are its own, so they become its findings' review IDs.
  const left = await context(t, { files: ['/src/a.ts'], sources: { '/src/a.ts': lines(20) }, models: { reviewers: ['p/a', 'p/b'] }, behave: async ({ payload, pass, read }) => {
    read('/src/a.ts');
    return pass ? answer(payload, [finding('F-1', 'head:/src/a.ts:9', 'Pass 2 numbered from F-1'), finding('F-2', 'head:/src/a.ts:12', 'Caused by F-1')], { report: 'F-1 is the one that matters.' })
      : answer(payload, [finding(payload.assignment.firstFindingId, 'head:/src/a.ts:3', 'Pass 1 kept its range')], { report: 'Nothing else stood out.' });
  } });
  const outside = await runReview(left.ctx, left.run, left.request);
  assert.deepEqual(outside.dispositions.map(d => [d.id, d.localId, d.finding.summary]), [['F-1', 'F-1001', 'Pass 1 kept its range'], ['F-2', 'F-1', 'Pass 2 numbered from F-2'], ['F-3', 'F-2', 'Caused by F-2']]);
  assert.match(outside.report, /### pass 1\/2\n\nNothing else stood out\.\n\n### pass 2\/2\n\nF-2 is the one that matters\./);
});

test('renameReferences: an answer\'s own IDs outside code become the review\'s; code, quoted IDs and other IDs stay', () => {
  const ids = new Map([['F-1001', 'F-1'], ['F-1002', 'F-2'], ['F-1', 'F-3']]);
  for (const [text, renamed] of [
    ['See F-1002; the source has `case "F-1001":`.', 'See F-2; the source has `case "F-1001":`.'],
    ['case "F-1001": and \'F-1002\' are literals; F-1002 and F-1001 are references.', 'case "F-1001": and \'F-1002\' are literals; F-2 and F-1 are references.'],
    ['```js\nconst id = F-1001;\n```\nAfter the block F-1001 and F-1.', '```js\nconst id = F-1001;\n```\nAfter the block F-1 and F-3.'],
    ['~~~\nF-1002 in a fence of tildes\n~~~\nthen F-1002', '~~~\nF-1002 in a fence of tildes\n~~~\nthen F-2'],
    ['A span of two: ``code `F-1001` inside`` then F-1001', 'A span of two: ``code `F-1001` inside`` then F-1'],
    ['An unclosed ` takes the rest as code: F-1001', 'An unclosed ` takes the rest as code: F-1001'],
    ['F-1001s F-10010 XF-1001 F-1001-x (F-1002), F-1002. F-1002\'s F-12', 'F-1001s F-10010 XF-1001 F-1001-x (F-2), F-2. F-2\'s F-12'],
    // Emphasis is no name: _F-1001_ is the ID, foo_F-1001 and F-1001_bar are names.
    ['Compare _F-1001_ and __F-1002__, not foo_F-1001 or F-1001_bar.', 'Compare _F-1_ and __F-2__, not foo_F-1001 or F-1001_bar.'],
    // A fence ends at a line of its own character, as long as its opening or longer, and nothing else.
    ['```js\nconst s = "```"; // F-1001\n```\nThen F-1001.', '```js\nconst s = "```"; // F-1001\n```\nThen F-1.'],
    ['```\ncode F-1002\n````\nAfter the block F-1002.', '```\ncode F-1002\n````\nAfter the block F-2.'],
    // An unclosed span is code to the end of its paragraph only; a text written next to the ID is no name.
    ['Inline `F-1001` and F-1002; unclosed ` F-1001\n\nNext paragraph F-1001.', 'Inline `F-1001` and F-1002; unclosed ` F-1001\n\nNext paragraph F-1.'.replace('and F-1002;', 'and F-2;')],
    ['見F-1002的說明。', '見F-2的說明。'],
    // Text with CRLF line ends keeps its fences; an escaped backtick opens no span; a hyphen next to an underscore
    // run makes the ID part of a name.
    ['~~~\r\nF-1002 in code\r\n~~~\r\nafter F-1002', '~~~\r\nF-1002 in code\r\n~~~\r\nafter F-2'],
    ['An escaped \\` then See F-1001.', 'An escaped \\` then See F-1.'],
    ['topic-_F-1001 and x-_F-1001_-y, but _F-1001_.', 'topic-_F-1001 and x-_F-1001_-y, but _F-1_.'],
  ]) assert.equal(renameReferences(text, ids), renamed, text);
  assert.deepEqual([renameReferences('F-1001', new Map()), renameReferences('F-1001', undefined), renameReferences(undefined, ids)], ['F-1001', 'F-1001', undefined]);
});

test('findings on the same line stay separate; only records identical in every field are removed, also across passes', async t => {
  const f = await context(t, { files: ['/src/pay.ts'], behave: reviewer(() => {
    const authz = finding('F-1', 'head:/src/pay.ts:1', 'The permission check runs after the charge');
    return [authz, finding('F-2', 'head:/src/pay.ts:1', 'A retry charges the card twice'), { ...authz, id: 'F-3' }];
  }) });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(rows(final), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:MERGED>F-1']);
  assert.equal(final.dispositions[2].reason, 'Identical in every field to F-1. [Runtime: exact duplicate.]');
  assert.equal(final.dispositions[2].mergedFinding.summary, 'The permission check runs after the charge');
  assert.deepEqual(final.reviewWarnings, ['Removed 1 exact duplicate finding(s); findings that differ in any field are kept.']);
  assert.equal(f.of('dedupe').length, 0);
  // Two passes that file the very same record: the runtime removes the copy itself, and the finding that stays
  // stands for both sessions. No model is asked, since nothing is left to compare.
  const two = await context(t, { files: ['/src/pay.ts'], models: { reviewers: ['p/a', 'p/a'] }, dedupe: async () => { throw new Error('must not run'); },
    behave: reviewer(() => [finding('F-1', 'head:/src/pay.ts:1', 'The   permission check\nruns after the charge')]) });
  const merged = await runReview(two.ctx, two.run, two.request);
  assert.deepEqual(rows(merged), ['F-1:REPORTED', 'F-2:MERGED>F-1']);
  assert.deepEqual(merged.dispositions[0].sessions, ['1/1 pass 1', '1/1 pass 2']);
  assert.equal(merged.dispositions[0].alsoReported, undefined);
  assert.deepEqual(two.of('rating')[0].payload.assignment.findingIds, ['F-1']);
  // A location is compared as it is: two files whose names differ only in their spaces are two places.
  const spaced = await context(t, { files: ['/src/a b.ts', '/src/a  b.ts'], models: { reviewers: ['p/a', 'p/a'] },
    behave: reviewer((payload, pass) => [finding('F-1', `head:${pass ? '/src/a  b.ts' : '/src/a b.ts'}:1`, 'The same text in both files')]) });
  const apart = await runReview(spaced.ctx, spaced.run, spaced.request);
  assert.deepEqual(apart.dispositions.map(d => `${d.id}:${d.status}:${d.finding?.location}`), ['F-1:REPORTED:head:/src/a  b.ts:1', 'F-2:REPORTED:head:/src/a b.ts:1']);
  // A difference in any field keeps both, and they go to the duplicate check.
  const near = await context(t, { files: ['/src/pay.ts'], models: { reviewers: ['p/a', 'p/a'] },
    behave: reviewer((payload, pass) => [finding('F-1', 'head:/src/pay.ts:1', 'The permission check runs after the charge', { severity: pass ? 'high' : 'medium' })]) });
  const both = await runReview(near.ctx, near.run, near.request);
  assert.deepEqual([rows(both), near.of('dedupe').length], [['F-1:REPORTED', 'F-2:REPORTED'], 1]);
  // Text is compared character for character: whitespace inside quoted code can name two different keys.
  const keys = await context(t, { files: ['/src/pay.ts'], behave: reviewer(() => [
    finding('F-1', 'head:/src/pay.ts:1', 'A key the table lacks', { evidence: 'The table has no entry for `"a b"`.' }),
    finding('F-2', 'head:/src/pay.ts:1', 'A key the table lacks', { evidence: 'The table has no entry for `"a  b"`.' })]) });
  assert.deepEqual(rows(await runReview(keys.ctx, keys.run, keys.request)), ['F-1:REPORTED', 'F-2:REPORTED']);
  // Two passes that file the same records, each naming its own other finding: each names a finding of its own pass,
  // so the two texts name different findings, are no copies, and go to the duplicate check. Once the merges are
  // settled, a text that names a merged finding names the one that stays.
  const chain = await context(t, { files: ['/src/pay.ts'], models: { reviewers: ['p/a', 'p/a'] },
    behave: reviewer(payload => [finding(payload.assignment.firstFindingId, 'head:/src/pay.ts:1', 'The charge runs twice', { suggestion: 'Fix it with F-1002.' }),
      finding('F-1002', 'head:/src/pay.ts:2', 'The retry has no key')]) });
  const copies = await runReview(chain.ctx, chain.run, chain.request);
  assert.deepEqual(rows(copies), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED', 'F-4:MERGED>F-3']);
  assert.deepEqual([copies.dispositions[0].finding.suggestion, copies.dispositions[1].finding.suggestion, copies.dispositions[3].mergedFinding.suggestion], ['Fix it with F-3.', 'Fix it with F-3.', 'Restore the guard; add a regression case.']);
  assert.equal(chain.of('dedupe').length, 1);
  // A finding that names itself names itself in each copy: such copies are removed.
  const selfish = await context(t, { files: ['/src/pay.ts'], models: { reviewers: ['p/a', 'p/a'] }, dedupe: async () => { throw new Error('must not run'); },
    behave: reviewer(payload => [finding(payload.assignment.firstFindingId, 'head:/src/pay.ts:1', `${payload.assignment.firstFindingId}: the charge runs twice`)]) });
  const itself = await runReview(selfish.ctx, selfish.run, selfish.request);
  assert.deepEqual([rows(itself), itself.dispositions[0].finding.summary, itself.dispositions[1].mergedFinding.summary], [['F-1:REPORTED', 'F-2:MERGED>F-1'], 'F-1: the charge runs twice', 'F-1: the charge runs twice']);
});

test('a text that names a finding merged into another names the finding that stays, whichever merge it was', async t => {
  // Pass 1 files the cause on line 1; pass 2 files the cause there too and, on line 2, an effect that names it. The
  // review gives them F-1, F-2 (pass 2's cause) and F-3, and F-2 is merged into F-1: as an exact copy, or by the
  // duplicate check. F-3 then names F-1, which a person can see and exclude.
  const cause = (text = 'The guard is dropped') => finding('F-1001', 'head:/src/a.ts:1', text);
  for (const [name, second, dedupe] of [
    ['an exact copy', cause(), noDuplicates],
    ['the duplicate check', cause('The same guard is missing'), async ({ payload }) => JSON.stringify({ status: 'COMPLETE', report: '',
      merged: [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same root cause and correction.' }].filter(() => payload.assignment.findingIds.includes('F-2')) })],
  ]) {
    const f = await context(t, { files: ['/src/a.ts'], models: { reviewers: ['p/a', 'p/b'] }, dedupe,
      behave: reviewer((payload, pass) => pass === 0 ? [cause()] : [second, finding('F-1002', 'head:/src/a.ts:2', 'The retry runs twice', { evidence: 'See F-1001 for the cause.' })]) });
    const final = await runReview(f.ctx, f.run, f.request);
    assert.deepEqual(rows(final), ['F-1:REPORTED', 'F-2:MERGED>F-1', 'F-3:REPORTED'], name);
    assert.equal(final.dispositions[2].finding.evidence, 'See F-1 for the cause.', name);
    assert.equal(final.findings[2].evidence, 'See F-1 for the cause.', name);
  }
  // An ID the parser had to give a finding is none the answer's text can mean: "F-1" below names another review.
  // The finding without an ID stands second, so the review gives its generated F-1 the ID F-2: a capture would show.
  const g = await context(t, { files: ['/src/a.ts'], behave: reviewer(() => [finding('F-1001', 'head:/src/a.ts:1', 'Compare the earlier review\'s F-1'),
    { ...finding('F-1001', 'head:/src/a.ts:2', 'A finding without an ID'), id: undefined }]) });
  const generated = await runReview(g.ctx, g.run, g.request);
  assert.deepEqual(generated.dispositions.map(d => [d.id, d.localId, d.finding.summary]), [['F-1', 'F-1001', 'Compare the earlier review\'s F-1'], ['F-2', 'F-1', 'A finding without an ID']]);
  // A text that only looks like a reference is no copy of one that is: the key tells them apart.
  const looks = await context(t, { files: ['/src/a.ts'], sources: { '/src/a.ts': lines(20) }, models: { reviewers: ['p/a', 'p/b'] }, behave: reviewer((payload, pass) => pass === 0
    ? [finding('F-1001', 'head:/src/a.ts:1', 'The cause'), finding('F-1002', 'head:/src/a.ts:3', 'The effect', { evidence: 'See F-1001.' })]
    : [finding('F-1001', 'head:/src/a.ts:3', 'The effect', { evidence: 'See F-1.' })]) });
  const apart = await runReview(looks.ctx, looks.run, looks.request);
  assert.deepEqual(rows(apart), ['F-1:REPORTED', 'F-2:REPORTED', 'F-3:REPORTED']);
});

// ------------------------------------------------------------------ severity rating

// Two passes file their findings at levels of their own: pass 1 low, pass 2 high.
const rated = (rate, extra = {}) => ({ files: ['/src/a.ts', '/src/b.ts'], models: { reviewers: ['p/a', 'p/b'] }, rate, ...extra,
  behave: reviewer((payload, pass) => pass === 0 ? [finding('F-1', 'head:/src/a.ts:1', 'A core path fails', { severity: 'low' }), finding('F-2', 'head:/src/b.ts:1', 'A label is misspelled', { severity: 'low' })]
    : [finding('F-1', 'head:/src/b.ts:2', 'Stored data is lost', { severity: 'high' })]) });

test('rater false: no rating session runs and every finding keeps the level its reviewer gave it', async t => {
  const f = await context(t, rated(async () => { throw new Error('must not run'); }, { models: { reviewers: ['p/a', 'p/b'], rater: false } }));
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.of('rating').length, 0);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.finding.severity}:${d.reviewerSeverity}:${d.ratedSeverity}`), ['F-1:low:low:undefined', 'F-2:low:low:undefined', 'F-3:high:high:undefined']);
  assert.deepEqual(final.method.rating, { state: 'off', sessions: 0, failed: 0, rated: 0, kept: 0 });
  assert.equal(final.shards.ratings, 0);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(f.notices.some(message => /Severity rating/.test(message)), false);
  assert.deepEqual(final.reviewWarnings.filter(warning => /rating/i.test(warning)), []);
});

test('severity rating: a session without tools that sees no earlier level sets the final one', async t => {
  const answerRating = async () => JSON.stringify({ status: 'COMPLETE', report: '', ratings: [
    { id: 'F-1', severity: 'high', reason: 'A core path fails.' }, { id: 'F-2', severity: 'low', reason: 'Cosmetic.' }, { id: 'F-3', severity: 'medium', reason: 'Recoverable.' }] });
  const f = await context(t, rated(answerRating));
  const final = await runReview(f.ctx, f.run, f.request);
  const raters = f.of('rating');
  assert.deepEqual(raters.map(call => [call.role, call.label]), [['azpr-review-rating', '']]);
  const { payload } = raters[0];
  // The rater gets the finding text and what the change is for: no PR identity, commit, file list or tool data.
  assert.deepEqual(Object.keys(payload).sort(), ['assignment', 'change', 'outputLanguage']);
  assert.deepEqual(payload.change, { title: 'Fixture PR', description: 'Fixture description' });
  assert.deepEqual(Object.keys(payload.assignment).sort(), ['findingIds', 'findings', 'kind']);
  assert.equal(payload.assignment.kind, 'rating');
  assert.deepEqual(payload.assignment.findingIds, ['F-1', 'F-2', 'F-3']);
  // Of a finding: its text and its place. No level, and nothing about which pass, model or session reported it or how often.
  for (const x of payload.assignment.findings) {
    assert.deepEqual(Object.keys(x).sort(), ['counterevidence', 'evidence', 'id', 'location', 'suggestion', 'summary'], x.id);
    assert.ok(x.summary && x.evidence && x.counterevidence && x.suggestion && x.location, x.id);
  }
  assert.doesNotMatch(JSON.stringify(payload), /"severity"|"low"|"high"|pass|session|p\/a|p\/b|alsoReported|reviewer/);
  // The rating is the final level; the reviewer's own stays on record beside it.
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}:${d.finding.severity}:${d.reviewerSeverity}:${d.ratedSeverity}`),
    ['F-1:REPORTED:high:low:high', 'F-2:REPORTED:low:low:low', 'F-3:REPORTED:medium:high:medium']);
  // Without a named rater, the first reviewer's model rates.
  assert.deepEqual(final.method.rating, { state: 'first', model: 'p/a', sessions: 1, failed: 0, rated: 3, kept: 0 });
  assert.equal(final.shards.ratings, 1);
  assert.equal(final.status, 'COMPLETE');
  assert.ok(f.notices.includes('Severity rating: 3 finding(s) in 1 session(s).'));
  assert.deepEqual(final.reviewWarnings.filter(warning => /rating/i.test(warning)), []);
  // A named rater is recorded as such.
  const named = await context(t, rated(answerRating, { models: { reviewers: ['p/a', 'p/b'], rater: 'p/x#high' } }));
  assert.deepEqual((await runReview(named.ctx, named.run, named.request)).method.rating, { state: 'named', model: 'p/x#high', sessions: 1, failed: 0, rated: 3, kept: 0 });
  // A long description is cut; the title is not part of what a model may be told to do.
  const long = await context(t, rated(answerRating));
  const snapshot = long.ctx.azure.snapshot;
  long.ctx.azure = { ...long.ctx.azure, snapshot: async (...args) => ({ ...(await snapshot(...args)), description: 'd'.repeat(5000) }) };
  await runReview(long.ctx, long.run, long.request);
  assert.equal(long.of('rating')[0].payload.change.description, `${'d'.repeat(4000)} […]`);
});

test('severity rating degrades per finding: an unrated finding and a failed session keep their reviewer\'s severity', async t => {
  // F-2 and F-3 are left out, also after the correction turns of the same session.
  const partial = await context(t, rated(async () => JSON.stringify({ status: 'COMPLETE', report: '', ratings: [{ id: 'F-1', severity: 'high', reason: 'A core path fails.' }, { id: 'F-9', severity: 'low', reason: 'Not assigned.' }] })));
  const kept = await runReview(partial.ctx, partial.run, partial.request);
  assert.deepEqual(kept.dispositions.map(d => `${d.id}:${d.finding.severity}:${d.ratedSeverity}`), ['F-1:high:high', 'F-2:low:undefined', 'F-3:high:undefined']);
  assert.deepEqual(kept.reviewWarnings, ['Severity rating: 2 finding(s) got no usable rating and keep their reviewer\'s severity.']);
  assert.deepEqual(partial.of('rating').map(call => call.repairs.length), [2], 'Corrections stay in the rating session.');
  assert.deepEqual(kept.method.rating, { state: 'first', model: 'p/a', sessions: 1, failed: 0, rated: 1, kept: 2 });
  assert.equal(kept.status, 'COMPLETE');
  // A rating session that fails changes nothing and is named.
  const failed = await context(t, rated(async () => { throw new Error('rater down'); }));
  const same = await runReview(failed.ctx, failed.run, failed.request);
  assert.deepEqual(same.dispositions.map(d => d.finding.severity), ['low', 'low', 'high']);
  assert.deepEqual(same.reviewWarnings, ['The severity rating failed (rater down); its 3 finding(s) keep their reviewer\'s severity.']);
  assert.deepEqual(same.method.rating, { state: 'first', model: 'p/a', sessions: 1, failed: 1, rated: 0, kept: 3 });
  assert.equal(same.status, 'COMPLETE');
  // An answer that is not JSON at all: the same outcome, with the reason.
  const prose = await context(t, rated(async () => 'All of them are medium.'));
  const unrated = await runReview(prose.ctx, prose.run, prose.request);
  assert.deepEqual(unrated.dispositions.map(d => d.finding.severity), ['low', 'low', 'high']);
  assert.deepEqual(unrated.reviewWarnings, ['Severity rating: The severity rating gave no usable answer; the reviewers\' severities are kept.']);
  assert.deepEqual(unrated.method.rating, { state: 'first', model: 'p/a', sessions: 1, failed: 0, rated: 0, kept: 3 });
  // Nothing reported, nothing to rate.
  const none = await context(t, { files: ['/a.ts'], rate: async () => { throw new Error('must not run'); }, behave: reviewer(() => []) });
  const empty = await runReview(none.ctx, none.run, none.request);
  assert.equal(none.of('rating').length, 0);
  assert.deepEqual([empty.shards.ratings, empty.method.rating], [0, { state: 'first', model: 'p/a', sessions: 0, failed: 0, rated: 0, kept: 0 }]);
});

test('severity rating: more than 25 findings are rated in several sessions, each answering for its own', async t => {
  const count = 30;
  const f = await context(t, { files: ['/src/a.ts'], sources: { '/src/a.ts': lines(40) },
    behave: reviewer(() => Array.from({ length: count }, (_, i) => finding(`F-${i + 1}`, `head:/src/a.ts:${i + 1}`, `Defect ${i + 1}`))),
    rate: async ({ payload }) => ratings(payload, payload.assignment.findingIds.length === 25 ? 'high' : 'low') });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(f.of('rating').map(call => [call.label, call.payload.assignment.findingIds.length]), [['1/2', 25], ['2/2', 5]]);
  assert.deepEqual(final.dispositions.map(d => d.finding.severity), [...Array(25).fill('high'), ...Array(5).fill('low')]);
  assert.equal(final.shards.ratings, 2);
  assert.deepEqual(final.method.rating, { state: 'first', model: 'p/a', sessions: 2, failed: 0, rated: 30, kept: 0 });
  // One of two sessions fails: its findings keep their level, the others are rated.
  const half = await context(t, { files: ['/src/a.ts'], sources: { '/src/a.ts': lines(40) },
    behave: reviewer(() => Array.from({ length: count }, (_, i) => finding(`F-${i + 1}`, `head:/src/a.ts:${i + 1}`, `Defect ${i + 1}`))),
    rate: async ({ payload }) => { if (payload.assignment.findingIds.length === 5) throw new Error('rater down'); return ratings(payload, 'high'); } });
  const mixed = await runReview(half.ctx, half.run, half.request);
  assert.deepEqual(mixed.dispositions.map(d => d.finding.severity), [...Array(25).fill('high'), ...Array(5).fill('medium')]);
  assert.deepEqual(mixed.method.rating, { state: 'first', model: 'p/a', sessions: 2, failed: 1, rated: 25, kept: 5 });
});

// ------------------------------------------------------------------ coverage and usable answers

test('an incomplete Azure file list asks reviewers to discover paths and records them', async t => {
  const f = await context(t, { files: ['/a.ts'], behave: async ({ payload, read }) => {
    assert.equal(payload.assignment.discoverFiles, true);
    read('/a.ts');
    return answer(payload, [], { additionalFiles: ['/hidden.ts'] });
  } });
  // The REST inventory is complete unless it exceeds the paging bound; simulate that.
  const snapshot = f.ctx.azure.snapshot;
  f.ctx.azure = { ...f.ctx.azure, snapshot: async (...args) => ({ ...(await snapshot(...args)), filesComplete: false }) };
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.discoveredFiles, ['/hidden.ts']);
  assert.ok(final.reviewWarnings.some(message => /incomplete changed-file list/.test(message)));
  assert.ok(final.reviewWarnings.includes('Reviewers reported 1 changed path(s) missing from Azure\'s list: /hidden.ts'));
  assert.deepEqual(final.coverageSummary, { complete: false, unreviewedFiles: 0, filesComplete: false, reasons: ['partial-file-list'], files: 1, passes: 1, reviewedOnce: 1, reviewedByAll: 1, failedSessions: 0 });
});

test('a parsed answer is not automatically usable: bad items degrade and a review without a usable answer is PARTIAL', async t => {
  const f = await context(t, { files: ['/src/a.ts'], behave: async ({ payload, read }) => {
    read('/src/a.ts');
    const { location: _missing, ...noLocation } = finding('F-2', '');
    return answer(payload, [finding('F-1', 'head:/src/a.ts:2'), noLocation]);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.calls[0].repairs.length, 2, 'The missing location got both correction turns.');
  assert.match(f.calls[0].repairs[0], /findings\[1\] \(F-2\): missing location/);
  assert.equal(final.status, 'COMPLETE');
  assert.deepEqual(rows(final), ['F-1:REPORTED', 'F-2:NEEDS_INFO']);
  assert.equal(final.dispositions[1].reason, 'The finding is missing location after the correction turns. [Runtime: not eligible for comments.]');
  assert.deepEqual([Object.hasOwn(final.dispositions[1], 'finding'), final.dispositions[1].partialFinding.summary], [false, 'Defect F-2']);
  // A field that is not text is no text, however it would read once turned into one: the correction turn names it,
  // and a finding that keeps it is NEEDS_INFO. An answer whose only finding is such, and that reviewed no file, is
  // no usable review.
  const typed = await context(t, { files: ['/src/a.ts'], behave: async ({ payload, read }) => {
    read('/src/a.ts');
    return JSON.stringify({ status: 'COMPLETE', coverage: { files: [], gaps: [] }, additionalFiles: [], report: '',
      findings: [{ ...finding('F-1001', 'head:/src/a.ts:2'), summary: false, evidence: [], counterevidence: {}, suggestion: false }] });
  } });
  const untyped = await runReview(typed.ctx, typed.run, typed.request);
  assert.match(typed.calls[0].repairs[0], /findings\[0\] \(F-1001\): missing summary, evidence, counterevidence, suggestion/);
  assert.deepEqual([untyped.status, rows(untyped)], ['PARTIAL', ['F-1:NEEDS_INFO']]);
  assert.equal(untyped.dispositions[0].reason, 'The finding comes from a reviewer answer that was not usable. [Runtime: not eligible for comments.]');
  // JSON that parses but carries no usable review never becomes a commentable COMPLETE.
  const g = await context(t, { files: ['/src/a.ts'], behave: async () => JSON.stringify({ status: 'COMPLETE', findings: { summary: 'not a list' }, coverage: 'everything', report: 'Looked around.' }) });
  const partial = await runReview(g.ctx, g.run, g.request);
  assert.equal(partial.status, 'PARTIAL');
  assert.ok(partial.dispositions.length > 0 && partial.dispositions.every(d => d.status === 'NEEDS_INFO' && /reviewer answer that was not usable/.test(d.reason)));
  assert.deepEqual(partial.coverageSummary, { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'], files: 1, passes: 1, reviewedOnce: 0, reviewedByAll: 0, failedSessions: 1 });
  assert.deepEqual(partial.unstructuredInitials, ['Looked around.']);
  assert.deepEqual(partial.method.passes, [{ pass: 1, model: 'p/a', sessions: 1, failed: 1 }]);
  assert.ok(partial.reviewWarnings.includes('The review session returned no usable review (no reviewed file or usable finding); its 1 file(s) count as not reviewed.'));
  assert.equal(g.of('rating').length + g.of('dedupe').length, 0, 'Nothing reported: nothing to compare or rate.');
  assert.equal(partial.initialObservations.length, partial.findings.length);
  // With two passes, one usable answer is enough for a review; the other pass's text is kept as it is.
  const mixed = await context(t, { files: ['/src/a.ts'], models: { reviewers: ['p/a', 'p/b'] }, behave: async ({ payload, pass, read }) => {
    if (pass === 1) return 'I looked at the change and it seems fine.';
    read('/src/a.ts');
    return answer(payload, [finding('F-1', 'head:/src/a.ts:1')]);
  } });
  const usable = await runReview(mixed.ctx, mixed.run, mixed.request);
  assert.deepEqual([usable.status, rows(usable), usable.coverageSummary.complete, usable.coverageSummary.reviewedByAll, usable.coverageSummary.failedSessions], ['COMPLETE', ['F-1:REPORTED'], true, 0, 1]);
  assert.deepEqual(usable.unstructuredInitials, ['### pass 2/2\n\nI looked at the change and it seems fine.']);
  assert.ok(usable.reviewWarnings.includes('The review pass 2/2 returned no usable review (no structured answer); its 1 file(s) count as not reviewed in this pass.'));
});

test('zero findings never hide incomplete coverage', async t => {
  // A failed shard: the number of unreviewed files is known.
  const failed = await context(t, { mode: 'quick', models: { reviewers: ['p/q'] }, files: ['/a.ts', '/b.ts', '/c.ts'], workflow: { shardFiles: 2 }, behave: async ({ payload, read }) => {
    if (payload.assignment.files.includes('/c.ts')) throw new Error('provider unavailable');
    for (const path of payload.assignment.files) read(path);
    return answer(payload, []);
  } });
  const one = await runReview(failed.ctx, failed.run, failed.request);
  assert.equal(one.status, 'COMPLETE');
  assert.deepEqual(one.coverageSummary, { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'], files: 3, passes: 1, reviewedOnce: 2, reviewedByAll: 2, failedSessions: 1 });
  assert.deepEqual(one.coverage['azpr-quick-reviewer'].failedFiles, ['/c.ts']);
  assert.deepEqual(one.reviewWarnings, ['The review shard 2/2 failed (provider unavailable); its 1 file(s) were not reviewed.']);
  // Every file reviewed, but the reviewer could not finish a check.
  const gaps = await context(t, { files: ['/a.ts'], behave: async ({ payload, read }) => {
    read('/a.ts');
    return answer(payload, [], { status: 'PARTIAL', coverage: { files: ['/a.ts'], gaps: ['The caller in /lib/x.ts could not be read.'] } });
  } });
  const two = await runReview(gaps.ctx, gaps.run, gaps.request);
  assert.deepEqual(two.coverageSummary, { complete: false, unreviewedFiles: 0, filesComplete: true, reasons: ['reviewer-gaps'], files: 1, passes: 1, reviewedOnce: 1, reviewedByAll: 1, failedSessions: 0 });
  // Azure returned part of the change list: the total is not known.
  const partialList = await context(t, { files: ['/a.ts'], behave: reviewer(() => []) });
  const snapshot = partialList.ctx.azure.snapshot;
  partialList.ctx.azure = { ...partialList.ctx.azure, snapshot: async (...args) => ({ ...(await snapshot(...args)), filesComplete: false }) };
  const three = await runReview(partialList.ctx, partialList.run, partialList.request);
  assert.deepEqual(three.coverageSummary, { complete: false, unreviewedFiles: 0, filesComplete: false, reasons: ['partial-file-list'], files: 1, passes: 1, reviewedOnce: 1, reviewedByAll: 1, failedSessions: 0 });
  // Two passes: a file that neither pass reviewed is unreviewed; a file one pass left out is reviewed once, and the
  // second number shows it. A path that a pass names twice (a split shard, a repeated entry) counts once.
  const uneven = await context(t, { files: ['/a.ts', '/b.ts', '/c.ts'], models: { reviewers: ['p/a', 'p/b'] }, behave: async ({ payload, pass, read }) => {
    for (const path of payload.assignment.files) read(path);
    return answer(payload, [], { status: 'PARTIAL', coverage: { files: pass === 0 ? ['/a.ts', '/a.ts', '/b.ts', '/not-assigned.ts'] : ['/a.ts'], gaps: [] } });
  } });
  const four = await runReview(uneven.ctx, uneven.run, uneven.request);
  assert.equal(four.status, 'COMPLETE');
  assert.deepEqual(four.coverageSummary, { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: [], files: 3, passes: 2, reviewedOnce: 2, reviewedByAll: 1, failedSessions: 0 });
  assert.deepEqual(Object.values(four.coverage).map(entry => [entry.assigned, entry.covered]), [[3, 2], [3, 1]]);
});

test('locations: deleted, renamed, unchanged and binary files, line ranges and the session\'s own reads', async t => {
  const head = 'b'.repeat(40), base = 'a'.repeat(40);
  const f = await context(t, {
    files: ['/src/edit.ts', '/src/gone.ts', '/src/new-name.ts', '/assets/logo.png'],
    changes: { '/src/gone.ts': { changeType: 'delete' }, '/src/new-name.ts': { changeType: 'rename', originalPath: '/src/old-name.ts' } },
    missing: [`${head}:/src/gone.ts`], binary: ['/assets/logo.png'],
    sources: { [`${base}:/src/old-name.ts`]: 'old line 1\nold line 2\n', '/src/util.ts': 'export const util = 1;\n' },
    behave: async ({ payload, turn, repair, read }) => {
      read('/src/edit.ts'); read('/src/gone.ts', 'base'); read('/src/new-name.ts');
      if (turn === 0) {
        return answer(payload, [
          finding('F-1', 'head:/src/edit.ts:1'), finding('F-2', 'head:/src/gone.ts:1'), finding('F-3', 'head:/src/old-name.ts:1'),
          finding('F-4', 'head:/assets/logo.png:1'), finding('F-5', 'head:/src/edit.ts:99'), finding('F-6', 'head:/src/util.ts:1')]);
      }
      if (turn === 1) {
        assert.match(repair, /F-2: \/src\/gone\.ts does not exist at HEAD\. It is deleted in this PR: use base:\/src\/gone\.ts:<line>/);
        assert.match(repair, /F-3: \/src\/old-name\.ts does not exist at HEAD\. It was renamed to \/src\/new-name\.ts in HEAD/);
        assert.match(repair, /F-4: \/assets\/logo\.png is a binary file at HEAD, so its lines cannot be read/);
        assert.match(repair, /F-5: lines 99 are outside \/src\/edit\.ts at HEAD, which has 2 line\(s\)/);
        assert.match(repair, /F-6: this session did not read \/src\/util\.ts at HEAD/);
      }
      if (turn >= 1) read('/src/util.ts');
      return answer(payload, [
        finding('F-1', 'head:/src/edit.ts:1'), finding('F-2', 'base:/src/gone.ts:1'), finding('F-3', 'head:/src/new-name.ts:1'),
        finding('F-4', 'head:/assets/logo.png'), finding('F-5', 'head:/src/edit.ts:2'), finding('F-6', 'head:/src/util.ts:1')]);
    },
  });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.equal(f.calls[0].repairs.length, 2);
  // By the IDs the answer used; the review numbers them by place (HEAD before BASE, then path and line).
  const byLocal = Object.fromEntries(final.dispositions.map(d => [d.localId, `${d.id}:${d.status}${d.status === 'REPORTED' ? `:${d.inline}` : ''}`]));
  assert.deepEqual(byLocal, { 'F-4': 'F-1:NEEDS_INFO', 'F-1': 'F-2:REPORTED:true', 'F-5': 'F-3:REPORTED:true', 'F-3': 'F-4:REPORTED:true', 'F-6': 'F-5:REPORTED:false', 'F-2': 'F-6:REPORTED:false' });
  // Only the unreadable message was received for the binary file: it is not evidence.
  assert.match(final.dispositions[0].reason, /^The location check failed: \/assets\/logo\.png is a binary file at HEAD, so its lines cannot be read/);
});

test('reads of another session do not count, and a location the runtime cannot check is not repaired', async t => {
  const f = await context(t, { files: ['/a.ts', '/b.ts'], workflow: { shardFiles: 1 }, behave: async ({ payload, read }) => {
    read(payload.assignment.files[0]);
    // The second shard reports a defect in the first shard's file without reading it.
    return answer(payload, payload.assignment.files[0] === '/b.ts' ? [finding('F-1', 'head:/a.ts:1')] : []);
  } });
  const final = await runReview(f.ctx, f.run, f.request);
  assert.deepEqual(final.dispositions.map(d => `${d.id}:${d.status}:${d.shard}`), ['F-1:NEEDS_INFO:2/2']);
  assert.match(final.dispositions[0].reason, /this session did not read \/a\.ts at HEAD/);
  const failing = { readFile: async () => { throw Object.assign(new Error('timeout'), { kind: 'timeout' }); } };
  const check = await checkLocation({ location: 'head:/a.ts:1' }, { snapshot: { head: 'h', base: 'b', changes: [] }, azure: failing, run: { active: true }, reads: new Set(['h\n/a.ts']) });
  assert.deepEqual(check, { problem: 'the runtime could not check /a.ts at HEAD (timeout).', repairable: false });
  // A session that read another shard's file may report there: with one pass, that file then holds findings of two sessions.
  const crossing = await context(t, { files: ['/a.ts', '/b.ts'], workflow: { shardFiles: 1 }, behave: async ({ payload, read }) => {
    read('/a.ts'); read(payload.assignment.files[0]);
    return answer(payload, [finding('F-1', 'head:/a.ts:1', `Seen from ${payload.assignment.files[0]}`)]);
  } });
  const crossed = await runReview(crossing.ctx, crossing.run, crossing.request);
  assert.deepEqual(crossed.dispositions.map(d => `${d.id}:${d.status}:${d.shard}`), ['F-1:REPORTED:1/2', 'F-2:REPORTED:2/2']);
  assert.deepEqual(crossing.of('dedupe').map(call => [call.payload.assignment.file, call.payload.assignment.findings.map(x => x.session)]), [['/a.ts', ['1/2', '2/2']]]);
});

test('a finding needs a read that showed that version of the file', async t => {
  const path = '/src/a.ts', head = 'b'.repeat(40), base = 'a'.repeat(40), current = 'export const enabled = true;\n';
  const outcomes = {};
  for (const [name, tool, args, before = 'export const enabled = false;\n'] of [
    ['past-end-line', 'azpr_read_file', { path, startLine: 99 }], ['past-end-hunk', 'azpr_read_diff', { path, fromHunk: 99 }],
    // Only the removed BASE line is shown; HEAD line 1 was never seen.
    ['removed-row-only', 'azpr_read_diff', { path, context: 0 }, `removed();\n${current}`],
    ['shown', 'azpr_read_file', { path }]]) {
    const f = await context(t, { files: [path], sources: { [`${base}:${path}`]: before, [`${head}:${path}`]: current },
      behave: async ({ payload, read }) => {
        // The session's own tool call decides what it read, as executeReviewTool does.
        const outcome = await runReviewTool(tool, args, { azure: f.ctx.azure, run: f.run, snapshot: f.run.snapshot });
        for (const shown of outcome.reads) read(shown.path, shown.version === base ? 'base' : 'head');
        return answer(payload, [finding('F-1', `head:${path}:1`)]);
      } });
    const final = await runReview(f.ctx, f.run, f.request);
    outcomes[name] = `${final.dispositions[0].status}:${f.calls[0].repairs.length}`;
  }
  assert.deepEqual(outcomes, { 'past-end-line': 'NEEDS_INFO:2', 'past-end-hunk': 'NEEDS_INFO:2', 'removed-row-only': 'NEEDS_INFO:2', shown: 'REPORTED:0' });
});

test('only a usable PARTIAL answer that names unfinished work asks for one follow-up', async () => {
  const snapshot = { head: 'h', base: 'b', files: ['/a.ts', '/b.ts'], filesComplete: true, changes: [{ path: '/a.ts', changeType: ['edit'] }, { path: '/b.ts', changeType: ['edit'] }] };
  const azure = { readFile: async (_run, _snapshot, path, version) => ({ path, version, text: 'const a = 1;\n', size: 13 }) };
  const session = { task: { files: ['/a.ts', '/b.ts'] }, snapshot, azure, run: { active: true }, reads: new Set(['h\n/a.ts']) };
  const reply = (status, { files = ['/a.ts', '/b.ts'], gaps = [], findings = [] } = {}) => JSON.stringify({ status, coverage: { files, gaps }, additionalFiles: [], findings, report: 'r' });
  const valid = finding('F-1', 'head:/a.ts:1');

  const gap = await evaluateReview(reply('PARTIAL', { gaps: ['Callers were not read.'], findings: [valid] }), session);
  assert.equal(gap.usable, true);
  assert.deepEqual([gap.issues, gap.followUp.gaps, gap.followUp.uncovered], [[], ['Callers were not read.'], []]);
  assert.match(gap.followUp.prompt, /^AZPR runtime: your answer is PARTIAL and names work that is not finished\.\n- Callers were not read\.\n\nWhere a check you need is unfinished and the source it needs is readable/);
  assert.match(gap.followUp.prompt, /Keep a gap only for a limit you cannot close/);
  assert.deepEqual(gap.result.checks, { 'F-1': { ok: true, inline: true } });

  // Assigned files missing from coverage are unfinished work too.
  const missing = await evaluateReview(reply('PARTIAL', { files: ['/a.ts'] }), session);
  assert.deepEqual(missing.followUp.uncovered, ['/b.ts']);
  assert.match(missing.followUp.prompt, /- Assigned files not listed as reviewed: \/b\.ts/);

  // COMPLETE (also with zero findings), something to repair first, or no usable answer: no follow-up.
  assert.equal((await evaluateReview(reply('COMPLETE'), session)).followUp, undefined);
  const repair = await evaluateReview(reply('PARTIAL', { gaps: ['g'], findings: [{ ...valid, location: undefined }] }), session);
  assert.ok(repair.issues.length && !repair.followUp, 'A correction turn comes first.');
  assert.match(repair.repairPrompt, /^AZPR runtime: your previous answer needs correction before it can be used\.\n- findings\[0\] \(F-1\): missing location\./);
  const plain = await evaluateReview('I could not finish.', session);
  assert.deepEqual([plain.usable, plain.followUp], [false, undefined]);
  const noFiles = await evaluateReview(reply('PARTIAL', { files: [], gaps: ['Nothing was read.'] }), session);
  assert.deepEqual([noFiles.usable, noFiles.followUp], [false, undefined], 'No reviewed file and no accepted finding is not a usable answer.');
  assert.equal(usableAnswer({ structured: true, envelope: { findings: false, coverage: true }, coverage: { files: ['/a.ts'], gaps: [] }, findings: [] }, ['/a.ts']), false);
  // An answer numbers its own findings from F-1, whatever the review will call them.
  const numbered = await evaluateReview(reply('COMPLETE', { findings: [{ ...valid, id: 'Q-7' }, { ...valid, id: undefined, summary: 'Another one' }] }), session);
  assert.deepEqual(numbered.result.findings.map(row => row.id), ['F-1', 'F-2']);
});

test('a review whose content search was refused lists that among its limitations', async t => {
  // The reviewer's own search call is refused, as for a repository over azure.archiveMegabytes.
  const refuse = run => runReviewTool('azpr_search_code', { query: 'caller' }, { azure: { archive: async () => ({ tooLarge: true, size: 104857601 }) }, run, snapshot: run.snapshot });
  const expected = /^Content search \(azpr_search_code\) was unavailable: the repository archive is larger than the azure\.archiveMegabytes setting allows\. Sessions could find and read files but not search file contents, so callers and other uses of the changed code may not have been checked\. azure\.archiveMegabytes is 100; it accepts up to 1024\.$/;
  for (const [mode, models] of [['review', { reviewers: ['p/a', 'p/b'] }], ['quick', { reviewers: ['p/q'] }]]) {
    const f = await context(t, { mode, models, files: ['/src/a.ts'], behave: async ({ payload, read }) => {
      assert.match((await refuse(f.run)).text, /^Content search is unavailable for this repository/);
      read('/src/a.ts');
      return answer(payload, [finding('F-1', 'head:/src/a.ts:1')]);
    } });
    const final = await runReview(f.ctx, f.run, f.request);
    assert.equal(final.status, 'COMPLETE', 'A missing search limits the review; it does not fail it.');
    assert.equal(final.reviewWarnings.filter(message => expected.test(message)).length, 1, JSON.stringify(final.reviewWarnings));
  }
  // A review whose searches ran says nothing.
  const plain = await context(t, { files: ['/src/a.ts'], behave: reviewer(() => []) });
  assert.deepEqual((await runReview(plain.ctx, plain.run, plain.request)).reviewWarnings, []);
});
