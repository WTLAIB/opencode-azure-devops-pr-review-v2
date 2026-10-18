import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComments, publishPlan, PLANNING_FINDINGS_PER_PAGE, PAGE_CONTINUATIONS, discussionDigest, parseLocation, sourceWindow, mergeCandidates, candidatePages } from '../src/comment-work.mjs';
import { createCommentData } from '../src/comment-data.mjs';
import { createAzureClient, parsePullRequestUrl } from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { publicationItems } from '../src/comments.mjs';
import { fakeAzure, azureError, FAKE_PAT } from './fake-azure.mjs';

const head = 'b'.repeat(40);
const finding = (id, severity = 'high') => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/Main.java:2', severity, suggestion: 's' });

async function setup(t, findings, azure = fakeAzure()) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createCommentData({ root: directory });
  const target = parsePullRequestUrl(azure.prUrl());
  const review = {
    id: 'abcdef12', target, outputLanguage: 'en', attribution: 'AI review',
    snapshot: { head, base: 'a'.repeat(40), files: ['/src/Main.java'], prId: azure.state.prId, repositoryId: 'rid', projectId: 'pid' },
    final: { report: 'Final report text', reviewWarnings: [], newFindings: [],
      dispositions: findings.map(f => ({ id: f.id, status: 'CONFIRMED', reason: 'ok', verifiedFinding: f })) },
    toolText: [], publication: new Map(),
  };
  return { review, store, azure };
}

/** Mirror the runtime's stage loop: evaluate, repair up to twice, then finalize. */
function stages(answer) {
  const payloads = [];
  const invoke = async (payload, handler) => {
    payloads.push(payload);
    let evaluation, text;
    for (let turn = 0; ; turn++) {
      text = await answer(payload, turn, evaluation);
      evaluation = await handler.evaluate(text, evaluation?.result);
      if (!evaluation.issues?.length || turn >= 2) break;
    }
    return evaluation.issues?.length && handler.finalize ? handler.finalize(text) : evaluation.result;
  };
  return { invoke, payloads };
}
const comment = id => ({ findingId: id, severity: 'high', path: '/src/Main.java', startLine: 1, endLine: 1, anchor: `code for ${id}`, body: `🔴 high: ${id} loses state` });

test('planning pages hold at most four findings and assemble one plan with every finding accounted for', async t => {
  const findings = Array.from({ length: 10 }, (_, i) => finding(`F-${i + 1}`, i === 9 ? 'low' : 'high'));
  const { review, store } = await setup(t, findings);
  const { invoke, payloads } = stages(async payload => JSON.stringify({ status: 'READY',
    comments: payload.findings.filter(f => f.severity !== 'low').map(f => comment(f.id)),
    skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, cause: 'low-severity', reason: 'Low.' })),
    ...(payload.commentWork.allowSummary ? { summary: 'Purpose.' } : {}) }));
  const plan = await prepareComments(review, store, invoke);
  assert.equal(payloads.length, 3);
  assert.ok(payloads.every(p => p.findings.length <= PLANNING_FINDINGS_PER_PAGE));
  assert.equal(plan.comments.length, 9);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-10']);
  assert.equal(new Set(plan.comments.map(c => c.marker)).size, 9);
  assert.match(plan.summary.content, /Purpose\./);
  assert.equal(payloads.filter(p => p.commentWork.allowSummary).length, 1, 'Only the first page writes the summary note.');
});

test('a page with problems is repaired in place; what stays broken is skipped, not fatal', async t => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')]);
  let turns = 0;
  const { invoke } = stages(async (payload, turn) => {
    turns++;
    if (turn === 0) return JSON.stringify({ status: 'READY', comments: [{ ...comment('F-1'), path: '/elsewhere.java' }], skipped: [] });
    return JSON.stringify({ status: 'READY', comments: [comment('F-1')], skipped: [] });
  });
  const plan = await prepareComments(review, store, invoke);
  assert.equal(turns, 3);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-2']);
  assert.match(plan.skipped[0].reason, /did not address/);
});

