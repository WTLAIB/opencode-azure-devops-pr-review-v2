import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComments, publishPlan, PLANNING_FINDINGS_PER_PAGE, PAGE_CONTINUATIONS, discussionDigest, postedComments, parseLocation, sourceWindow, mergeCandidates, candidatePages, repeatEligible, severitySets, boundedGroups, pairFits } from '../src/comment-work.mjs';
import { createCommentData } from '../src/comment-data.mjs';
import { createAzureClient, parsePullRequestUrl } from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { publicationItems, inlineMarker, describeEarlierText } from '../src/comments.mjs';
import { renderPublication, renderOtherPlaces, listedPlaces, listablePlace, commentAttribution } from '../src/attribution.mjs';
import { fakeAzure, azureError, FAKE_PAT } from './fake-azure.mjs';

const head = 'b'.repeat(40);
// The attribution of a comment as the runtime writes it: one line that ends with the models.
const ATTRIBUTION = 'AI review. Models: `fixture/planner`';
const finding = (id, severity = 'high') => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/Main.java:2', severity, suggestion: 's' });

async function setup(t, findings, azure = fakeAzure()) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createCommentData({ root: directory });
  const target = parsePullRequestUrl(azure.prUrl());
  const review = {
    id: 'abcdef12', target, outputLanguage: 'en', attribution: ATTRIBUTION,
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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits in these tests are bounded, so a broken lane fails an assertion instead of hanging.
const within = (promise, ms = 5000) => Promise.race([promise, sleep(ms)]);
// A wait that must end by what it waits for: running out of time fails the test instead of letting it pass late.
const inTime = (promise, what, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}.`)), ms); })]).finally(() => clearTimeout(timer));
};

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

test('on a large PR a page carries the files and dispositions of its findings and references the complete lists', async t => {
  const findings = Array.from({ length: 6 }, (_, i) => ({ ...finding(`F-${i + 1}`), location: `head:/src/File${i + 1}.java:2` }));
  const { review, store } = await setup(t, findings);
  const files = Array.from({ length: 316 }, (_, i) => `/src/File${i + 1}.java`);
  review.snapshot.files = files;
  review.final.dispositions.push(...Array.from({ length: 40 }, (_, i) => ({ id: `R-${i + 1}`, status: 'MERGED', mergedInto: i ? 'F-6' : 'F-1', reason: 'Same root cause as the finding it merged into.' })));
  const { invoke, payloads } = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => ({ ...comment(f.id), path: /head:([^:]+)/.exec(f.location)[1] })), skipped: [] }));
  const plan = await prepareComments(review, store, invoke);
  assert.equal(plan.comments.length, 6, 'The runtime still checks paths against every changed file.');
  // Pages are prepared side by side, so read their payloads by page.
  const [first, second] = [1, 2].map(page => payloads.find(p => p.commentWork.page === page));
  assert.deepEqual(first.snapshot.files, ['/src/File1.java', '/src/File2.java', '/src/File3.java', '/src/File4.java']);
  assert.equal(first.snapshot.changedFileCount, 316);
  assert.deepEqual(JSON.parse(await store.read(first.snapshot.allFiles.azprData)), files);
  assert.deepEqual(first.dispositions.map(row => row.id), ['F-1', 'F-2', 'F-3', 'F-4', 'R-1'], "A page keeps its findings' decisions and what merged into them.");
  assert.equal(JSON.parse(await store.read(second.allDispositions.azprData)).length, 46);
  assert.ok(JSON.stringify(first).length < 9000, `${JSON.stringify(first).length} characters`);
  // A small PR keeps both lists inline, as before.
  const small = await setup(t, [finding('F-1')]);
  const few = stages(async payload => JSON.stringify({ status: 'READY', comments: [comment('F-1')], skipped: [] }));
  await prepareComments(small.review, small.store, few.invoke);
  assert.deepEqual([few.payloads[0].snapshot.files, few.payloads[0].dispositions.length, few.payloads[0].allFiles, few.payloads[0].allDispositions], [['/src/Main.java'], 1, undefined, undefined]);
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
    review.commentEvidence = [...(review.commentEvidence ?? []), { page: 1, tool: 'azpr_read_file', input: { path: '/src/Main.java', offset: reads }, result: { sha256: String(reads) } }];
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

test('pages planned side by side assemble exactly as one at a time, whichever page finishes first', async t => {
  // F-1 (page 1) and F-5 (page 2) quote the same line, so their ordinals follow page order.
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 2 }, (_, i) => finding(`F-${i + 1}`));
  const answer = payload => JSON.stringify({ status: 'READY', skipped: [], summaryDetails: `Details of page ${payload.commentWork.page}.`,
    comments: payload.findings.map(f => ({ ...comment(f.id), anchor: ['F-1', 'F-5'].includes(f.id) ? 'shared line' : `code for ${f.id}` })),
    ...(payload.commentWork.allowSummary ? { summary: 'Purpose.' } : {}) });
  const one = await setup(t, findings);
  const sequential = await prepareComments(one.review, one.store, stages(async payload => answer(payload)).invoke, { parallel: 1 });
  const two = await setup(t, findings);
  const secondDone = deferred(), finished = [];
  const { invoke, payloads } = stages(async payload => {
    if (payload.commentWork.page === 1) await within(secondDone.promise);
    return answer(payload);
  });
  const parallel = await prepareComments(two.review, two.store, async (payload, handler) => {
    const page = await invoke(payload, handler);
    finished.push(payload.commentWork.page);
    if (payload.commentWork.page === 2) secondDone.resolve();
    return page;
  }, { parallel: 2 });
  assert.deepEqual(finished, [2, 1], 'Page 2 finished first.');
  const pairs = plan => plan.comments.map(c => [(c.findingIds ?? [c.findingId]).join('+'), c.marker]);
  assert.deepEqual(pairs(parallel), pairs(sequential), 'Every finding keeps the marker it gets when pages run one at a time.');
  assert.deepEqual(parallel, sequential);
  const shared = parallel.comments.filter(c => c.anchor === 'shared line');
  assert.deepEqual(shared.map(c => [c.findingId, c.marker]),
    [['F-1', inlineMarker(two.review.target, shared[0], 0)], ['F-5', inlineMarker(two.review.target, shared[1], 1)]], 'Ordinals follow page order.');
  assert.match(parallel.summary.content, /Purpose\.[\s\S]*Details of page 1\.\n\nDetails of page 2\./);
  assert.ok(payloads.every(p => !('priorPages' in p)), 'No page depends on what another page produced.');
});

test('at most `parallel` pages are planned at once, and two lanes do overlap', async t => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE * 3 + 1 }, (_, i) => finding(`F-${i + 1}`));
  for (const parallel of [2, 1]) {
    const { review, store } = await setup(t, findings);
    let running = 0, most = 0;
    const together = deferred();
    const { invoke, payloads } = stages(async payload => {
      most = Math.max(most, ++running);
      // The first two pages wait for each other, briefly, so one lane cannot hang the test.
      if (payload.commentWork.page <= 2) { if (running === 2) together.resolve(); await Promise.race([together.promise, sleep(200)]); }
      await sleep(2);
      running--;
      return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] });
    });
    const plan = await prepareComments(review, store, invoke, { parallel });
    assert.equal(most, parallel, `${parallel} lane(s)`);
    assert.equal(payloads.length, 4);
    assert.equal(plan.comments.length, findings.length);
  }
});

test('only the first page writes the summary note; a note from another page is dropped without a repair turn', async t => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings);
  const turns = [], results = [];
  const { invoke, payloads } = stages(async payload => {
    turns.push(payload.commentWork.page);
    // Page 1 writes no note; page 2 writes one although it may not.
    return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [],
      ...(payload.commentWork.page === 2 ? { summary: 'Page 2 note.', summaryDetails: '### Details from page 2' } : {}) });
  });
  const plan = await prepareComments(review, store, async (payload, handler) => {
    const page = await invoke(payload, handler);
    results.push([payload.commentWork.page, page]);
    return page;
  });
  assert.deepEqual(payloads.map(p => [p.commentWork.page, p.commentWork.allowSummary]).sort(), [[1, true], [2, false]]);
  assert.deepEqual(turns.sort(), [1, 2], 'The dropped note cost no repair turn.');
  const second = results.find(([page]) => page === 2)[1];
  assert.equal(second.summary, undefined);
  assert.ok(second.corrections.some(c => c.action === 'drop-unallowed-summary'));
  assert.doesNotMatch(plan.summary.content, /Page 2 note|Review notes/, 'Without a note from page 1 the summary has no review notes.');
  assert.match(plan.summary.content, /### Details from page 2/, 'The page keeps its summary details.');
  // The first page may still write the note in a continuation session.
  const cont = await setup(t, [finding('F-1'), finding('F-2')]);
  const later = stages(async payload => JSON.stringify(payload.continuation
    ? { status: 'READY', comments: [comment('F-2')], skipped: [], summary: 'Purpose.' }
    : { status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check F-2 next.' }));
  const kept = await prepareComments(cont.review, cont.store, later.invoke);
  assert.deepEqual(later.payloads.map(p => p.commentWork.allowSummary), [true, true]);
  assert.match(kept.summary.content, /\*\*Review notes\*\*\n\nPurpose\./);
});

test('a continuing page keeps its own checkpoint and evidence while another page runs', async t => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings);
  const read = (page, offset) => ({ sessionID: `ses_${page}`, page, tool: 'azpr_read_file', input: { path: '/src/Main.java', offset }, result: { sha256: `${page}:${offset}` } });
  // Page 2 reads before page 1's first session ends and finishes, with details, before its second ends.
  const secondRead = deferred(), firstSession = deferred(), secondDone = deferred();
  const { invoke, payloads } = stages(async payload => {
    if (payload.commentWork.page === 2) {
      review.commentEvidence = [...(review.commentEvidence ?? []), read(2, 99)];
      secondRead.resolve();
      await within(firstSession.promise);
      return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [], summaryDetails: 'Page 2 details.' });
    }
    if (!payload.continuation) {
      await within(secondRead.promise);
      review.commentEvidence = [...(review.commentEvidence ?? []), read(1, 1)];
      return JSON.stringify({ status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check F-2 to F-4 next.' });
    }
    await within(secondDone.promise);
    return JSON.stringify({ status: 'CONTINUE', comments: [], skipped: [], continuation: 'Still checking F-2 to F-4.' });
  });
  const notices = [];
  const plan = await prepareComments(review, store, async (payload, handler) => {
    const page = await invoke(payload, handler);
    if (payload.commentWork.page === 2) secondDone.resolve();
    else if (!payload.continuation) firstSession.resolve();
    return page;
  }, { progress: message => notices.push(message) });
  const first = payloads.filter(p => p.commentWork.page === 1);
  assert.equal(first.length, 2, "Page 2's read and details were not page 1's progress.");
  const work = (await store.read(first[1].workEvidence)).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(work.map(item => item.page), [1], "A continuation sees only its own page's reads.");
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-5']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-2', 'F-3', 'F-4']);
  assert.ok(notices.includes('Planning comments, page 1/2: the planner repeated a checkpoint without progress; 3 finding(s) skipped.'));
});

test('after a page fails no page or continuation starts; the running page finishes before the failure is thrown', async t => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE * 2 + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings);
  const firstEntered = deferred(), secondFailed = deferred(), started = [];
  let firstFinished = false;
  await assert.rejects(prepareComments(review, store, async (payload, handler) => {
    started.push(`${payload.commentWork.page}${payload.continuation ? ' continued' : ''}`);
    if (payload.commentWork.page === 2) {
      await within(firstEntered.promise);
      secondFailed.resolve();
      throw new Error('Page 2 failed permanently.');
    }
    firstEntered.resolve();
    await within(secondFailed.promise);
    await sleep(10);
    firstFinished = true;
    // Page 1 asks to continue, but no continuation starts after a failure.
    return (await handler.evaluate(JSON.stringify({ status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check the rest next.' }))).result;
  }), /Page 2 failed permanently/);
  assert.ok(firstFinished, 'The failure is thrown only after the running page finished.');
  assert.deepEqual(started.sort(), ['1', '2'], 'Neither page 3 nor a continuation of page 1 started.');
  // When both running pages fail, the lower page's failure is thrown.
  const both = await setup(t, findings);
  const entered = deferred(), failed = deferred();
  await assert.rejects(prepareComments(both.review, both.store, async payload => {
    if (payload.commentWork.page === 2) { await within(entered.promise); failed.resolve(); throw new Error('Page 2 failed.'); }
    entered.resolve();
    await within(failed.promise);
    await sleep(5);
    throw new Error('Page 1 failed.');
  }), /Page 1 failed/);
});

test('a page still preparing its input when another page fails starts no model work', async t => {
  // F-5 has a severity of its own, so no two places could share a comment: nothing is read before the pages.
  const findings = [...Array.from({ length: PLANNING_FINDINGS_PER_PAGE }, (_, i) => finding(`F-${i + 1}`)), { ...finding('F-5', 'medium'), location: 'head:/src/Other.java:2' }];
  const { review, store } = await setup(t, findings);
  review.snapshot.files.push('/src/Other.java');
  const fetching = deferred(), release = deferred(), started = [];
  const fetchSource = async path => {
    if (path === '/src/Other.java') { fetching.resolve(); await within(release.promise); }
    return 'line one\nline two\n';
  };
  await assert.rejects(prepareComments(review, store, async payload => {
    started.push(payload.commentWork.page);
    // Page 2 is still fetching its source; it may go on only after this failure is recorded.
    await within(fetching.promise);
    setTimeout(release.resolve, 20);
    throw new Error('Page 1 failed.');
  }, { fetchSource }), /Page 1 failed/);
  assert.deepEqual(started, [1]);
});

test('a page treats the HEAD source of its own and earlier pages as observed, whichever fetch finishes first', async t => {
  // Page 1 (F-1 to F-4, in A) quotes a line of B; page 2 (F-5, in B) quotes a line of A; both declare line 20.
  // F-5 has a severity of its own, so no two places could share a comment and no file is read before the pages:
  // the fetches below are the pages' own.
  const findings = [...Array.from({ length: PLANNING_FINDINGS_PER_PAGE }, (_, i) => ({ ...finding(`F-${i + 1}`), location: 'head:/src/A.java:2' })),
    { ...finding('F-5', 'medium'), location: 'head:/src/B.java:2' }];
  const sources = { '/src/A.java': 'a0\nonly in A\n', '/src/B.java': 'b0\nonly in B\n' };
  const answer = payload => JSON.stringify(payload.commentWork.page === 1
    ? { status: 'READY', comments: [{ ...comment('F-1'), path: '/src/B.java', startLine: 20, endLine: 20, anchor: 'only in B' }],
      skipped: ['F-2', 'F-3', 'F-4'].map(findingId => ({ findingId, cause: 'too-long', reason: 'Too long to state faithfully.' })) }
    : { status: 'READY', comments: [{ ...comment('F-5'), path: '/src/A.java', startLine: 20, endLine: 20, anchor: 'only in A' }], skipped: [] });
  for (const quick of [false, true]) {
    const plans = [];
    for (const parallel of [1, 2]) {
      const { review, store } = await setup(t, findings);
      review.snapshot.files = ['/src/A.java', '/src/B.java'];
      if (quick) Object.assign(review, { verification: 'none', final: { ...review.final, dispositions: findings.map(f => ({ id: f.id, status: 'REPORTED', finding: f, shard: '1/1' })) } });
      // Two lanes: A is still being fetched while page 2 checks its answer, and
      // page 1 checks its answer only after page 2, which fetched B, finished.
      const aFetched = deferred(), secondDone = deferred();
      const fetchSource = async path => { if (parallel === 2 && path === '/src/A.java') await inTime(aFetched.promise, 'page 2 to release the read of A'); return sources[path]; };
      const { invoke } = stages(async payload => {
        if (parallel === 2 && payload.commentWork.page === 1) await inTime(secondDone.promise, 'page 2 to finish before page 1 answers');
        if (parallel === 2 && payload.commentWork.page === 2) setTimeout(aFetched.resolve, 20);
        return answer(payload);
      });
      plans.push(await prepareComments(review, store, async (payload, handler) => {
        const page = await invoke(payload, handler);
        if (payload.commentWork.page === 2) secondDone.resolve();
        return page;
      }, { fetchSource, parallel }));
    }
    assert.deepEqual(plans[1], plans[0], quick ? 'quick' : 'review');
    if (quick) {
      assert.deepEqual(plans[0].comments.map(c => c.findingId), ['F-5'], 'Page 1 never saw B, so its quote was not found.');
      assert.match(plans[0].skipped.find(s => s.findingId === 'F-1').reason, /anchor text was not found in the HEAD source/);
    } else {
      assert.deepEqual(plans[0].comments.map(c => [c.findingId, c.path, c.startLine]), [['F-1', '/src/B.java', 20], ['F-5', '/src/A.java', 2]],
        'Page 2 saw A and moved its quote to line 2; page 1 never saw B.');
    }
  }
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

// As in Azure DevOps: the thread stays listed, flagged deleted, and the deleted comment has no content.
const deleteOnPr = thread => Object.assign(thread, { isDeleted: true, comments: [{ id: 1, isDeleted: true, commentType: 'text' }] });

test('a comment deleted on the PR is DELETED, settled and never posted again, also for another review', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  assert.deepEqual((await publishPlan({ run, review, azure: api, attempts })).counts, { ALREADY_PRESENT: 3 }, 'A re-run while the comments are visible keeps their record.');
  const [, ...inline] = azure.state.threads;
  inline.forEach(deleteOnPr);
  const writes = azure.callsTo('createThread').length;
  const again = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(again.status, 'POSTED', 'A deleted comment is not a failure to retry.');
  assert.deepEqual(again.counts, { ALREADY_PRESENT: 1, DELETED: 2 });
  assert.deepEqual([...review.publication.values()].filter(entry => entry.state === 'DELETED').map(entry => entry.threadId), inline.map(thread => thread.id));
  const other = (await plannedReview(t, azure)).review;
  assert.deepEqual((await publishPlan({ run, review: other, azure: api, attempts })).counts, { ALREADY_PRESENT: 1, DELETED: 2 });
  assert.equal(azure.callsTo('createThread').length, writes, 'Neither review posts the deleted comments again.');
});

test('a comment found on the PR without a record of its own is remembered, so its deletion is recognized', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  await publishPlan({ run, review, azure: api, attempts });
  // Posted before this record existed, or by another installation.
  for (const marker of Object.keys(attempts.entries)) delete attempts.entries[marker];
  assert.deepEqual((await publishPlan({ run, review, azure: api, attempts })).counts, { ALREADY_PRESENT: 3 });
  assert.deepEqual(Object.values(attempts.entries).map(entry => [entry.state, entry.threadId]), azure.state.threads.map(thread => ['CREATED', thread.id]));
  azure.state.threads.forEach(deleteOnPr);
  const writes = azure.callsTo('createThread').length;
  assert.deepEqual((await publishPlan({ run, review, azure: api, attempts })).counts, { DELETED: 3 });
  assert.equal(azure.callsTo('createThread').length, writes);
});

test('a thread that is already deleted when it is read back is DELETED, not UNVERIFIED', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  azure.state.fail.createThread = () => {
    const thread = deleteOnPr({ id: azure.state.nextThread++ });
    azure.state.threads.push(thread);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: thread.id, comments: [] }) };
  };
  const result = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(result.status, 'POSTED');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'DELETED' && entry.threadId >= 1000));
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

test('publication refuses a changed source commit before writing; the PR\'s status stops nothing and is named', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  azure.state.head = 'c'.repeat(40);
  const stale = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(stale.status, 'STALE');
  assert.equal(azure.callsTo('createThread').length, 0);
  // A PR completed before its review was commented on (merged too early, say) takes the comments like an active one.
  azure.state.head = head;
  azure.state.status = 'completed';
  const posted = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(posted.status, 'POSTED');
  assert.equal(posted.prStatus, 'completed');
  assert.equal(azure.state.threads.length, 3);
  assert.match(renderPublication(review, posted), /^Publication \(VERIFIED=3\); the PR is completed:\n/);
  // So does an abandoned one, and a second run still posts nothing twice.
  azure.state.status = 'abandoned';
  const again = await publishPlan({ run, review, azure: api, attempts });
  assert.deepEqual([again.status, again.prStatus, again.counts], ['POSTED', 'abandoned', { ALREADY_PRESENT: 3 }]);
  assert.equal(azure.state.threads.length, 3);
  // An active PR is not mentioned: the receipt of the usual case stays as it was.
  azure.state.status = 'active';
  const active = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(Object.hasOwn(active, 'prStatus'), false);
  assert.match(renderPublication(review, active), /^Publication \(ALREADY_PRESENT=3\):\n/);
  // The changed source commit of a completed PR is refused like any other.
  azure.state.status = 'completed';
  azure.state.head = 'c'.repeat(40);
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'STALE');
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

test('a posted comment for several places tells a later plan which other places it covers', () => {
  const marker = '<!-- azpr-comment:' + 'b'.repeat(32) + ' -->';
  const places = [{ findingId: 'F-2', place: '/src/b.ts:30-34' }, { findingId: 'F-3', place: '/src/c`d.ts:12' }];
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    // The text is what the runtime posts: the planner's body, the list, the attribution and the marker.
    const content = `🔴 high: Unchecked call\n\n${'Body. '.repeat(80)}\n\n${renderOtherPlaces(places, language)}\n\n---\n${ATTRIBUTION}\n\n${marker}`;
    assert.deepEqual(listedPlaces(content), ['/src/b.ts:30-34', '/src/c`d.ts:12'], language);
    const [entry] = discussionDigest([{ id: 7, status: 1, comments: [{ content }], threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 4 } } }]);
    assert.deepEqual(entry.alsoAt, ['/src/b.ts:30-34', '/src/c`d.ts:12'], 'The list lies beyond the excerpt, so the digest names the places.');
    assert.equal(entry.excerpt.length, 300);
  }
  // Only AZPR's own comment is read this way: the same words from anyone else, or without a file, are just text.
  const list = renderOtherPlaces(places, 'en'), lookalike = `Note\n\n${list}`, tail = `\n\n---\n${ATTRIBUTION}\n\n${marker}`;
  const at = { filePath: '/src/a.ts', rightFileStart: { line: 4 } };
  assert.equal(Object.hasOwn(discussionDigest([{ id: 8, comments: [{ content: lookalike }], threadContext: at }])[0], 'alsoAt'), false);
  assert.equal(Object.hasOwn(discussionDigest([{ id: 9, comments: [{ content: `${lookalike}\n\n${marker}` }] }])[0], 'alsoAt'), false);
  // ... and only where it opened the thread, as AZPR posts it. A reply that quotes such a comment, marker and
  // all, says nothing about the thread it is in, also when it is the first comment left there.
  const posted = `Note\n\n${list}${tail}`;
  const quoting = discussionDigest([{ id: 10, comments: [{ id: 1, parentCommentId: 0, content: 'Is this still right?' }, { id: 2, parentCommentId: 1, content: posted }], threadContext: at }])[0];
  assert.deepEqual([Object.hasOwn(quoting, 'alsoAt'), quoting.azpr], [false, true]);
  const orphan = discussionDigest([{ id: 11, comments: [{ id: 1, parentCommentId: 0, isDeleted: true }, { id: 2, parentCommentId: 1, content: posted }], threadContext: at }])[0];
  assert.equal(Object.hasOwn(orphan, 'alsoAt'), false);
  assert.deepEqual(discussionDigest([{ id: 12, comments: [{ id: 1, parentCommentId: 0, content: posted }, { id: 2, parentCommentId: 1, content: 'Fixed in both.' }], threadContext: at }])[0].alsoAt, ['/src/b.ts:30-34', '/src/c`d.ts:12']);
});

