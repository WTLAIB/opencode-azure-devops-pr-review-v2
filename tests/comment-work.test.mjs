import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComments, publishPlan, PLANNING_FINDINGS_PER_PAGE, PAGE_CONTINUATIONS, discussionDigest, parseLocation, pairable, sourceWindow, mergeCandidates, candidatePages, repeatEligible, severitySets, boundedGroups } from '../src/comment-work.mjs';
import { createCommentData, captureObservation, observationIndex, observationKey, evidenceIndex, heldItems, pageRows, wholePages, ROW_CHARACTERS } from '../src/comment-data.mjs';
import { HOST_READ_LINE_CHARACTERS } from '../src/host.mjs';
import { createAzureClient, parsePullRequestUrl, markersInThreads } from '../src/azure.mjs';
import { createToolQueue } from '../src/tool-queue.mjs';
import { publicationItems, inlineMarker, sharedMarker, reviewMethod, publishableFindings } from '../src/comments.mjs';
import { renderPublication, renderOtherPlaces, listedPlaces, listablePlace, commentAttribution } from '../src/attribution.mjs';
import { ROLES, PROMPTS, roleFor, promptVariant, buildAgents, validateSettings } from '../src/config.mjs';
import { fakeAzure, azureError, FAKE_PAT } from './fake-azure.mjs';

const head = 'b'.repeat(40);
// Comments are planned for three kinds of saved review (`reviewMethod` in comments.mjs): a verified and a quick review
// as 0.4.x saved them, and a review of this pipeline. `setup` builds any of them; what they share runs once per kind.
// The attribution of a comment as the runtime writes it for each kind, in English.
const ATTRIBUTIONS = Object.fromEntries(['verified', 'quick', 'reviewers'].map(method => [method, commentAttribution({ stages: [{ model: 'fixture/reviewer' }] }, 'en', 'fixture/planner', { method })]));
const ATTRIBUTION = ATTRIBUTIONS.verified;
const literal = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const finding = (id, severity = 'high') => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/Main.java:2', severity, suggestion: 's' });

// What each kind's record says of itself, and the row a finding is in it. A finding may name the session that
// reported it (`shard`), which only records without a verifier keep.
const RECORDS = {
  // 0.4.x, /pr-review or /pr-deep: the verifier's confirmations (0.4.6 wrote the field; older records have none).
  verified: { profile: 'review', verification: 'independent' },
  // 0.4.x, /pr-quick.
  quick: { profile: 'quick', verification: 'none' },
  // This pipeline: reviewer passes, a duplicate check and a rating; the record names that method.
  reviewers: { profile: 'review', verification: 'none', method: { kind: 'reviewers', version: 1, requested: ['fixture/reviewer', 'fixture/reviewer'],
    passes: [{ pass: 1, model: 'fixture/reviewer', sessions: 1, failed: 0 }, { pass: 2, model: 'fixture/reviewer', sessions: 1, failed: 0 }],
    duplicateCheck: { groups: 0, failed: 0, merged: 0, refused: 0 }, rating: { state: 'first', model: 'fixture/reviewer', sessions: 1, failed: 0, rated: 0, kept: 0 } } },
};
const ROWS = {
  verified: ({ shard: _session, ...f }) => ({ id: f.id, status: 'CONFIRMED', reason: 'ok', verifiedFinding: f }),
  quick: ({ id, shard = '1/1', ...own }) => ({ id, status: 'REPORTED', reason: 'r', finding: own, inline: true, shard }),
  reviewers: ({ id, shard = '1/1 pass 1', ...own }) => ({ id, status: 'REPORTED', reason: 'r', finding: own, inline: true, reviewerSeverity: own.severity, shard, pass: 1, localId: id, sessions: [shard] }),
};
// The line of a file that `comment(id)` quotes for a finding.
const codeFor = id => `code for ${id}`;

/**
 * A saved review of one kind with these findings, its private data store and a fake Azure DevOps.
 * A finding is REPORTED only when its own session read its file at that commit, so a review without a verifier has
 * those reads on record, and a comment for it must quote text found in them or in what the runtime reads. `source`
 * gives a file's text as the sessions read it; by default it holds the line `comment(id)` quotes for each of the
 * file's findings. A verified review of 0.4.x keeps a comment's declared lines without any such text.
 */
async function setup(t, findings, azure = fakeAzure(), { kind = 'verified', source = (path, located) => located.map(f => codeFor(f.id)).join('\n') + '\n' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createCommentData({ root: directory });
  const target = parsePullRequestUrl(azure.prUrl());
  const review = {
    id: 'abcdef12', target, outputLanguage: 'en', attribution: ATTRIBUTIONS[kind], ...RECORDS[kind],
    snapshot: { head, base: 'a'.repeat(40), files: ['/src/Main.java'], prId: azure.state.prId, repositoryId: 'rid', projectId: 'pid' },
    final: { report: 'Final report text', reviewWarnings: [], newFindings: [],
      dispositions: findings.map(ROWS[kind]) },
    toolText: [], publication: new Map(),
  };
  if (kind !== 'verified') {
    const paths = [...new Set(findings.map(f => parseLocation(f.location)?.path).filter(Boolean))];
    review.toolText = await Promise.all(paths.map(path => captureObservation(store, 'azpr_read_file', { path, version: head },
      source(path, findings.filter(f => parseLocation(f.location)?.path === path)))));
  }
  return { review, store, azure };
}
/** One test per kind of review, for what the kinds share: `run(t, kind)`. By default a verified review of 0.4.x and a review of this pipeline. */
const eachKind = (name, run, kinds = ['verified', 'reviewers']) => { for (const kind of kinds) test(`${name} [${kind}]`, t => run(t, kind)); };

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
const comment = id => ({ findingId: id, severity: 'high', path: '/src/Main.java', startLine: 1, endLine: 1, anchor: codeFor(id), body: `🔴 high: ${id} loses state` });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits in these tests are bounded, so a broken lane fails an assertion instead of hanging.
const within = (promise, ms = 5000) => Promise.race([promise, sleep(ms)]);
// A wait that must end by what it waits for: running out of time fails the test instead of letting it pass late.
const inTime = (promise, what, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}.`)), ms); })]).finally(() => clearTimeout(timer));
};

eachKind('planning pages hold at most four findings and assemble one plan with every finding accounted for', async (t, kind) => {
  const findings = Array.from({ length: 10 }, (_, i) => finding(`F-${i + 1}`, i === 9 ? 'low' : 'high'));
  const { review, store } = await setup(t, findings, undefined, { kind });
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

eachKind('a page with problems is repaired in place; what stays broken is skipped, not fatal', async (t, kind) => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
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

eachKind('a skip whose cause the page contradicts goes back to the planner, which then comments', async (t, kind) => {
  // As in a live PR #3 plan: the page showed the finding's whole file and the planner said it had no source.
  const file = 'line one\nconst value = load();\n';
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind, source: () => file });
  const thread = { findingId: 'F-2', cause: 'existing-thread', threadId: 5, reason: 'Thread 5 covers it.' };
  const { invoke, payloads } = stages(async (payload, turn) => turn === 0
    ? JSON.stringify({ status: 'READY', comments: [], skipped: [{ findingId: 'F-1', cause: 'cannot-anchor', reason: 'This page has no source passage for F-1.' }, thread] })
    : JSON.stringify({ status: 'READY', comments: [{ ...comment('F-1'), startLine: 2, endLine: 2, anchor: 'const value = load();' }], skipped: [thread] }));
  const plan = await prepareComments(review, store, invoke, { fetchSource: async () => file, discussions: [{ threadId: 5, path: '/src/Main.java', line: 2 }] });
  assert.deepEqual(payloads[0].sourceExcerpts.map(item => [item.findingIds.join(), item.firstLine, item.lastLine]), [['F-1,F-2', 1, 2]]);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.startLine]), [['F-1', 2]]);
  assert.deepEqual(plan.skipped, [thread]);
});

eachKind('on a large PR a page carries the files and dispositions of its findings and references the complete lists', async (t, kind) => {
  const findings = Array.from({ length: 6 }, (_, i) => ({ ...finding(`F-${i + 1}`), location: `head:/src/File${i + 1}.java:2` }));
  const { review, store } = await setup(t, findings, undefined, { kind });
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
  const small = await setup(t, [finding('F-1')], undefined, { kind });
  const few = stages(async payload => JSON.stringify({ status: 'READY', comments: [comment('F-1')], skipped: [] }));
  await prepareComments(small.review, small.store, few.invoke);
  assert.deepEqual([few.payloads[0].snapshot.files, few.payloads[0].dispositions.length, few.payloads[0].allFiles, few.payloads[0].allDispositions], [['/src/Main.java'], 1, undefined, undefined]);
});

eachKind('CONTINUE checkpoints keep finished work; a checkpoint without progress skips what is open instead of failing', async (t, kind) => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
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
  const stuck = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
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

eachKind('a page gets at most three continuation sessions even when each one reads something new; later pages still run', async (t, kind) => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings, undefined, { kind });
  let reads = 0;
  const { invoke, payloads } = stages(async payload => {
    if (payload.commentWork.page === 2) return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] });
    // Page 1 never finishes, but every session reads new source, so its checkpoint always differs.
    if (++reads > 10) throw new Error('Page 1 kept continuing: the continuation cap is missing.');
    review.commentEvidence = [...(review.commentEvidence ?? []), { page: 1, tool: 'azpr_read_file', input: { path: '/src/Main.java', offset: reads }, result: await store.object({ output: `part ${reads}` }) }];
    return JSON.stringify({ status: 'CONTINUE', comments: payload.continuation ? [] : [comment('F-1')], skipped: [], continuation: `Read part ${reads}; more to read.` });
  });
  const notices = [];
  const plan = await prepareComments(review, store, invoke, { progress: message => notices.push(message) });
  assert.equal(PAGE_CONTINUATIONS, 3);
  assert.equal(payloads.filter(p => p.commentWork.page === 1).length, 1 + PAGE_CONTINUATIONS, 'Page 1 stops after its first session and three continuations.');
  // Each continuation is handed what the page's sessions before it read.
  const handed = await Promise.all(payloads.filter(p => p.commentWork.page === 1).slice(1).map(async p => (await store.read(p.workEvidence)).trim().split('\n').map(row => JSON.parse(row).input.offset)));
  assert.deepEqual(handed, [[1], [1, 2], [1, 2, 3]]);
  assert.equal(payloads.filter(p => p.commentWork.page === 2).length, 1);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-5']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-2', 'F-3', 'F-4']);
  assert.ok(plan.skipped.every(s => s.reason === 'The comment planner did not finish the page in 4 sessions; it remains in the summary index.'));
  assert.ok(notices.includes('Planning comments, page 1/2: the planner did not finish the page in 4 sessions; 3 finding(s) skipped.'));
});

eachKind('pages planned side by side assemble exactly as one at a time, whichever page finishes first', async (t, kind) => {
  // F-1 (page 1) and F-5 (page 2) quote the same line, so their ordinals follow page order.
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 2 }, (_, i) => finding(`F-${i + 1}`));
  const answer = payload => JSON.stringify({ status: 'READY', skipped: [], summaryDetails: `Details of page ${payload.commentWork.page}.`,
    comments: payload.findings.map(f => ({ ...comment(f.id), anchor: ['F-1', 'F-5'].includes(f.id) ? 'shared line' : `code for ${f.id}` })),
    ...(payload.commentWork.allowSummary ? { summary: 'Purpose.' } : {}) });
  // The file as the review's sessions read it: the line both comments quote, then each finding's own.
  const source = (path, located) => ['shared line', ...located.map(f => codeFor(f.id))].join('\n') + '\n';
  const one = await setup(t, findings, undefined, { kind, source });
  const sequential = await prepareComments(one.review, one.store, stages(async payload => answer(payload)).invoke, { parallel: 1 });
  const two = await setup(t, findings, undefined, { kind, source });
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

eachKind('only the first page writes the summary note; a note from another page is dropped without a repair turn', async (t, kind) => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings, undefined, { kind });
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
  const cont = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
  const later = stages(async payload => JSON.stringify(payload.continuation
    ? { status: 'READY', comments: [comment('F-2')], skipped: [], summary: 'Purpose.' }
    : { status: 'CONTINUE', comments: [comment('F-1')], skipped: [], continuation: 'Check F-2 next.' }));
  const kept = await prepareComments(cont.review, cont.store, later.invoke);
  assert.deepEqual(later.payloads.map(p => p.commentWork.allowSummary), [true, true]);
  assert.match(kept.summary.content, /\*\*Review notes\*\*\n\nPurpose\./);
});

eachKind('a continuing page keeps its own checkpoint and evidence while another page runs', async (t, kind) => {
  const findings = Array.from({ length: PLANNING_FINDINGS_PER_PAGE + 1 }, (_, i) => finding(`F-${i + 1}`));
  const { review, store } = await setup(t, findings, undefined, { kind });
  // What a planner session read, as the runtime keeps it: the result is a value the store holds.
  const read = async (page, offset) => ({ sessionID: `ses_${page}`, page, tool: 'azpr_read_file', input: { path: '/src/Main.java', offset }, result: await store.object({ output: `page ${page}, offset ${offset}` }) });
  // Page 2 reads before page 1's first session ends and finishes, with details, before its second ends.
  const secondRead = deferred(), firstSession = deferred(), secondDone = deferred();
  const { invoke, payloads } = stages(async payload => {
    if (payload.commentWork.page === 2) {
      review.commentEvidence = [...(review.commentEvidence ?? []), await read(2, 99)];
      secondRead.resolve();
      await within(firstSession.promise);
      return JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [], summaryDetails: 'Page 2 details.' });
    }
    if (!payload.continuation) {
      await within(secondRead.promise);
      const own = await read(1, 1);
      review.commentEvidence = [...(review.commentEvidence ?? []), own];
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

test('a comment stands in its own finding\'s file, and a page\'s plan is the same whichever fetch finishes first', async t => {
  // Page 1 (F-1 to F-4, in A) quotes a line of B for F-1; page 2 (F-5, in B) quotes a line of its own file. F-5 has
  // a severity of its own, so no two places could share a comment and no file is read before the pages: the
  // fetches below are the pages' own.
  const findings = [...Array.from({ length: PLANNING_FINDINGS_PER_PAGE }, (_, i) => ({ ...finding(`F-${i + 1}`), location: 'head:/src/A.java:2' })),
    { ...finding('F-5', 'medium'), location: 'head:/src/B.java:2' }];
  const sources = { '/src/A.java': 'a0\nonly in A\n', '/src/B.java': 'b0\nonly in B\n' };
  const answer = payload => JSON.stringify(payload.commentWork.page === 1
    ? { status: 'READY', comments: [{ ...comment('F-1'), path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'only in B' }],
      skipped: ['F-2', 'F-3', 'F-4'].map(findingId => ({ findingId, cause: 'too-long', reason: 'Too long to state faithfully.' })) }
    : { status: 'READY', comments: [{ ...comment('F-5'), path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'only in B' }], skipped: [] });
  for (const kind of ['verified', 'reviewers', 'quick']) {
    const plans = [];
    for (const parallel of [1, 2]) {
      const { review, store } = await setup(t, findings, undefined, { kind });
      review.snapshot.files = ['/src/A.java', '/src/B.java'];
      // No read of a review session is on record here: what counts as observed is what the runtime fetches for a page.
      review.toolText = [];
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
    assert.deepEqual(plans[1], plans[0], kind);
    // F-1's comment quotes another file, an excerpt of another place, in every kind of review; F-5's stands. Where
    // findings need an anchor in text the runtime read, page 1 has not read B, which is said first.
    assert.deepEqual(plans[0].comments.map(c => [c.findingId, c.path, c.startLine]), [['F-5', '/src/B.java', 2]], kind);
    assert.match(plans[0].skipped.find(s => s.findingId === 'F-1').reason, kind === 'verified' ? /path \/src\/B\.java is not F-1's own file \/src\/A\.java; quote lines of that file/
      : /anchor text was not found in the HEAD source/, kind);
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
// Publication reads a review's saved plan, its snapshot and its ledger, never what kind of review it is. The first
// test below posts the plan of each kind; the others, which are about writes, attempts and read-back, run on one.
async function plannedReview(t, azure, kind = 'verified') {
  const ctx = await setup(t, [finding('F-1'), finding('F-2')], azure, { kind });
  const { invoke } = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  ctx.review.plan = await prepareComments(ctx.review, ctx.store, invoke);
  return ctx;
}

eachKind('publication posts exact saved text, reads every marker back, and is idempotent on re-run', async (t, kind) => {
  const azure = fakeAzure();
  const { review } = await plannedReview(t, azure, kind);
  const { api, run, attempts } = publisher(azure);
  let persisted = 0;
  const first = await publishPlan({ run, review, azure: api, attempts, persist: async () => { persisted++; } });
  assert.equal(first.status, 'POSTED');
  assert.equal(azure.state.threads.length, 3);
  assert.deepEqual(azure.state.threads.map(thread => thread.comments[0].content), publicationItems(review.plan).map(item => item.content));
  // What is on the PR carries the disclosure of that kind of review: under each comment, and at the top of the summary.
  const [summary, ...inline] = azure.state.threads.map(thread => thread.comments[0].content);
  assert.ok(summary.startsWith(`🤖 ${ATTRIBUTIONS[kind]}\n\n## PR Review Summary\n\nhigh: 2 · medium: 0 · low: 0\n\n`), summary);
  assert.deepEqual(inline, ['F-1', 'F-2'].map((id, index) => `🔴 high: ${id} loses state\n\n---\n${ATTRIBUTIONS[kind]}\n\n${review.plan.comments[index].marker}`));
  assert.ok([...review.publication.values()].every(entry => entry.state === 'VERIFIED' && entry.threadId));
  assert.ok(persisted >= 3);
  const writes = () => azure.callsTo('createThread').length;
  const before = writes();
  const second = await publishPlan({ run, review, azure: api, attempts });
  assert.equal(second.status, 'POSTED');
  assert.equal(writes(), before, 'Existing markers are skipped, not posted again.');
  assert.ok([...review.publication.values()].every(entry => entry.state === 'ALREADY_PRESENT'));
});