test('a skip whose cause the page contradicts goes back to the planner, which then comments', async t => {
  // As in a live PR #3 plan: the page showed the finding's whole file and the planner said it had no source.
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')]);
  const thread = { findingId: 'F-2', cause: 'existing-thread', threadId: 5, reason: 'Thread 5 covers it.' };
  const { invoke, payloads } = stages(async (payload, turn) => turn === 0
    ? JSON.stringify({ status: 'READY', comments: [], skipped: [{ findingId: 'F-1', cause: 'cannot-anchor', reason: 'This page has no source passage for F-1.' }, thread] })
    : JSON.stringify({ status: 'READY', comments: [{ ...comment('F-1'), startLine: 2, endLine: 2, anchor: 'const value = load();' }], skipped: [thread] }));
  const plan = await prepareComments(review, store, invoke, { fetchSource: async () => 'line one\nconst value = load();\n', discussions: [{ threadId: 5, path: '/src/Main.java', line: 2 }] });
  assert.deepEqual(payloads[0].sourceExcerpts.map(item => [item.findingIds.join(), item.firstLine, item.lastLine]), [['F-1,F-2', 1, 2]]);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.startLine]), [['F-1', 2]]);
  assert.deepEqual(plan.skipped, [thread]);
});

test('CONTINUE checkpoints keep finished work; a checkpoint without progress skips what is open instead of failing', async t => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')]);
  let sessions = 0;
  const { invoke, payloads } = stages(async payload => {
    sessions++;
    if (!payload.continuation) return JSON.stringify({ status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check F-2 next.' });
    return JSON.stringify({ status: 'READY', comments: [comment('F-2')], skipped: [] });
  });
  const plan = await prepareComments(review, store, invoke);
  assert.equal(sessions, 2);
  assert.equal(payloads[1].findings.length, 1);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-2']);
  const stuck = await setup(t, [finding('F-1'), finding('F-2')]);
  const notices = [];
  const loop = stages(async payload => JSON.stringify(payload.continuation
    ? { status: 'CONTINUE', comments: [], skipped: [], continuation: 'Still reading.' }
    : { status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check F-2 next.' }));
  const kept = await prepareComments(stuck.review, stuck.store, loop.invoke, { progress: message => notices.push(message) });
  assert.equal(loop.payloads.length, 2, 'The first continuation repeats the checkpoint and ends the page.');
  assert.deepEqual(kept.comments.map(c => c.findingId), ['F-1'], 'Finished work is kept.');
  assert.deepEqual(kept.skipped.map(s => [s.findingId, s.reason]), [['F-2', 'The comment planner repeated a checkpoint without progress; it remains in the summary index.']]);
  assert.match(kept.summary.content, /F-2/, 'The skipped finding stays in the summary index.');
  assert.deepEqual(notices.filter(n => /without progress/.test(n)), ['Planning comments, page 1/1: the planner repeated a checkpoint without progress; 1 finding(s) skipped.']);
});

test('a page gets at most three continuation sessions even when each one reads something new; later pages still run', async t => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings);
  let reads = 0;
  const { invoke, payloads } = stages(async payload => {
    if (payload.commentWork.page === 2) return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] });
    // Page 1 never finishes, but every session reads new source, so its checkpoint always differs.
    if (++reads > 10) throw new Error('Page 1 kept continuing: the continuation cap is missing.');
    review.commentEvidence = [...(review.commentEvidence ?? []), { tool: 'azpr_read_file', input: { path: '/src/Main.java', offset: reads }, result: { sha256: String(reads) } }];
    return JSON.stringify({ status: 'CONTINUE', comments: payload.continuation ? [] : [comment('F-1')], skipped: [], continuation: `Read part ${reads}; more to read.` });
  });
  const notices = [];
  const plan = await prepareComments(review, store, invoke, { progress: message => notices.push(message) });
  assert.equal(PAGE_CONTINUATIONS, 3);
  assert.equal(payloads.filter(p => p.commentWork.page === 1).length, 1 + PAGE_CONTINUATIONS, 'Page 1 stops after its first session and three continuations.');
  assert.equal(payloads.filter(p => p.commentWork.page === 2).length, 1);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-5']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-2', 'F-3', 'F-4']);
  assert.ok(plan.skipped.every(s => s.reason === 'The comment planner did not finish the page in 4 sessions; it remains in the summary index.'));
  assert.ok(notices.includes('Planning comments, page 1/2: the planner did not finish the page in 4 sessions; 3 finding(s) skipped.'));
});

/** Publication attempts as the store keeps them per PR; `fail` makes every write throw. */
function memoryAttempts() {
  const entries = {};
  return { entries, fail: false, get: marker => entries[marker],
    async set(marker, entry) { if (this.fail) throw new Error('disk full'); entries[marker] = entry; },
    async remove(markers) { if (this.fail) throw new Error('disk full'); for (const marker of markers) delete entries[marker]; } };
}
function publisher(azure, attempts = memoryAttempts()) {
  const api = createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 2, timeoutMs: 1000 }), fetch: azure.fetch, retryDelayMs: 1 });
  return { api, attempts, run: { id: 'run1', active: true, controller: new AbortController() } };
}
async function plannedReview(t, azure) {
  const ctx = await setup(t, [finding('F-1'), finding('F-2')], azure);
  const { invoke } = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  ctx.review.plan = await prepareComments(ctx.review, ctx.store, invoke);
  return ctx;
}