test('the list of other places is read back only in the form the runtime writes it', () => {
  const marker = '<!-- azpr-comment:' + 'c'.repeat(32) + ' -->', tail = `\n\n---\n${ATTRIBUTION}\n\n${marker}`;
  const places = [{ findingId: 'F-2', place: '/src/b.ts:30-34' }, { findingId: 'Q-1003', place: '/src/c.ts:12' }], read = ['/src/b.ts:30-34', '/src/c.ts:12'];
  const list = renderOtherPlaces(places, 'en');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}${tail}`), read);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n${marker}`), read, 'Without an attribution the marker follows at once.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}${tail}`.replaceAll('\n', '\r\n')), read, 'Line ends as a service may return them.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}${tail}\n\n`), read);
  // Anything else is text: no marker, another heading, the heading inside a line, rows that do not follow it, text after the rows.
  assert.deepEqual(listedPlaces('🔴 high: Title\n\nNo list here.'), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}`), [], 'No marker.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}`), [], 'No marker at the end.');
  assert.deepEqual(listedPlaces(`Body.\n\n**📍 Also at** (…):\n- \`/x.ts:1\` (F-1)${tail}`), [], 'Another heading.');
  assert.deepEqual(listedPlaces(`Body.\n\nSee **📍 Also at** (the same defect; fix these places with it):\n- \`/x.ts:1\` (F-1)${tail}`), [], 'The heading is a line of its own.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list.replace('\n', '\nnot a row\n')}${tail}`), [], 'Rows follow the heading directly.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n- no place here${tail}`), [], 'Every line under the heading is a row.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\nMore of the body.${tail}`), [], 'A list inside someone\'s text is not the runtime\'s.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n${marker}`), [], 'A blank line ends the list.');
  // After the rows comes what the runtime writes and nothing else: the marker, or a rule, one paragraph and the marker.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nThe list above is only an example.\n\n---\n${ATTRIBUTION}\n\n${marker}`), [], 'A paragraph between the list and the attribution.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n\nOne more paragraph.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n\n${marker}`), [], 'A rule without an attribution.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n${ATTRIBUTION}\n\n${marker}`), [], 'An attribution without its rule.');
  // The attribution is the one line the runtime writes, which ends with its models: a comment that someone continued
  // after it (a heading and a withdrawal, say, with or without a blank line) no longer says what it lists.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n## Correction\nThe second place is withdrawn.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION} The second place is withdrawn.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nAI review\n\n${marker}`), [], 'Not an attribution of the runtime\'s: no models.');
  // What `commentAttribution` writes, for each kind of review and language, is such a line.
  const provenance = { stages: [{ model: 'provider/reviewer' }, { model: 'provider/verifier#high' }] };
  for (const language of ['en', 'zh-TW', 'zh-CN']) for (const options of [{}, { verification: 'none' }, { verification: 'none', coverage: { complete: false, reviewed: 3, total: 5 } }]) {
    const attribution = commentAttribution(provenance, language, 'provider/planner', options);
    assert.deepEqual(listedPlaces(`Body.\n\n${renderOtherPlaces(places, language)}\n\n---\n${attribution}\n\n${marker}`), read, `${language} ${JSON.stringify(options)}: ${attribution}`);
  }
  assert.deepEqual(listedPlaces(null), []);
  // A text that quotes such a list above the runtime's own: the rows are those under the last heading.
  assert.deepEqual(listedPlaces(`Body.\n\n${renderOtherPlaces([{ findingId: 'F-9', place: '/fake.ts:1' }], 'en')}\n\nMore.\n\n${list}${tail}`), read);
  // Whatever a file is called, a place that may be listed reads back as it was written, in each language.
  for (const place of ['/src/a b.ts:3', '/src/a`b``c.ts:3-9', '/src/(F-1) x.ts:7', '/src/名前.ts:1', '/src/a（F-2）.ts:5', '/src/` (F-1)`.ts:2', '/src/&lt;!--.ts:4', '/`.ts:1', '/src/a - `x` (F-3).ts:10-11']) {
    assert.equal(listablePlace(place), true, place);
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      assert.deepEqual(listedPlaces(`Body.\n\n${renderOtherPlaces([{ findingId: 'F-2', place }, { findingId: 'F-3', place: '/z.ts:1' }], language)}${tail}`), [place, '/z.ts:1'], `${place} ${language}`);
    }
  }
  // One that cannot (a control character, an end of an HTML comment, which the posted text would change) is never offered for a list.
  for (const place of ['/src/x-->y.ts:2', '/src/x<!--y.ts:2', '/src/a\tb.ts:2', '/src/a\nb.ts:2', '/src/a\u007fb.ts:2', '/src/a\u0085b.ts:2', '/src/a\u2028b.ts:2', 7, null, undefined]) assert.equal(listablePlace(place), false, String(place));
});