test('a review of this pipeline finds the comments a review of 0.4.x posted on the same lines, and posts none of them again', async t => {
  const azure = fakeAzure();
  // 0.4.x reviewed this commit, and its comments are on the PR.
  const earlier = (await plannedReview(t, azure, 'verified')).review;
  const { api, run, attempts } = publisher(azure);
  assert.equal((await publishPlan({ run, review: earlier, azure: api, attempts })).status, 'POSTED');
  const writes = azure.callsTo('createThread').length;
  // The same commit reviewed again by this version: the same findings, quoted on the same lines.
  const later = (await plannedReview(t, azure, 'reviewers')).review;
  const markers = review => publicationItems(review.plan).map(item => item.marker), texts = review => publicationItems(review.plan).map(item => item.content);
  assert.deepEqual(markers(later), markers(earlier), 'A marker holds nothing of the review that made the comment.');
  assert.ok(texts(later).every((text, index) => text !== texts(earlier)[index]), 'The texts differ: each says how its review was made.');
  const again = await publishPlan({ run, review: later, azure: api, attempts, compare: true });
  assert.deepEqual([again.status, again.counts, again.otherComments, azure.callsTo('createThread').length], ['POSTED', { ALREADY_PRESENT: 3 }, 0, writes]);
  // The PR keeps what it has, as for any item found there: nothing posted is changed, and the record says so.
  assert.ok([...later.publication.values()].every(entry => entry.earlierText === true));
  assert.deepEqual(azure.state.threads.map(thread => thread.comments[0].content), texts(earlier));
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
  // As such a comment ends: the marker of its lines, a blank line, its own marker.
  const marker = '<!-- azpr-comment:' + 'b'.repeat(32) + ' -->\n\n<!-- azpr-comment:' + 'd'.repeat(32) + ' -->';
  const places = [{ findingId: 'F-2', place: '/src/b.ts:30-34' }, { findingId: 'F-3', place: '/src/c`d.ts:12' }];
  for (const language of ['en', 'zh-TW', 'zh-CN']) for (const [kind, attribution] of Object.entries(ATTRIBUTIONS)) {
    // The text is what the runtime posts: the planner's body, the list, the attribution and the two markers. A
    // comment of any kind of review says so: one that 0.4.x posted for a verified or a quick review, and this pipeline's.
    const content = `🔴 high: Unchecked call\n\n${'Body. '.repeat(80)}\n\n${renderOtherPlaces(places, language)}\n\n---\n${attribution}\n\n${marker}`;
    assert.deepEqual(listedPlaces(content), ['/src/b.ts:30-34', '/src/c`d.ts:12'], `${language} ${kind}`);
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
  // The opener is the comment without a parent, in whatever order the comments come, and what the digest says
  // of the thread is that one comment's: the places are never shown next to the words of a reply.
  const reply = { id: 2, parentCommentId: 1, author: { displayName: 'Ben' }, content: 'Retries are a separate matter.' };
  const opener = { id: 1, parentCommentId: 0, author: { displayName: 'Review bot' }, content: posted };
  for (const comments of [[opener, reply], [reply, opener]]) {
    const [entry] = discussionDigest([{ id: 13, comments, threadContext: at }]);
    assert.deepEqual([entry.alsoAt, entry.author, entry.excerpt.startsWith('Note **📍 Also at** (the same defect'), entry.comments], [['/src/b.ts:30-34', '/src/c`d.ts:12'], 'Review bot', true, 2]);
  }
  // A thread whose opener is gone is described by the first comment that is left, as before.
  const left = discussionDigest([{ id: 14, comments: [{ id: 1, parentCommentId: 0, isDeleted: true }, reply], threadContext: at }])[0];
  assert.deepEqual([left.author, left.excerpt, Object.hasOwn(left, 'alsoAt')], ['Ben', 'Retries are a separate matter.', false]);
  // The opener is comment 1 of its thread, as publication takes it. When it is gone, no later comment stands
  // for it, whatever that one says of its parent (none, or no such field): what it quotes is not this thread's.
  for (const parent of [{ parentCommentId: 0 }, {}]) {
    const quoted = discussionDigest([{ id: 15, comments: [{ id: 1, parentCommentId: 0, isDeleted: true }, { id: 2, ...parent, author: { displayName: 'Ben' }, content: posted }], threadContext: at }])[0];
    assert.deepEqual([Object.hasOwn(quoted, 'alsoAt'), quoted.author, quoted.azpr], [false, 'Ben', true]);
  }
});

test('the list of other places is read back only in the form the runtime writes it', () => {
  // A comment for several places ends with the marker of its lines, a blank line and its own marker.
  const one = '<!-- azpr-comment:' + 'c'.repeat(32) + ' -->', marker = `${one}\n\n<!-- azpr-comment:${'e'.repeat(32)} -->`, tail = `\n\n---\n${ATTRIBUTION}\n\n${marker}`;
  const places = [{ findingId: 'F-2', place: '/src/b.ts:30-34' }, { findingId: 'Q-1003', place: '/src/c.ts:12' }], read = ['/src/b.ts:30-34', '/src/c.ts:12'];
  const list = renderOtherPlaces(places, 'en');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}${tail}`), read);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n${marker}`), read, 'Without an attribution the markers follow at once.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n\n${one}`), [], 'One marker ends a comment for one place, which has no list.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n\n${one}\n${one}`), [], 'The two markers stand apart.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}${tail}\n\n${one}`), [], 'A third marker is not what the runtime writes.');
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
  // After the rows comes what the runtime writes and nothing else: the markers, or a rule, the attribution's line and the markers.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nThe list above is only an example.\n\n---\n${ATTRIBUTION}\n\n${marker}`), [], 'A paragraph between the list and the attribution.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n\nOne more paragraph.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n\n${marker}`), [], 'A rule without an attribution.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n${ATTRIBUTION}\n\n${marker}`), [], 'An attribution without its rule.');
  // The attribution is the one line the runtime writes, which ends with its models: a comment that someone continued
  // after it (a heading and a withdrawal, say, with or without a blank line) no longer says what it lists.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}\n## Correction\nThe second place is withdrawn.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION} The second place is withdrawn.\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nAI review\n\n${marker}`), [], 'Not an attribution of the runtime\'s: no models.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION} No change is needed in \`/src/b.ts:30-34\`\n\n${marker}`), [], 'Text after the models, though it ends with a code span.');
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nAI review \`fixture/planner\`\n\n${marker}`), [], 'The models follow the word for them.');
  // The whole line is the runtime's wording: other words before the models are someone's sentence, whatever it ends with.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\nThe places above are withdrawn. Models: \`provider/model\`\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION.replace('Models:', 'The places above are withdrawn. Models:')}\n\n${marker}`), []);
  // ... and the models are model references, as settings take them: a sentence in a code span, a placeholder or an
  // overlong name is none.
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}, \`the other place was withdrawn\`\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}, \`YOUR_PROVIDER/YOUR_MODEL\`\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}, \`provider/${'m'.repeat(510)}\`\n\n${marker}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list}\n\n---\n${ATTRIBUTION}, \`provider/model#high\`\n\n${marker}`), read);
  // A row is a place and a finding's ID, as the runtime writes IDs: a row whose ID someone replaced is no row, and the list no list.
  assert.deepEqual(listedPlaces(`Body.\n\n${list.replace('(F-2)', '(withdrawn)')}${tail}`), []);
  assert.deepEqual(listedPlaces(`Body.\n\n${list.replace('(Q-1003)', '(Q-1003, fixed)')}${tail}`), []);
  // ... and a place is a path with its lines, as a finding's place is written: one row of another form makes the whole list none.
  for (const other of ['not a location', '/src/b.ts', '/src/b.ts:0', '/src/b.ts:3-', 'src/b.ts:3', '/src/b.ts:3-x', '/src/b.ts:12-7', '/src/a.ts:1` or `/src/b.ts:2', '/src/b.ts:3\ttab', '/src/a.ts:4 corrected to /src/b.ts:8', '/:3']) {
    assert.deepEqual(listedPlaces(`Body.\n\n${list.replace('/src/b.ts:30-34', other)}${tail}`), [], other);
  }
  // A row is the row the runtime writes for that place and ID under that heading, to the character: other spacing,
  // other brackets, the other language's brackets or anything after the row are not.
  for (const [from, to] of [['- `/src/b.ts:30-34` (F-2)', '-  `/src/b.ts:30-34` (F-2)'], ['` (F-2)', '`(F-2)'], ['` (F-2)', '` （F-2）'], ['` (F-2)', '`（F-2）'], ['- `/src/b.ts:30-34`', '- `` /src/b.ts:30-34 ``'], ['(F-2)', '(F-2)\t'], ['(F-2)', '(F-2) ']]) {
    assert.deepEqual(listedPlaces(`Body.\n\n${list.replace(from, to)}${tail}`), [], JSON.stringify(to));
  }
  const chinese = renderOtherPlaces(places, 'zh-TW');
  assert.deepEqual(listedPlaces(`Body.\n\n${chinese}${tail}`), read);
  assert.deepEqual(listedPlaces(`Body.\n\n${chinese.replace('（F-2）', ' (F-2)')}${tail}`), [], 'English brackets under the Chinese heading.');
  // What `commentAttribution` writes for a comment, for each kind of review and language, is such a line.
  const provenance = { stages: [{ model: 'provider/reviewer' }, { model: 'provider/verifier#high' }] };
  const under = (attribution, language) => listedPlaces(`Body.\n\n${renderOtherPlaces(places, language)}\n\n---\n${attribution}\n\n${marker}`);
  for (const language of ['en', 'zh-TW', 'zh-CN']) for (const options of [{}, { method: 'reviewers' }, { method: 'verified' }, { method: 'quick' }, { method: 'reviewers', coverage: { complete: true } }, { method: 'quick', coverage: { complete: true } }]) {
    const attribution = commentAttribution(provenance, language, 'provider/planner', options);
    assert.deepEqual(under(attribution, language), read, `${language} ${JSON.stringify(options)}: ${attribution}`);
  }
  // ... and so are the lines 0.4.x wrote, word for word as they stand on PRs: the comments it posted for a verified
  // and for a quick review are still read, whatever this version writes for its own reviews.
  const models = '`provider/reviewer`, `provider/verifier#high`, `provider/planner`';
  for (const [language, verified, quick] of [
    ['en', `AI-generated review; not human review or approval. Models: ${models}`, `AI-generated review; not human review or approval. Review method: quick review, not independently verified. Models: ${models}`],
    ['zh-TW', `AI 審查，非人工審查或核准。模型： ${models}`, `AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型： ${models}`],
    ['zh-CN', `AI 审查，非人工审查或批准。模型： ${models}`, `AI 审查，非人工审查或批准。审查方式：快速审查，未经独立验证。模型： ${models}`],
  ]) {
    assert.deepEqual([under(verified, language), under(quick, language)], [read, read], language);
    assert.deepEqual([commentAttribution(provenance, language, 'provider/planner', { method: 'verified' }), commentAttribution(provenance, language, 'provider/planner', { method: 'quick' })], [verified, quick], `${language}: still what is written for a review of that kind`);
  }
  // The line under a comment never states coverage: the summary's does, and the summary lists no places.
  const gap = { complete: false, unreviewedFiles: 2, filesComplete: true, reasons: ['shard-failed'] };
  for (const method of ['reviewers', 'quick']) assert.deepEqual(under(commentAttribution(provenance, 'en', 'provider/planner', { method, coverage: gap }), 'en'), [], method);
  // One kind's words in another kind's line are nobody's line.
  assert.deepEqual(under(`AI-generated review; not human review or approval. Review method: findings checked by a verifier. Models: ${models}`, 'en'), []);
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
  // Nor is a path with a colon (a structured location of 0.4.x may name one): the reader takes the first colon for
  // the start of the lines, so the place would not read back.
  assert.equal(listablePlace('/a:b.ts:2'), false);
});