test('publication posts exact saved text, reads every marker back, and is idempotent on re-run', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  let persisted = 0;
  const first = await publishPlan({ run, review, azure: api, attempts, persist: async () => { persisted++; } });
  assert.equal(first.status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
  assert.deepEqual(azure.state.threads.map(thread => thread.comments[0].content), publicationItems(review.plan).map(item => item.content));
  assert.ok([...review.publication.values()].every(entry => entry.state === 'VERIFIED' && entry.threadId));
  assert.ok(persisted >= 3);
  const writes = () => azure.callsTo('createThread').length;
  const before = writes();
  const second = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(second.status, 'POSTED');
  assert.equal(writes(), before, 'Existing markers are skipped, not posted again.');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'ALREADY_PRESENT'));
});

test('a failed write leaves a partial result that a later run completes without duplicates', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  let failures = 1;
  azure.state.fail.createThread = () => { if (failures-- > 0) return azureError(503, 'ServiceUnavailableException', 'Busy.'); };
  const first = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(first.status, 'PARTIALLY_POSTED');
  assert.equal(azure.state.threads.length, 2);
  assert.equal([...review.publication.values()].filter(entry => entry.state === 'FAILED').length, 1);
  const second = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(second.status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
});

test('an uncertain write that did land is confirmed by read-back', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  azure.state.fail.createThread = call => {
    azure.state.threads.push({ id: 77, comments: [{ content: call.body.comments[0].content }] });
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comments: [] }) };
  };
  const result = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(result.status, 'POSTED');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'VERIFIED' && entry.threadId === 77));
});

test('an uncertain write is never repeated until its marker appears or the settle time passes', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => clock;
  const late = [];
  // The create's outcome is unknown and it lands only later (a delayed server commit).
  azure.state.fail.createThread = call => {
    late.push(call.body.comments[0].content);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comments: [] }) };
  };
  const first = await publishPlan({ run, review, azure: api, attempts, now });
  assert.equal(first.status, 'FAILED');
  assert.match(first.reason, /not posted again until their marker appears or 15 minutes/);
  assert.ok([...review.publication.values()].every(entry => entry.state === 'UNCERTAIN'), 'No read-back marker does not prove the write failed.');
  const writes = () => azure.callsTo('createThread').length;
  const sent = writes();
  clock += 5 * 60 * 1000;
  assert.equal((await publishPlan({ run, review, azure: api, attempts, now })).status, 'FAILED');
  assert.equal(writes(), sent, 'A retry within the settle time sends nothing.');
  azure.state.threads.push({ id: 90, comments: [{ content: late[0] }] });
  const landed = await publishPlan({ run, review, azure: api, attempts, now });
  assert.equal(landed.counts.ALREADY_PRESENT, 1, 'The delayed create is found by its marker.');
  assert.equal(writes(), sent);
  delete azure.state.fail.createThread;
  clock += 15 * 60 * 1000;
  assert.equal((await publishPlan({ run, review, azure: api, attempts, now })).status, 'POSTED');
  assert.equal(azure.state.threads.length, 3, 'After the settle time the missing items are written once.');
  review.publication.get(publicationItems(review.plan)[0].marker).state = 'SENDING';
  assert.equal((await publishPlan({ run, review, azure: api, attempts, now })).status, 'POSTED', 'Existing markers win over a leftover SENDING record.');
});

test('another review of the same PR does not resend an unresolved create', async t => {
  const azure = fakeAzure();
  const first = (await plannedReview(t, azure)).review, second = (await plannedReview(t, azure)).review;
  assert.deepEqual(publicationItems(second.plan).map(item => item.marker), publicationItems(first.plan).map(item => item.marker));
  const { api, run, attempts } = publisher(azure);
  azure.state.fail.createThread = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comments: [] }) });
  await publishPlan({ run, review: first, azure: api, attempts });
  const sent = azure.callsTo('createThread').length;
  const other = await publishPlan({ run, review: second, azure: api, attempts });
  assert.equal(azure.callsTo('createThread').length, sent, 'The second review sends nothing while the first one\'s creates are unresolved.');
  assert.ok([...second.publication.values()].every(entry => entry.state === 'UNCERTAIN'));
  assert.match(other.reason, /earlier attempt whose outcome is unknown/);
});