test('what a comment would meet on the PR under its marker: the thread, and the places that the comment which opened it lists', () => {
  const mark = digit => '<!-- azpr-comment:' + String(digit).repeat(32) + ' -->';
  const list = renderOtherPlaces([{ findingId: 'F-2', place: '/src/b.ts:3' }], 'en');
  const shared = marker => `Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n\n${marker}`, single = marker => `Body.\n\n---\n${ATTRIBUTION}\n\n${marker}`;
  const posted = postedComments([
    // A reply that quotes a shared comment whose own thread is gone: the marker is on the PR, but nothing says what it covers.
    { id: 4, comments: [{ id: 1, parentCommentId: 0, content: 'Is this still open?' }, { id: 2, parentCommentId: 1, content: shared(mark(1)) }] },
    { id: 5, comments: [{ id: 1, parentCommentId: 0, content: shared(mark(2)) }, { id: 2, parentCommentId: 1, content: `A reply that quotes ${mark(3)}` }] },
    { id: 6, isDeleted: true, comments: [{ id: 1, parentCommentId: 0, content: shared(mark(4)) }] },
    { id: 7, comments: [{ id: 1, parentCommentId: 0, isDeleted: true, content: shared(mark(5)) }, { id: 2, parentCommentId: 1, content: 'No marker.' }] },
    // The opening comment of a later thread is what the marker of a quote stands for, wherever the quote came first.
    { id: 8, comments: [{ id: 1, parentCommentId: 0, content: single(mark(3)) }] },
    // A marker inside a text that ends otherwise is on the PR and lists nothing.
    { id: 9, comments: [{ id: 1, parentCommentId: 0, content: `${shared(mark(6))}\n\nA note written after it.` }] },
  ]);
  assert.deepEqual([...posted].sort(([a], [b]) => a.localeCompare(b)), [
    [mark(1), { threadId: 4, places: [], opening: false }],
    [mark(2), { threadId: 5, places: ['/src/b.ts:3'], opening: true }],
    [mark(3), { threadId: 8, places: [], opening: true }],
    [mark(6), { threadId: 9, places: [], opening: false }],
  ]);
  assert.equal(postedComments(null).size, 0);
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

// ------------------------------------------------------------ one defect at several places
// Findings on line 2 of their own files: the same mistake wherever a test says so.
const placed = (id, file, severity = 'high', extra = {}) => ({ ...finding(id, severity), location: `head:/src/${file}.java:2`, ...extra });
const sourceOf = async () => 'line one\nline two\nline three\n';
async function placedSetup(t, findings) {
  const prepared = await setup(t, findings);
  prepared.review.snapshot.files = [...new Set(findings.map(f => parseLocation(f.location).path))];
  return prepared;
}
// The planning pages among recorded payloads, in page order (lanes record them as they start).
const pagesOf = payloads => payloads.filter(p => p.commentWork.kind !== 'group').sort((x, y) => x.commentWork.page - y.commentWork.page);
// A planner that writes one comment for every listed group and its own comment for every other finding.
const groupwise = payload => {
  const grouped = new Set((payload.repeatCandidates ?? []).flat());
  const at = f => ({ path: parseLocation(f.location).path, startLine: 2, endLine: 2, anchor: 'line two' });
  const byId = new Map(payload.findings.map(f => [f.id, f]));
  return JSON.stringify({ status: 'READY', skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, cause: 'low-severity', reason: 'Low.' })),
    comments: [...(payload.repeatCandidates ?? []).map(ids => ({ findingIds: ids, mergeReason: 'The same unchecked call.', severity: byId.get(ids[0]).severity, ...at(byId.get(ids[0])), body: `🔴 high: Unchecked call\n\nBody.` })),
      ...payload.findings.filter(f => f.severity !== 'low' && !grouped.has(f.id)).map(f => ({ ...comment(f.id), severity: f.severity, ...at(f) }))] });
};