test('locations and source windows', () => {
  assert.deepEqual(parseLocation('head:/src/a.ts:12-14'), { side: 'head', path: '/src/a.ts', start: 12, end: 14 });
  assert.deepEqual(parseLocation('/src/a.ts:7'), { side: 'head', path: '/src/a.ts', start: 7, end: 7 });
  assert.deepEqual(parseLocation('head:/src/a.ts'), { side: 'head', path: '/src/a.ts', start: null, end: null });
  // A BASE location keeps its side, so HEAD source is never shown for BASE line numbers.
  assert.deepEqual(parseLocation('base:/src/old.ts:3'), { side: 'base', path: '/src/old.ts', start: 3, end: 3 });
  assert.equal(parseLocation('somewhere'), null);
  // The forms a review of 0.4.x saved are read the same way everywhere: a structured location, a path without its
  // leading slash or with "./", a file at the root with its line; a side counts only with its colon.
  for (const [location, at] of [
    [JSON.stringify({ side: 'head', path: '/src/a.ts', lineStart: 2, lineEnd: 4 }), { side: 'head', path: '/src/a.ts', start: 2, end: 4 }],
    [{ side: 'base', path: '/src/a.ts', lineStart: 3 }, { side: 'base', path: '/src/a.ts', start: 3, end: 3 }],
    ['src/a.ts:2', { side: 'head', path: '/src/a.ts', start: 2, end: 2 }], ['./src/a.ts:2', { side: 'head', path: '/src/a.ts', start: 2, end: 2 }],
    ['Makefile:3', { side: 'head', path: '/Makefile', start: 3, end: 3 }], ['head/a.ts:2', { side: 'head', path: '/head/a.ts', start: 2, end: 2 }],
    ['base/a.ts:2', { side: 'head', path: '/base/a.ts', start: 2, end: 2 }],
  ]) assert.deepEqual(parseLocation(location), at, JSON.stringify(location));
  for (const nothing of ['', 'head:', JSON.stringify({ side: 'head', path: 'src/a.ts' }), JSON.stringify({ side: 'left', path: '/src/a.ts' })]) assert.equal(parseLocation(nothing), null, nothing);
  // A structured path is a field of its own, so a colon in it is part of the name; a range stays as it was written,
  // a reversed one as the text form "3-2" does, and an end left out is the start.
  assert.deepEqual(parseLocation(JSON.stringify({ side: 'head', path: '/a:b.ts', lineStart: 2, lineEnd: 2 })), { side: 'head', path: '/a:b.ts', start: 2, end: 2 });
  assert.deepEqual([parseLocation(JSON.stringify({ side: 'head', path: '/a.ts', lineStart: 3, lineEnd: 2 })), parseLocation('head:/a.ts:3-2')],
    [{ side: 'head', path: '/a.ts', start: 3, end: 2 }, { side: 'head', path: '/a.ts', start: 3, end: 2 }]);
  // An end that is given but is no line number leaves the range unknown (the file stays); one left out is the start.
  assert.deepEqual([parseLocation({ side: 'head', path: '/a.ts', lineStart: 3, lineEnd: '2' }), parseLocation({ side: 'head', path: '/a.ts', lineStart: 3, lineEnd: null })],
    [{ side: 'head', path: '/a.ts', start: null, end: null }, { side: 'head', path: '/a.ts', start: 3, end: 3 }]);
  for (const lineEnd of [-1, 0]) assert.deepEqual(parseLocation({ side: 'head', path: '/a.ts', lineStart: 3, lineEnd }), { side: 'head', path: '/a.ts', start: null, end: null }, String(lineEnd));
  const small = sourceWindow('a\nb\nc\n', { start: 2 });
  assert.deepEqual({ ...small, text: small.text.split('\n') }, { firstLine: 1, lastLine: 3, totalLines: 3, text: ['1 | a', '2 | b', '3 | c'] });
  const big = sourceWindow(Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'), { start: 500, end: 502, context: 5 });
  assert.equal(big.firstLine, 495);
  assert.equal(big.lastLine, 507);
  assert.match(big.text, /^495 \| line 495/);
});

eachKind('planning payloads inline source excerpts and the discussion digest; tools are rarely needed', async (t, kind) => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
  const fetched = [];
  const { invoke, payloads } = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  const plan = await prepareComments(review, store, invoke, {
    discussions: [{ threadId: 9, path: '/src/Main.java', line: 1, excerpt: 'Existing note' }],
    // The file at HEAD: the two lines the comments quote.
    fetchSource: async path => { fetched.push(path); return `${codeFor('F-1')}\n${codeFor('F-2')}\n`; },
  });
  assert.deepEqual(fetched, ['/src/Main.java'], 'Each file is fetched once.');
  const payload = payloads[0];
  assert.equal(payload.discussionsRead, true);
  assert.deepEqual(payload.existingDiscussions, [{ threadId: 9, path: '/src/Main.java', line: 1, excerpt: 'Existing note' }]);
  assert.deepEqual(payload.sourceExcerpts.map(e => [e.path, e.findingIds, e.firstLine, e.lastLine]), [['/src/Main.java', ['F-1', 'F-2'], 1, 2]]);
  assert.equal(payload.sourceExcerpts[0].text, '1 | code for F-1\n2 | code for F-2');
  assert.equal(payload.evidenceIndex, undefined, 'No evidence index when every finding has an excerpt.');
  assert.equal(payload.reportReference, undefined, 'A one-segment report needs no file reference.');
  assert.equal(typeof payload.findings[0].evidence, 'string', 'Findings are inline.');
  assert.equal(plan.comments.length, 2);
  // A structured location that 0.4.6 saved gets its excerpt, and its comment stands in its file, like any other.
  const structured = await setup(t, [{ ...finding('F-1'), location: JSON.stringify({ side: 'head', path: '/src/Main.java', lineStart: 1, lineEnd: 1 }) }], undefined, { kind });
  const legacy = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  const legacyPlan = await prepareComments(structured.review, structured.store, legacy.invoke, { discussions: [], fetchSource: async () => `${codeFor('F-1')}\n` });
  assert.deepEqual(legacy.payloads[0].sourceExcerpts.map(e => [e.path, e.findingIds]), [['/src/Main.java', ['F-1']]]);
  assert.deepEqual(legacyPlan.comments.map(c => [c.findingId, c.path, c.startLine]), [['F-1', '/src/Main.java', 1]]);
  // Without discussions or source the planner is told to read them itself.
  const other = await setup(t, [finding('F-1')], undefined, { kind });
  const second = stages(async payload => JSON.stringify({ status: 'READY', comments: [comment(payload.findings[0].id)], skipped: [] }));
  await prepareComments(other.review, other.store, second.invoke, {});
  assert.equal(second.payloads[0].discussionsRead, false);
  assert.ok(second.payloads[0].evidenceIndex, 'The evidence index remains available without excerpts.');
  // A saved line past the end of a long file gives a window with no line: that is no excerpt, and the evidence
  // index stays.
  const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const beyond = await setup(t, [{ ...finding('F-1'), location: JSON.stringify({ side: 'head', path: '/src/Main.java', lineStart: 600, lineEnd: 600 }) }], undefined, { kind });
  const third = stages(async payload => JSON.stringify({ status: 'READY', comments: [], skipped: [{ findingId: 'F-1', cause: 'no-inline-location', reason: 'Its line is not in the file.' }] }));
  await prepareComments(beyond.review, beyond.store, third.invoke, { discussions: [], fetchSource: async () => long });
  assert.deepEqual([third.payloads[0].sourceExcerpts ?? [], Boolean(third.payloads[0].evidenceIndex)], [[], true]);
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
const PLACED_SOURCE = 'line one\nline two\nline three\n';
const sourceOf = async () => PLACED_SOURCE;
async function placedSetup(t, findings, kind = 'verified') {
  // A review without a verifier has its sessions' reads of these files on record, with the text the runtime reads.
  const prepared = await setup(t, findings, undefined, { kind, source: () => PLACED_SOURCE });
  prepared.review.snapshot.files = [...new Set(findings.map(f => parseLocation(f.location).path))];
  return prepared;
}
// The planning pages among recorded payloads, in page order (lanes record them as they start).
// Whether any two of these findings could share a planning page.
const pairFits = findings => pairable(findings).length > 0;
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

eachKind('on one page the findings of equal severity at different places are offered; one comment lists the other places', async (t, kind) => {
  const { review, store } = await placedSetup(t, [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C', 'medium'), placed('F-4', 'D', 'low')], kind);
  const { invoke, payloads } = stages(async payload => groupwise(payload));
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.equal(payloads.length, 1, 'No grouping pass: the page sees every finding itself.');
  assert.deepEqual(payloads[0].repeatCandidates, [['F-1', 'F-2']]);
  assert.equal(Object.hasOwn(payloads[0], 'mergeCandidates'), false);
  assert.deepEqual(payloads[0].findings.map(f => f.id), ['F-1', 'F-2', 'F-3', 'F-4'], 'The page keeps its order.');
  assert.deepEqual(plan.comments.map(c => [c.findingIds ?? c.findingId, c.path, c.otherPlaces ?? null]),
    [[['F-1', 'F-2'], '/src/A.java', [{ findingId: 'F-2', place: '/src/B.java:2' }]], ['F-3', '/src/C.java', null]]);
  assert.match(plan.comments[0].content, new RegExp(`Body\\.\\n\\n\\*\\*📍 Also at\\*\\* \\(the same defect; fix these places with it\\):\\n- \`/src/B\\.java:2\` \\(F-2\\)\\n\\n---\\n${literal(review.attribution)}\\n\\n<!-- azpr-comment:[a-f0-9]{32} -->\\n\\n<!-- azpr-comment:[a-f0-9]{32} -->$`));
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-4']);
  assert.match(plan.summary.content, /high: 2 · medium: 1 · low: 1/, 'Every place keeps its row and its count.');
  // The same findings on the same lines are one place: nothing is offered and the input is as before.
  const same = await setup(t, [finding('F-1'), finding('F-2')], undefined, { kind });
  const unchanged = stages(async payload => JSON.stringify({ status: 'READY', comments: payload.findings.map(f => comment(f.id)), skipped: [] }));
  await prepareComments(same.review, same.store, unchanged.invoke);
  assert.equal(Object.hasOwn(unchanged.payloads[0], 'repeatCandidates'), false);
});

eachKind('only a place whose lines the HEAD file has is offered; without that text nothing is', async (t, kind) => {
  // F-3 names line 40 of a file of three lines, F-4 a file that cannot be read at HEAD (deleted in this PR, say).
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C', 'high', { location: 'head:/src/C.java:40' }), placed('F-4', 'D')];
  const fetchSource = async path => { if (path === '/src/D.java') throw new Error('not found'); return 'line one\nline two\nline three\n'; };
  const { review, store } = await placedSetup(t, findings, kind);
  const one = stages(async payload => groupwise(payload));
  const plan = await prepareComments(review, store, one.invoke, { fetchSource });
  assert.deepEqual(one.payloads[0].repeatCandidates, [['F-1', 'F-2']]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), [['F-1', 'F-2'], 'F-3', 'F-4']);
  // A planner that combines them all the same is refused, with the place and the reason.
  const forced = await placedSetup(t, findings, kind), issues = [];
  const insisting = stages(async (payload, turn, evaluation) => {
    if (turn) { issues.push(...evaluation.issues); return groupwise(payload); }
    return JSON.stringify({ status: 'READY', skipped: [{ findingId: 'F-4', cause: 'cannot-anchor', reason: 'No source.' }], comments: [{ findingIds: ['F-1', 'F-2', 'F-3'], mergeReason: 'Same.', severity: 'high', path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🔴 high: Unchecked call\n\nBody.' }] });
  });
  await prepareComments(forced.review, forced.store, insisting.invoke, { fetchSource });
  assert.match(issues.join('\n'), /combined comment for F-1, F-2, F-3: the findings are not all in one listed group/);
  // With several pages the pass sees only such places.
  const many = [...findings, placed('F-5', 'E'), placed('F-6', 'F')];
  const paged = await placedSetup(t, many, kind);
  const pass = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload));
  await prepareComments(paged.review, paged.store, pass.invoke, { fetchSource });
  assert.deepEqual(pass.payloads[0].findings.map(f => f.id), ['F-1', 'F-2', 'F-5', 'F-6']);
  // Without the text of the files nothing can be listed, so nothing is offered and no pass runs.
  const blind = await placedSetup(t, many, kind);
  const none = stages(async payload => JSON.stringify({ status: 'READY', skipped: payload.findings.map(f => ({ findingId: f.id, cause: 'cannot-anchor', reason: 'No source.' })), comments: [] }));
  await prepareComments(blind.review, blind.store, none.invoke);
  assert.ok(none.payloads.every(p => p.commentWork.kind === 'plan' && !Object.hasOwn(p, 'repeatCandidates')));
});

eachKind('a comment for several places planned onto lines that already carry a comment of AZPR\'s goes back to the planner, which moves it', async (t, kind) => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C')];
  const { review, store } = await placedSetup(t, findings, kind);
  // What an earlier publication left at F-1's lines: a comment for that place alone.
  const first = await prepareComments(review, store, stages(async payload => groupwise({ ...payload, repeatCandidates: [] })).invoke, { fetchSource: sourceOf });
  const threads = [{ id: 31, status: 'active', comments: [{ id: 1, parentCommentId: 0, content: first.comments[0].content }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } }];
  const issues = [];
  const { invoke } = stages(async (payload, turn, evaluation) => {
    if (!turn) return groupwise(payload);
    issues.push(...evaluation.issues);
    // The planner anchors the comment at another of its places.
    return JSON.stringify({ status: 'READY', skipped: [], comments: [{ findingIds: ['F-1', 'F-2', 'F-3'], mergeReason: 'Same.', severity: 'high', path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🔴 high: Unchecked call\n\nBody.' }] });
  });
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf, discussions: discussionDigest(threads), posted: markersInThreads(threads) });
  assert.match(issues.join('\n'), /the PR already has a comment of AZPR's on these quoted lines \(thread 31\), and a second one is not put on them/);
  assert.deepEqual(plan.comments.map(c => [c.findingId, c.path, c.otherPlaces.map(other => other.place)]), [['F-2', '/src/B.java', ['/src/A.java:2', '/src/C.java:2']]]);
  // Once that comment is on the PR, the same plan made again is that very comment: nothing is sent back.
  const there = [...threads, { id: 32, status: 'active', comments: [{ id: 1, parentCommentId: 0, content: plan.comments[0].content }], threadContext: { filePath: '/src/B.java', rightFileStart: { line: 2 } } }];
  const again = stages(async payload => JSON.stringify({ status: 'READY', skipped: [], comments: [{ findingIds: ['F-1', 'F-2', 'F-3'], mergeReason: 'Same.', severity: 'high', path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'line two', body: '🔴 high: Unchecked call\n\nBody.' }] }));
  const same = await prepareComments(review, store, async (payload, handler) => { const page = await again.invoke(payload, handler); assert.deepEqual(page.corrections, []); return page; },
    { fetchSource: sourceOf, discussions: discussionDigest(there), posted: markersInThreads(there) });
  assert.equal(same.comments[0].marker, plan.comments[0].marker);
});

eachKind('publication knows a comment for several places by its own marker: it is skipped only when the PR has this very comment', async (t, kind) => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C')];
  const { review, store, azure } = await placedSetup(t, findings, kind);
  const { api, run, attempts } = publisher(azure);
  const plan = (answer, options = {}) => prepareComments(review, store, stages(answer).invoke, { fetchSource: sourceOf, ...options });
  const separate = await plan(async payload => groupwise({ ...payload, repeatCandidates: [] })), shared = await plan(async payload => groupwise(payload));
  const item = shared.comments[0];
  assert.deepEqual([shared.comments.length, item.marker === sharedMarker(review.target, item, 0), item.marker === separate.comments[0].marker], [1, true, false]);
  const only = comments => ({ ...review, publication: new Map(), plan: { summary: null, skipped: [], comments } });
  // An earlier publication put a comment for F-1 alone on the PR.
  assert.equal((await publishPlan({ run, review: only(separate.comments.slice(0, 1)), azure: api, attempts })).status, 'POSTED');
  // A plan made without a look at the PR has the shared comment on the same lines. It is another comment: it is posted
  // with every place, and the receipt says of it only what is so.
  const later = only(shared.comments);
  const result = await publishPlan({ run, review: later, azure: api, attempts });
  assert.deepEqual([result.status, result.counts, azure.callsTo('createThread').length], ['POSTED', { VERIFIED: 1 }, 2]);
  assert.deepEqual(azure.state.threads.map(thread => thread.comments[0].content), [separate.comments[0].content, item.content], 'The earlier comment is as it was; the new one lists the other places.');
  assert.match(renderPublication(later, result), /^Publication \(VERIFIED=1\):\n- F-1, F-2, F-3 \(\/src\/A\.java:2\): VERIFIED; thread=\d+\n\nPOSTED\/VERIFIED entries/);
  // Published again, it is found by its own marker, which no other comment has; its record is under that marker alone.
  const again = await publishPlan({ run, review: only(shared.comments), azure: api, attempts });
  assert.deepEqual([again.counts, azure.callsTo('createThread').length], [{ ALREADY_PRESENT: 1 }, 2]);
  assert.deepEqual([attempts.entries[item.marker].state, Object.hasOwn(attempts.entries, item.linesMarker)], ['CREATED', false]);
  // Other places on the same quoted lines are another comment; the same places are the same one whoever is named first.
  assert.notEqual(sharedMarker(review.target, { ...item, otherPlaces: item.otherPlaces.slice(0, 1) }), item.marker);
  assert.equal(sharedMarker(review.target, { ...item, otherPlaces: [...item.otherPlaces].reverse() }), item.marker);
  // With a person's adjustments, the other AZPR comments of the PR are counted by comment: the shared comment of the
  // preview is none, whatever second marker it carries, and one outside the preview is one.
  const counted = await publishPlan({ run, review: only(shared.comments), azure: api, attempts, compare: true });
  assert.deepEqual([counted.counts, counted.otherComments], [{ ALREADY_PRESENT: 1 }, 1], 'The comment for F-1 alone is the other one.');
  const outside = await publishPlan({ run, review: only(separate.comments.slice(0, 1)), azure: api, attempts, compare: true });
  assert.equal(outside.otherComments, 1, 'The shared comment, with its two markers, is one comment.');
  // A reply in the preview's own thread that quotes another thread's marker does not hide that thread.
  azure.state.threads[0].comments.push({ id: 2, parentCommentId: 1, content: `See also ${item.marker}`, commentType: 'text' });
  const quoted = await publishPlan({ run, review: only(separate.comments.slice(0, 1)), azure: api, attempts, compare: true });
  assert.equal(quoted.otherComments, 1, 'The shared comment\'s thread is still another comment.');
  azure.state.threads[0].comments.pop();
  // Which thread a quoted marker is found in first does not matter: a preview's two comments, one of them quoted in
  // the other's thread, are the preview's own in either order of the threads.
  const quoting = await placedSetup(t, findings, kind), q = publisher(quoting.azure);
  const twoItems = { ...quoting.review, publication: new Map(), plan: { summary: null, skipped: [], comments: separate.comments.slice(0, 2) } };
  await publishPlan({ run: q.run, review: twoItems, azure: q.api, attempts: q.attempts });
  quoting.azure.state.threads[0].comments.push({ id: 2, parentCommentId: 1, content: `As in ${separate.comments[1].marker}`, commentType: 'text' });
  for (const reversed of [false, true]) {
    if (reversed) quoting.azure.state.threads.reverse();
    const ownOnly = await publishPlan({ run: q.run, review: { ...twoItems, publication: new Map() }, azure: q.api, attempts: q.attempts, compare: true });
    assert.deepEqual([ownOnly.counts, ownOnly.otherComments], [{ ALREADY_PRESENT: 2 }, 0], reversed ? 'reversed' : 'in order');
  }
  // Two defects at the same places are two comments on the PR.
  const twin = { ...item, findingId: 'F-9', findingIds: ['F-9', 'F-8'], marker: sharedMarker(review.target, item, 1) };
  twin.content = item.content.replace(item.marker, twin.marker);
  const both = await placedSetup(t, findings, kind), pair = publisher(both.azure);
  const result2 = await publishPlan({ run: pair.run, review: { ...both.review, publication: new Map(), plan: { summary: null, skipped: [], comments: [item, twin] } }, azure: pair.api, attempts: pair.attempts });
  assert.deepEqual([result2.counts, both.azure.callsTo('createThread').length], [{ VERIFIED: 2 }, 2]);
  // Planning keeps the two kinds off each other's lines. With the shared comment on the PR, a plan that comments on
  // F-1 alone at those lines is sent back; left as it is, F-1 is skipped with the reason and the others are planned.
  const threads = [{ id: 51, status: 'active', comments: [{ id: 1, parentCommentId: 0, content: item.content }], threadContext: { filePath: '/src/A.java', rightFileStart: { line: 2 } } }];
  const issues = [];
  const alone = await plan(async (payload, turn, evaluation) => { if (turn) issues.push(...evaluation.issues); return groupwise({ ...payload, repeatCandidates: [] }); }, { discussions: discussionDigest(threads), posted: markersInThreads(threads) });
  assert.match(issues.join('\n'), /comment for F-1: the PR already has a comment of AZPR's on these quoted lines \(thread 51\), and a second one is not put on them\. Skip F-1 with cause existing-thread when that thread covers it, or quote other lines\./);
  assert.deepEqual([alone.comments.map(c => c.findingId), alone.skipped.map(s => s.findingId)], [['F-2', 'F-3'], ['F-1']]);
});

eachKind('a page continued in a new session still offers what is open of a group, while two of its findings are', async (t, kind) => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C'), placed('F-4', 'D', 'medium')];
  const { review, store } = await placedSetup(t, findings, kind);
  const { invoke, payloads } = stages(async payload => {
    // The first session comments on F-1 alone and stops; the next one sees what is left.
    if (payload.findings.length === 4) return JSON.stringify({ status: 'CONTINUE', continuation: 'F-1 is done; F-2, F-3 and F-4 remain.', skipped: [],
      comments: [{ ...comment('F-1'), path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two' }] });
    return groupwise(payload);
  });
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
  assert.deepEqual(payloads.map(p => [p.findings.map(f => f.id), p.repeatCandidates ?? null]), [[['F-1', 'F-2', 'F-3', 'F-4'], [['F-1', 'F-2', 'F-3']]], [['F-2', 'F-3', 'F-4'], [['F-2', 'F-3']]]]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3'], 'F-4']);
  // What is left of a set must still lie at two places: two findings on the same lines can share no comment.
  const same = await placedSetup(t, [placed('F-1', 'A', 'medium'), placed('F-2', 'A', 'medium'), placed('F-3', 'B', 'medium')], kind);
  const left = stages(async payload => payload.findings.length === 3
    ? JSON.stringify({ status: 'CONTINUE', continuation: 'F-3 is done; F-1 and F-2 remain.', skipped: [], comments: [{ ...comment('F-3'), severity: 'medium', path: '/src/B.java', startLine: 2, endLine: 2, anchor: 'line two' }] })
    : groupwise(payload));
  await prepareComments(same.review, same.store, left.invoke, { fetchSource: sourceOf });
  assert.deepEqual(left.payloads.map(p => [p.findings.map(f => f.id), p.repeatCandidates ?? null]), [[['F-1', 'F-2', 'F-3'], [['F-1', 'F-2', 'F-3']]], [['F-1', 'F-2'], null]]);
  // One finding left of a group is no group.
  const pair = await placedSetup(t, findings.slice(0, 2), kind);
  const alone = stages(async payload => payload.findings.length === 2
    ? JSON.stringify({ status: 'CONTINUE', continuation: 'F-1 is done; F-2 remains.', skipped: [], comments: [{ ...comment('F-1'), path: '/src/A.java', startLine: 2, endLine: 2, anchor: 'line two' }] })
    : groupwise(payload));
  await prepareComments(pair.review, pair.store, alone.invoke, { fetchSource: sourceOf });
  assert.deepEqual(alone.payloads.map(p => p.repeatCandidates ?? null), [[['F-1', 'F-2']], null]);
});

eachKind('the grouping pass reads its findings inline: a long list goes without the evidence, and one that is still too long is not grouped', async (t, kind) => {
  const answer = async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload);
  const files = Array.from({ length: 40 }, (_, i) => `F${i}`);
  // 40 findings with 2,000 characters of evidence each: more than the pass takes, but not without the evidence.
  const long = await placedSetup(t, files.map((file, i) => placed(`F-${i + 1}`, file, 'high', { evidence: 'e'.repeat(2000) })), kind);
  const some = stages(answer), notes = [];
  await prepareComments(long.review, long.store, some.invoke, { fetchSource: sourceOf, progress: note => notes.push(note) });
  const pass = some.payloads.find(p => p.commentWork.kind === 'group');
  assert.ok(Array.isArray(pass.findings), 'The findings are inline, never a reference the pass would have to read.');
  assert.equal(pass.findings.length, 40);
  assert.deepEqual(Object.keys(pass.findings[0]), ['id', 'severity', 'location', 'summary', 'suggestion']);
  assert.ok(JSON.stringify(pass.findings).length <= 60000);
  // Summaries alone beyond that size: no pass, a note, and every finding planned on its own.
  const huge = await placedSetup(t, files.map((file, i) => ({ ...placed(`F-${i + 1}`, file), summary: 's'.repeat(2000) })), kind);
  const skipped = stages(answer), said = [];
  const plan = await prepareComments(huge.review, huge.store, skipped.invoke, { fetchSource: sourceOf, progress: note => said.push(note) });
  assert.ok(skipped.payloads.every(p => p.commentWork.kind === 'plan' && !Object.hasOwn(p, 'repeatCandidates')));
  assert.match(said.join('\n'), /Planning comments: 40 findings are too many to look through for one defect at several places; planning goes on without grouping them\./);
  assert.equal(plan.comments.length, 40);
});

eachKind('with several pages one grouping pass runs first; a group shares a page, which may then hold more than four findings', async (t, kind) => {
  const findings = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C'), placed('F-4', 'D'), placed('F-5', 'E'), placed('F-6', 'F'), placed('F-7', 'G', 'medium'), placed('F-8', 'H', 'low')];
  const { review, store } = await placedSetup(t, findings, kind);
  const notes = [];
  const { invoke, payloads } = stages(async payload => payload.commentWork.kind === 'group'
    // F-2 to F-6 repeat one mistake. F-7 is the only medium finding: no group could hold it, so the pass is not asked about it.
    ? JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-6', 'F-2', 'F-5', 'F-3', 'F-4'], reason: 'The same unchecked call in each handler.' }] })
    : groupwise(payload));
  const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf, progress: note => notes.push(note) });
  const pass = payloads[0], pages = pagesOf(payloads);
  assert.equal(payloads.filter(p => p.commentWork.kind === 'group').length, 1, 'One pass, before any page.');
  assert.deepEqual(pass.commentWork, { kind: 'group' });
  assert.deepEqual(pass.findings.map(f => f.id), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6'], 'The pass sees the findings that could share a comment: not the low one, nor the one that is alone in its severity.');
  assert.deepEqual(Object.keys(pass.findings[0]), ['id', 'severity', 'location', 'summary', 'evidence', 'suggestion']);
  assert.deepEqual(Object.keys(pass).sort(), ['commentWork', 'findings', 'outputLanguage', 'reviewId']);
  assert.match(notes[0], /looking for one defect at several places \(6 findings\)/);
  assert.deepEqual(pages.map(p => p.findings.map(f => f.id)), [['F-1'], ['F-2', 'F-3', 'F-4', 'F-5', 'F-6'], ['F-7', 'F-8']], 'The group has a page of its own, in the order of the findings.');
  assert.deepEqual(pages.map(p => p.repeatCandidates ?? null), [null, [['F-2', 'F-3', 'F-4', 'F-5', 'F-6']], null]);
  assert.deepEqual(pages.map(p => [p.commentWork.page, p.commentWork.pages]), [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(plan.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3', 'F-4', 'F-5', 'F-6'], 'F-7']);
  assert.deepEqual(plan.comments[1].otherPlaces.map(place => place.place), ['/src/C.java:2', '/src/D.java:2', '/src/E.java:2', '/src/F.java:2']);
  assert.deepEqual(plan.skipped.map(s => s.findingId), ['F-8']);
  // A pass that finds nothing leaves the pages exactly as they are without it.
  const none = await placedSetup(t, findings, kind);
  const plain = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [] }) : groupwise(payload));
  await prepareComments(none.review, none.store, plain.invoke, { fetchSource: sourceOf });
  assert.deepEqual(pagesOf(plain.payloads).map(p => p.findings.map(f => f.id)), [['F-1', 'F-2', 'F-3', 'F-4'], ['F-5', 'F-6', 'F-7', 'F-8']]);
  assert.ok(pagesOf(plain.payloads).every(p => !Object.hasOwn(p, 'repeatCandidates')));
});

eachKind('the grouping pass is corrected like a page; a group that stays wrong is dropped and its findings are planned alone', async (t, kind) => {
  const findings = ['A', 'B', 'C', 'D', 'E'].map((file, i) => placed(`F-${i + 1}`, file));
  const { review, store } = await placedSetup(t, findings, kind);
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

eachKind('a grouping pass that fails costs only the grouping; a stopped run is not continued', async (t, kind) => {
  const findings = ['A', 'B', 'C', 'D', 'E'].map((file, i) => placed(`F-${i + 1}`, file));
  const failing = pages => async (payload, handler) => {
    if (payload.commentWork.kind === 'group') throw Object.assign(new Error('Provider unavailable.'), { failureClass: 'transient' });
    return pages.invoke(payload, handler);
  };
  const { review, store } = await placedSetup(t, findings, kind);
  const pages = stages(async payload => groupwise(payload)), notes = [];
  const plan = await prepareComments(review, store, failing(pages), { fetchSource: sourceOf, progress: note => notes.push(note) });
  assert.match(notes.join('\n'), /the grouping failed \(Provider unavailable\.\); planning goes on without grouping repeated places\./);
  assert.deepEqual(pagesOf(pages.payloads).map(p => p.findings.map(f => f.id)), [['F-1', 'F-2', 'F-3', 'F-4'], ['F-5']]);
  assert.ok(pages.payloads.every(p => !Object.hasOwn(p, 'repeatCandidates')));
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5']);
  // A run that was stopped meanwhile plans nothing more, whatever the failure looked like.
  const stopped = await placedSetup(t, findings, kind), later = stages(async payload => groupwise(payload));
  await assert.rejects(prepareComments(stopped.review, stopped.store, async (payload, handler) => {
    if (payload.commentWork.kind === 'group') throw Object.assign(new Error('Review stopped.'), { failureClass: 'cancelled' });
    return later.invoke(payload, handler);
  }, { fetchSource: sourceOf }), /Review stopped/);
  assert.equal(later.payloads.length, 0, 'No page starts after a stop.');
  // A stop that arrives while the pass is ending, so that it still answers: no page is prepared, and no further file is read.
  const late = await placedSetup(t, [...findings, placed('F-6', 'F', 'low')], kind), after = stages(async payload => groupwise(payload)), files = [];
  let running = true;
  await assert.rejects(prepareComments(late.review, late.store, async (payload, handler) => {
    if (payload.commentWork.kind === 'group') { running = false; return { status: 'READY', groups: [['F-1', 'F-2']], corrections: [] }; }
    return after.invoke(payload, handler);
  }, { active: () => running, fetchSource: async path => { files.push(path); return 'line one\nline two\nline three\n'; } }), /Comment planning was stopped/);
  assert.deepEqual([after.payloads.length, files.includes('/src/F.java')], [0, false], 'The low finding\'s file is read for its page only, and no page is prepared.');
  // Stopped while the files are read ahead of the pages: no further file is read, no pass is asked and no page starts.
  for (const stopAfter of [0, 2]) {
    const early = await placedSetup(t, findings, kind), none = stages(async payload => groupwise(payload)), read = [];
    let active = true;
    await assert.rejects(prepareComments(early.review, early.store, none.invoke, { parallel: 1, active: () => active,
      fetchSource: async path => { read.push(path); if (read.length >= stopAfter) active = false; return 'line one\nline two\nline three\n'; },
      ...(stopAfter ? {} : { active: () => false }) }), /Comment planning was stopped/);
    assert.deepEqual([read.length, none.payloads.length], [stopAfter, 0]);
  }
});

test('a quick review of 0.4.x offers both kinds: the same lines twice as merge candidates, other places as repeat candidates', async t => {
  const a = quickFinding('Q-1', '1/2', 'head:/src/A.java:2'), b = quickFinding('Q-1001', '2/2', 'head:/src/A.java:2'),
    c = quickFinding('Q-2', '1/2', 'head:/src/B.java:2'), d = quickFinding('Q-3', '1/2', 'head:/src/C.java:2');
  const { review, store } = await placedSetup(t, [a, b, c, d], 'quick');
  assert.equal(reviewMethod(review), 'quick');
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

test('only a quick review of 0.4.x is offered merge candidates: a review of this pipeline had its duplicate check, a verified one its verifier', async t => {
  // Two findings of different sessions on the same lines, which this pipeline's duplicate check left apart, and two
  // more of that severity at other places.
  const found = ([one, other]) => [quickFinding('F-1', one, 'head:/src/A.java:2'), quickFinding('F-2', other, 'head:/src/A.java:2'), quickFinding('F-3', one, 'head:/src/B.java:2'), quickFinding('F-4', one, 'head:/src/C.java:2')];
  const at = file => ({ severity: 'medium', path: `/src/${file}.java`, startLine: 2, endLine: 2, anchor: 'line two' });
  const twice = { findingIds: ['F-1', 'F-2'], mergeReason: 'Reported twice.', ...at('A'), body: '🟡 medium: Twice\n\nBody.' };
  const each = ['F-1', 'F-2'].map(id => ({ findingId: id, ...at('A'), body: `🟡 medium: ${id} loses state\n\nBody.` }));
  const places = { findingIds: ['F-3', 'F-4'], mergeReason: 'The same call.', ...at('C'), body: '🟡 medium: Repeated\n\nBody.' };
  const fields = ['counterevidence', 'evidence', 'id', 'location', 'severity', 'suggestion', 'summary'];
  for (const [kind, sessions, keys, status] of [['reviewers', ['1/1 pass 1', '1/1 pass 2'], [...fields, 'shard'].sort(), 'REPORTED'], ['verified', [undefined, undefined], fields, 'CONFIRMED']]) {
    const { review, store } = await placedSetup(t, found(sessions), kind);
    assert.equal(reviewMethod(review), kind);
    // The planner tries what a quick review of 0.4.x allows, one comment for the two findings on the same lines.
    // Sent back, it comments on each.
    const issues = [];
    const { invoke, payloads } = stages(async (payload, turn, evaluation) => {
      if (turn) issues.push(...evaluation.issues);
      return JSON.stringify({ status: 'READY', skipped: [], comments: [...(turn ? each : [twice]), places] });
    });
    const plan = await prepareComments(review, store, invoke, { fetchSource: sourceOf });
    assert.equal(payloads.length, 1, kind);
    const [payload] = payloads;
    // The input: the findings this kind publishes, as its record has them, and no merge candidates. The four findings
    // of one severity are possible repeats, and that rule knows the same lines for one place.
    assert.equal(Object.hasOwn(payload, 'mergeCandidates'), false, kind);
    assert.deepEqual(payload.repeatCandidates, [['F-1', 'F-2', 'F-3', 'F-4']], kind);
    assert.deepEqual(payload.findings, publishableFindings(review), kind);
    assert.deepEqual([payload.findings.map(f => f.id), Object.keys(payload.findings[1]).sort(), payload.findings.map(f => f.shard), payload.dispositions.map(row => row.status)],
      [['F-1', 'F-2', 'F-3', 'F-4'], keys, [sessions[0], sessions[1], sessions[0], sessions[0]], Array(4).fill(status)], kind);
    assert.deepEqual(issues, ['combined comment for F-1, F-2: F-1 and F-2 are on the same lines, which is not another place. Correct it, or comment on each finding separately.'], kind);
    // The two stay two comments on the same quoted line, told apart by their order, and two rows of the summary;
    // the defect at two places is one comment, as for any kind.
    assert.deepEqual(plan.comments.map(c => [c.findingIds ?? c.findingId, c.otherPlaces ?? null]), [['F-1', null], ['F-2', null], [['F-4', 'F-3'], [{ findingId: 'F-3', place: '/src/B.java:2' }]]], kind);
    assert.deepEqual(plan.comments.slice(0, 2).map(c => c.marker), [0, 1].map(ordinal => inlineMarker(review.target, plan.comments[0], ordinal)), kind);
    assert.match(plan.summary.content, /\| 🟡 medium \| F-1 — Defect F-1 \|[^\n]*\n\| 🟡 medium \| F-2 — Defect F-2 \|/, kind);
    assert.deepEqual(plan.skipped, [], kind);
  }
  // The same four findings as a quick review of 0.4.x saved them: there the two are listed, and one comment may hold them.
  const quick = await placedSetup(t, found(['1/2', '2/2']), 'quick');
  const listed = stages(async () => JSON.stringify({ status: 'READY', skipped: [], comments: [twice, places] }));
  const combined = await prepareComments(quick.review, quick.store, listed.invoke, { fetchSource: sourceOf });
  assert.deepEqual([listed.payloads[0].mergeCandidates, listed.payloads[0].repeatCandidates], [[['F-1', 'F-2']], [['F-3', 'F-4']]]);
  assert.deepEqual(combined.comments.map(c => [c.findingIds, c.otherPlaces?.length ?? 0]), [[['F-1', 'F-2'], 0], [['F-4', 'F-3'], 1]]);
});

test('each kind of review is planned with the wording that describes it: the verified variant only for verified reviews of 0.4.x', async () => {
  // Which role plans a review is the runtime's choice by `reviewMethod` (the verified planner for a verified review
  // of 0.4.x, the mode's planner for every other kind). Here: that both planners exist and what each is told.
  for (const mode of ['review', 'deep', 'quick']) assert.equal(promptVariant(roleFor(mode, 'comment-plan')), 'reviewers', mode);
  for (const mode of ['review', 'deep']) assert.equal(promptVariant(roleFor(mode, 'comment-plan-verified')), 'verified', mode);
  assert.equal(Object.hasOwn(ROLES, roleFor('quick', 'comment-plan-verified')), false, 'A /pr-quick of 0.4.x had no verifier, so no such review exists.');
  const prompts = Object.fromEntries(await Promise.all(PROMPTS.map(async name => [name, await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8')])));
  const settings = validateSettings({ version: 3, models: { review: { reviewers: ['provider/first', 'provider/second'] }, deep: { reviewers: ['provider/deep'] }, quick: { reviewers: ['provider/quick'] } },
    azure: { organization: 'org', pat: FAKE_PAT } });
  const agents = buildAgents(settings, prompts);
  for (const mode of ['review', 'deep', 'quick']) {
    // The planner of this pipeline's reviews, which also plans a quick review of 0.4.x: nobody verified the findings,
    // a finding may be summary-only, and merge candidates are explained for the input that has them.
    const { system, model } = agents[roleFor(mode, 'comment-plan')];
    assert.match(system, /The supplied findings come from this review's reviewers: each checked its own\nfindings against the source, and no separate verification re-checked them\./, mode);
    assert.match(system, /A finding with\n`"inline": false` has no location that can carry an inline comment/, mode);
    assert.match(system, /Where the input has `mergeCandidates`, different sessions may have reported one\ndefect twice/, mode);
    assert.match(system, /\nOne general PR summary plus inline comments for high and medium findings:\n/, mode);
    assert.doesNotMatch(system, /verifier|confirmed|azpr:(?:verified|reviewers|end)/i, mode);
    // It runs with the mode's first reviewer model.
    assert.equal(`${model.providerID}/${model.id}`, settings.models[mode].reviewers[0], mode);
  }
  for (const mode of ['review', 'deep']) {
    // The planner of a verified review of 0.4.x: the verifier's findings, confirmed and already merged, and no word
    // of merge candidates, which such a review never has.
    const { system, model } = agents[roleFor(mode, 'comment-plan-verified')];
    assert.match(system, /The supplied findings are the verifier's corrected findings and are\nauthoritative/, mode);
    assert.match(system, /The verifier already merged duplicate findings: each finding is a separate\nissue/, mode);
    assert.match(system, /\nOne general PR summary plus inline comments for confirmed high and medium\nfindings:\n/, mode);
    assert.doesNotMatch(system, /mergeCandidates|no separate verification|azpr:(?:verified|reviewers|end)/, mode);
    assert.equal(`${model.providerID}/${model.id}`, settings.models[mode].reviewers[0], mode);
    // One defect at several places is explained to both planners alike.
    for (const planner of [system, agents[roleFor(mode, 'comment-plan')].system]) assert.match(planner, /`repeatCandidates`, when present, lists groups of this page's findings\nthat may be such repeats/, mode);
  }
});

eachKind('no grouping pass is asked where no two findings of a set fit one page together', async (t, kind) => {
  // Two high findings in different files, each with 6,500 characters of evidence: a pair is larger than a page.
  const long = await placedSetup(t, [placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) })], kind);
  const none = stages(async payload => groupwise(payload));
  const plan = await prepareComments(long.review, long.store, none.invoke, { fetchSource: sourceOf });
  // Two lanes plan the two pages; either may reach the model first.
  assert.ok(none.payloads.every(p => p.commentWork.kind === 'plan'), 'No grouping pass was asked.');
  assert.deepEqual(pagesOf(none.payloads).map(p => [p.findings.map(f => f.id), p.repeatCandidates ?? null]), [[['F-1'], null], [['F-2'], null]]);
  assert.deepEqual(plan.comments.map(c => c.findingId), ['F-1', 'F-2']);
  // Nor is any file read ahead of the pages for it: each page reads its own, when its turn comes.
  const four = await placedSetup(t, ['A', 'B', 'C', 'D'].map((name, i) => placed(`F-${i + 1}`, name, 'high', { evidence: 'e'.repeat(6500) })), kind);
  const reads = [], started = [];
  await prepareComments(four.review, four.store, async (payload, handler) => { started.push([payload.commentWork.page, [...reads]]); return stages(async p => groupwise(p)).invoke(payload, handler); },
    { fetchSource: async path => { reads.push(path); return 'line one\nline two\nline three\n'; }, parallel: 1 });
  assert.deepEqual(started, [[1, ['/src/A.java']], [2, ['/src/A.java', '/src/B.java']], [3, ['/src/A.java', '/src/B.java', '/src/C.java']], [4, ['/src/A.java', '/src/B.java', '/src/C.java', '/src/D.java']]]);
  assert.equal(pairFits([placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) })]), false);
  // With a third, short finding of that severity a pair fits, so the pass is asked.
  const mixed = await placedSetup(t, [placed('F-1', 'A', 'high', { evidence: 'e'.repeat(6500) }), placed('F-2', 'B', 'high', { evidence: 'e'.repeat(6500) }), placed('F-3', 'C')], kind);
  const some = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-2', 'F-3'] }] }) : groupwise(payload));
  const grouped = await prepareComments(mixed.review, mixed.store, some.invoke, { fetchSource: sourceOf });
  assert.equal(some.payloads.filter(p => p.commentWork.kind === 'group').length, 1);
  assert.deepEqual(grouped.comments.map(c => c.findingIds ?? c.findingId), ['F-1', ['F-2', 'F-3']]);
  // A pair of another severity, or on the same lines, is no pair.
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'B', 'medium')]), false);
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'A')]), false);
  assert.equal(pairFits([placed('F-1', 'A'), placed('F-2', 'B')]), true);
  // A finding that fits a page with no other one takes no part in any group. With several pages nothing is read
  // ahead for it and the pass is not asked about it, so that it takes none of the pass's input: here a finding
  // longer than a page, and one that is alone in its severity.
  const unpaired = [placed('F-1', 'A'), placed('F-2', 'B'), placed('F-3', 'C', 'high', { evidence: 'e'.repeat(12000) }), placed('F-4', 'D', 'medium')];
  assert.deepEqual(pairable(unpaired).map(f => f.id), ['F-1', 'F-2']);
  const lone = await placedSetup(t, unpaired, kind);
  const fetched = [], asked = [];
  const pair = stages(async payload => payload.commentWork.kind === 'group' ? JSON.stringify({ status: 'READY', groups: [{ findingIds: ['F-1', 'F-2'] }] }) : groupwise(payload));
  const paired = await prepareComments(lone.review, lone.store, async (payload, handler) => {
    if (payload.commentWork.kind === 'group') asked.push([...fetched], payload.findings.map(f => f.id));
    return pair.invoke(payload, handler);
  }, { fetchSource: async path => { fetched.push(path); return 'line one\nline two\nline three\n'; }, parallel: 1 });
  assert.deepEqual(asked, [['/src/A.java', '/src/B.java'], ['F-1', 'F-2']]);
  assert.deepEqual(paired.comments.map(c => c.findingIds ?? c.findingId), [['F-1', 'F-2'], 'F-3', 'F-4']);
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

eachKind('a person\'s adjustments reach the planner only when there are some; the planning input is otherwise unchanged', async (t, kind) => {
  const { review, store } = await setup(t, [finding('F-1'), finding('F-2'), finding('F-3', 'low')], undefined, { kind });
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
  const { review, store } = await setup(t, [a, b], undefined, { kind: 'quick' });
  // No source is on record or fetched here: a quote has no text to be found in.
  review.toolText = [];
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
  assert.match(plan.skipped[0].reason, /^No inline comment: the anchor text was not found in the HEAD source/);
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

// OpenCode's native read cuts a line at HOST_READ_LINE_CHARACTERS and says so at its end; a model reads the
// pages of a private value with that tool, one row per line.
test('the rows of a private value\'s pages come back whole through the host\'s read, and together they are the value', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createCommentData({ root: directory });
  const hostRead = line => line.length <= HOST_READ_LINE_CHARACTERS ? line : `${line.slice(0, HOST_READ_LINE_CHARACTERS)}... (line truncated to ${HOST_READ_LINE_CHARACTERS} chars)`;
  const texts = {
    prose: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: the "retry budget" check moves before the cache lookup; see /src/file-0.ts.`).join('\n'),
    code: Array.from({ length: 400 }, (_, i) => `  const value${i} = compute(input${i}, options) // step ${i}`).join('\n'),
    oneLine: 'x'.repeat(12000),
    quotes: '"\\'.repeat(4000),
    control: '\u0000\u0001\u001f'.repeat(1500),
    pairs: '中文說明與🙂表情'.repeat(700),
  };
  for (const [name, text] of Object.entries(texts)) {
    for (const reference of [await store.put(text), await store.object({ value: text, list: [text.slice(0, 5000)] })]) {
      const whole = await store.read(reference);
      const content = await readFile(reference.pages, 'utf8');
      // What tells that a pages file gives its value whole says so of every file this version writes, and of
      // nothing that is a part of it, a row longer than the host returns, another text or another order.
      assert.equal(wholePages(content, whole), true, name);
      const first = content.slice(0, content.indexOf('\n') + 1), rest = content.slice(first.length);
      for (const [what, other] of [['no rows', ''], ['no line end', content.slice(0, -1)], ['a row less', first], ['its rows the other way round', rest + first], ['a row twice', first + content],
        ['another text', content.replace(/"text":"(.)/, (match, character) => `"text":"${character === 'Q' ? 'R' : 'Q'}`)], ['a text that is longer', content], ['something else', 'not rows\n'], ['a row that is no object', `null\n${content}`]]) {
        assert.equal(wholePages(other, what === 'a text that is longer' ? `${whole}.` : whole), false, `${name}: ${what}`);
      }
      const lines = content.split('\n');
      assert.equal(lines.pop(), '', name);
      assert.ok(lines.length > 1, `${name}: more than one row`);
      const rows = lines.map(line => { assert.ok(line.length <= ROW_CHARACTERS, `${name}: a row of ${line.length} characters`); return JSON.parse(hostRead(line)); });
      assert.equal(rows.map(row => row.text).join(''), whole, `${name}: the rows are the value`);
      rows.forEach((row, index) => {
        assert.deepEqual([row.start, row.end - row.start], [index ? rows[index - 1].end : 0, row.text.length], `${name}: row ${index} continues the one before`);
        assert.doesNotMatch(row.text, /[\uD800-\uDBFF]$/, `${name}: no surrogate pair is split`);
      });
    }
  }
  assert.deepEqual(pageRows(''), [], 'An empty value has no row.');
  assert.deepEqual([wholePages('\n', ''), wholePages('', ''), wholePages('\n', 'x'), wholePages(`${JSON.stringify({ start: 0, end: 0, text: '' })}\n`, '')], [true, false, false, false], 'Its pages file is a line end, and nothing else is.');
  // A row is judged by what the host's read returns of a line, not by the length this version writes.
  const row = size => `${JSON.stringify({ start: 0, end: size, text: 'y'.repeat(size) })}\n`;
  let size = 1900;
  while (row(size).length - 1 < HOST_READ_LINE_CHARACTERS) size++;
  assert.deepEqual([row(size).length - 1, wholePages(row(size), 'y'.repeat(size)), wholePages(row(size + 1), 'y'.repeat(size + 1))], [HOST_READ_LINE_CHARACTERS, true, false]);
  assert.deepEqual(pageRows('abc').map(row => JSON.parse(row)), [{ start: 0, end: 3, text: 'abc' }]);
  // A model reads a row as it stands, not as it parses: a member that is there twice, one more, another order
  // or another spelling parses to the same page, or to more than the page, and is not what was written.
  assert.equal(wholePages('{"start":0,"end":3,"text":"abc"}\n', 'abc'), true);
  for (const [what, written] of [['a text twice', '{"start":0,"end":3,"text":"xyz","text":"abc"}'], ['a start twice', '{"start":7,"start":0,"end":3,"text":"abc"}'],
    ['a member more', '{"start":0,"end":3,"text":"abc","note":"read this too"}'], ['another order', '{"text":"abc","start":0,"end":3}'],
    ['blanks', '{"start": 0, "end": 3, "text": "abc"}'], ['another escape', '{"start":0,"end":3,"text":"\\u0061bc"}'], ['a list', '[{"start":0,"end":3,"text":"abc"}]']]) {
    assert.equal(wholePages(`${written}\n`, 'abc'), false, what);
  }
  // A row ends at a line break where one lies in its second half.
  const broken = pageRows(`${'a'.repeat(1200)}\n${'b'.repeat(1200)}`).map(row => JSON.parse(row));
  assert.deepEqual(broken.map(row => [row.start, row.end]), [[0, 1201], [1201, 2401]]);
});

// As 0.5.0 wrote a pages file: rows of 3,000 characters of text.
const earlierRows = text => { const rows = []; for (let start = 0; start < text.length; start += 3000) rows.push(JSON.stringify({ start, end: Math.min(text.length, start + 3000), text: text.slice(start, start + 3000) })); return rows.join('\n') + '\n'; };
const rowsOf = async reference => (await readFile(reference.pages, 'utf8')).trimEnd().split('\n');

test('a value is made ready when it is handed out: pages that do not give it whole through the host\'s read are written again, whoever wrote them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createCommentData({ root: directory });
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} of a tool output that a review saved`).join('\n');
  const whole = async (reference, value) => { const rows = await rowsOf(reference); assert.ok(rows.every(row => row.length <= ROW_CHARACTERS)); assert.equal(rows.map(row => JSON.parse(row).text).join(''), value); };
  // As 0.5.0 wrote them: rows the host's read cuts.
  const reference = await first.put(text);
  await writeFile(reference.pages, earlierRows(text));
  assert.ok((await rowsOf(reference)).some(row => row.length > HOST_READ_LINE_CHARACTERS), 'The earlier rows are longer than the host returns.');
  // One row of exactly the length the host's read returns, and one a character longer: only the second is cut.
  let length = 1900;
  const oneRow = size => JSON.stringify({ start: 0, end: size, text: 'y'.repeat(size) });
  while (oneRow(length).length < HOST_READ_LINE_CHARACTERS) length++;
  assert.deepEqual([oneRow(length).length, oneRow(length + 1).length], [HOST_READ_LINE_CHARACTERS, HOST_READ_LINE_CHARACTERS + 1]);
  const fits = await first.put('y'.repeat(length)), over = await first.put('y'.repeat(length + 1));
  await writeFile(fits.pages, `${oneRow(length)}\n`);
  await writeFile(over.pages, `${oneRow(length + 1)}\n`);
  // Pages that are not there, that are empty, that stop in a row, that stop after a row, and that hold something
  // else: what a writer that was cut off leaves, or anything that is not the value.
  const values = Object.fromEntries(['missing', 'empty', 'cut in a row', 'cut after a row', 'another text', 'no rows'].map(name => [name, `${name}: ${'v'.repeat(4000)}`]));
  const stored = {};
  for (const [name, value] of Object.entries(values)) stored[name] = await first.put(value);
  const written = async name => readFile(stored[name].pages, 'utf8');
  await rm(stored.missing.pages);
  await writeFile(stored.empty.pages, '');
  await writeFile(stored['cut in a row'].pages, (await written('cut in a row')).slice(0, 2500));
  await writeFile(stored['cut after a row'].pages, `${(await rowsOf(stored['cut after a row']))[0]}\n`);
  await writeFile(stored['another text'].pages, (await written('another text')).replace('another text', 'another TEXT'));
  await writeFile(stored['no rows'].pages, 'left by something else\n');
  // Opening the store looks at nothing and changes nothing: a value is made ready when it is handed out.
  const reopened = await createCommentData({ directory: first.directory });
  assert.ok((await rowsOf(reference)).some(row => row.length > HOST_READ_LINE_CHARACTERS));
  await assert.rejects(readFile(stored.missing.pages), { code: 'ENOENT' });
  // A reference that a review saved, asked for: the store holds it once its pages are whole.
  assert.equal(await reopened.holds(reference), true);
  await whole(reference, text);
  assert.equal(await reopened.read(reference), text, 'The reference a saved review holds still names the object.');
  assert.equal(await reopened.holds(fits), true);
  assert.equal(await readFile(fits.pages, 'utf8'), `${oneRow(length)}\n`, 'Rows of another length than this version writes stay where the host returns them whole.');
  assert.equal(await reopened.holds(over), true);
  await whole(over, 'y'.repeat(length + 1));
  for (const [name, value] of Object.entries(values)) { assert.equal(await reopened.read(stored[name]), value, name); await whole(stored[name], value); }
  // Nothing says of a value at an earlier time that it is ready: an earlier version that still runs, or that is
  // installed again for a while, writes pages of its own, and the next time the value is handed out sees them.
  await writeFile(over.pages, earlierRows('y'.repeat(length + 1)));
  assert.equal(await reopened.holds(over), true);
  await whole(over, 'y'.repeat(length + 1));
  assert.deepEqual((await readdir(first.directory)).sort(), ['.gitignore', 'objects'], 'The store holds no mark of its own.');
  // The same when a value is put that another writer has written: an earlier version with its rows, a writer cut
  // off in the object or in the pages, an object that is something else. The text in hand is the value, and the
  // reference that is handed out names files that are right.
  const late = (name, object, pages) => ({ value: `${name} ${'q'.repeat(7000)}`, object, pages });
  for (const [name, { value, object, pages }] of Object.entries({
    'an earlier version': late('an earlier version', v => v, earlierRows),
    'cut off in the object': late('cut off in the object', v => v.slice(0, 3000), null),
    'cut off in the pages': late('cut off in the pages', v => v, v => earlierRows(v).slice(0, 1000)),
    'an object that is something else': late('an object that is something else', () => 'not the value', v => `${JSON.stringify({ start: 0, end: 5, text: 'other' })}\n`),
  })) {
    const file = join(first.directory, 'objects', `${createHash('sha256').update(value).digest('hex')}.txt`);
    await writeFile(file, object(value));
    if (pages) await writeFile(`${file}.pages.jsonl`, pages(value));
    const again = await reopened.put(value);
    assert.equal(again.file, file, name);
    // The files as the put left them, before anything is read through the store, which would make them right.
    assert.equal(await readFile(again.file, 'utf8'), value, name);
    await whole(again, value);
    assert.equal(await reopened.read(again), value, name);
  }
  // Pages that cannot be read are no pages: with a sound object they are replaced, when the value is handed out
  // and when it is put. (An administrator reads every file, so there is nothing to see as one.)
  const locked = `locked ${'k'.repeat(5000)}`, lock = await reopened.put(locked);
  if (process.getuid?.() !== 0) {
    for (const hand of [() => reopened.holds(lock), () => reopened.put(locked)]) {
      await chmod(lock.pages, 0o000);
      await assert.rejects(readFile(lock.pages, 'utf8'), { code: 'EACCES' });
      assert.ok(await hand());
      await whole(lock, locked);
      assert.equal((await stat(lock.pages)).mode & 0o777, 0o600);
    }
  }
  // A row that says its text twice parses to the value and reads otherwise: such pages are written again.
  const doubled = (await rowsOf(lock)).map(row => row.replace('"text":', '"text":"something else","text":')).join('\n') + '\n';
  await writeFile(lock.pages, doubled);
  assert.equal(await reopened.holds(lock), true);
  assert.notEqual(await readFile(lock.pages, 'utf8'), doubled);
  await whole(lock, locked);
  // Nor does a put say anything of a later one: a value this very store put before is looked at again when it is
  // put again, since its files may have been damaged since.
  const twice = `put twice ${'t'.repeat(6000)}`, once = await reopened.put(twice);
  await writeFile(once.file, twice.slice(0, 100));
  await writeFile(once.pages, earlierRows(twice));
  assert.deepEqual(await reopened.put(twice), once);
  assert.equal(await readFile(once.file, 'utf8'), twice);
  await whole(once, twice);
  // Two puts of one value at once are one, and each gets the reference.
  const both = await Promise.all([reopened.put(`${twice}!`), reopened.put(`${twice}!`)]);
  assert.deepEqual(both[0], both[1]);
  await whole(both[0], `${twice}!`);
  assert.deepEqual((await readdir(join(first.directory, 'objects'))).filter(name => name.endsWith('.tmp')), [], 'No working file is left.');
});

test('an object is what its name says by its bytes; one that is damaged or gone is written again from complete pages, and a value that cannot be made ready is not handed out', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createCommentData({ root: directory });
  const sound = await first.put('x'.repeat(5000)), damaged = await first.put('z'.repeat(9000));
  const fresh = await readFile(damaged.pages, 'utf8');
  const store = await createCommentData({ directory: first.directory });
  const whole = async (reference, value) => {
    assert.deepEqual([await store.holds(reference), await store.read(reference), await readFile(reference.file, 'utf8')], [true, value, value]);
    assert.ok((await rowsOf(reference)).every(row => row.length <= ROW_CHARACTERS));
    assert.equal((await rowsOf(reference)).map(row => JSON.parse(row).text).join(''), value);
  };
  const unready = async (reference, name) => {
    assert.equal(await store.holds(reference), false, name);
    await assert.rejects(store.read(reference), /Private comment data changed; no plan was accepted\./, name);
  };
  // An object that lost its end and has no pages: a write that was cut off, or another process that still writes.
  // Nothing is derived from it and the store does not hold its reference; the other values are not held back
  // for it; and putting its value writes it again.
  await writeFile(damaged.file, 'z'.repeat(4000));
  await rm(damaged.pages);
  await unready(damaged, 'cut off, without pages');
  await assert.rejects(readFile(damaged.pages), { code: 'ENOENT' });
  await whole(sound, 'x'.repeat(5000));
  assert.deepEqual(await store.put('z'.repeat(9000)), damaged);
  await whole(damaged, 'z'.repeat(9000));
  assert.equal(await readFile(damaged.pages, 'utf8'), fresh);
  // The object damaged or gone, its pages complete: they hold the value, of whatever length their rows are and
  // also where only the last line end is missing, and the object is written again from them.
  for (const [name, pages] of [['rows of this version', fresh], ['rows of an earlier version', earlierRows('z'.repeat(9000))], ['without the last line end', fresh.slice(0, -1)]]) {
    for (const object of ['z'.repeat(4000), null]) {
      if (object === null) await rm(damaged.file); else await writeFile(damaged.file, object);
      await writeFile(damaged.pages, pages);
      await whole(damaged, 'z'.repeat(9000));
    }
  }
  // An object is what its name says by its bytes: a write that was cut off inside its last character decodes to
  // the same text, and is not the object.
  const ending = await store.put(`${'e'.repeat(3000)}�`);
  const bytes = await readFile(ending.file);
  await writeFile(ending.file, bytes.subarray(0, bytes.length - 1));
  assert.equal(await readFile(ending.file, 'utf8'), `${'e'.repeat(3000)}�`, 'Decoded, the cut object reads like the whole one.');
  assert.equal(await store.holds(ending), true);
  assert.deepEqual(await readFile(ending.file), bytes, 'It was told apart by its bytes, and written again from its pages.');
  // Object and pages both cut: the value cannot be made ready, with rows of this version or of an earlier one.
  // It is not handed out, nothing of it is changed, and the store goes on with its other values.
  for (const pages of [fresh.slice(0, 3000), earlierRows('z'.repeat(9000)).slice(0, 7000)]) {
    await writeFile(damaged.file, 'z'.repeat(4000));
    await writeFile(damaged.pages, pages);
    await unready(damaged, 'both cut');
    assert.equal(await readFile(damaged.pages, 'utf8'), pages, 'What is there is left.');
    await whole(sound, 'x'.repeat(5000));
  }
  // The pages of a sound object cannot be read or replaced (a directory stands where they belong): not handed
  // out either. Once the obstacle is gone, the value is ready again: another look finds it so.
  await writeFile(damaged.file, 'z'.repeat(9000));
  await rm(damaged.pages);
  await mkdir(damaged.pages);
  await writeFile(join(damaged.pages, 'in the way'), '');
  await unready(damaged, 'pages that cannot be written');
  await rm(damaged.pages, { recursive: true });
  await whole(damaged, 'z'.repeat(9000));
  assert.deepEqual((await readdir(join(first.directory, 'objects'))).filter(name => name.endsWith('.tmp')), [], 'No working file is left.');
  // Only a reference to this store's own values is looked at: another store's, a path of someone's choosing and
  // a name that is no digest are not.
  const elsewhere = await (await createCommentData({ root: directory })).put('x'.repeat(5000));
  for (const reference of [elsewhere, { ...sound, file: join(directory, 'somewhere', 'else.txt') }, { ...sound, sha256: '../x', file: join(first.directory, 'objects', '../x.txt') }, { ...sound, pages: join(directory, 'other.jsonl') }, null]) {
    assert.equal(await store.holds(reference), false);
    await assert.rejects(store.read(reference), /Unknown private comment data reference\./);
  }
});

test('a value is stored as the text a file can hold, and only a reference the store holds ready is listed for a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-comment-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createCommentData({ root: directory });
  // A lone surrogate cannot be written as UTF-8: the object would hold U+FFFD in its place and the pages the
  // surrogate itself. The value is the text the object holds, in both.
  const given = `tool output with half a pair \uD83D and more ${'m'.repeat(2500)}`, kept = given.replace('\uD83D', '�');
  const reference = await store.put(given);
  // The files as the put left them, before anything is read through the store, which would make the pages right.
  assert.deepEqual([(await rowsOf(reference)).map(row => JSON.parse(row).text).join(''), await readFile(reference.file, 'utf8'), await store.read(reference), reference.characters],
    [kept, kept, kept, kept.length]);
  assert.deepEqual(await store.put(kept), reference, 'Both texts are one value.');
  const pages = await readFile(reference.pages, 'utf8');
  const reopened = await createCommentData({ directory: store.directory });
  assert.equal(await reopened.holds(reference), true);
  assert.equal(await readFile(reference.pages, 'utf8'), pages, 'Handed out again, the value is ready as it is.');
  // What the planner is listed as evidence it may read: observations whose saved references the store holds
  // ready when the list is made. One whose object and pages were cut since, one whose files are gone and one of
  // another store are left out; one whose object is gone and whose pages are complete is written again and listed.
  const output = index => `observed text ${index} ${'o'.repeat(3000)}`;
  const observations = await Promise.all([0, 1, 2, 3].map(index => captureObservation(reopened, 'azpr_read_file', { path: `/src/file-${index}.ts`, version: 'head' }, output(index))));
  const elsewhere = await captureObservation(await createCommentData({ root: directory }), 'azpr_read_file', { path: '/src/elsewhere.ts', version: 'head' }, output(9));
  await writeFile(observations[1].outputRef.file, 'cut');
  await writeFile(observations[1].outputRef.pages, (await readFile(observations[1].outputRef.pages, 'utf8')).slice(0, 900));
  await rm(observations[2].outputRef.file);
  await rm(observations[2].outputRef.pages);
  await rm(observations[3].outputRef.file);
  // The same store, still open: what was ready when its value was put is looked at again when it is handed out.
  const listed = async () => (await reopened.read(await observationIndex(reopened, [...observations, elsewhere]))).trim().split('\n').map(row => JSON.parse(row)).map(row => row.arguments.path);
  assert.deepEqual(await listed(), ['/src/file-0.ts', '/src/file-3.ts']);
  assert.equal(await readFile(observations[3].outputRef.file, 'utf8'), output(3));
  // And one that another writer has made right since is listed the next time.
  await writeFile(observations[1].outputRef.file, output(1));
  assert.deepEqual(await listed(), ['/src/file-0.ts', '/src/file-1.ts', '/src/file-3.ts']);
  assert.equal(observations[0].key, observationKey('azpr_read_file', { path: '/src/file-0.ts', version: 'head' }, output(0)), 'An observation is known by its key before it is saved.');
  // A list is handed out a few values at a time, each value once however many items name it, and in its order:
  // a large review has thousands of observations, and each is read whole to be made ready.
  const many = await Promise.all(Array.from({ length: 30 }, (_, index) => reopened.put(`value ${index % 20} ${'n'.repeat(300)}`)));
  await rm(many[7].file);
  await rm(many[7].pages);
  let running = 0, most = 0;
  const asked = [];
  const counting = { ...reopened, async holds(reference) { asked.push(reference.sha256); most = Math.max(most, ++running); try { return await reopened.holds(reference); } finally { running--; } } };
  const items = many.map((reference, index) => ({ index, reference }));
  const handed = await heldItems(counting, items, item => [item.reference]);
  assert.deepEqual(handed.map(item => item.index), items.filter(item => item.index % 20 !== 7).map(item => item.index), 'In their order, without the ones whose value is gone.');
  assert.deepEqual([asked.length, new Set(asked).size, most <= 8, most > 1], [20, 20, true, true], 'Each of the 20 values was looked at once, at most eight at a time.');
  assert.deepEqual(await heldItems(counting, [], () => []), []);
  // What a planning page's earlier sessions read, for its continuation: an entry is listed only where the store
  // holds its saved result ready, and its saved input where that was too large to stay inline.
  const large = { path: '/src/large.ts', note: 'l'.repeat(13000) };
  const entry = async (tool, input, result) => ({ sessionID: 'ses_plan', page: 1, tool, input: await reopened.pack(input), result: await reopened.object({ output: result }) });
  const evidence = [await entry('read', { path: 'a' }, 'kept'), await entry('read', { path: 'b' }, 'its result is cut'), await entry('azpr_read_file', large, 'its input is gone'),
    await entry('read', { path: 'd' }, 'its pages are gone'), await entry('azpr_read_file', { ...large, path: '/src/other.ts' }, 'kept too')];
  assert.ok(evidence[2].input.azprData && !evidence[0].input.azprData, 'A large input is a reference; a small one stays as it is.');
  await writeFile(evidence[1].result.file, 'cut');
  await writeFile(evidence[1].result.pages, 'cut');
  await rm(evidence[2].input.azprData.file);
  await rm(evidence[2].input.azprData.pages);
  await rm(evidence[3].result.pages);
  const index = await evidenceIndex(reopened, evidence);
  const rows = (await reopened.read(index)).trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(rows, [evidence[0], evidence[3], evidence[4]]);
  assert.ok((await readFile(evidence[3].result.pages, 'utf8')).length > 0, 'Pages that were gone are written again from the object.');
});