test('a create that returned a thread is not sent again while the thread list lags', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  let id = 50;
  azure.state.fail.createThread = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ++id, comments: [] }) });
  const first = await publishPlan({ run, review, azure: api, attempts });
  assert.ok([...review.publication.values()].every(entry => entry.state === 'UNVERIFIED'));
  assert.equal(first.status, 'FAILED');
  const sent = azure.callsTo('createThread').length;
  await publishPlan({ run, review, azure: api, attempts });
  assert.equal(azure.callsTo('createThread').length, sent, 'Returned threads are not sent again.');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'UNVERIFIED' && entry.threadId > 50 && entry.earlierAttempt), 'Still reported as not read back.');
});

test('nothing is sent when the attempt cannot be saved first', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  attempts.fail = true;
  const result = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(azure.callsTo('createThread').length, 0);
  assert.equal(result.status, 'FAILED');
  assert.match(result.reason, /attempt could not be saved \(disk full\); nothing was sent/);
  attempts.fail = false;
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
});

test('publication refuses a changed source commit or an inactive PR before writing', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  azure.state.head = 'c'.repeat(40);
  const stale = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(stale.status, 'STALE');
  azure.state.head = head;
  azure.state.status = 'completed';
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'INCOMPLETE');
  assert.equal(azure.callsTo('createThread').length, 0);
});

test('the discussion digest lists only live threads, compactly', () => {
  const marker = '<!-- azpr-comment:' + 'a'.repeat(32) + ' -->';
  const digest = discussionDigest([
    { id: 1, status: 1, comments: [], threadContext: { filePath: '/a.ts', rightFileStart: { line: 3 } } },
    { id: 2, status: 1, isDeleted: true, comments: [{ content: 'gone' }] },
    { id: 3, status: 2, comments: [{ isDeleted: true, content: 'deleted' }, { content: `Real question about   the guard ${marker}`, author: { displayName: 'Ann' } }], threadContext: { filePath: '/a.ts', rightFileStart: { line: 9 } } },
    { id: 4, status: 1, comments: [{ content: 'x'.repeat(500) }] },
    { id: 5, status: 'active', comments: [{ content: 'Ann voted 10', commentType: 'system' }] },
  ]);
  assert.deepEqual(digest.map(d => d.threadId), [3, 4]);
  assert.deepEqual(digest[0], { threadId: 3, status: 2, path: '/a.ts', line: 9, author: 'Ann', comments: 1, azpr: true, excerpt: 'Real question about the guard' });
  assert.equal(digest[1].excerpt.length, 300);
});

test('locations and source windows', () => {
  assert.deepEqual(parseLocation('head:/src/a.ts:12-14'), { side: 'head', path: '/src/a.ts', start: 12, end: 14 });
  assert.deepEqual(parseLocation('/src/a.ts:7'), { side: 'head', path: '/src/a.ts', start: 7, end: 7 });
  assert.deepEqual(parseLocation('head:/src/a.ts'), { side: 'head', path: '/src/a.ts', start: null, end: null });
  // A BASE location keeps its side, so HEAD source is never shown for BASE line numbers.
  assert.deepEqual(parseLocation('base:/src/old.ts:3'), { side: 'base', path: '/src/old.ts', start: 3, end: 3 });
  assert.equal(parseLocation('somewhere'), null);
  const small = sourceWindow('a\nb\nc\n', { start: 2 });
  assert.deepEqual({ ...small, text: small.text.split('\n') }, { firstLine: 1, lastLine: 3, totalLines: 3, text: ['1 | a', '2 | b', '3 | c'] });
  const big = sourceWindow(Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'), { start: 500, end: 502, context: 5 });
  assert.equal(big.firstLine, 495);
  assert.equal(big.lastLine, 507);
  assert.match(big.text, /^495 \| line 495/);
});

test('planning payloads inline source excerpts and the discussion digest; tools are rarely needed', async t => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')]);
  const fetched = [];
  const { invoke, payloads } = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  const plan = await prepareComments(review, store, invoke, {
    discussions: [{ threadId: 9, path: '/src/Main.java', line: 1, excerpt: 'Existing note' }],
    fetchSource: async path => { fetched.push(path); return 'fixture code\nsecond line\n'; },
  });
  assert.deepEqual(fetched, ['/src/Main.java'], 'Each file is fetched once.');
  const payload = payloads[0];
  assert.equal(payload.discussionsRead, true);
  assert.deepEqual(payload.existingDiscussions, [{ threadId: 9, path: '/src/Main.java', line: 1, excerpt: 'Existing note' }]);
  assert.deepEqual(payload.sourceExcerpts.map(e => [e.path, e.findingIds, e.firstLine, e.lastLine]), [['/src/Main.java', ['F-1', 'F-2'], 1, 2]]);
  assert.equal(payload.sourceExcerpts[0].text, '1 | fixture code\n2 | second line');
  assert.equal(payload.evidenceIndex, undefined, 'No evidence index when every finding has an excerpt.');
  assert.equal(payload.reportReference, undefined, 'A one-segment report needs no file reference.');
  assert.equal(typeof payload.findings[0].evidence, 'string', 'Findings are inline.');
  assert.equal(plan.comments.length, 2);
  // Without discussions or source the planner is told to read them itself.
  const other = await setup(t, [finding('F-1')]);
  const second = stages(async payload => JSON.stringify({ status: 'READY', comments: [comment(payload.findings[0].id)], skipped: [] }));
  await prepareComments(other.review, other.store, second.invoke, {});
  assert.equal(second.payloads[0].discussionsRead, false);
  assert.ok(second.payloads[0].evidenceIndex, 'The evidence index remains available without excerpts.');
});