test('repeat candidates: high and medium findings on HEAD lines; a set needs one severity and two places', () => {
  const a = placed('F-1', 'A'), b = placed('F-2', 'B'), c = placed('F-3', 'C', 'medium'), d = placed('F-4', 'A');
  assert.deepEqual(repeatEligible([a, b, c, placed('F-5', 'D', 'low'), { ...placed('F-6', 'E'), inline: false }, { ...placed('F-7', 'F'), location: 'base:/src/F.java:2' },
    { ...placed('F-8', 'G'), location: 'head:/src/G.java' }]).map(f => f.id), ['F-1', 'F-2', 'F-3']);
  assert.deepEqual(repeatEligible([a, b, c], [['F-2', 'F-9']]).map(f => f.id), ['F-1', 'F-3'], 'A quick finding that is a merge candidate is left to that rule.');
  assert.deepEqual(repeatEligible([a, b, c], [], ['/src/A.java', 'src/C.java']).map(f => f.id), ['F-1', 'F-3'], 'Only places on files the PR changes.');
  assert.deepEqual(repeatEligible([a, { ...b, location: 'head:/src/B.java:5-3' }, { ...c, location: 'head:/src/x-->y.java:2' }, { ...d, location: 'head:/src/a\tb.java:2' }]).map(f => f.id), ['F-1'],
    'Lines that end before they begin are no place, and a file name a list cannot hold as it is is listed nowhere.');
  assert.deepEqual(severitySets([a, b, c]), [['F-1', 'F-2']], 'One medium finding is no set.');
  assert.deepEqual(severitySets([a, d]), [], 'Findings that all share lines lie at one place.');
  assert.deepEqual(severitySets([a, d, b]), [['F-1', 'F-4', 'F-2']]);
  assert.deepEqual(severitySets([a, { ...d, location: 'head:/src/A.java:3-5' }]), [['F-1', 'F-4']], 'Other lines of one file are another place.');
  assert.deepEqual(severitySets([a, c]), []);
});

test('a group larger than a page\'s text is planned in parts of two or more findings; no place is dropped', () => {
  const big = 'x'.repeat(5000);
  const findings = ['A', 'B', 'C', 'D', 'E'].map((file, i) => placed(`F-${i + 1}`, file, 'high', { evidence: big }));
  assert.deepEqual(boundedGroups([['F-1', 'F-2', 'F-3', 'F-4', 'F-5']], findings), [['F-1', 'F-2'], ['F-3', 'F-4']], 'F-5 is left alone and gets its own comment.');
  assert.deepEqual(boundedGroups([['F-1', 'F-2', 'F-3', 'F-4']], findings), [['F-1', 'F-2'], ['F-3', 'F-4']]);
  const small = findings.map(f => ({ ...f, evidence: 'e' }));
  assert.deepEqual(boundedGroups([['F-1', 'F-2', 'F-3', 'F-4', 'F-5'], ['F-9']], small), [['F-1', 'F-2', 'F-3', 'F-4', 'F-5']]);
  // A long finding before two short ones: it is planned alone, and the part that follows fits a page.
  const uneven = [placed('F-1', 'A', 'high', { evidence: 'x'.repeat(9000) }), placed('F-2', 'B', 'high', { evidence: 'x'.repeat(4000) }), placed('F-3', 'C', 'high', { evidence: 'x'.repeat(4000) })];
  const parts = boundedGroups([['F-1', 'F-2', 'F-3']], uneven);
  assert.deepEqual(parts, [['F-2', 'F-3']]);
  const length = ids => ids.reduce((sum, id) => sum + JSON.stringify(uneven.find(f => f.id === id)).length, 0);
  assert.ok(parts.every(ids => length(ids) <= 12000), 'No part is larger than a page.');
  assert.deepEqual(boundedGroups([['F-1', 'F-2', 'F-3']], [uneven[1], uneven[0], uneven[2]].map((f, i) => ({ ...f, id: `F-${i + 1}` }))), [], 'A long finding between two short ones leaves no two for one page.');
});

