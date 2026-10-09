import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComments, publishPlan, PLANNING_FINDINGS_PER_PAGE, discussionDigest, parseLocation, sourceWindow } from '../src/comment-work.mjs';
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
    skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, reason: 'Low.' })),
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

test('CONTINUE checkpoints keep finished work and stop when no progress is made', async t => {
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
  const stuck = await setup(t, [finding('F-1')]);
  const loop = stages(async () => JSON.stringify({ status: 'CONTINUE', comments: [], skipped: [], continuation: 'Still reading.' }));
  await assert.rejects(prepareComments(stuck.review, stuck.store, loop.invoke), /without progress/);
});

function publisher(azure) {
  const api = createAzureClient({ organization: 'org', pat: FAKE_PAT, queue: createToolQueue({ concurrency: 2, timeoutMs: 1000 }), fetch: azure.fetch, retryDelayMs: 1 });
  return { api, run: { id: 'run1', active: true, controller: new AbortController() } };
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
  const { api, run } = publisher(azure);
  let persisted = 0;
  const first = await publishPlan({ run, review, azure: api, persist: async () => { persisted++; } });
  assert.equal(first.status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
  assert.deepEqual(azure.state.threads.map(thread => thread.comments[0].content), publicationItems(review.plan).map(item => item.content));
  assert.ok([...review.publication.values()].every(entry => entry.state === 'VERIFIED' && entry.threadId));
  assert.ok(persisted >= 3);
  const writes = () => azure.callsTo('createThread').length;
  const before = writes();
  const second = await publishPlan({ run, review, azure: api });
  assert.equal(second.status, 'POSTED');
  assert.equal(writes(), before, 'Existing markers are skipped, not posted again.');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'ALREADY_PRESENT'));
});

test('a failed write leaves a partial result that a later run completes without duplicates', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run } = publisher(azure);
  let failures = 1;
  azure.state.fail.createThread = () => { if (failures-- > 0) return azureError(503, 'ServiceUnavailableException', 'Busy.'); };
  const first = await publishPlan({ run, review, azure: api });
  assert.equal(first.status, 'PARTIALLY_POSTED');
  assert.equal(azure.state.threads.length, 2);
  assert.equal([...review.publication.values()].filter(entry => entry.state === 'FAILED').length, 1);
  const second = await publishPlan({ run, review, azure: api });
  assert.equal(second.status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
});

test('an uncertain write that did land is confirmed by read-back', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run } = publisher(azure);
  azure.state.fail.createThread = call => {
    azure.state.threads.push({ id: 77, comments: [{ content: call.body.comments[0].content }] });
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comments: [] }) };
  };
  const result = await publishPlan({ run, review, azure: api });
  assert.equal(result.status, 'POSTED');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'VERIFIED' && entry.threadId === 77));
});

test('publication refuses a changed source commit or an inactive PR before writing', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run } = publisher(azure);
  azure.state.head = 'c'.repeat(40);
  const stale = await publishPlan({ run, review, azure: api });
  assert.equal(stale.status, 'STALE');
  azure.state.head = head;
  azure.state.status = 'completed';
  assert.equal((await publishPlan({ run, review, azure: api })).status, 'INCOMPLETE');
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
  assert.deepEqual(parseLocation('head:/src/a.ts:12-14'), { path: '/src/a.ts', start: 12, end: 14 });
  assert.deepEqual(parseLocation('/src/a.ts:7'), { path: '/src/a.ts', start: 7, end: 7 });
  assert.deepEqual(parseLocation('head:/src/a.ts'), { path: '/src/a.ts', start: null, end: null });
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