const quickFinding = (id, shard, location, severity = 'medium', extra = {}) => ({ id, shard, location, severity, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', suggestion: 's', ...extra });

test('merge candidates: findings of different sessions on overlapping lines of one file with the same severity', () => {
  const a = quickFinding('Q-1', '1/2', 'head:/src/pay.ts:18');
  const b = quickFinding('Q-1001', '2/2', 'head:/src/pay.ts:17-19');
  assert.deepEqual(mergeCandidates([a, b]), [['Q-1', 'Q-1001']]);
  // Never within one session, across severities, files or non-overlapping lines, or for summary-only or low findings.
  assert.deepEqual(mergeCandidates([a, quickFinding('Q-2', '1/2', 'head:/src/pay.ts:18')]), []);
  assert.deepEqual(mergeCandidates([a, { ...b, severity: 'high' }]), []);
  assert.deepEqual(mergeCandidates([a, { ...b, location: 'head:/src/other.ts:18' }]), []);
  assert.deepEqual(mergeCandidates([a, { ...b, location: 'head:/src/pay.ts:20-22' }]), []);
  assert.deepEqual(mergeCandidates([a, { ...b, inline: false }]), []);
  assert.deepEqual(mergeCandidates([{ ...a, severity: 'low' }, { ...b, severity: 'low' }]), []);
  assert.deepEqual(mergeCandidates([a, { ...b, location: 'base:/src/pay.ts:18' }]), []);
  // Overlaps chain into one candidate group; the planner's combination is checked member by member later.
  const chain = [quickFinding('Q-1', '1/3', 'head:/a.ts:1-2'), quickFinding('Q-1001', '2/3', 'head:/a.ts:2-3'), quickFinding('Q-2001', '3/3', 'head:/a.ts:3-4')];
  assert.deepEqual(mergeCandidates(chain), [['Q-1', 'Q-1001', 'Q-2001']]);
  // A group larger than a planning page is not offered.
  const crowd = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => quickFinding(`Q-${i * 1000 + 1}`, `${i + 1}/9`, 'head:/a.ts:5'));
  assert.deepEqual(mergeCandidates(crowd), []);
});

test('candidate pages keep a group on one page and plan an oversized group separately', () => {
  const a = quickFinding('Q-1', '1/2', 'head:/a.ts:1'), x = quickFinding('Q-2', '1/2', 'head:/b.ts:1'), y = quickFinding('Q-3', '1/2', 'head:/c.ts:1'),
    z = quickFinding('Q-4', '1/2', 'head:/d.ts:1'), b = quickFinding('Q-1001', '2/2', 'head:/a.ts:1');
  const ids = pages => pages.map(page => page.map(finding => finding.id));
  const grouped = candidatePages([a, x, y, z, b], [['Q-1', 'Q-1001']]);
  assert.deepEqual(ids(grouped.pages), [['Q-1', 'Q-1001', 'Q-2', 'Q-3'], ['Q-4']]);
  assert.deepEqual(grouped.offered, [['Q-1', 'Q-1001']]);
  assert.deepEqual(ids(candidatePages([a, x, y, z, b], []).pages), [['Q-1', 'Q-2', 'Q-3', 'Q-4'], ['Q-1001']], 'Without candidates paging is unchanged.');
  const big = 'x'.repeat(7000);
  const split = candidatePages([{ ...a, evidence: big }, { ...b, evidence: big }], [['Q-1', 'Q-1001']]);
  assert.deepEqual(split.offered, [], 'A group that does not fit one page is not offered, and its evidence is not cut.');
  assert.deepEqual(ids(split.pages), [['Q-1'], ['Q-1001']]);
});