test('on one page the findings of equal severity at different places are offered; one comment lists the other places', async t => {
  const { review, store } = await placedSetup(t, [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C', 'medium'), placed('F-4', 'D', 'low')]);
  const { invoke, payloads } = stages(async payload => groupwise(payload));
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.equal(payloads.length, 1, 'No grouping pass: the page sees every finding itself.');
  assert.deepEqual(payloads[0].repeatCandidates, [['F-1', 'F-2']]);
  assert.equal(Object.hasOwn(payloads[0], 'mergeCandidates'), false);
  assert.deepEqual(payloads[0].findings.map(f => f.id), ['F-1', 'F-2', 'F-3', 'F-4'], 'The page keeps its order.');
  assert.deepEqual(plan.comments.map(c => [c.findingIds ?? c.findingId, c.path, c.otherPlaces ?? null]),
    [[['F-1', 'F-2'], '/src/A.java', [{ findingId: 'F-2', place: '/src/B.java:2' }]], ['F-3', '/src/C.java', null]]);
  assert.match(plan.comments[0].content, /Body\.\n\n\*\*📍 Also at\*\* \(the same defect; fix these places with it\):\n- `\/src\/B\.java:2` \(F-2\)\n\n---\nAI review\. Models: `fixture\/planner`\n\n<!-- azpr-comment:/);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-4']);
  assert.match(plan.summary.content, /high: 2 · medium: 1 · low: 1/, 'Every place keeps its row and its count.');
  // The same findings on the same lines are one place: nothing is offered and the input is as before.
  const same = await setup(t, [finding('F-1'), finding('F-2')]);
  const unchanged = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  await prepareComments(same.review, same.store, unchanged.invoke);
  assert.equal(Object.hasOwn(unchanged.payloads[0], 'repeatCandidates'), false);
});

test('only a place whose lines the HEAD file has is offered; without that text nothing is', async t => {
  // F-3 names line 40 of a file of three lines, F-4 a file that cannot be read at HEAD (deleted in this PR, say).
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C', 'high', { location: 'head:/src/C.java:40' }), placed('F-4', 'D')];
  const fetchSource = async path => { if (path === '/src/D.java') throw new Error('not found'); return 'line one\nline two\nline three\n'; };
  const { review, store } = await placedSetup(t, findings);
  const one = stages(async payload => groupwise(payload));
  const plan = await prepareComments(review, store, one.invoke, { fetchSource });
  assert.deepEqual(one.payloads[0].repeatCandidates, [['F-1', 'F-2']]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), [['F-1', 'F-2'], 'F-3', 'F-4']);
  // A planner that combines them all the same is refused, with the place and the reason.
  const forced = await placedSetup(t, findings), issues = [];
  const insisting = stages(async (payload, turn, evaluation) => {
    if (turn) { issues.push(...evaluation.issues); return groupwise(payload); }
    return JSON.stringify({ status: 'READY', skipped: [{ findingId: 'F-4', cause: 'cannot-anchor', reason: 'No source.' }], comments: [{ findingIds: ['F-1', 'F-2', 'F-3'], mergeReason: 'Same.', severity: 'high', path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🔴 high: Unchecked call\n\nBody.' }] });
  });
  await prepareComments(forced.review, forced.store, insisting.invoke, { fetchSource });
  assert.match(issues.join('\n'), /combined comment for F-1, F-2, F-3: the findings are not all in one listed group/);
  // With several pages the pass sees only such places.
  const many = [...findings, placed('F-5', 'E'), placed('F-6', 'F')];
  const paged = await placedSetup(t, many);
  const pass = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload));
  await prepareComments(paged.review, paged.store, pass.invoke, { fetchSource });
  assert.deepEqual(pass.payloads[0].findings.map(f => f.id), ['F-1', 'F-2', 'F-5', 'F-6']);
  // Without the text of the files nothing can be listed, so nothing is offered and no pass runs.
  const blind = await placedSetup(t, many);
  const none = stages(async payload => JSON.stringify({ status: 'READY', skipped: payload.findings.map(f => ({ findingId: f.id, cause: 'cannot-anchor', reason: 'No source.' })), comments: [] }));
  await prepareComments(blind.review, blind.store, none.invoke);
  assert.ok(none.payloads.every(p => p.commentWork.kind === 'plan' && !Object.hasOwn(p, 'repeatCandidates')));
});

test('a comment for several places that the PR would already seem to have goes back to the planner, which moves it', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C')];
  const { review, store } = await placedSetup(t, findings);
  // What an earlier publication left at F-1's lines: a comment for that place alone, under the marker a shared one would carry.
  const first = await prepareComments(review, store, stages(async payload => groupwise({ ...payload, repeatCandidates: [] })).invoke, { fetchSource: sourceOf });
  const threads = [{ id: 31, status: 'active', comments: [{ id: 1, parentCommentId: 0, content: first.comments[0].content }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } }];
  const issues = [];
  const { invoke } = stages(async (payload, turn, evaluation) => {
    if (!turn) return groupwise(payload);
    issues.push(...evaluation.issues);
    // The planner anchors the comment at another of its places.
    return JSON.stringify({ status: 'READY', skipped: [], comments: [{ findingIds: ['F-1', 'F-2', 'F-3'], mergeReason: 'Same.', severity: 'high', path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🔴 high: Unchecked call\n\nBody.' }] });
  });
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf, discussions: discussionDigest(threads), posted: postedComments(threads) });
  assert.match(issues.join('\n'), /the PR already has a comment under the marker of these lines \(thread 31\)[\s\S]*does not list F-2 at \/src\/B\.java:2, F-3 at \/src\/C\.java:2/);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.path, c.otherPlaces.map(other => other.place)]), [['F-2', '/src/B.java', ['/src/A.java:2', '/src/C.java:2']]]);
  assert.notEqual(plan.comments[0].marker, first.comments[0].marker);
});

test('a page continued in a new session still offers what is open of a group, while two of its findings are', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C'), placed('F-4', 'D', 'medium')];
  const { review, store } = await placedSetup(t, findings);
  const { invoke, payloads } = stages(async payload => {
    // The first session comments on F-1 alone and stops; the next one sees what is left.
    if (payload.findings.length === 4) return JSON.stringify({ status: 'CONTINUE', continuation: 'F-1 is done; F-2, F-3 and F-4 remain.', skipped: [],
      comments: [{ ...comment('F-1'), path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two' }] });
    return groupwise(payload);
  });
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.deepEqual(payloads.map(p => [p.findings.map(f => f.id), p.repeatCandidates ?? null]), [[['F-1', 'F-2', 'F-3', 'F-4'], [['F-1', 'F-2', 'F-3']]], [['F-2', 'F-3', 'F-4'], [['F-2', 'F-3']]]]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3'], 'F-4']);
  // One finding left of a group is no group.
  const pair = await placedSetup(t, findings.slice(0, 2));
  const alone = stages(async payload => payload.findings.length === 2
    ? JSON.stringify({ status: 'CONTINUE', continuation: 'F-1 is done; F-2 remains.', skipped: [], comments: [{ ...comment('F-1'), path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two' }] })
    : groupwise(payload));
  await prepareComments(pair.review, pair.store, alone.invoke, { fetchSource: sourceOf });
  assert.deepEqual(alone.payloads.map(p => p.repeatCandidates ?? null), [[['F-1', 'F-2']], null]);
});

test('the grouping pass reads its findings inline: a long list goes without the evidence, and one that is still too long is not grouped', async t => {
  const answer = async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload);
  const files = Array.from({ length: 40 }, (_, i) => `F${i}`);
  // 40 findings with 2,000 characters of evidence each: more than the pass takes, but not without the evidence.
  const long = await placedSetup(t, files.map((file, i) => placed(`F-${i + 1}`, file, 'high', { evidence: 'e'.repeat(2000) })));
  const some = stages(answer), notes = [];
  await prepareComments(long.review, long.store, some.invoke, { fetchSource: sourceOf, progress: note => notes.push(note) });
  const pass = some.payloads.find(p => p.commentWork.kind === 'group');
  assert.ok(Array.isArray(pass.findings), 'The findings are inline, never a reference the pass would have to read.');
  assert.equal(pass.findings.length, 40);
  assert.deepEqual(Object.keys(pass.findings[0]), ['id', 'severity', 'location', 'summary', 'suggestion']);
  assert.ok(JSON.stringify(pass.findings).length <= 60000);
  // Summaries alone beyond that size: no pass, a note, and every finding planned on its own.
  const huge = await placedSetup(t, files.map((file, i) => ({ ...placed(`F-${i + 1}`, file), summary: 's'.repeat(2000) })));
  const skipped = stages(answer), said = [];
  const plan = await prepareComments(huge.review, huge.store, skipped.invoke, { fetchSource: sourceOf, progress: note => said.push(note) });
  assert.ok(skipped.payloads.every(p => p.commentWork.kind === 'plan' && !Object.hasOwn(p, 'repeatCandidates')));
  assert.match(said.join('\n'), /Planning comments: 40 findings are too many to look through for one defect at several places; every finding gets its own comment\./);
  assert.equal(plan.comments.length, 40);
});

test('with several pages one grouping pass runs first; a group shares a page, which may then hold more than four findings', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C'), placed('F-4', 'D'), placed('F-5', 'E'), placed('F-6', 'F'), placed('F-7', 'G', 'medium'), placed('F-8', 'H', 'low')];
  const { review, store } = await placedSetup(t, findings);
  const notes = [];
  const { invoke, payloads } = stages(async payload => payload.commentWork.kind === 'group'
    // F-2, F-3, F-5 and F-6 and F-7 repeat one mistake; F-7 is medium and belongs to no group.
    ? JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-6', 'F-2', 'F-5', 'F-3', 'F-4'], reason: 'The same unchecked call in each handler.' }] })
    : groupwise(payload));
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf, progress: note => notes.push(note) });
  const pass = payloads[0], pages = pagesOf(payloads);
  assert.equal(payloads.filter(p => p.commentWork.kind === 'group').length, 1, 'One pass, before any page.');
  assert.deepEqual(pass.commentWork, { kind: 'group' });
  assert.deepEqual(pass.findings.map(f => f.id), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7'], 'The pass sees the high and medium findings, not the low one.');
  assert.deepEqual(Object.keys(pass.findings[0]), ['id', 'severity', 'location', 'summary', 'evidence', 'suggestion']);
  assert.deepEqual(Object.keys(pass).sort(), ['commentWork', 'findings', 'outputLanguage', 'reviewId']);
  assert.match(notes[0], /looking for one defect at several places \(7 findings\)/);
  assert.deepEqual(pages.map(p => p.findings.map(f => f.id)), [['F-1'], ['F-2', 'F-3', 'F-4', 'F-5', 'F-6'], ['F-7', 'F-8']], 'The group has a page of its own, in the order of the findings.');
  assert.deepEqual(pages.map(p => p.repeatCandidates ?? null), [null, [['F-2', 'F-3', 'F-4', 'F-5', 'F-6']], null]);
  assert.deepEqual(pages.map(p => [p.commentWork.page, p.commentWork.pages]), [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3', 'F-4', 'F-5', 'F-6'], 'F-7']);
  assert.deepEqual(plan.comments[1].otherPlaces.map(place => place.place), ['/src/C.java:2', '/src/D.java:2', '/src/E.java:2', '/src/F.java:2']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-8']);
  // A pass that finds nothing leaves the pages exactly as they are without it.
  const none = await placedSetup(t, findings);
  const plain = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload));
  await prepareComments(none.review, none.store, plain.invoke, { fetchSource: sourceOf });
  assert.deepEqual(pagesOf(plain.payloads).map(p => p.findings.map(f => f.id)), [['F-1', 'F-2', 'F-3', 'F-4'], ['F-5', 'F-6', 'F-7', 'F-8']]);
  assert.ok(pagesOf(plain.payloads).every(p => !Object.hasOwn(p, 'repeatCandidates')));
});

test('the grouping pass is corrected like a page; a group that stays wrong is dropped and its findings are planned alone', async t => {
  const findings = ['A', 'B', 'C', 'D', 'E'].map((file, i) => placed(`F-${i + 1}`, file));
  const { review, store } = await placedSetup(t, findings);
  const turns = [];
  const { invoke, payloads } = stages(async (payload, turn, evaluation) => {
    if (payload.commentWork.kind !== 'group') return groupwise(payload);
    turns.push(evaluation?.issues ?? null);
    // F-9 does not exist; the planner never corrects it, and keeps one valid group.
    return JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-1', 'F-9'] }, { findingIds: ['F-4', 'F-5'], reason: 'Same.' }] });
  });
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.equal(turns.length, 3, 'Two correction turns, as for a page.');
  assert.match(turns[1].join('\n'), /group F-1, F-9: F-9 is not in findings/);
  assert.deepEqual(pagesOf(payloads).map(p => [p.findings.map(f => f.id), p.repeatCandidates ?? null]), [[['F-1', 'F-2', 'F-3'], null], [['F-4', 'F-5'], [['F-4', 'F-5']]]]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), ['F-1', 'F-2', 'F-3', ['F-4', 'F-5']]);
});

test('a grouping pass that fails costs only the grouping; a stopped run is not continued', async t => {
  const findings = ['A', 'B', 'C', 'D', 'E'].map((file, i) => placed(`F-${i + 1}`, file));
  const failing = pages => async (payload, handler) => {
    if (payload.commentWork.kind === 'group') throw Object.assign(new Error('Provider unavailable.'), { failureClass: 'transient' });
    return pages.invoke(payload, handler);
  };
  const { review, store } = await placedSetup(t, findings);
  const pages = stages(async payload => groupwise(payload)), notes = [];
  const plan = await prepareComments(review, store, failing(pages), { fetchSource: sourceOf, progress: note => notes.push(note) });
  assert.match(notes.join('\n'), /the grouping failed \(Provider unavailable\.\); every finding gets its own comment\./);
  assert.deepEqual(pagesOf(pages.payloads).map(p => p.findings.map(f => f.id)), [['F-1', 'F-2', 'F-3', 'F-4'], ['F-5']]);
  assert.ok(pages.payloads.every(p => !Object.hasOwn(p, 'repeatCandidates')));
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5']);
  // A run that was stopped meanwhile plans nothing more, whatever the failure looked like.
  for (const options of [{ active: () => false }, {}]) {
    const stopped = await placedSetup(t, findings), later = stages(async payload => groupwise(payload));
    const thrown = options.active ? new Error('Review stopped.') : Object.assign(new Error('Review stopped.'), { failureClass: 'cancelled' });
    await assert.rejects(prepareComments(stopped.review, stopped.store, async (payload, handler) => {
      if (payload.commentWork.kind === 'group') throw thrown;
      return later.invoke(payload, handler);
    }, { fetchSource: sourceOf, ...options }), /Review stopped/);
    assert.equal(later.payloads.length, 0, 'No page starts after a stop.');
  }
});

test('a quick review offers both kinds: the same lines twice as merge candidates, other places as repeat candidates', async t => {
  const a = quickFinding('Q-1', '1/2', 'head:/src/A.java:2'), b = quickFinding('Q-1001', '2/2', 'head:/src/A.java:2'),
    c = quickFinding('Q-2', '1/2', 'head:/src/B.java:2'), d = quickFinding('Q-3', '1/2', 'head:/src/C.java:2');
  const { review, store } = await placedSetup(t, [a, b, c, d]);
  Object.assign(review, { verification: 'none', final: { ...review.final, dispositions: [a, b, c, d].map(f => ({ id: f.id, status: 'REPORTED', finding: f, shard: f.shard })) } });
  const { invoke, payloads } = stages(async payload => JSON.stringify({ status: 'READY', skipped: [], comments: [
    { findingIds: ['Q-1', 'Q-1001'], mergeReason: 'Reported twice.', severity: 'medium', path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🟡 medium: Twice\n\nBody.' },
    { findingIds: ['Q-2', 'Q-3'], mergeReason: 'The same call.', severity: 'medium', path: '/src/C.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🟡 medium: Repeated\n\nBody.' }] }));
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.deepEqual([payloads[0].mergeCandidates, payloads[0].repeatCandidates], [[['Q-1', 'Q-1001']], [['Q-2', 'Q-3']]]);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.findingIds, c.otherPlaces ?? null]),
    [['Q-1', ['Q-1', 'Q-1001'], null], ['Q-3', ['Q-3', 'Q-2'], [{ findingId: 'Q-2', place: '/src/B.java:2' }]]]);
  assert.match(plan.summary.content, /\| 🟡 medium \| Q-1, Q-1001 — Defect Q-1 \|/, 'Reported twice on the same lines: one row.');
  assert.match(plan.summary.content, /\| 🟡 medium \| Q-2 — Defect Q-2 \|[\s\S]*\| 🟡 medium \| Q-3 — Defect Q-3 \|/, 'Two places: two rows.');
});

test('a shared comment that meets an earlier comment at its place: publication says which findings the PR does not hold', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C')];
  const { review, store, azure } = await placedSetup(t, findings);
  const { api, run, attempts } = publisher(azure);
  const plan = answer => prepareComments(review, store, stages(answer).invoke, { fetchSource: sourceOf });
  // An earlier publication put a comment for F-1 alone on the PR.
  const separate = await plan(async payload => groupwise({ ...payload, repeatCandidates: [] }));
  review.plan = { summary: null, skipped: [], comments: separate.comments.slice(0, 1) };
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  // A plan that was made without a look at the PR combines the three at F-1's lines: the marker is the one already there.
  const shared = await plan(async payload => groupwise(payload));
  assert.deepEqual([shared.comments.length, shared.comments[0].marker], [1, separate.comments[0].marker]);
  const later = { ...review, publication: new Map(), plan: { summary: null, skipped: [], comments: shared.comments } };
  const result = await publishPlan({ run, review: later, azure: api, attempts });
  assert.equal(azure.callsTo('createThread').length, 1, 'Nothing is posted again, and the earlier comment is not changed.');
  assert.equal(azure.state.threads[0].comments[0].content, separate.comments[0].content);
  const thread = azure.state.threads[0].id;
  assert.deepEqual([result.status, result.counts], ['POSTED', { ALREADY_PRESENT: 1 }]);
  assert.deepEqual(result.uncovered, [{ marker: shared.comments[0].marker, findingIds: ['F-2', 'F-3'], path: '/src/A.java', startLine: 2, threadId: thread }]);
  assert.deepEqual([[...later.publication.values()][0].unlisted, [...later.publication.values()][0].unlistedThread], [['F-2', 'F-3'], thread], 'The item\'s entry says what the comment there does not list, and which comment.');
  const receipt = renderPublication(later, result);
  assert.match(receipt, new RegExp(`^Publication \\(ALREADY_PRESENT=1\\):\\n- F-1, F-2, F-3 \\(/src/A\\.java:2\\): ALREADY_PRESENT; thread=${thread}; the comment there does not list F-2, F-3\\n`));
  assert.match(receipt, /An entry that says a comment "does not list" findings stands for one defect at several places, and the comment the PR has under its marker lists fewer: that comment was not changed, and this one was not posted for the findings named\.$/);
  // A later publication of another plan of this review keeps that row as it was recorded, with what it says.
  const next = { ...later, plan: { summary: null, skipped: [], comments: separate.comments.slice(1, 2) } };
  const nextResult = await publishPlan({ run, review: next, azure: api, attempts });
  assert.equal(Object.hasOwn(nextResult, 'uncovered'), false, 'Nothing of the kind was found for the items of this publication.');
  assert.match(renderPublication(next, nextResult), new RegExp(`- F-1, F-2, F-3 \\(/src/A\\.java:2\\): ALREADY_PRESENT; thread=${thread}; the comment there does not list F-2, F-3\\n- F-2 \\(/src/B\\.java:2\\): VERIFIED`));
  // The shared comment itself on the PR covers every place: a re-run says nothing of the kind, and its receipt is as it was.
  const fresh = await placedSetup(t, findings), other = publisher(fresh.azure);
  const posted = { ...fresh.review, publication: new Map(), plan: { summary: null, skipped: [], comments: shared.comments } };
  const first = await publishPlan({ run: other.run, review: posted, azure: other.api, attempts: other.attempts });
  const again = await publishPlan({ run: other.run, review: posted, azure: other.api, attempts: other.attempts });
  assert.deepEqual([first.status, Object.hasOwn(first, 'uncovered'), again.counts, Object.hasOwn(again, 'uncovered')], ['POSTED', false, { ALREADY_PRESENT: 1 }, false]);
  assert.ok([...posted.publication.values()].every(entry => !Object.hasOwn(entry, 'unlisted')));
  assert.doesNotMatch(renderPublication(posted, again), /does not list/);
  // A comment there that lists some of the places leaves the others.
  const partly = await placedSetup(t, findings), third = publisher(partly.azure);
  const two = { ...shared.comments[0], otherPlaces: shared.comments[0].otherPlaces.slice(0, 1) };
  const earlier = { ...partly.review, publication: new Map(), plan: { summary: null, skipped: [], comments: [{ ...two, content: shared.comments[0].content.replace('\n- `/src/C.java:2` (F-3)', '') }] } };
  assert.equal((await publishPlan({ run: third.run, review: earlier, azure: third.api, attempts: third.attempts })).status, 'POSTED');
  const now = { ...partly.review, publication: new Map(), plan: { summary: null, skipped: [], comments: shared.comments } };
  assert.deepEqual((await publishPlan({ run: third.run, review: now, azure: third.api, attempts: third.attempts })).uncovered.map(row => row.findingIds), [['F-3']]);
});

test('what a shared comment stands for is read from the last listing of the PR, whoever wrote the comment found there', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B')];
  const planned = async () => {
    const ctx = await placedSetup(t, findings);
    const plan = await prepareComments(ctx.review, ctx.store, stages(async payload => groupwise(payload)).invoke, { fetchSource: sourceOf });
    return { ...ctx, ...publisher(ctx.azure), review: { ...ctx.review, plan: { summary: null, skipped: [], comments: plan.comments } }, item: plan.comments[0] };
  };
  const listing = (azure, change) => { let listings = 0; azure.state.fail.threads = (_call, state) => { if (listings++ === 1) change(state); }; };
  // This run's own write, kept by the service without the list: the read-back shows the marker and no place.
  const own = await planned();
  listing(own.azure, state => { state.threads[0].comments[0].content = own.item.content.replace(/\n\n\*\*📍 Also at[^\n]*\n- [^\n]*/, ''); });
  const written = await publishPlan({ run: own.run, review: own.review, azure: own.api, attempts: own.attempts });
  assert.equal(own.azure.callsTo('createThread').length, 1);
  assert.deepEqual([[...own.review.publication.values()].map(entry => [entry.state, entry.unlisted]), written.uncovered.map(row => row.findingIds)], [[['VERIFIED', ['F-2']]], [['F-2']]]);
  // A comment found on the PR whose list was completed between the two listings: nothing is missing in the end.
  const completed = await planned();
  completed.azure.state.threads.push({ id: 41, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: `Body.\n\n${completed.item.marker}` }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } });
  listing(completed.azure, state => { state.threads[0].comments[0].content = completed.item.content; });
  const found = await publishPlan({ run: completed.run, review: completed.review, azure: completed.api, attempts: completed.attempts });
  assert.deepEqual([[...completed.review.publication.values()].map(entry => [entry.state, entry.unlisted]), Object.hasOwn(found, 'uncovered')], [[['ALREADY_PRESENT', undefined]], false]);
  // A marker that only a reply holds (the thread of the quoted comment is gone): the item counts as present, as always,
  // and nothing on the PR says what that marker covers.
  const quoted = await planned();
  quoted.azure.state.threads.push({ id: 42, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: 'Was this not settled?' }, { id: 2, parentCommentId: 1, content: quoted.item.content }],
    threadContext: { filePath: '/src/Other.java', rightFileStart: { line: 9 } } });
  const reply = await publishPlan({ run: quoted.run, review: quoted.review, azure: quoted.api, attempts: quoted.attempts });
  assert.equal(quoted.azure.callsTo('createThread').length, 0);
  assert.deepEqual([[...quoted.review.publication.values()].map(entry => [entry.state, entry.threadId, entry.unlisted]), reply.uncovered.map(row => row.findingIds)], [[['ALREADY_PRESENT', 42, ['F-2']]], [['F-2']]]);
  // The same at planning: such a marker lists nothing, so the comment is sent back.
  const issues = [];
  await prepareComments(quoted.review, quoted.store, stages(async (payload, turn, evaluation) => { if (turn) issues.push(...evaluation.issues); return groupwise({ ...payload, repeatCandidates: turn ? [] : payload.repeatCandidates }); }).invoke,
    { fetchSource: sourceOf, posted: postedComments(quoted.azure.state.threads) });
  assert.match(issues.join('\n'), /the PR already has a comment under the marker of these lines \(thread 42\)[\s\S]*does not list F-2 at \/src\/B\.java:2/);
  // With `compare`, the entry of such an item says both: other text, and what that text does not list.
  const adjusted = await planned();
  adjusted.azure.state.threads.push({ id: 43, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: `Body.\n\n${adjusted.item.marker}` }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } });
  await publishPlan({ run: adjusted.run, review: adjusted.review, azure: adjusted.api, attempts: adjusted.attempts, compare: true });
  assert.deepEqual([...adjusted.review.publication.values()].map(entry => [entry.state, entry.earlierText, entry.unlisted]), [['ALREADY_PRESENT', true, ['F-2']]]);
  // A comment for F-1 alone that the first listing shows and the read-back no longer does (deleted meanwhile): what was
  // seen of it stands. Neither listing showed F-2, so nothing may say that it is on the PR.
  const gone = await planned();
  gone.azure.state.threads.push({ id: 44, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: `Body.\n\n${gone.item.marker}` }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } });
  listing(gone.azure, state => { state.threads[0].deleted = true; });
  const vanished = await publishPlan({ run: gone.run, review: gone.review, azure: gone.api, attempts: gone.attempts, compare: true });
  assert.deepEqual([...gone.review.publication.values()].map(entry => [entry.state, entry.earlierText, entry.unlisted, entry.unlistedThread]), [['ALREADY_PRESENT', true, ['F-2'], 44]]);
  assert.deepEqual(vanished.uncovered.map(row => [row.findingIds, row.threadId]), [[['F-2'], 44]]);
  assert.match(describeEarlierText({ ...gone.review, adjustments: { excluded: [], severity: {} } }), /is not what the PR shows there: F-1 at \/src\/A\.java:2\. /);
  // A reply in an earlier thread quotes the marker, and the comment itself opens a later thread: the places, the
  // thread named in the note and the thread of the result are that comment's.
  const two = await planned();
  two.azure.state.threads.push(
    { id: 45, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: 'See the other thread.' }, { id: 2, parentCommentId: 1, content: `Quoted: ${two.item.marker}` }], threadContext: { filePath: '/src/Z.java', rightFileStart: { line: 1 } } },
    { id: 46, status: 'active', isDeleted: false, comments: [{ id: 1, parentCommentId: 0, content: `Body.\n\n${two.item.marker}` }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } });
  const named = await publishPlan({ run: two.run, review: two.review, azure: two.api, attempts: two.attempts });
  assert.deepEqual(named.uncovered.map(row => [row.findingIds, row.threadId]), [[['F-2'], 46]]);
  assert.match(renderPublication(two.review, named), /- F-1, F-2 \(\/src\/A\.java:2\): ALREADY_PRESENT; thread=45; the comment of thread 46 does not list F-2\n/);
});

test('no grouping pass is asked where no two findings of a set fit one page together', async t => {
  // Two high findings in different files, each with 6,500 characters of evidence: a pair is larger than a page.
  const long = await placedSetup(t, [placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) })]);
  const none = stages(async payload => groupwise(payload));
  const plan = await prepareComments(long.review, long.store, none.invoke, { fetchSource: sourceOf });
  assert.deepEqual(none.payloads.map(p => [p.commentWork.kind, p.findings.map(f => f.id), p.repeatCandidates ?? null]), [['plan', ['F-1'], null], ['plan', ['F-2'], null]]);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-2']);
  assert.equal(pairFits([placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) })]), false);
  // With a third, short finding of that severity a pair fits, so the pass is asked.
  const mixed = await placedSetup(t, [placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) }), placed('F-3', 'C')]);
  const some = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-2', 'F-3'] }] }) : groupwise(payload));
  const grouped = await prepareComments(mixed.review, mixed.store, some.invoke, { fetchSource: sourceOf });
  assert.equal(some.payloads.filter(p => p.commentWork.kind === 'group').length, 1);
  assert.deepEqual(grouped.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3']]);
  // A pair of another severity, or on the same lines, is no pair.
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'B', 'medium')]), false);
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'A')]), false);
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'B')]), true);
});

test('the files of possible repeats are read a few at a time before the pages, never all at once', async t => {
  const files = Array.from({ length: 9 }, (_, i) => `F${i}`);
  const findings = files.map((file, i) => placed(`F-${i + 1}`, file));
  for (const parallel of [1, 2, 3]) {
    const { review, store } = await placedSetup(t, findings);
    let reading = 0, most = 0;
    const read = [];
    const fetchSource = async path => { read.push(path); most = Math.max(most, ++reading); await sleep(5); reading--; return 'line one\nline two\nline three\n'; };
    const { invoke } = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload));
    await prepareComments(review, store, invoke, { fetchSource, parallel });
    assert.equal(most, parallel, `at most ${parallel} read(s) under way`);
    assert.deepEqual(read, files.map(file => `/src/${file}.java`), 'Each file once, in the order of the findings.');
  }
});

test('an earlier comment that only the read-back lists is checked for the places of a shared comment too', async t => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B')];
  const { review, store, azure } = await placedSetup(t, findings);
  const { api, run, attempts } = publisher(azure);
  const plan = answer => prepareComments(review, store, stages(answer).invoke, { fetchSource: sourceOf });
  const separate = await plan(async payload => groupwise({ ...payload, repeatCandidates: [] })), shared = await plan(async payload => groupwise(payload));
  review.plan = { summary: null, skipped: [], comments: separate.comments.slice(0, 1) };
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  // Another machine without a record of its own; its first thread list lags, and Azure DevOps refuses the write.
  const other = publisher(azure);
  const later = { ...review, publication: new Map(), plan: { summary: null, skipped: [], comments: shared.comments } };
  let listings = 0;
  azure.state.fail.threads = () => listings++ ? undefined : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [], count: 0 }) };
  azure.state.fail.createThread = () => azureError(403, 'AccessDeniedException', 'Fixture writes denied.');
  const result = await publishPlan({ run: other.run, review: later, azure: other.api, attempts: other.attempts });
  assert.equal(azure.state.threads.length, 1, 'Nothing was written.');
  assert.deepEqual([[...later.publication.values()].map(entry => entry.state), result.uncovered.map(row => row.findingIds)], [['VERIFIED'], [['F-2']]]);
});

test('a person\'s adjustments reach the planner only when there are some; the planning input is otherwise unchanged', async t => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2'), finding('F-3', 'low')]);
  const answer = async payload => JSON.stringify({ status: 'READY',
    comments: payload.findings.filter(f => f.severity !== 'low').map(f => comment(f.id)),
    skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, cause: 'low-severity', reason: 'Low.' })),
    ...(payload.commentWork.allowSummary ? { summary: 'Purpose.' } : {}) });
  const plain = stages(answer);
  const before = await prepareComments(review, store, plain.invoke);
  assert.ok(plain.payloads.every(payload => !Object.hasOwn(payload, 'adjustments')), 'Without adjustments the input has no new field.');
  // An emptied record, as --reset leaves it, plans exactly as none.
  const emptied = stages(answer);
  const again = await prepareComments({ ...review, adjustments: { excluded: [], severity: {}, changes: [] } }, store, emptied.invoke);
  assert.deepEqual(emptied.payloads.map(payload => Object.keys(payload)), plain.payloads.map(payload => Object.keys(payload)));
  assert.deepEqual(emptied.payloads.map(payload => payload.findings), plain.payloads.map(payload => payload.findings));
  assert.deepEqual(again, before);
  const adjusted = stages(answer);
  const plan = await prepareComments({ ...review, adjustments: { excluded: ['F-1'], severity: { 'F-2': 'low', 'F-3': 'medium' } } }, store, adjusted.invoke);
  const [payload] = adjusted.payloads;
  assert.deepEqual(payload.findings.map(f => [f.id, f.severity]), [['F-2', 'low'], ['F-3', 'medium']]);
  assert.deepEqual(payload.adjustments.excludedFindings, ['F-1']);
  assert.deepEqual(payload.adjustments.severityChanges, [{ id: 'F-2', from: 'high', to: 'low' }, { id: 'F-3', from: 'low', to: 'medium' }]);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.severity]), [['F-3', 'medium']], 'A raised low finding gets an inline comment; a lowered one stays in the summary.');
  assert.match(plan.comments[0].content, /^🟡 medium: F-3 loses state/);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-2']);
  assert.doesNotMatch(plan.summary.content, /F-1/);
  assert.match(plan.summary.content, /high: 0 · medium: 1 · low: 1/);
});

test('an excluded quick finding is no merge candidate; the other one is planned on its own', async t => {
  const a = quickFinding('Q-1', '1/2', 'head:/src/Main.java:2'), b = quickFinding('Q-1001', '2/2', 'head:/src/Main.java:2');
  const { review, store } = await setup(t, []);
  Object.assign(review, { verification: 'none', final: { ...review.final, dispositions: [a, b].map(f => ({ id: f.id, status: 'REPORTED', finding: f, shard: f.shard })) } });
  const answer = async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [],
    ...(payload.commentWork.allowSummary ? { summary: 'Purpose.' } : {}) });
  const plain = stages(answer);
  await prepareComments(review, store, plain.invoke);
  assert.deepEqual(plain.payloads[0].mergeCandidates, [['Q-1', 'Q-1001']]);
  const adjusted = stages(answer);
  const plan = await prepareComments({ ...review, adjustments: { excluded: ['Q-1'], severity: {} } }, store, adjusted.invoke);
  assert.equal(Object.hasOwn(adjusted.payloads[0], 'mergeCandidates'), false);
  assert.deepEqual(adjusted.payloads[0].findings.map(f => f.id), ['Q-1001']);
  // Without source the runtime read, the quick comment is skipped for its anchor; Q-1 is in neither list.
  assert.deepEqual([...plan.comments, ...plan.skipped].map(item => item.findingId), ['Q-1001']);
  assert.doesNotMatch(plan.summary.content, /Q-1\b/);
});

test('items the PR already has are skipped as always; with `compare` those with other text are marked and other comments counted', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  const writes = azure.callsTo('createThread').length;
  // The same markers with other text, as after a person changed a severity in another review of this commit.
  const changed = () => ({ ...review, publication: new Map(), plan: { ...review.plan,
    summary: { ...review.plan.summary, content: review.plan.summary.content.replace('high: 2', 'high: 1 · medium: 1') },
    comments: review.plan.comments.map((item, index) => index ? item : { ...item, content: item.content.replace('🔴 high:', '🟡 medium:') }) } });
  const plain = changed();
  const skipped = await publishPlan({ run, review: plain, azure: api, attempts });
  assert.equal(skipped.status, 'POSTED');
  assert.ok([...plain.publication.values()].every(entry => entry.state === 'ALREADY_PRESENT' && !Object.hasOwn(entry, 'earlierText')));
  assert.equal(Object.hasOwn(skipped, 'otherComments'), false, 'Without `compare` the result is as before.');
  const compared = changed();
  const result = await publishPlan({ run, review: compared, azure: api, attempts, compare: true });
  assert.equal(result.status, 'POSTED');
  assert.equal(azure.callsTo('createThread').length, writes, 'Nothing is posted again or replaced.');
  const entries = [...compared.publication.values()];
  assert.ok(entries.every(entry => entry.state === 'ALREADY_PRESENT'));
  assert.deepEqual(entries.filter(entry => entry.earlierText).map(entry => entry.kind === 'summary' ? 'summary' : entry.findingId), ['summary', 'F-1']);
  assert.equal(result.otherComments, 0);
  // A plan without one of the comments leaves that comment on the PR, counted as another one.
  const smaller = { ...review, publication: new Map(), plan: { ...review.plan, comments: review.plan.comments.slice(1) } };
  assert.equal((await publishPlan({ run, review: smaller, azure: api, attempts, compare: true })).otherComments, 1);
});

test('an earlier comment that only the read-back lists is marked as keeping its earlier text', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const { api, run, attempts } = publisher(azure);
  assert.equal((await publishPlan({ run, review, azure: api, attempts })).status, 'POSTED');
  const writes = azure.callsTo('createThread').length;
  // Another review of this commit with other text on the same lines; the first thread list lags behind.
  const changed = { ...review, publication: new Map(), plan: { ...review.plan,
    summary: { ...review.plan.summary, content: review.plan.summary.content.replace('high: 2', 'high: 1 · medium: 1') },
    comments: review.plan.comments.map((item, index) => index ? item : { ...item, content: item.content.replace('🔴 high:', '🟡 medium:') }) } };
  let listings = 0;
  azure.state.fail.threads = () => listings++ ? undefined : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [], count: 0 }) };
  const result = await publishPlan({ run, review: changed, azure: api, attempts, compare: true });
  assert.equal(result.status, 'POSTED');
  assert.equal(azure.callsTo('createThread').length, writes, 'The earlier creates are not sent again.');
  const entries = [...changed.publication.values()];
  assert.ok(entries.every(entry => entry.state === 'VERIFIED' && entry.earlierAttempt));
  assert.deepEqual(entries.filter(entry => entry.earlierText).map(entry => entry.kind === 'summary' ? 'summary' : entry.findingId), ['summary', 'F-1']);
});

test('without a local record, a refused write whose marker the read-back finds is compared too', async t => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure);
  const first = publisher(azure);
  assert.equal((await publishPlan({ run: first.run, review, azure: first.api, attempts: first.attempts })).status, 'POSTED');
  const threads = azure.state.threads.length;
  // Another machine: no publication record of its own. Its first thread list lags, and Azure DevOps refuses the writes.
  const other = publisher(azure);
  const changed = { ...review, publication: new Map(), plan: { ...review.plan,
    summary: { ...review.plan.summary, content: review.plan.summary.content.replace('high: 2', 'high: 1 · medium: 1') },
    comments: review.plan.comments.map((item, index) => index ? item : { ...item, content: item.content.replace('🔴 high:', '🟡 medium:') }) } };
  let listings = 0;
  azure.state.fail.threads = () => listings++ ? undefined : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [], count: 0 }) };
  azure.state.fail.createThread = () => azureError(403, 'AccessDeniedException', 'Fixture writes denied.');
  await publishPlan({ run: other.run, review: changed, azure: other.api, attempts: other.attempts, compare: true });
  assert.equal(azure.state.threads.length, threads, 'Nothing was written.');
  const entries = [...changed.publication.values()];
  assert.ok(entries.every(entry => entry.state === 'VERIFIED'), 'The read-back finds every marker, as before.');
  assert.deepEqual(entries.filter(entry => entry.earlierText).map(entry => entry.kind === 'summary' ? 'summary' : entry.findingId), ['summary', 'F-1']);
});
