import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePlanPage, assemblePlan, inlineMarker, summaryMarker, normalizeTitle, restoreAnchor, confirmedFindings, publicationItems,
  publishableFindings, reviewMethod, reviewVerification, combinationProblems, repeatProblems, placeOf, evaluateGrouping, groupingRepairPrompt,
  automaticPublicationProblems, automaticPublicationRepeats,
  INLINE_SOFT_LIMIT, INLINE_HARD_LIMIT, commentFindings, adjustmentInput, describeAdjustments, hasAdjustments, resolveAdjustments,
  everyFindingExcluded, publicationStarted, describeEarlierText, excludedReferences, previewNextSteps, previewActions, commentToken, sharedMarker, linesMarker,
} from '../src/comments.mjs';
import { commentAttribution } from '../src/attribution.mjs';
import { parsePullRequestUrl } from '../src/azure.mjs';

const target = parsePullRequestUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/7');
const head = 'b'.repeat(40);
const finding = (id, severity = 'high', extra = {}) => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/a.ts:2', severity, suggestion: 's', ...extra });
const body = id => { const { id: _id, ...rest } = finding(id); return rest; };

// Comments are planned for three kinds of saved review (`reviewMethod`), and the fixtures below are one of each.
// What the kinds share is tested once per kind (`eachKind`); the finding IDs are a test's own, since nothing here
// depends on their letters (a review of 0.4.x has F-, R-, V- and Q- IDs, a review of this pipeline F- only).

// A verified review as 0.4.x saved it: the findings its verifier confirmed are CONFIRMED rows with `verifiedFinding`.
// The record says `verification: 'independent'` (0.4.6; older ones have no such field) and names no method.
const review = (findings = [finding('F-1')], toolText = []) => ({
  id: 'abcdef12', target, outputLanguage: 'en', attribution: 'AI-generated review; Models: `x/y`', profile: 'review', verification: 'independent',
  snapshot: { head, base: 'a'.repeat(40), files: ['/src/a.ts', '/src/b.ts'] },
  final: { dispositions: findings.map(f => ({ id: f.id, status: 'CONFIRMED', reason: 'ok', verifiedFinding: f })), newFindings: [] },
  toolText,
});
// A quick review as 0.4.x saved it: REPORTED rows that say which session reported them (`shard`), and no method.
const quickReview = (dispositions, toolText = []) => ({ ...review([]), profile: 'quick', verification: 'none', toolText,
  attribution: 'AI-generated review; not human review or approval. Review method: quick review, not independently verified. Models: `x/y`',
  final: { dispositions, newFindings: [], coverageSummary: { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [] } } });
// A review of this pipeline: each finding that passed the runtime's checks is a REPORTED row with the level in effect,
// its reviewer's own level and the sessions that reported it. The record says `verification: 'none'` and its method.
const METHOD = Object.freeze({ kind: 'reviewers', version: 1, requested: ['x/y', 'x/y'], passes: [{ pass: 1, model: 'x/y', sessions: 1, failed: 0 }, { pass: 2, model: 'x/y', sessions: 1, failed: 0 }],
  duplicateCheck: { groups: 0, failed: 0, merged: 0, refused: 0 }, rating: { state: 'first', model: 'x/y', sessions: 1, failed: 0, rated: 0, kept: 0 } });
const row = ({ id, ...own }, extra = {}) => ({ id, status: 'REPORTED', reason: 'r', finding: own, inline: true, reviewerSeverity: own.severity, shard: '1/1 pass 1', pass: 1, localId: id, sessions: ['1/1 pass 1'], ...extra });
const reviewersRows = (dispositions, toolText = []) => ({ ...review([]), verification: 'none', method: METHOD, toolText,
  attribution: 'AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification. Models: `x/y`',
  final: { dispositions, newFindings: [], verification: 'none', method: METHOD,
    coverageSummary: { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [], files: 2, passes: 2, reviewedOnce: 2, reviewedByAll: 2, failedSessions: 0 } } });

// What a reviewer session read of /src/a.ts at HEAD. A finding whose reviewer alone checked it gets an inline comment
// only on a quote found in such text, so the two kinds without a verifier have this read on record by default.
const observed = [{ input: { path: '/src/a.ts', version: head }, output: 'line one\nconst value = load();\nline three\nline four\nline five\nline six\n' }];
// `make(findings, toolText)` builds a review of one kind whose findings can all be published.
const KINDS = {
  verified: review,
  reviewers: (findings = [finding('F-1')], toolText = observed) => reviewersRows(findings.map(f => row(f)), toolText),
  quick: (findings = [finding('F-1')], toolText = observed) => quickReview(findings.map(({ id, ...own }) => ({ id, status: 'REPORTED', reason: 'r', finding: own, inline: true, shard: '1/1' })), toolText),
};
/**
 * One test per kind of review, for what the kinds share: `run(t, { kind, make, none })`, where `none` says that no
 * stage verified the findings (every kind but the verified one). By default the verified kind of 0.4.x and this
 * pipeline's; a quick review of 0.4.x takes the same paths as the latter and is named where a test is about it.
 */
const eachKind = (name, run, kinds = ['verified', 'reviewers']) => {
  for (const kind of kinds) test(`${name} [${kind}]`, t => run(t, { kind, make: KINDS[kind], none: kind !== 'verified' }));
};
const comment = (extra = {}) => ({ findingId: 'F-1', severity: 'high', path: '/src/a.ts', startLine: 2, endLine: 2, anchor: 'const value = load();', body: '🔴 high: Value is lost\n\nBody.', ...extra });
const answer = (comments, skipped = [], extra = {}) => JSON.stringify({ status: 'READY', comments, skipped, ...extra });

test('titles are normalized to the verified severity label without double prefixes', () => {
  assert.equal(normalizeTitle('🔴 High: Title', 'high'), '🔴 high: Title');
  assert.equal(normalizeTitle('**🟡 medium: Title**', 'medium'), '🟡 medium: **Title**');
  assert.equal(normalizeTitle('issue (high): Title', 'high'), '🔴 high: Title');
  assert.equal(normalizeTitle('Plain title', 'medium'), '🟡 medium: Plain title');
});

eachKind('a clean page is accepted; formatting slips are corrected instead of failing the page', (t, { make }) => {
  const r = make([finding('F-1'), finding('F-2', 'medium')]);
  const { result, issues, corrections } = evaluatePlanPage(answer([
    comment({ severity: 'HIGH', path: 'src/a.ts', body: 'High: lost value <!-- hidden -->' }),
    comment({ findingId: 'F-2', severity: 'high', startLine: 5, endLine: 9, anchor: 'line five\nline six', body: 'Medium thing' }),
  ]), { review: r, assigned: publishableFindings(r) });
  assert.deepEqual(issues, []);
  assert.equal(result.comments[0].path, '/src/a.ts');
  assert.equal(result.comments[0].body, '🔴 high: lost value &lt;!-- hidden --&gt;');
  assert.equal(result.comments[1].severity, 'medium', 'The severity of the review\'s finding wins.');
  assert.equal(result.comments[1].endLine, 6, 'The end line follows the quoted anchor.');
  assert.ok(corrections.some(c => c.action === 'use-verified-severity'));
  assert.ok(corrections.some(c => c.action === 'derive-end-line-from-anchor'));
});

eachKind('real problems become repair issues first, then per-item skips on the final pass', (t, { make }) => {
  const r = make([finding('F-1'), finding('F-2'), finding('F-3')]);
  const assigned = publishableFindings(r);
  const text = answer([
    comment({ body: '🔴 high: ' + 'x'.repeat(INLINE_SOFT_LIMIT + 10) }),
    comment({ findingId: 'F-2', path: '/not/changed.ts' }),
  ]);
  const first = evaluatePlanPage(text, { review: r, assigned });
  assert.ok(first.issues.some(issue => /F-1: body is \d+ characters/.test(issue)));
  assert.ok(first.issues.some(issue => /F-2: path .* is not a changed file/.test(issue)));
  assert.ok(first.issues.some(issue => /missing: F-1, F-2, F-3/.test(issue)) || first.issues.some(issue => /missing:.*F-3/.test(issue)));
  const final = evaluatePlanPage(text, { review: r, assigned, final: true });
  assert.deepEqual(final.issues, []);
  assert.deepEqual(final.result.comments.map(c => c.findingId), ['F-1'], 'A long body under the hard limit is kept on the final pass.');
  assert.deepEqual(final.result.skipped.map(s => s.findingId).sort(), ['F-2', 'F-3']);
  assert.match(final.result.skipped.find(s => s.findingId === 'F-2').reason, /not a changed file/);
  const huge = evaluatePlanPage(answer([comment({ body: 'x'.repeat(INLINE_HARD_LIMIT + 1) })]), { review: make(), assigned: [finding('F-1')], final: true });
  assert.equal(huge.result.comments.length, 0);
  assert.match(huge.result.skipped[0].reason, /exceeds/);
});

eachKind('low-severity and unknown findings never become inline comments', (t, { make }) => {
  const r = make([finding('F-1', 'low')]);
  const { result, issues, corrections } = evaluatePlanPage(answer([comment(), comment({ findingId: 'R-9' })]), { review: r, assigned: [finding('F-1', 'low')] });
  assert.deepEqual(issues, []);
  assert.equal(result.comments.length, 0);
  assert.match(result.skipped[0].reason, /Low-severity/);
  assert.ok(corrections.some(c => c.action === 'drop-unassigned-comment'));
});

eachKind('a skip that relies on another finding of this review gets a correction turn', (t, { make, kind }) => {
  // As in a live PR #3 plan: R-12001 skipped because F-1009's comment on an earlier page "covered" it.
  const r = make([finding('F-1009'), finding('R-12001', 'medium'), finding('F-1'), finding('F-10')]);
  const assigned = [finding('R-12001', 'medium'), finding('F-10')];
  const text = answer([], [{ findingId: 'R-12001', cause: 'existing-thread', reason: '已由先前頁面的F-1009 inline 留言覆蓋相同根因。' }, { findingId: 'F-10', cause: 'existing-thread', threadId: 42, reason: 'Already discussed in thread 42; F-10 is UTF-8 safe there (TF401174).' }]);
  const first = evaluatePlanPage(text, { review: r, assigned });
  assert.equal(first.issues.length, 1, 'Only the skip that names another finding is sent back; F-10 may name itself and is not read as F-1.');
  // Either way another finding's comment covers nothing. A review whose duplicates were merged before planning
  // (by this pipeline's duplicate check, or by the verifier of 0.4.x) is told so; a quick review of 0.4.x, which
  // merged none, that findings share a comment only through a group the runtime lists.
  const ways = 'or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).';
  assert.equal(first.issues[0], kind === 'quick'
    ? `skip for R-12001 relies on F-1009: another finding's comment does not cover it. Comment on R-12001 at the lines of its own claim, combine it with findingIds only when a listed mergeCandidates or repeatCandidates group holds both and they state one defect, ${ways}`
    : `skip for R-12001 relies on F-1009: findings of this review are separate issues (duplicates were merged before planning), so another finding's comment does not cover it. Comment on R-12001 at the lines of its own claim, give one comment findingIds with both only when a listed repeatCandidates group holds them and they are one defect made at several places, ${ways}`);
  assert.deepEqual(first.result.skipped.map(s => s.findingId), ['F-10']);
  const final = evaluatePlanPage(text, { review: r, assigned, final: true });
  assert.deepEqual(final.issues, []);
  assert.deepEqual(final.result.skipped.map(s => s.findingId), ['R-12001', 'F-10']);
  assert.match(final.result.skipped[0].reason, /\[Runtime: other findings of this review do not cover this one; it remains in the summary index\.\]$/);
  assert.ok(final.corrections.some(c => c.action === 'keep-skip-citing-other-finding' && c.cited.join() === 'F-1009'));
}, ['verified', 'reviewers', 'quick']);

eachKind('a skip names its cause, and the runtime checks the facts the cause states', (t, { make }) => {
  // As in a live PR #3 plan: F-1 skipped for "no source passage" while the page showed its whole file.
  const r = make([finding('F-1', 'medium', { location: 'head:/src/a.ts:18' }), finding('F-2', 'low'), finding('F-3'), finding('F-4'), finding('F-5', 'high', { location: 'head:/src/b.ts:2' })]);
  const assigned = publishableFindings(r);
  const sources = [{ path: '/src/a.ts', version: head, findingIds: ['F-1', 'F-3', 'F-4'], firstLine: 1, lastLine: 18, totalLines: 18, text: '1 | ...' }];
  const discussions = [{ threadId: 42, path: '/src/a.ts', line: 2 }];
  const text = answer([], [
    { findingId: 'F-1', cause: 'cannot-anchor', reason: 'This page has no source passage for F-1.' },
    { findingId: 'F-2', cause: 'low-severity', reason: 'Low severity.' },
    { findingId: 'F-3', cause: 'existing-thread', threadId: 41, reason: 'Thread 41 covers it.' },
    { findingId: 'F-4', reason: 'Not worth a comment.' },
    { findingId: 'F-5', cause: 'cannot-anchor', reason: 'No excerpt shows /src/b.ts.' },
  ]);
  const first = evaluatePlanPage(text, { review: r, assigned, sources, discussions });
  assert.deepEqual(first.issues.map(issue => issue.split(':')[0]), ['skip for F-1', 'skip for F-3', 'skip for F-4']);
  assert.equal(first.issues[0], 'skip for F-1: its lines /src/a.ts:18 are in sourceExcerpts (lines 1-18); quote them as the anchor. Comment on it, or skip it with the cause that applies.');
  assert.match(first.issues[1], /thread 41 is not a live thread of this PR; give the "threadId" of the existingDiscussions thread that covers it/);
  assert.match(first.issues[2], /a skip needs "cause": one of low-severity, no-inline-location, existing-thread, cannot-anchor, too-long/);
  assert.deepEqual(first.result.skipped, [{ findingId: 'F-2', reason: 'Low severity.', cause: 'low-severity' }, { findingId: 'F-5', reason: 'No excerpt shows /src/b.ts.', cause: 'cannot-anchor' }]);
  // A cause whose fact does not hold: a medium finding called low, an inline location called missing.
  const wrong = evaluatePlanPage(answer([], [{ findingId: 'F-1', cause: 'low-severity', reason: 'Minor.' }, { findingId: 'F-3', cause: 'no-inline-location', reason: 'No location.' }]), { review: r, assigned: [assigned[0], assigned[2]], sources, discussions });
  assert.match(wrong.issues[0], /skip for F-1: F-1 is medium, not low/);
  assert.match(wrong.issues[1], /skip for F-3: F-3 is located on lines of a changed HEAD file that sourceExcerpts shows/);
  // A live thread is accepted with its ID; without read threads the ID is not checked; too-long is the planner's call.
  const accepted = evaluatePlanPage(answer([], [{ findingId: 'F-3', cause: 'existing-thread', threadId: '42', reason: 'Thread 42.' }, { findingId: 'F-4', cause: 'too-long', reason: 'Needs three triggers.' }]), { review: r, assigned: [assigned[2], assigned[3]], sources, discussions });
  assert.deepEqual([accepted.issues, accepted.result.skipped], [[], [{ findingId: 'F-3', reason: 'Thread 42.', cause: 'existing-thread', threadId: 42 }, { findingId: 'F-4', reason: 'Needs three triggers.', cause: 'too-long' }]]);
  assert.deepEqual(evaluatePlanPage(answer([], [{ findingId: 'F-3', cause: 'existing-thread', threadId: 7, reason: 'Thread 7.' }]), { review: r, assigned: [assigned[2]], sources }).issues, []);
  // The final pass keeps every skip and says what the runtime found.
  const final = evaluatePlanPage(text, { review: r, assigned, sources, discussions, final: true });
  assert.deepEqual(final.issues, []);
  assert.deepEqual(final.result.skipped.map(s => s.findingId), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5']);
  assert.match(final.result.skipped[0].reason, /^This page has no source passage for F-1\. \[Runtime: its lines \/src\/a\.ts:18 are in sourceExcerpts \(lines 1-18\); quote them as the anchor; it remains in the summary index\.\]$/);
  assert.equal(final.result.skipped[3].cause, undefined, 'A skip without a valid cause keeps no cause.');
  assert.deepEqual(final.corrections.filter(c => c.action === 'keep-skip-with-unconfirmed-cause').map(c => c.findingId), ['F-1', 'F-3', 'F-4']);
});

test('confirmed findings for planning and the summary carry the final location only', () => {
  const r = review([finding('F-1', 'high', { location: 'head:/src/a.ts:18', movedFrom: 'head:/tests/a.test.ts:3' })]);
  assert.deepEqual(confirmedFindings(r).map(f => [f.location, Object.hasOwn(f, 'movedFrom')]), [['head:/src/a.ts:18', false]]);
});

eachKind('CONTINUE checkpoints, INCOMPLETE pages and unparseable answers degrade safely', (t, { make }) => {
  const r = make([finding('F-1'), finding('F-2')]);
  const assigned = publishableFindings(r);
  const checkpoint = evaluatePlanPage(JSON.stringify({ status: 'CONTINUE', comments: [comment()], skipped: [], reason: 'Read page 3 of discussions next.' }), { review: r, assigned });
  assert.equal(checkpoint.result.status, 'CONTINUE');
  assert.equal(checkpoint.result.continuation, 'Read page 3 of discussions next.');
  assert.deepEqual(checkpoint.issues, []);
  const incomplete = evaluatePlanPage(JSON.stringify({ status: 'INCOMPLETE', comments: [comment()], skipped: [], reason: 'Discussions unavailable.' }), { review: r, assigned });
  assert.equal(incomplete.result.status, 'READY');
  assert.deepEqual(incomplete.result.skipped.map(s => s.findingId), ['F-2']);
  assert.match(incomplete.result.skipped[0].reason, /Discussions unavailable/);
  const broken = evaluatePlanPage('not json', { review: r, assigned });
  assert.equal(broken.result, null);
  assert.match(broken.issues[0], /could not be used/);
  const brokenFinal = evaluatePlanPage('not json', { review: r, assigned, final: true });
  assert.deepEqual(brokenFinal.result.skipped.map(s => s.findingId), ['F-1', 'F-2']);
});

test('anchors are restored from observed HEAD text; ambiguous quotes are reported', () => {
  const observed = [{ input: { path: '/src/a.ts', version: head }, output: 'first\nconst value = load();\nthird\n' }];
  const restored = restoreAnchor({ path: '/src/a.ts', startLine: 9, endLine: 9, anchor: '  const value = load();' }, { snapshot: { head }, toolText: observed });
  assert.deepEqual({ startLine: restored.startLine, anchor: restored.anchor, found: restored.found }, { startLine: 2, anchor: 'const value = load();', found: true });
  const ambiguous = restoreAnchor({ path: '/src/a.ts', startLine: 9, endLine: 9, anchor: 'x' }, { snapshot: { head }, toolText: [{ input: { path: 'src/a.ts', v: head }, output: 'x\nx\n' }] });
  assert.equal(ambiguous.ambiguous, true);
  // A quote that is in the source twice is sent back, whatever kind of review it is planned for.
  for (const [kind, make] of Object.entries(KINDS)) {
    const r = make([finding('F-1')], [{ input: { path: '/src/a.ts', version: head }, output: 'x\nx\n' }]);
    const page = evaluatePlanPage(answer([comment({ anchor: 'x', startLine: 9, endLine: 9 })]), { review: r, assigned: [finding('F-1')] });
    assert.ok(page.issues.some(issue => /appears several times/.test(issue)), kind);
  }
});

test('inline markers depend on PR, path and anchor only; summaries on head and inline markers', () => {
  const a = inlineMarker(target, { path: '/src/a.ts', anchor: 'const  value = load();' });
  assert.equal(a, inlineMarker(target, { path: '/src/a.ts', anchor: '   const value = load();  ' }), 'Whitespace changes keep the fingerprint.');
  assert.notEqual(a, inlineMarker(target, { path: '/src/b.ts', anchor: 'const value = load();' }));
  assert.notEqual(a, inlineMarker(target, { path: '/src/a.ts', anchor: 'const value = load();' }, 1));
  assert.notEqual(a, inlineMarker({ ...target, pullRequestId: 8 }, { path: '/src/a.ts', anchor: 'const value = load();' }));
  assert.match(a, /^<!-- azpr-comment:[a-f0-9]{32} -->$/);
  assert.equal(summaryMarker(target, head, [a]), summaryMarker(target, head, [a]));
  assert.notEqual(summaryMarker(target, head, [a]), summaryMarker(target, 'c'.repeat(40), [a]));
  assert.notEqual(summaryMarker(target, head, [a]), summaryMarker(target, head, []));
});

eachKind('assemblePlan builds exact saved content, offsets, ordinals and one summary', (t, { make }) => {
  const findings = [finding('F-1'), finding('F-2'), finding('F-3', 'low')];
  const pages = [
    { comments: [comment(), comment({ findingId: 'F-2', body: '🔴 high: Second issue on the same line' })], skipped: [{ findingId: 'F-3', reason: 'Low severity.' }], summary: 'Purpose of the change.', summaryDetails: '### 💡 Improvement suggestions\n\n- Idea.' },
  ];
  const r = make(findings);
  const plan = assemblePlan(r, pages);
  assert.equal(plan.comments.length, 2);
  assert.notEqual(plan.comments[0].marker, plan.comments[1].marker, 'Two comments on identical lines get distinct ordinals.');
  for (const item of plan.comments) {
    assert.ok(item.content.endsWith(item.marker));
    assert.match(item.content, /AI-generated review/);
    assert.equal(item.content, `${item.body}\n\n---\n${r.attribution}\n\n${item.marker}`, 'The planner\'s text, the review\'s own disclosure line and the marker.');
    assert.equal(item.startOffset, 1);
    assert.equal(item.endOffset, 'const value = load();'.length);
  }
  assert.equal(plan.summary.kind, 'summary');
  assert.match(plan.summary.content, /^🤖 AI-generated review/);
  assert.match(plan.summary.content, /\*\*Review notes\*\*\n\nPurpose of the change\./);
  assert.match(plan.summary.content, /F-3/, 'Low findings stay in the index.');
  assert.match(plan.summary.content, /Improvement suggestions/);
  assert.deepEqual(publicationItems(plan).map(item => item.kind), ['summary', 'inline', 'inline']);
  assert.equal(publishableFindings(r).length, 3);
  // A marker is made of the PR, the file and the quoted lines, never of the review: a review of this pipeline
  // finds the comment a review of 0.4.x posted on unchanged code, and the summary of the same comments.
  const earlier = assemblePlan(review(findings), pages);
  assert.deepEqual(publicationItems(plan).map(item => item.marker), publicationItems(earlier).map(item => item.marker));
});

eachKind('a summary note from a page that may not write one is dropped, not repaired', (t, { make }) => {
  const r = make();
  const text = answer([comment()], [], { summary: 'Not this page.', summaryDetails: '### Details' });
  const page = evaluatePlanPage(text, { review: r, assigned: [finding('F-1')], allowSummary: false });
  assert.deepEqual(page.issues, []);
  assert.equal(page.result.summary, undefined);
  assert.equal(page.result.summaryDetails, '### Details', 'The page keeps its details.');
  assert.deepEqual(page.corrections.filter(c => /summary/.test(c.action)), [{ action: 'drop-unallowed-summary' }]);
  assert.equal(evaluatePlanPage(text, { review: r, assigned: [finding('F-1')], allowSummary: false, final: true }).result.summary, undefined);
  assert.equal(evaluatePlanPage(text, { review: r, assigned: [finding('F-1')] }).result.summary, 'Not this page.', 'A note is allowed unless the runtime says otherwise.');
});

test('publishable findings: confirmations for verified reviews, REPORTED for quick ones; unknown records are not trusted', () => {
  const verified = { ...review([finding('F-1')]), profile: 'review' };
  assert.equal(reviewVerification(verified), 'independent');
  assert.deepEqual(publishableFindings(verified).map(f => f.id), ['F-1']);
  assert.equal(reviewVerification({ profile: 'deep' }), 'independent');
  assert.equal(reviewVerification({ profile: 'quick' }), null, 'Only known review and deep records default to independent.');
  assert.equal(reviewVerification({ profile: 'mystery' }), null);
  assert.equal(reviewVerification({ profile: 'review', verification: 'bogus' }), null);
  const quick = quickReview([
    { id: 'Q-1', status: 'REPORTED', reason: 'r', finding: body('Q-1'), inline: true },
    { id: 'Q-2', status: 'REPORTED', reason: 'r', finding: body('Q-2'), inline: false },
    { id: 'Q-3', status: 'NEEDS_INFO', reason: 'r', partialFinding: body('Q-3') },
    { id: 'Q-4', status: 'MERGED', mergedInto: 'Q-1', reason: 'exact duplicate' },
  ]);
  assert.deepEqual(publishableFindings(quick).map(f => `${f.id}:${f.inline ?? 'inline'}`), ['Q-1:inline', 'Q-2:false']);
  assert.deepEqual(confirmedFindings(quick), [], 'Quick findings are never confirmations.');
});

test('a saved review says how its findings were produced: this pipeline, a verified or a quick review of 0.4.x, or nothing this version knows', () => {
  const method = { kind: 'reviewers', version: 1 };
  // This pipeline, whatever the mode: the record names its method and says that nothing verified its findings.
  for (const profile of ['review', 'deep', 'quick']) assert.equal(reviewMethod({ profile, verification: 'none', method }), 'reviewers', profile);
  // 0.4.x: a /pr-review or /pr-deep, whose verifier confirmed the findings (0.4.6 wrote "independent", records
  // older than that field nothing), and a /pr-quick, which wrote "none" and no method.
  for (const profile of ['review', 'deep']) for (const record of [{ profile }, { profile, verification: 'independent' }]) assert.equal(reviewMethod(record), 'verified', JSON.stringify(record));
  assert.equal(reviewMethod({ profile: 'quick', verification: 'none' }), 'quick');
  assert.deepEqual([reviewMethod(review()), reviewMethod(KINDS.reviewers()), reviewMethod(KINDS.quick())], ['verified', 'reviewers', 'quick'], 'The fixtures of this file.');
  // Any other record is of no known kind. It is not taken for the nearest one.
  const unknown = [
    // Signals that contradict each other: a method beside a verified review's word, or without the word a method goes with.
    { profile: 'review', verification: 'independent', method }, { profile: 'deep', method }, { profile: 'review', verification: 'bogus', method }, { profile: 'quick', verification: 'independent', method },
    // A method or a version of it that this version does not know, or no usable method at all.
    { profile: 'review', verification: 'none', method: { kind: 'verified', version: 1 } }, { profile: 'review', verification: 'none', method: { kind: 'panel', version: 1 } },
    { profile: 'review', verification: 'none', method: { kind: 'reviewers', version: 2 } }, { profile: 'review', verification: 'none', method: { kind: 'reviewers', version: '1' } },
    { profile: 'review', verification: 'none', method: { kind: 'reviewers' } }, { profile: 'review', verification: 'none', method: {} }, { profile: 'review', verification: 'none', method: null },
    { profile: 'review', verification: 'none', method: 'reviewers' }, { profile: 'review', verification: 'none', method: [method] },
    // A /pr-review or /pr-deep that says "none" without a method is neither verified nor a quick review of 0.4.x;
    // a /pr-quick that claims verification, or says nothing, never existed.
    { profile: 'review', verification: 'none' }, { profile: 'deep', verification: 'none' }, { profile: 'quick', verification: 'independent' }, { profile: 'quick' },
    // No profile, or one that is no review mode.
    { verification: 'none', method }, { verification: 'none' }, { verification: 'independent' }, {}, { profile: 'mystery', verification: 'none', method }, { profile: 'mystery' }, { profile: 'comment', verification: 'none' },
    // A word for the verification that no version wrote.
    { profile: 'review', verification: 'bogus' }, { profile: 'review', verification: null }, { profile: 'review', verification: false },
    undefined, null,
  ];
  for (const record of unknown) assert.deepEqual([reviewMethod(record), reviewVerification(record)], [null, null], JSON.stringify(record));
  // What a review's comments disclose follows its kind: only a verified review of 0.4.x was independently verified.
  assert.deepEqual([reviewVerification(review()), reviewVerification(KINDS.reviewers()), reviewVerification(KINDS.quick())], ['independent', 'none', 'none']);
  assert.deepEqual([reviewVerification({ profile: 'deep', verification: 'none', method }), reviewVerification({ profile: 'review' })], ['none', 'independent']);
});

test('what may become comments follows the kind of review: confirmations, or the REPORTED findings that were not merged; an unknown kind has none', () => {
  // A verified review of 0.4.x: what its verifier confirmed and what it added, never a rejected or a merged candidate.
  const verified = review([finding('F-1'), finding('R-1', 'medium')]);
  verified.final.dispositions.push({ id: 'F-2', status: 'REJECTED', reason: 'Not reachable.' }, { id: 'R-2', status: 'MERGED', mergedInto: 'F-1', reason: 'Same cause.' }, { id: 'F-3', status: 'UNREVIEWED', reason: 'No decision.' });
  verified.final.newFindings.push(finding('V-1', 'low'));
  assert.deepEqual(publishableFindings(verified).map(f => f.id), ['F-1', 'R-1', 'V-1']);
  assert.deepEqual(publishableFindings({ ...verified, verification: undefined }).map(f => f.id), ['F-1', 'R-1', 'V-1'], 'A record older than the field.');
  // A review of this pipeline: the REPORTED rows. A report that an identical record or the duplicate check merged
  // into another is no finding of its own, and a finding the runtime could not check is none.
  const rows = [
    row(finding('F-1'), { reviewerSeverity: 'medium', ratedSeverity: 'high', sessions: ['1/1 pass 1', '1/1 pass 2'], alsoReported: [{ id: 'F-2', sessions: ['1/1 pass 2'], severity: 'low' }] }),
    { id: 'F-2', status: 'MERGED', mergedInto: 'F-1', reason: 'One defect. [Runtime: merged by the duplicate check of independent reviewer sessions.]', mergedFinding: body('F-2'), reviewerSeverity: 'low', shard: '1/1 pass 2', pass: 2, localId: 'F-1', sessions: ['1/1 pass 2'] },
    row(finding('F-3', 'low'), { inline: false, shard: '1/1 pass 2', pass: 2, sessions: ['1/1 pass 2'] }),
    { id: 'F-4', status: 'NEEDS_INFO', reason: 'The location check failed. [Runtime: not eligible for comments.]', partialFinding: body('F-4'), shard: '1/1 pass 1', pass: 1, localId: 'F-3', sessions: ['1/1 pass 1'] },
    { id: 'F-5', status: 'MERGED', mergedInto: 'F-3', reason: 'Identical in every field to F-3. [Runtime: exact duplicate.]', mergedFinding: body('F-3'), shard: '1/1 pass 1', pass: 1, localId: 'F-4', sessions: ['1/1 pass 1'] },
  ];
  const current = reviewersRows(rows);
  // Each carries the finding's own fields with the level in effect, whether it can stand inline and its session;
  // nothing else of the record (the reviewer's level, the sessions that also reported it) reaches the planner.
  assert.deepEqual(publishableFindings(current), [{ ...body('F-1'), id: 'F-1', shard: '1/1 pass 1' }, { ...body('F-3'), severity: 'low', id: 'F-3', inline: false, shard: '1/1 pass 2' }]);
  assert.deepEqual(confirmedFindings(current), [], 'Nothing of it is a confirmation.');
  for (const profile of ['deep', 'quick']) assert.deepEqual(publishableFindings({ ...current, profile }).map(f => f.id), ['F-1', 'F-3'], profile);
  // A record whose kind is not known has nothing to publish, whatever rows it holds: it is never read as the kind its rows look like.
  for (const [name, record] of [
    ['a record of this pipeline without its method', { ...current, method: undefined }], ['one with an unknown method', { ...current, method: { kind: 'reviewers', version: 2 } }],
    ['one that claims verification', { ...current, verification: 'independent' }], ['one without a profile', { ...current, profile: undefined }],
    ['a verified record that names a method', { ...verified, method: METHOD }], ['a verified record that says "none"', { ...verified, verification: 'none' }],
    ['a verified record without a profile', { ...verified, profile: undefined }], ['a verified record as a quick review', { ...verified, profile: 'quick' }],
    ['a record without its findings', { id: 'abcdef12', profile: 'quick' }],
  ]) {
    assert.equal(reviewMethod(record), null, name);
    assert.deepEqual([publishableFindings(record), commentFindings(record), everyFindingExcluded(record)], [[], [], false], name);
  }
  // So nothing of it can be adjusted either, and an offer for it lists no finding.
  const lost = { ...current, method: undefined };
  assert.throws(() => resolveAdjustments(lost, { exclude: ['F-1'] }), /^Error: \[AZPR\] Nothing was changed: F-1 is REPORTED, not a finding this review can publish\. Findings of review abcdef12 you can adjust: none\.$/);
  assert.deepEqual(previewActions(lost).findings, []);
});

eachKind('inline comments on findings that no stage verified need a checked location and an anchor found in the HEAD source', (t, { kind }) => {
  const source = [{ input: { path: '/src/a.ts', version: head }, output: 'line one\nconst value = load();\n' }];
  // One finding on a changed HEAD file, one whose location cannot carry an inline comment.
  const [one, other] = kind === 'quick' ? ['Q-1', 'Q-2'] : ['F-1', 'F-2'];
  const dispositions = kind === 'quick'
    ? [{ id: one, status: 'REPORTED', reason: 'r', finding: body(one), inline: true }, { id: other, status: 'REPORTED', reason: 'r', finding: body(other), inline: false }]
    : [row(finding(one)), row(finding(other), { inline: false })];
  const r = kind === 'quick' ? quickReview(dispositions, source) : reviewersRows(dispositions, source);
  const assigned = publishableFindings(r);
  const page = answer([comment({ findingId: one }), comment({ findingId: other })]);
  const accepted = evaluatePlanPage(page, { review: r, assigned });
  assert.deepEqual(accepted.issues, []);
  assert.deepEqual(accepted.result.comments.map(c => c.findingId), [one]);
  assert.match(accepted.result.skipped.find(s => s.findingId === other).reason, /cannot carry an inline comment/);
  assert.ok(accepted.corrections.some(c => c.action === 'skip-location-without-inline'));
  // An anchor that is not in the source is a correction turn, then a skip.
  const unfound = answer([comment({ findingId: one, anchor: 'not in the source' })], [{ findingId: other, cause: 'no-inline-location', reason: 'Summary only.' }]);
  assert.match(evaluatePlanPage(unfound, { review: r, assigned }).issues.join('\n'), /anchor text was not found in the HEAD source/);
  const final = evaluatePlanPage(unfound, { review: r, assigned, final: true });
  assert.deepEqual(final.result.comments, []);
  assert.match(final.result.skipped.find(s => s.findingId === one).reason, /No inline comment: the anchor text was not found/);
  // Without any source on record there is no text to find the quote in: the comment is refused, not taken on trust.
  assert.match(evaluatePlanPage(page, { review: { ...r, toolText: [] }, assigned }).issues.join('\n'), new RegExp(`comment for ${one}: the anchor text was not found in the HEAD source`));
  // Verified reviews of 0.4.x keep their behavior: the declared lines stand.
  const verified = review([finding('F-1')], source);
  assert.deepEqual(evaluatePlanPage(answer([comment({ anchor: 'not in the source' })]), { review: verified, assigned: confirmedFindings(verified) }).issues, []);
}, ['reviewers', 'quick']);

test('a summary carries the disclosure of its review and speaks of confirmed defects only for a verified review', () => {
  const empty = [{ status: 'READY', comments: [], skipped: [], summaryDetails: '' }];
  const quick = { ...quickReview([]), summaryAttribution: 'AI-generated review; not human review or approval. Review method: quick review, not independently verified; coverage incomplete (1 changed file(s) not reviewed). Models: `x/y`' };
  const plan = assemblePlan(quick, empty);
  assert.match(plan.summary.content, /^🤖 AI-generated review; not human review or approval\. Review method: quick review, not independently verified; coverage incomplete \(1 changed file\(s\) not reviewed\)\./);
  assert.match(plan.summary.content, /No defects reported; this does not establish that the code is bug-free\./);
  assert.doesNotMatch(plan.summary.content, /confirmed/i);
  // The marker depends on the PR, head and inline markers only, never on the disclosure.
  assert.equal(plan.summary.marker, summaryMarker(quick.target, quick.snapshot.head, []));
  // A review of this pipeline: its own disclosure, with the coverage in the summary, and the same wording for no findings.
  const current = { ...reviewersRows([]), summaryAttribution: 'AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification; coverage incomplete (1 changed file(s) not reviewed). Models: `x/y`' };
  const now = assemblePlan(current, empty);
  assert.equal(now.summary.content, `🤖 ${current.summaryAttribution}\n\n## PR Review Summary\n\nhigh: 0 · medium: 0 · low: 0\n\nNo defects reported; this does not establish that the code is bug-free.\n\n${now.summary.marker}`);
  assert.equal(now.summary.marker, plan.summary.marker, 'The same summary marker, whatever the review says of itself.');
  // Without a line of its own the summary uses the comments' disclosure.
  assert.match(assemblePlan(reviewersRows([]), empty).summary.content, /^🤖 AI-generated review; not human review or approval\. Review method: findings checked by their reviewer against the source, no separate verification\. Models: `x\/y`\n\n/);
  // A verified review of 0.4.x keeps its words.
  const before = assemblePlan(review([]), empty);
  assert.equal(before.summary.content, `🤖 AI-generated review; Models: \`x/y\`\n\n## PR Review Summary\n\nhigh: 0 · medium: 0 · low: 0\n\nNo confirmed defects found; this does not establish that the code is bug-free.\n\n${before.summary.marker}`);
  assert.equal(before.summary.marker, plan.summary.marker);
});

test('the disclosure line of every kind of review, in each language, holds nothing that automatic publication leaves to a person', () => {
  const provenance = { stages: [{ model: 'provider/reviewer' }, { model: 'provider/other-reviewer#high' }] };
  const gaps = [undefined, { complete: false, unreviewedFiles: 2, filesComplete: true, reasons: ['shard-failed'] }, { complete: false, unreviewedFiles: 3, filesComplete: false, reasons: ['partial-file-list', 'reviewer-gaps', 'shard-failed'] }];
  for (const [kind, make] of Object.entries(KINDS)) for (const language of ['en', 'zh-TW', 'zh-CN']) for (const coverage of gaps) {
    const line = commentAttribution(provenance, language, 'provider/planner', { method: kind, coverage });
    const r = { ...make([finding('F-1')]), outputLanguage: language, attribution: commentAttribution(provenance, language, 'provider/planner', { method: kind }), summaryAttribution: line };
    const plan = assemblePlan(r, [{ comments: [comment()], skipped: [], summary: 'Purpose of the change.' }]);
    assert.ok(plan.summary.content.startsWith(`🤖 ${line}\n\n`) && plan.comments[0].content.includes(`\n\n---\n${r.attribution}\n\n`), `${kind} ${language}`);
    assert.deepEqual(automaticPublicationProblems(plan), [], `${kind} ${language}: ${line}`);
  }
});

// ------------------------------------------------------------ combined comments
const reported = (id, shard, location, severity = 'medium') => ({ id, status: 'REPORTED', reason: 'r', finding: { ...body(id), location, severity }, inline: true, shard });
const lines = 'line one\nconst value = load();\nline three\nline four\n';
const combinedReview = dispositions => quickReview(dispositions, [{ input: { path: '/src/a.ts', version: head }, output: lines }]);
const combined = (ids, extra = {}) => ({ findingIds: ids, severity: 'medium', path: '/src/a.ts', startLine: 2, endLine: 2, anchor: 'const value = load();',
  body: '🟡 medium: Value is lost\n\nBody.', mergeReason: 'Both describe the dropped load result.', ...extra });

test('one comment may combine a listed candidate group only under the combination rules', () => {
  const r = combinedReview([reported('Q-1', '1/2', 'head:/src/a.ts:2'), reported('Q-1001', '2/2', 'head:/src/a.ts:1-3')]);
  const assigned = publishableFindings(r), candidates = [['Q-1', 'Q-1001']];
  const ok = evaluatePlanPage(answer([combined(['Q-1', 'Q-1001'])]), { review: r, assigned, candidates });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.result.comments.map(c => [c.findingId, c.findingIds, c.mergeReason]), [['Q-1', ['Q-1', 'Q-1001'], 'Both describe the dropped load result.']]);
  assert.deepEqual(ok.result.skipped, []);
  // The runtime never combines on its own: separate comments on the same line stay separate.
  const apart = evaluatePlanPage(answer([comment({ findingId: 'Q-1', severity: 'medium', body: '🟡 medium: Permission check after charge\n\nBody.' }),
    comment({ findingId: 'Q-1001', severity: 'medium', body: '🟡 medium: Retry charges twice\n\nBody.' })]), { review: r, assigned, candidates });
  assert.deepEqual(apart.result.comments.map(c => c.findingIds ?? c.findingId), ['Q-1', 'Q-1001']);
  const refused = (page, options = {}) => evaluatePlanPage(answer(page), { review: r, assigned, candidates, ...options }).issues.join('\n');
  assert.match(refused([combined(['Q-1', 'Q-1001'], { mergeReason: '' })]), /needs a mergeReason/);
  assert.match(refused([combined(['Q-1', 'Q-1001'], { startLine: 4, endLine: 4, anchor: 'line four' })]), /anchor must lie within lines 2-2/);
  assert.match(refused([combined(['Q-1', 'Q-1001'])], { candidates: [] }), /only the findings of one listed group \(mergeCandidates or repeatCandidates\)/);
  // A verified review has no merge candidates: its verifier already merged what was reported twice.
  const verified = review([finding('F-1'), finding('F-2')], [{ input: { path: '/src/a.ts', version: head }, output: lines }]);
  assert.match(evaluatePlanPage(answer([combined(['F-1', 'F-2'], { severity: 'high' })]), { review: verified, assigned: confirmedFindings(verified), candidates }).issues.join('\n'), /only the findings of one listed group/);
  // A group that names its two findings changes nothing for it, also on a page that lists other groups.
  assert.match(evaluatePlanPage(answer([combined(['F-1', 'F-2'], { severity: 'high' })]), { review: verified, assigned: confirmedFindings(verified), candidates: [['F-1', 'F-2']] }).issues.join('\n'), /only the findings of one listed group/);
  assert.match(evaluatePlanPage(answer([combined(['F-1', 'F-2'], { severity: 'high' })]), { review: verified, assigned: confirmedFindings(verified), candidates: [['F-1', 'F-2']], repeats: [['F-3', 'F-4']] }).issues.join('\n'),
    /combined comment for F-1, F-2: the findings are not all in one listed group \(mergeCandidates or repeatCandidates\)/);
});

test('combination rules: different sessions, one severity and a shared line for every member', () => {
  const chainReview = combinedReview([reported('Q-1', '1/3', 'head:/src/a.ts:1-2'), reported('Q-1001', '2/3', 'head:/src/a.ts:2-3'), reported('Q-2001', '1/3', 'head:/src/a.ts:3-4')]);
  const assigned = publishableFindings(chainReview), candidates = [['Q-1', 'Q-1001', 'Q-2001']];
  const issues = page => evaluatePlanPage(answer(page), { review: chainReview, assigned, candidates }).issues.join('\n');
  // A chain of overlaps is one candidate group, but A and C share no line and come from the same session.
  assert.match(issues([combined(['Q-1', 'Q-2001'])]), /different review sessions[\s\S]*share no common line/);
  assert.match(issues([combined(['Q-1', 'Q-1001', 'Q-2001'])]), /different review sessions/);
  const own = comment({ findingId: 'Q-2001', severity: 'medium', startLine: 3, endLine: 3, anchor: 'line three', body: '🟡 medium: Other defect\n\nBody.' });
  assert.deepEqual(issues([combined(['Q-1', 'Q-1001']), own]), '', 'A pair inside the chain that meets the rules is accepted.');
  assert.deepEqual(combinationProblems([{ shard: '1/2', severity: 'high', location: 'head:/a.ts:2' }, { shard: '2/2', severity: 'medium', location: 'head:/a.ts:2' }]).problems, ['combined findings must have the same severity']);
});

test('a refused combination keeps every finding accounted for; valid single comments survive', () => {
  const r = combinedReview([reported('Q-1', '1/2', 'head:/src/a.ts:2'), reported('Q-1001', '2/2', 'head:/src/a.ts:2'), reported('Q-2', '1/2', 'head:/src/a.ts:2', 'high')]);
  const assigned = publishableFindings(r), candidates = [['Q-1', 'Q-1001']];
  // The planner wrote only an invalid combination for Q-1 and Q-1001, and a valid comment for Q-2.
  const page = answer([combined(['Q-1', 'Q-1001'], { mergeReason: ' ' }), comment({ findingId: 'Q-2' })]);
  const final = evaluatePlanPage(page, { review: r, assigned, candidates, final: true });
  assert.deepEqual(final.result.comments.map(c => c.findingId), ['Q-2']);
  assert.deepEqual(final.result.skipped.map(s => s.findingId).sort(), ['Q-1', 'Q-1001']);
  assert.ok(final.result.skipped.every(s => /did not meet the combination rules \(a combined comment needs a mergeReason\); the finding remains in the summary index/.test(s.reason)));
  assert.ok(final.corrections.some(c => c.action === 'drop-invalid-combined-comment'));
  // When one member also has its own valid comment, that comment stays and only the other is skipped.
  const own = evaluatePlanPage(answer([comment({ findingId: 'Q-1', severity: 'medium', body: '🟡 medium: Lost value\n\nBody.' }), combined(['Q-1', 'Q-1001'])]), { review: r, assigned, candidates, final: true });
  assert.deepEqual(own.result.comments.map(c => c.findingId), ['Q-1']);
  assert.deepEqual(own.result.skipped.map(s => s.findingId).sort(), ['Q-1001', 'Q-2']);
});

test('the summary index follows accepted combinations only, and old plan records stay readable', () => {
  const r = combinedReview([reported('Q-1', '1/2', 'head:/src/a.ts:2'), reported('Q-1001', '2/2', 'head:/src/a.ts:2'), reported('Q-3', '1/2', 'head:/src/a.ts:3')]);
  const comments = [{ findingId: 'Q-1', findingIds: ['Q-1', 'Q-1001'], severity: 'medium', path: '/src/a.ts', startLine: 2, endLine: 2, anchor: 'const value = load();', body: '🟡 medium: Lost\n\nBody.', mergeReason: 'same' }];
  const plan = assemblePlan(r, [{ status: 'READY', comments, skipped: [{ findingId: 'Q-3', reason: 'Already discussed in thread 9.' }], summaryDetails: '' }]);
  assert.match(plan.summary.content, /medium: 2 · low: 0/, 'Counts follow the rows: one combined row and Q-3.');
  assert.match(plan.summary.content, /\| 🟡 medium \| Q-1, Q-1001 — Defect Q-1 \|/);
  assert.match(plan.summary.content, /\| 🟡 medium \| Q-3 — Defect Q-3 \|/);
  assert.equal(plan.comments.length, 1);
  assert.deepEqual(plan.comments[0].findingIds, ['Q-1', 'Q-1001']);
  assert.equal(plan.comments[0].marker, inlineMarker(r.target, plan.comments[0], 0), 'The marker formula is unchanged.');
  // Without an accepted combination every finding keeps its own row.
  const separate = assemblePlan(r, [{ status: 'READY', comments: [], skipped: [], summaryDetails: '' }]);
  assert.match(separate.summary.content, /medium: 3/);
  // Plans saved before findingIds existed render and assemble as before.
  const old = assemblePlan(review([finding('F-1')]), [{ status: 'READY', comments: [{ findingId: 'F-1', severity: 'high', path: '/src/a.ts', startLine: 2, endLine: 2, anchor: 'x', body: '🔴 high: T\n\nB.' }], skipped: [], summaryDetails: '' }]);
  assert.equal(old.comments[0].findingIds, undefined);
  assert.match(old.summary.content, /\| 🔴 high \| F-1 — Defect F-1 \|/);
});

// ------------------------------------------------------------ one defect at several places
const twoFiles = [{ input: { path: '/src/a.ts', version: head }, output: lines }, { input: { path: '/src/b.ts', version: head }, output: 'first\nsecond\nthird\n' }];
// F-1 at /src/a.ts:2, F-2 at /src/b.ts:2-3, F-3 at /src/a.ts:4: three places, one severity. A review of the kind
// `make` builds, with both files on record as read at HEAD.
const repeated = (make, extra = []) => make([finding('F-1', 'medium'), finding('F-2', 'medium', { location: 'head:/src/b.ts:2-3' }),
  finding('F-3', 'medium', { location: 'head:/src/a.ts:4' }), ...extra], twoFiles);
const third = comment({ findingId: 'F-3', severity: 'medium', startLine: 4, endLine: 4, anchor: 'line four', body: '🟡 medium: Other defect\n\nBody.' });
// What a page shows of the two files as the runtime read them at HEAD: four lines and three.
const shown = [{ path: '/src/a.ts', firstLine: 1, lastLine: 4, totalLines: 4 }, { path: '/src/b.ts', firstLine: 1, lastLine: 3, totalLines: 3 }];

eachKind('one comment may hold one defect made at several places: it stands at one place and carries the others', (t, { make }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  // The planner names F-2 first, but the anchor lies in F-1's lines: the comment stands there.
  const ok = evaluatePlanPage(answer([combined(['F-2', 'F-1']), third]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.result.comments.map(c => [c.findingId, c.findingIds ?? null, c.otherPlaces ?? null]),
    [['F-1', ['F-1', 'F-2'], [{ findingId: 'F-2', place: '/src/b.ts:2-3' }]], ['F-3', null, null]]);
  assert.equal(ok.result.comments[0].mergeReason, 'Both describe the dropped load result.');
  assert.deepEqual(ok.result.skipped, []);
  // The whole group in one comment: the other places follow the order of the page, whatever order the planner wrote.
  const all = evaluatePlanPage(answer([combined(['F-3', 'F-2', 'F-1'])]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual(all.issues, []);
  assert.deepEqual(all.result.comments[0].otherPlaces, [{ findingId: 'F-2', place: '/src/b.ts:2-3' }, { findingId: 'F-3', place: '/src/a.ts:4' }]);
  // Anchored at the other file, the same findings stand there instead.
  const elsewhere = evaluatePlanPage(answer([combined(['F-1', 'F-2'], { path: '/src/b.ts', startLine: 3, endLine: 3, anchor: 'third' }), third]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual(elsewhere.issues, []);
  assert.deepEqual([elsewhere.result.comments[0].findingId, elsewhere.result.comments[0].otherPlaces], ['F-2', [{ findingId: 'F-1', place: '/src/a.ts:2' }]]);
  // Nothing is combined unless the planner says so: separate comments stay separate.
  const apart = evaluatePlanPage(answer([comment({ severity: 'medium', body: '🟡 medium: One\n\nBody.' }),
    comment({ findingId: 'F-2', severity: 'medium', path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second', body: '🟡 medium: Two\n\nBody.' }), third]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual(apart.result.comments.map(c => [c.findingId, c.otherPlaces]), [['F-1', undefined], ['F-2', undefined], ['F-3', undefined]]);
});

eachKind('rules of a comment for several places: a listed group, one severity, different lines, an anchor in one member\'s lines', (t, { make, none }) => {
  const low = finding('F-4', 'low', { location: 'head:/src/b.ts:1' }), high = finding('F-5', 'high', { location: 'head:/src/b.ts:1' }), same = finding('F-6', 'medium');
  const r = repeated(make, [low, high, same]), assigned = publishableFindings(r);
  const refused = (page, repeats, options = {}) => evaluatePlanPage(answer(page), { review: r, assigned, repeats, sources: shown, ...options }).issues.join('\n');
  assert.match(refused([combined(['F-1', 'F-2'])], []), /only the findings of one listed group \(mergeCandidates or repeatCandidates\)/);
  assert.match(refused([combined(['F-1', 'F-3'])], [['F-1', 'F-2'], ['F-3', 'F-6']]), /not all in one listed group/);
  assert.match(refused([combined(['F-1', 'F-2'], { mergeReason: ' ' })], [['F-1', 'F-2']]), /needs a mergeReason/);
  assert.match(refused([combined(['F-1', 'F-2'], { startLine: 3, endLine: 3, anchor: 'line three' })], [['F-1', 'F-2']]),
    /anchor must lie on the lines of one of the combined findings \(F-1 at \/src\/a\.ts:2, F-2 at \/src\/b\.ts:2-3\)/);
  // An anchor that reaches beyond a finding's lines still stands at that finding.
  const plain = repeated(make);
  const wide = evaluatePlanPage(answer([combined(['F-1', 'F-2'], { startLine: 1, endLine: 2, anchor: 'line one\nconst value = load();' }), third]), { review: plain, assigned: publishableFindings(plain), repeats: [['F-1', 'F-2']], sources: shown });
  assert.deepEqual([wide.issues, wide.result.comments[0].findingId, wide.result.comments[0].startLine, wide.result.comments[0].endLine], [[], 'F-1', 1, 2]);
  // Quoted lines that reach from one finding's lines into another's name no place, and the runtime chooses none.
  const both = evaluatePlanPage(answer([combined(['F-1', 'F-3'], { startLine: 2, endLine: 4, anchor: 'const value = load();\nline three\nline four' }),
    comment({ findingId: 'F-2', severity: 'medium', path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second', body: '🟡 medium: Two\n\nBody.' })]),
  { review: plain, assigned: publishableFindings(plain), repeats: [['F-1', 'F-2', 'F-3']], sources: shown });
  assert.match(both.issues.join('\n'), /the anchor \(lines 2-4\) touches the lines of F-1 at \/src\/a\.ts:2 and F-3 at \/src\/a\.ts:4; quote lines of one of them only/);
  assert.match(refused([combined(['F-1', 'F-5'])], [['F-1', 'F-5']]), /must have the same severity/);
  assert.match(refused([combined(['F-1', 'F-6'])], [['F-1', 'F-6']]), /F-1 and F-6 are on the same lines, which is not another place/);
  assert.match(refused([combined(['F-1', 'F-9'])], [['F-1', 'F-9']]), /F-9 not assigned to this page/);
  const outside = make([finding('F-1', 'medium'), finding('F-2', 'medium', { location: 'head:/src/unchanged.ts:7' })], twoFiles);
  assert.match(evaluatePlanPage(answer([combined(['F-1', 'F-2'])]), { review: outside, assigned: publishableFindings(outside), repeats: [['F-1', 'F-2']], sources: [...shown, { path: '/src/unchanged.ts', firstLine: 1, lastLine: 9, totalLines: 9 }] }).issues.join('\n'),
    /F-2 \(\/src\/unchanged\.ts:7\) is not on lines of a changed file as the runtime read it at HEAD/);
  // A place is listed as its finding states it, so its lines must be in the file as the runtime read it at HEAD:
  // not beyond its end, not in a file the page could not read (deleted in this PR, say).
  const beyond = make([finding('F-1', 'medium'), finding('F-2', 'medium', { location: 'head:/src/b.ts:40' })], twoFiles);
  const placesOf = (r, sources) => evaluatePlanPage(answer([combined(['F-1', 'F-2'])]), { review: r, assigned: publishableFindings(r), repeats: [['F-1', 'F-2']], sources }).issues.join('\n');
  assert.match(placesOf(beyond, shown), /F-2 \(\/src\/b\.ts:40\) is not on lines of a changed file as the runtime read it at HEAD/);
  assert.match(placesOf(repeated(make), shown.slice(0, 1)), /F-2 \(\/src\/b\.ts:2-3\) is not on lines of a changed file as the runtime read it at HEAD/);
  assert.equal(placesOf(repeated(make), shown.map(({ totalLines: _all, ...window }) => window)).includes('not on lines'), false, 'A window that ends at the lines is enough.');
  assert.deepEqual(repeatProblems([low, { ...low, id: 'F-7', location: 'head:/src/b.ts:3' }]).problems, ['only high and medium findings get inline comments']);
  assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: 'base:/src/b.ts:3' })]).problems, ['every combined finding must be located on lines of a HEAD file']);
  assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: 'head:/src/b.ts' })]).problems, ['every combined finding must be located on lines of a HEAD file']);
  assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: 'head:/src/a.ts:3-9' })]).problems, []);
  assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: 'head:/src/b.ts:3-2' })]).problems, ['every combined finding must be located on lines of a HEAD file'], 'A range that ends before it begins is no lines.');
  // A file name that a list cannot hold as it is (a control character, an end of an HTML comment) is listed nowhere.
  for (const name of ['/src/x-->y.ts', '/src/x<!--y.ts', '/src/x\ty.ts']) {
    assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: `head:${name}:2` })]).problems, ['the file name of F-2 cannot be written into a list of places as it is'], name);
  }
  assert.deepEqual(repeatProblems([finding('F-1'), finding('F-2', 'high', { location: 'head:/src/a `b` (F-9).ts:2' })]).problems, [], 'Backticks and brackets are text a list holds.');
  assert.equal(placeOf({ location: 'head:/src/a.ts:12-14' }), '/src/a.ts:12-14');
  assert.equal(placeOf({ location: '/src/a.ts:7' }), '/src/a.ts:7');
  // After the repair turns a comment that still breaks a rule is dropped; every finding it named stays accounted for.
  const final = evaluatePlanPage(answer([combined(['F-1', 'F-6']), third]), { review: r, assigned: assigned.filter(f => ['F-1', 'F-3', 'F-6'].includes(f.id)), repeats: [['F-1', 'F-6']], sources: shown, final: true });
  assert.deepEqual(final.result.comments.map(c => c.findingId), ['F-3']);
  assert.deepEqual(final.result.skipped.map(s => s.findingId).sort(), ['F-1', 'F-6']);
  assert.ok(final.result.skipped.every(s => /did not meet the combination rules \(F-1 and F-6 are on the same lines/.test(s.reason)));
  // A skip that leans on another finding's comment is sent back with the way to combine them.
  const leaning = evaluatePlanPage(answer([combined(['F-1'], { findingId: 'F-1', findingIds: undefined }), third], [{ findingId: 'F-2', reason: 'Covered by the comment for F-1.' }]),
    { review: repeated(make), assigned: publishableFindings(repeated(make)), repeats: [['F-1', 'F-2']], sources: shown });
  // Both kinds had their duplicates merged before planning, so both are pointed at the groups of repeats alone.
  assert.match(leaning.issues.join('\n'), /skip for F-2 relies on F-1: findings of this review are separate issues \(duplicates were merged before planning\)[\s\S]*give one comment findingIds with both only when a listed repeatCandidates group holds them/);
  assert.doesNotMatch(leaning.issues.join('\n'), /mergeCandidates/);
});

test('a quick review keeps both kinds apart: the same lines twice, and one defect at several places', () => {
  const r = quickReview([reported('Q-1', '1/2', 'head:/src/a.ts:2'), reported('Q-1001', '2/2', 'head:/src/a.ts:1-3'), reported('Q-2', '1/2', 'head:/src/b.ts:2'), reported('Q-3', '1/2', 'head:/src/a.ts:4')], twoFiles);
  const assigned = publishableFindings(r);
  const page = [combined(['Q-1', 'Q-1001']), combined(['Q-2', 'Q-3'], { path: '/src/b.ts', anchor: 'second' })];
  const ok = evaluatePlanPage(answer(page), { review: r, assigned, candidates: [['Q-1', 'Q-1001']], repeats: [['Q-2', 'Q-3']], sources: shown });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.result.comments.map(c => [c.findingIds, c.otherPlaces ?? null]), [[['Q-1', 'Q-1001'], null], [['Q-2', 'Q-3'], [{ findingId: 'Q-3', place: '/src/a.ts:4' }]]]);
  // A quick comment for several places needs its anchor in the HEAD source like any other.
  assert.match(evaluatePlanPage(answer([page[0], combined(['Q-2', 'Q-3'], { path: '/src/b.ts', anchor: 'not there' })]),
    { review: r, assigned, candidates: [['Q-1', 'Q-1001']], repeats: [['Q-2', 'Q-3']], sources: shown }).issues.join('\n'), /anchor text was not found in the HEAD source/);
});

eachKind('the plan lists the other places under the comment, from the findings\' own locations, and every place keeps its index row', (t, { make }) => {
  const r = repeated(make);
  const page = evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'])]), { review: r, assigned: publishableFindings(r), repeats: [['F-1', 'F-2', 'F-3']], sources: shown }).result;
  const plan = assemblePlan(r, [page]);
  const item = plan.comments[0];
  assert.equal(item.content, `🟡 medium: Value is lost\n\nBody.\n\n**📍 Also at** (the same defect; fix these places with it):\n- \`/src/b.ts:2-3\` (F-2)\n- \`/src/a.ts:4\` (F-3)\n\n---\n${r.attribution}\n\n${item.linesMarker}\n\n${item.marker}`);
  assert.deepEqual([item.linesMarker, item.marker], [linesMarker(r.target, item), sharedMarker(r.target, item, 0)], 'The marker of its quoted lines, then its own.');
  assert.equal(item.body, '🟡 medium: Value is lost\n\nBody.', 'The planner\'s text is kept as it was written.');
  assert.match(plan.summary.content, /medium: 3 · low: 0/);
  for (const id of ['F-1', 'F-2', 'F-3']) assert.match(plan.summary.content, new RegExp(`\\| 🟡 medium \\| ${id} — Defect ${id} \\|`), 'Each place is a finding of its own in the index.');
  assert.deepEqual(automaticPublicationProblems(plan), [], 'The list holds nothing that waits for a person.');
  // Text of a place never closes or opens an HTML comment next to the marker.
  const odd = assemblePlan(r, [{ ...page, comments: [{ ...page.comments[0], otherPlaces: [{ findingId: 'F-2', place: '/src/x-->y<!--.ts:2' }] }] }]);
  assert.match(odd.comments[0].content, /- `\/src\/x--&gt;y&lt;!--\.ts:2` \(F-2\)/);
  // In the review's language, and nothing but the list when no attribution is set.
  const local = assemblePlan({ ...r, outputLanguage: 'zh-TW', attribution: undefined }, [page]);
  assert.equal(local.comments[0].content, `🟡 medium: Value is lost\n\nBody.\n\n**📍 其他位置**（同一個問題，請一併修正）：\n- \`/src/b.ts:2-3\`（F-2）\n- \`/src/a.ts:4\`（F-3）\n\n${local.comments[0].linesMarker}\n\n${local.comments[0].marker}`);
});

eachKind('a comment for several places has a marker of its own, and one that says such a comment stands on its quoted lines', (t, { make }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  const planned = (page, extra = {}) => assemblePlan(r, [evaluatePlanPage(answer(page), { review: r, assigned, repeats, sources: shown, ...extra }).result]);
  const [shared] = planned([combined(['F-1', 'F-2', 'F-3'])]).comments;
  // Its own marker follows the file, the quoted lines and the other places; the other one only the file and the quoted lines.
  assert.deepEqual([shared.marker, shared.linesMarker], [sharedMarker(r.target, shared, 0), linesMarker(r.target, shared)]);
  assert.equal(new Set([shared.marker, shared.linesMarker, inlineMarker(r.target, shared, 0)]).size, 3, 'Neither is the marker of a comment for one place on these lines.');
  assert.ok(shared.content.endsWith(`\n\n---\n${r.attribution}\n\n${shared.linesMarker}\n\n${shared.marker}`), 'Both end the comment, each on a line of its own between blank lines.');
  // The same comment planned again is the same comment, whatever order the planner names the findings in.
  assert.equal(planned([combined(['F-3', 'F-1', 'F-2'])]).comments[0].marker, shared.marker);
  // Other places, another quote or another file make another comment; the marker of the lines stays where the quote stays.
  const two = planned([combined(['F-1', 'F-2']), third]).comments[0];
  assert.deepEqual([two.marker === shared.marker, two.linesMarker === shared.linesMarker], [false, true]);
  const elsewhere = planned([combined(['F-1', 'F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })]).comments[0];
  assert.deepEqual([elsewhere.marker === shared.marker, elsewhere.linesMarker === shared.linesMarker], [false, false]);
  // A comment for one place has the one marker it always had, whatever shared comments the plan holds, and the summary
  // is keyed by each comment's own marker.
  const single = planned([comment({ severity: 'medium', body: '🟡 medium: One\n\nBody.' }), combined(['F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })]);
  assert.deepEqual([single.comments[0].marker, Object.hasOwn(single.comments[0], 'linesMarker')], [inlineMarker(r.target, single.comments[0], 0), false]);
  assert.equal(single.summary.marker, summaryMarker(r.target, r.snapshot.head, single.comments.map(c => c.marker)));
  // Two comments that quote the same lines, one of each kind: the comment for one place has the first marker of
  // those lines whether it comes before the shared one or after it.
  const twin = finding('F-4', 'medium'), both = repeated(make, [twin]);
  const alone = comment({ findingId: 'F-4', severity: 'medium', body: '🟡 medium: Twin\n\nBody.' });
  for (const page of [[alone, combined(['F-1', 'F-2', 'F-3'])], [combined(['F-1', 'F-2', 'F-3']), alone]]) {
    const stacked = assemblePlan(both, [evaluatePlanPage(answer(page), { review: both, assigned: publishableFindings(both), repeats, sources: shown }).result]).comments;
    assert.deepEqual(Object.fromEntries(stacked.map(c => [c.findingId, c.marker])), { 'F-4': inlineMarker(both.target, shared, 0), 'F-1': shared.marker });
  }
  // Two defects at the same places: each has a finding on the same lines of both files, their comments quote the same
  // line and list the same place. They are two comments, told apart by their order in the plan.
  const twins = make([finding('F-1', 'medium'), finding('F-2', 'medium', { location: 'head:/src/b.ts:2-3' }), finding('F-3', 'medium'), finding('F-4', 'medium', { location: 'head:/src/b.ts:2-3' })], twoFiles);
  const pair = assemblePlan(twins, [evaluatePlanPage(answer([combined(['F-1', 'F-2']), combined(['F-3', 'F-4'], { body: '🟡 medium: Another defect\n\nBody.' })]),
    { review: twins, assigned: publishableFindings(twins), repeats: [['F-1', 'F-2'], ['F-3', 'F-4']], sources: shown }).result]).comments;
  assert.deepEqual(pair.map(c => c.findingIds), [['F-1', 'F-2'], ['F-3', 'F-4']]);
  assert.deepEqual(pair.map(c => c.marker), [sharedMarker(twins.target, pair[0], 0), sharedMarker(twins.target, pair[0], 1)]);
  assert.equal(pair[0].linesMarker, pair[1].linesMarker);
  // What a marker is made of is kept apart: a quote of two lines whose second reads like a place is not a quote of one
  // line with that place listed.
  const one = { path: '/src/a.ts', anchor: 'fix', otherPlaces: [{ place: '/b:2' }, { place: '/c:3' }] }, other = { path: '/src/a.ts', anchor: 'fix\n/b:2', otherPlaces: [{ place: '/c:3' }] };
  const mixed = assemblePlan(r, [{ comments: [{ ...one, body: 'B', findingId: 'F-1' }, { ...other, body: 'B', findingId: 'F-2' }], skipped: [] }]).comments;
  assert.deepEqual(mixed.map(c => c.marker), [sharedMarker(r.target, one, 0), sharedMarker(r.target, other, 0)]);
});

eachKind('a comment for several places and a comment for one place are not put on the same quoted lines of the PR', (t, { make }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  const whole = [combined(['F-1', 'F-2', 'F-3'])];
  const [shared] = assemblePlan(r, [evaluatePlanPage(answer(whole), { review: r, assigned, repeats, sources: shown }).result]).comments;
  const plan = (posted, page = whole, options = {}) => evaluatePlanPage(answer(page), { review: r, assigned, repeats, sources: shown, posted, ...options });
  const place = ordinal => inlineMarker(r.target, shared, ordinal);
  // An earlier publication left a comment for F-1 alone on these lines (thread 12): the shared comment is another
  // comment and would be posted next to it, so the planner is asked to put it elsewhere.
  assert.match(plan(new Map([[place(0), 12]])).issues.join('\n'), /combined comment for F-1, F-2, F-3: the PR already has a comment of AZPR's on these quoted lines \(thread 12\), and a second one is not put on them\. Anchor this comment on the lines of another of its findings, or leave F-1 out of it; a finding that an existing thread covers is skipped with cause existing-thread/);
  // Comments on the same quoted lines count from 0, and the first may have been deleted since: the next ones are looked for too.
  assert.match(plan(new Map([[place(1), 14]])).issues.join('\n'), /already has a comment of AZPR's on these quoted lines \(thread 14\)/);
  assert.match(plan(new Map([[place(7), 15]])).issues.join('\n'), /\(thread 15\)/);
  // So for a shared comment with other places that stands there (the marker of its lines).
  assert.match(plan(new Map([[shared.linesMarker, 16], ['<!-- azpr-comment:' + '0'.repeat(32) + ' -->', 16]])).issues.join('\n'), /already has a comment of AZPR's on these quoted lines \(thread 16\)/);
  // The PR has this very comment: planned again it is the same, and publication will skip it. So for the second of two alike.
  assert.deepEqual(plan(new Map([[shared.linesMarker, 12], [shared.marker, 12]])).issues, []);
  assert.deepEqual(plan(new Map([[shared.linesMarker, 12], [sharedMarker(r.target, shared, 1), 12]])).issues, []);
  // Anchored at another place it meets nothing.
  const moved = plan(new Map([[place(0), 12]]), [combined(['F-1', 'F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })]);
  assert.deepEqual([moved.issues, moved.result.comments[0].findingId], [[], 'F-2']);
  // A comment for one place on lines that carry one for one place is as it always was: publication finds it by marker.
  const apart = [comment({ severity: 'medium', body: '🟡 medium: One\n\nBody.' }), combined(['F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })];
  const kept = plan(new Map([[place(0), 12]]), apart);
  assert.deepEqual([kept.issues, kept.result.comments.map(c => c.findingIds ?? c.findingId)], [[], ['F-1', ['F-2', 'F-3']]]);
  // The other way round: a comment for one place is not put on lines that carry a comment for several places ...
  const under = plan(new Map([[shared.linesMarker, 21], [shared.marker, 21]]), apart);
  assert.match(under.issues.join('\n'), /comment for F-1: the PR already has a comment of AZPR's on these quoted lines \(thread 21\), and a second one is not put on them\. Skip F-1 with cause existing-thread when that thread covers it, or quote other lines\./);
  const skipped = plan(new Map([[shared.linesMarker, 21], [shared.marker, 21]]), apart, { final: true });
  assert.deepEqual([skipped.result.comments.map(c => c.findingId), skipped.result.skipped.map(s => s.findingId)], [['F-2'], ['F-1']]);
  assert.match(skipped.result.skipped[0].reason, /No inline comment: the PR already has a comment of AZPR's on these quoted lines \(thread 21\)/);
  // ... unless a comment for one place is there as well, which it then finds by marker.
  assert.deepEqual(plan(new Map([[shared.linesMarker, 21], [place(0), 12]]), apart).issues, []);
  // Threads that could not be read refuse nothing.
  assert.deepEqual([plan(null).issues, plan(null, apart).issues], [[], []]);
  // After the repair turns the shared comment is dropped like any that breaks a rule, and its findings stay accounted for.
  const final = plan(new Map([[place(0), 12]]), whole, { final: true });
  assert.deepEqual([final.result.comments, final.result.skipped.map(s => s.findingId), final.issues], [[], ['F-1', 'F-2', 'F-3'], []]);
  assert.match(final.result.skipped[0].reason, /did not meet the combination rules \(the PR already has a comment of AZPR's on these quoted lines/);
  // Comments of this very plan are no comments of the PR: both kinds are planned on one line, as two comments always were.
  const twin = finding('F-4', 'medium'), both = repeated(make, [twin]);
  const side = evaluatePlanPage(answer([comment({ findingId: 'F-4', severity: 'medium', body: '🟡 medium: Twin\n\nBody.' }), combined(['F-1', 'F-2', 'F-3'])]),
    { review: both, assigned: publishableFindings(both), repeats, sources: shown, posted: new Map() });
  assert.deepEqual([side.issues, side.result.comments.map(c => c.findingId)], [[], ['F-4', 'F-1']]);
});

eachKind('a planner\'s text never holds the heading of the list of other places, however it is written', (t, { make }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  const heading = '**📍 Also at** (the same defect; fix these places with it):', row = '- `/src/unrelated.ts:25` (F-9)';
  const others = [combined(['F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })];
  for (const text of [`${heading}\n${row}`, ` ${heading}\n${row}`, `\t${heading}\n${row}`, `> ${heading}\n> ${row}`, `- ${heading}`, `See ${heading} for the rest.`,
    '**📍 其他位置**（同一個問題，請一併修正）：\n- `/src/unrelated.ts:25`（F-9）', ' **📍 其他位置**（同一个问题，请一并修正）：']) {
    // In a comment for several places, where the runtime's own list would follow it, and in a comment for one place.
    const shared = evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'], { body: `🟡 medium: Value is lost\n\nBody.\n\n${text}` })]), { review: r, assigned, repeats, sources: shown });
    assert.match(shared.issues.join('\n'), /combined comment for F-1, F-2, F-3: body holds the heading of the list of other places, which only the runtime writes; leave that list out/, text);
    const single = evaluatePlanPage(answer([comment({ severity: 'medium', body: `🟡 medium: One\n\nBody.\n\n${text}` }), ...others]), { review: r, assigned, repeats, sources: shown });
    assert.match(single.issues.join('\n'), /comment for F-1: body holds the heading of the list of other places/, text);
    // After the correction turns such a comment is not planned.
    const final = evaluatePlanPage(answer([comment({ severity: 'medium', body: `🟡 medium: One\n\nBody.\n\n${text}` }), ...others]), { review: r, assigned, repeats, sources: shown, final: true });
    assert.deepEqual([final.result.comments.map(c => c.findingId), final.result.skipped.map(s => s.findingId)], [['F-2'], ['F-1']], text);
  }
  // Words about other places are a planner's to write; only the runtime's heading is not.
  const plain = evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'], { body: '🟡 medium: Value is lost\n\nAlso at the other handlers; fix these places with it.' })]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual(plain.issues, []);
});

eachKind('a comment for several places leaves no block open that would take the list of other places in', (t, { make }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  // The list follows the body after a blank line. A block that goes on over a blank line would take it in, so
  // such a body is sent back; the text after the title is the planner's.
  const planned = (text, options = {}) => evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'], { body: `🟡 medium: Value is lost\n\nSuggested fix:\n\n${text}` })]), { review: r, assigned, repeats, sources: shown, ...options });
  const sentBack = block => new RegExp(`^combined comment for F-1, F-2, F-3: body leaves ${block} open, which would take the list of other places into it; close it\\. Correct it, or comment on each finding separately\\.$`);
  const open = {
    'a code fence': [
      // A fence without a closing one: of its own marker, at least as long, with nothing after it.
      '```ts\nconst value = load();', '~~~\ncode', '   ```\ncode', '````\ncode\n```', '```\ncode\n~~~', '```\ncode\n``` not a closing fence',
      // What ends a list item or a quote ends the fence in it, and a fence line after it starts a block at the top level:
      // an unindented one under an item, one indented less than the item's text, one after a quote.
      '- ~~~js\n  code\n~~~', '1. Change the call:\n  ```ts\n  load();', '> ```\n> code\n\n```\nmore', '> ```\ncode\n```',
      // A line that continues an item's paragraph does not continue its code.
      '- ~~~js\n  code\ntext\n  ~~~',
      // Under a paragraph, a number other than 1 and a marker without text start no list item, so the fence is not in one.
      'Then:\n2. step\n   ```\n   code', 'Then:\n-\n  ~~~\n  code',
      // An item that began with nothing ends at a blank line.
      '-\n\n  ```\n  code',
      // A line ends at a line feed or a carriage return only: U+2028 is a character of the fence's first line.
      '~~~js\u2028x\nrun();',
    ],
    'a <pre> block': ['<pre>\nconst value = load();', '<PRE class="x">\ncode', '<pre>\ncode\n\nmore'],
    'a <script> block': ['<script>\nrun();'],
    'a <?…?> block': ['<?php\necho 1;'],
    'a <!…> declaration': ['<!DOCTYPE html'],
    'a CDATA section': ['<![CDATA[\nvalue'],
  };
  for (const [block, texts] of Object.entries(open)) {
    for (const text of texts) assert.match(planned(text).issues.join('\n'), sentBack(block.replace(/[?.[\]]/g, '\\$&')), text);
  }
  const closed = [
    '```ts\nconst value = load();\n```', '~~~\ncode\n~~~~', '```\na\n```\n\n```\nb\n```', 'Use ``` in a sentence.', '```js `x` ```', '\t```\n\tcode',
    // A fence in a list item, closed there, and one the item ends: by a sibling, by text after a blank line, by the body's end.
    '- ~~~js\n  code\n  ~~~', '1. Change the call:\n   ```ts\n   load();\n   ```\n2. Run it again.', '-\t```js\n\tcode\n\t```', '- item\n  ```\n  code\n\nAfter the list.', '- item\n\n      ```\n      code',
    // A fence in a quote ends with the quote; an item's paragraph goes on in a line that is not indented.
    '> ```\n> code', '- item\ngoes on\n  ```\n  code',
    // Raw HTML that ends where it says, in the same line or later; a tag in code or in a sentence opens no block; in a list item it ends with the item.
    '<pre>\ncode\n</pre>', '<pre>code</pre>', '<textarea>\nvalue\n</TEXTAREA>', '<?php echo 1; ?>', '<!DOCTYPE html>', 'Wrap the output in `<pre>`.', 'The <pre> tag is missing.', '```html\n<pre>\n```', '- <pre>\n  code',
    // Raw HTML that ends at a blank line holds the fence line as text.
    '<details>\n```\n</details>', '<div>\n~~~\n\nAfter it.',
    // ... which a line that is one whole tag starts, as commonmark.js and markdown-it take it: `<pre/>` too
    // (no block of the first kind), and with any white space after the tag.
    '<pre/>\n~~~js\nrun();', '<span>\u00a0\n~~~js\nrun();',
    // U+2028 is a character of a list item's first line, so the fence under it is the item's.
    '- item\u2028x\n  ```\n  code',
  ];
  for (const text of closed) assert.deepEqual(planned(text).issues, [], text);
  // After the correction turns such a comment is not planned; its findings stay in the summary index.
  const dropped = planned('```ts\nconst value = load();', { final: true });
  assert.deepEqual([dropped.issues, dropped.result.comments, dropped.result.skipped.map(s => s.findingId)], [[], [], ['F-1', 'F-2', 'F-3']]);
  // A comment for one place has no list under it and is planned as before.
  const single = evaluatePlanPage(answer([comment({ severity: 'medium', body: '🟡 medium: One\n\n```ts\nconst value = load();' }), combined(['F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })]),
    { review: r, assigned, repeats, sources: shown });
  assert.deepEqual([single.issues, single.result.comments.map(c => c.findingId)], [[], ['F-1', 'F-2']]);
});

eachKind('a comment for several places quotes lines the file has, also in a review whose single comments need not', (t, { make, none }) => {
  const r = repeated(make), assigned = publishableFindings(r), repeats = [['F-1', 'F-2', 'F-3']];
  // /src/b.ts has three lines; the comment claims lines 3-4 and invents the fourth. Its lines would touch F-2 (lines 2-3).
  const invented = combined(['F-1', 'F-2', 'F-3'], { path: '/src/b.ts', startLine: 3, endLine: 4, anchor: 'third\nfourth' });
  const refused = evaluatePlanPage(answer([invented]), { review: r, assigned, repeats, sources: shown });
  assert.match(refused.issues.join('\n'), /combined comment for F-1, F-2, F-3: the anchor text was not found in the HEAD source; quote the exact lines from sourceExcerpts/);
  // A single comment of an independently verified review keeps its declared lines when the quote is not found, as
  // before; in a review whose findings no stage verified it needs the quote like the comment for several places.
  const single = evaluatePlanPage(answer([comment({ severity: 'medium', startLine: 9, endLine: 9, anchor: 'not in the file', body: '🟡 medium: One\n\nBody.' }), combined(['F-2', 'F-3'], { path: '/src/b.ts', startLine: 2, endLine: 2, anchor: 'second' })]),
    { review: r, assigned, repeats, sources: shown });
  assert.deepEqual([single.issues, single.result.comments.map(c => [c.findingId, c.startLine])], none
    ? [['comment for F-1: the anchor text was not found in the HEAD source; quote the exact lines from sourceExcerpts.'], [['F-2', 2]]]
    : [[], [['F-1', 9], ['F-2', 2]]]);
  // A quote that is found at other lines than declared is moved there, and the comment stands where the quote is.
  const moved = evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'], { startLine: 1, endLine: 1, anchor: 'line four' })]), { review: r, assigned, repeats, sources: shown });
  assert.deepEqual([moved.issues, moved.result.comments[0].findingId, moved.result.comments[0].startLine], [[], 'F-3', 4]);
  // A quote of the file's last line and a blank one after it matches the text (which ends with a line break), but the
  // file has no such line: the range would end past its end.
  const past = evaluatePlanPage(answer([combined(['F-1', 'F-2', 'F-3'], { path: '/src/b.ts', startLine: 3, endLine: 4, anchor: 'third\n ' })]), { review: r, assigned, repeats, sources: shown });
  assert.match(past.issues.join('\n'), /combined comment for F-1, F-2, F-3: the anchor \(lines 3-4\) reaches past the end of \/src\/b\.ts, which has 3 line\(s\); quote lines the file has/);
});

test('the grouping pass proposes groups under the same rules; what breaks one is reported, then dropped', () => {
  const findings = [finding('F-1', 'medium'), finding('F-2', 'medium', { location: 'head:/src/b.ts:2-3' }), finding('F-3', 'medium', { location: 'head:/src/a.ts:4' }),
    finding('F-4', 'high', { location: 'head:/src/b.ts:1' }), finding('F-5', 'medium'), finding('F-6', 'high', { location: 'head:/src/a.ts:9' })];
  const grouping = groups => JSON.stringify({ status: 'READY', groups });
  const ok = evaluateGrouping(grouping([{ findingIds: ['F-6', 'F-4'], reason: 'Same unchecked call.' }, ['F-3', 'F-1']]), { findings });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.result, { status: 'READY', groups: [['F-1', 'F-3'], ['F-4', 'F-6']] }, 'Groups and their members follow the order of the findings.');
  assert.deepEqual(evaluateGrouping(grouping([]), { findings }).result.groups, []);
  // An answer without `groups` (a page's answer, say) is no grouping: it is sent back, and counts as none once the turns are used up.
  const page = JSON.stringify({ status: 'READY', comments: [], skipped: [] });
  assert.match(evaluateGrouping(page, { findings }).issues.join('\n'), /groups is missing: answer with \{"status": "READY", "groups": \[\.\.\.\]\}/);
  assert.deepEqual([evaluateGrouping(page, { findings, final: true }).result, evaluateGrouping(page, { findings, final: true }).issues], [{ status: 'READY', groups: [] }, []]);
  const issues = groups => evaluateGrouping(grouping(groups), { findings }).issues.join('\n');
  assert.match(issues([{ findingIds: ['F-1', 'F-9'] }]), /group F-1, F-9: F-9 is not in findings/);
  assert.match(issues([{ findingIds: ['F-1', 'F-2'] }, { findingIds: ['F-2', 'F-3'] }]), /group F-2, F-3: F-2 already belongs to another group/);
  assert.match(issues([{ findingIds: ['F-1', 'F-4'] }]), /must have the same severity/);
  assert.match(issues([{ findingIds: ['F-1', 'F-5'] }]), /F-1 and F-5 are on the same lines, which is not another place/);
  assert.match(evaluateGrouping(JSON.stringify({ status: 'READY', groups: 'F-1, F-2' }), { findings }).issues.join('\n'), /groups must be an array/);
  assert.equal(evaluateGrouping('not json', { findings }).result, null);
  // A group of one finding, or of the same finding twice, is nothing to correct.
  assert.deepEqual(evaluateGrouping(grouping([{ findingIds: ['F-1'] }, { findingIds: ['F-2', 'F-2'] }]), { findings }).issues, []);
  // An entry whose findings are no list is a mistake the planner gets to correct; after the turns it is dropped.
  for (const entry of [{ findingIds: 'F-1,F-2' }, 'F-1, F-2', { ids: ['F-1', 'F-3'] }, 7]) {
    assert.match(evaluateGrouping(grouping([entry, { findingIds: ['F-4', 'F-6'] }]), { findings }).issues.join('\n'), /^group 1: findingIds must be an array of finding IDs/, JSON.stringify(entry));
    const dropped = evaluateGrouping(grouping([entry, { findingIds: ['F-4', 'F-6'] }]), { findings, final: true });
    assert.deepEqual([dropped.result.groups, dropped.issues, dropped.corrections.map(c => c.action)], [[['F-4', 'F-6']], [], ['drop-malformed-group']]);
  }
  // After the repair turns the valid groups stand and the others are dropped; an unusable answer groups nothing.
  const final = evaluateGrouping(grouping([{ findingIds: ['F-1', 'F-5'] }, { findingIds: ['F-4', 'F-6'] }, { findingIds: ['F-2', 'F-9'] }]), { findings, final: true });
  assert.deepEqual([final.result.groups, final.issues], [[['F-4', 'F-6']], []]);
  assert.deepEqual(final.corrections.map(c => c.action), ['drop-invalid-group', 'drop-invalid-group']);
  assert.deepEqual(evaluateGrouping('not json', { findings, final: true }).result, { status: 'READY', groups: [] });
  // A missing status is no READY: an answer may name unfinished work without one.
  assert.match(evaluateGrouping(JSON.stringify({ groups: [], continuation: 'not finished' }), { findings }).issues.join('\n'), /status must be READY: this pass has no continuation/);
  // The pass has one answer and no continuation: another status goes back, and after the repairs the groups it named stand.
  const early = JSON.stringify({ status: 'CONTINUE', continuation: 'F-5 is still to be read.', groups: [{ findingIds: ['F-4', 'F-6'] }] });
  assert.match(evaluateGrouping(early, { findings }).issues.join('\n'), /status must be READY: this pass has no continuation/);
  const stopped = evaluateGrouping(early, { findings, final: true });
  assert.deepEqual([stopped.result, stopped.issues, stopped.corrections], [{ status: 'READY', groups: [['F-4', 'F-6']] }, [], [{ action: 'accept-grouping-without-ready', status: 'CONTINUE' }]]);
  assert.match(groupingRepairPrompt(['group F-1, F-9: F-9 is not in findings.']), /this grouping needs correction[\s\S]*- group F-1, F-9[\s\S]*leave them out of every group/);
});

eachKind('automatic publication posts ordinary links and markup in examples, and leaves mentions, images, embedded content and script links to a person', (t, { make }) => {
  const plan = texts => assemblePlan(make(texts.map((_, index) => finding(`F-${index + 1}`))),
    [{ comments: texts.map((text, index) => comment({ findingId: `F-${index + 1}`, anchor: `line ${index}`, body: `🔴 high: Issue ${index}\n\n${text}` })), skipped: [] }]);
  const plain = [
    '`List<String>` drops `Map<String, List<Integer>>` entries when `i < a && j > b`.',
    'Use Optional<T>, <T extends Comparable<T>> and vector<int>; Result<(), Error> too.',
    'A decorator @property, an email user@example.com, work item #12, PR !34 and `if (!a[0])`.',
    'Path /src/a.ts:12, index.md and `handlers[name](event)`; ratio 3 < 4 > 2.',
    // Ordinary links are posted, however they are written.
    'See https://learn.microsoft.com/dotnet/api for details; the client calls `https://api.example.com/v1`.',
    'Visit www.example.com, mail <help@outside.example> or read [docs](//outside.example/a).',
    '> [details][ref]\n>\n> [ref]: &#47;&#47;outside.example/report',
    'Clone ssh://git.example/repo and see [mail](mailto:someone@example.com) or [x](https&#58;//outside.example).',
    // Markup that neither loads content nor runs a script is posted too.
    'Markup in examples: `<input name="id">`, <a href="/x">click</a>, <button type="submit">, <div class="x">.',
    'Hearts <3, a < b > c, Map<K, V>, <https://learn.microsoft.com/x> and <p title="a > b">.',
    'Tab-separated: java\tdata\tvalue, and the script: field.',
  ];
  const clean = plan(plain);
  assert.ok(publicationItems(clean).every(item => /<!-- azpr-comment:[a-f0-9]{32} -->$/.test(item.content)), 'Every item carries its marker.');
  assert.deepEqual(automaticPublicationProblems(clean), [], 'Plain text, ordinary links, harmless markup and the marker pass.');
  for (const [text, kind] of [
    ['[x](javascript:alert(1))', 'a script, data or local-file link'],
    ['[x](VBScript:msgbox)', 'a script, data or local-file link'],
    ['[x](data:text/html;base64,PHNjcmlwdD4=)', 'a script, data or local-file link'],
    ['Open file:///etc/passwd', 'a script, data or local-file link'],
    // CommonMark decodes escapes and character references in link destinations and text.
    ['[x](java&#115;cript:alert(1))', 'a script, data or local-file link'],
    ['[x](javascript\\:alert(1))', 'a script, data or local-file link'],
    // A browser drops tabs and line breaks from a URL, written or as references, which it decodes in raw HTML
    // with any number of digits and without a semicolon.
    ...['java&#9;script:', 'java\tscript:', 'jav\nascript:', 'java&#x0A;script:', 'java&Tab;script:', 'java&NewLine;script:',
      'java&#0000000009;script:', 'java&#x0000000009;script:', 'java&#9script:', 'vb&#13;script:', 'da&#9;ta:text/html,x', 'fi&#9;le:///etc'].map(url =>
      [`<a href="${url}f()">x</a>`, 'a script, data or local-file link']),
    ['Ping @<6D6A2A6A-0000-0000-0000-000000000000> about it.', 'an @mention'],
    ['Ask @&lt;6D6A2A6A-0000-0000-0000-000000000000&gt;.', 'an @mention'],
    ['![diagram](diagram.png)', 'an image'],
    ['if (![a].length)', 'an image'], // The literal check prefers this false alarm outside code.
    ['<img src=x onerror=alert(1)>', 'HTML that embeds content or runs a script'],
    ['<script>steal()</script>', 'HTML that embeds content or runs a script'],
    ['<div onclick="x()">text</div>', 'HTML that embeds content or runs a script'],
    ['<IFRAME>', 'HTML that embeds content or runs a script'],
    ['<video poster="p.png">', 'HTML that embeds content or runs a script'],
    ['<input type="image" src="https://outside.example/a.png">', 'HTML that embeds content or runs a script'],
    ['<p style="background:url(x)">', 'HTML that embeds content or runs a script'],
    ['hidden <!-- note --> text', 'HTML that hides text'],
    // Declarations, processing instructions and malformed end tags become hidden comments in a browser.
    ['<?php echo $x ?> runs', 'HTML that hides text'], ['<!DOCTYPE x> here', 'HTML that hides text'],
    ['a <![CDATA[ x ]]> b', 'an image and HTML that hides text'], // `![` also reads as an image.
    ['text </ hidden> more', 'HTML that hides text'],
    // Attributes are read as a browser reads them: quoted values may hold < and >, slashes separate
    // attributes, and a tag name runs to a space, slash or >.
    ['<p title=">" onMouseOver="f()">', 'HTML that embeds content or runs a script'],
    ["<p title='</div>' onclick='f()'>", 'HTML that embeds content or runs a script'],
    ['<x y=">" z=a"b onclick=f()>', 'HTML that embeds content or runs a script'],
    ['<p/onclick="f()">', 'HTML that embeds content or runs a script'],
    ['<div>\n<https:x onclick=f()>\n</div>', 'HTML that embeds content or runs a script'],
    // Only ASCII whitespace separates attributes, so the value runs on past a no-break space.
    ['<p t=">" a=x\u00a0b="y onclick=f()">', 'HTML that embeds content or runs a script'],
    // A renderer shows the unfinished first tag as text, so the second one is a tag of its own.
    ['x <p title="\n`y`<p title=\'<\' onmouseover=\'f()\'>', 'HTML that embeds content or runs a script'],
  ]) assert.deepEqual(automaticPublicationProblems(plan([text])).map(problem => problem.reason), [`the comment for F-1 (/src/a.ts:2) contains ${kind}`], text);
  // A decoded character never forms markup, and AZPR's own escaping of <!-- stays text.
  for (const text of ['Kept &lt;!-- note --&gt; as text.', 'Shown as &#60;img src=x&#62; text.', 'Paths C:\\Users\\dev and \\d+\\.\\d+; a &amp; b; &constructor; &nbsp;',
    '`y = arr[i]: z` and List<@NonNull String> stay text.', '> A quoted note\n> - with a list item']) {
    assert.deepEqual(automaticPublicationProblems(plan([text])), [], text);
  }
  // Each problem names its item; the summary is checked like an inline comment, and several kinds are named together.
  const noted = assemblePlan(make([finding('F-1')]), [{ comments: [], skipped: [{ findingId: 'F-1', reason: 'x' }], summary: 'Ask @<6D6A2A6A-0000-0000-0000-000000000000> and see ![i](y)' }]);
  assert.deepEqual(automaticPublicationProblems(noted), [{ marker: noted.summary.marker, reason: 'the PR summary contains an @mention and an image' }]);
  const combined = assemblePlan(make([finding('F-1'), finding('F-2')]), [{ comments: [comment({ findingIds: ['F-1', 'F-2'], body: '🔴 high: x\n\n<b onmouseover=x>' })], skipped: [] }]);
  assert.deepEqual(automaticPublicationProblems(combined), [{ marker: combined.comments[0].marker, reason: 'the comment for F-1, F-2 (/src/a.ts:2) contains HTML that embeds content or runs a script' }]);
  const mixed = plan(['Plain text.', '![d](d.png)']);
  assert.deepEqual(automaticPublicationProblems(mixed).map(problem => problem.marker), [mixed.comments[1].marker], 'Only the item with the image is held.');
});

eachKind('automatic publication posts literal code, and checks code it cannot tell apart from markup', (t, { make }) => {
  const held = text => automaticPublicationProblems(assemblePlan(make([finding('F-1')]), [{ comments: [comment({ body: `🔴 high: Issue\n\n${text}` })], skipped: [] }]))
    .map(problem => problem.reason.replace('the comment for F-1 (/src/a.ts:2) contains ', ''));
  // Fenced code blocks and code spans render as text.
  for (const text of [
    'The avatar has no alternative text: `<img src="avatar.png">`. Add an alt attribute.',
    'The old URL remains in this source example:\n\n```html\n<script src="old.js"></script>\n```',
    'The documentation uses a broken relative path:\n\n```markdown\n![diagram](../missing.png)\n```',
    'This span hides the failure message: `<span style="display:none">failure</span>`.',
    'Without a blank line:\n```js\nel.innerHTML = "<img src=x onerror=f()>";\n```\nAfter the fence, `javascript:void(0)` and `data:text/html,x`.',
    '~~~\n<iframe src="x"></iframe>\n~~~', '````\n```\n<img src=x>\n```\n````', 'Unclosed:\n\n```\n<script>x()</script>',
    '```\ncode\n    ```\n<img src=x onerror=f()>', '``a ` <img src=x> ``', 'See [docs](https://learn.microsoft.com/x) and `<img src=x>`.',
    '- item `<img src=x>`\n> quoted `<script>`\n# Heading `![a](b)`', '| a | b |\n|---|---|\n| `<img src=x>` | c |',
    '\\\\`<img src=x>`', '```\r\n<img src=x>\r\n```\r\nafter',
  ]) assert.deepEqual(held(text), [], text);
  // Where the pairing of backticks or the end of a fence is not certain, the text stays checked.
  for (const [text, kind] of [
    ['\\`<img src=x onerror=f()>`', 'HTML that embeds content or runs a script'], // An escaped backtick opens nothing.
    ['a `b\nc` <img src=x onerror=f()> `d`', 'HTML that embeds content or runs a script'], // The first span crosses lines,
    ['x `<img src=x onerror=f()>\n# y` z', 'HTML that embeds content or runs a script'], // and a heading ends a paragraph.
    ['a ` <img src=x onerror=f()>', 'HTML that embeds content or runs a script'],
    ['[t](x`y) <img src=x onerror=f()>`', 'HTML that embeds content or runs a script'], // The destination swallows a backtick.
    ['see <p title="`" onmouseover="f()" x="`">', 'HTML that embeds content or runs a script'], // So does an attribute value.
    ['see <p title="`" onclick="f()"\nx="`">', 'HTML that embeds content or runs a script'],
    ['https://a.example/`x <img src=x onerror=f()>`', 'HTML that embeds content or runs a script'], // A bare address may be linked first,
    ['https://a.example/\\``<img src=x onerror=f()>`', 'HTML that embeds content or runs a script'], // with escapes and backticks,
    ['https://a.example/\\<p title="`" onclick="f()" x="`">', 'HTML that embeds content or runs a script'], // so the backslash escapes nothing.
    ['| 🔴🔴 | h |\n|---|---|\n| `|<img src=x onerror=f()>` |', 'HTML that embeds content or runs a script'], // Offsets count UTF-16 units.
    ['$a`$ <img src=x onerror=f()> `', 'HTML that embeds content or runs a script'], // Math may take the first backtick.
    ['| a | b |\n|---|---|\n| `x | <img src=x onerror=f()> | y` |', 'HTML that embeds content or runs a script'], // Cells split first.
    ['<div>\n```\n<img src=x onerror=f()>\n```\n</div>', 'HTML that embeds content or runs a script'], // An HTML block holds the fence.
    ['- item\n  ```\n<img src=x onerror=f()>\n  ```', 'HTML that embeds content or runs a script'], // The list item ends the fence.
    [' ```\nok\n```\n<img src=x onerror=f()>\n```', 'HTML that embeds content or runs a script'],
    ['```\ncode\n   ```\n<img src=x onerror=f()>', 'HTML that embeds content or runs a script'],
    ['```a|b\n---|---\n<img src=x onerror=f()>', 'HTML that embeds content or runs a script'], // A table header, not a fence.
    ['```x`y\n<img src=x onerror=f()>', 'HTML that embeds content or runs a script'], // A backtick in the info string: no fence.
    ['| a | b |\n|---|---|\n```\n<img src=x onerror=f()>\n```', 'HTML that embeds content or runs a script'],
    ['```\r\n<img src=x>\r\n```\r\n<img src=x onerror=f()>', 'HTML that embeds content or runs a script'], // The fence ends at a CRLF closer.
    ['[`![a](b.png)` x\n<b>`', 'an image'], // The HTML line continues the paragraph; markdown-it then shows no code span.
    ['`@<6D6A2A6A-0000-0000-0000-000000000000>` and\n```\n@<6D6A2A6A-0000-0000-0000-000000000000>\n```', 'an @mention'],
  ]) assert.deepEqual(held(text), [kind], text);
  // The summary is read the same way.
  const noted = assemblePlan(make([finding('F-1')]), [{ comments: [], skipped: [{ findingId: 'F-1', reason: 'x' }], summary: 'Escape `<script>` in templates.' }]);
  assert.deepEqual(automaticPublicationProblems(noted), []);
});

test('automatic publication reads long tag-like text in linear time', () => {
  // Reading again from every < would take seconds for each of these; a linear reading takes milliseconds.
  for (const [text, held] of [['<a'.repeat(100000), false], [`x <p title="${'<a'.repeat(100000)}">`, false], ['<a b="'.repeat(40000), false],
    ['x <a/'.repeat(50000), false], [`<p t=">" on${'c'.repeat(200000)}=f()>`, true]]) {
    const started = performance.now();
    const problems = automaticPublicationProblems({ summary: { kind: 'summary', marker: 'm', content: text }, comments: [] });
    const milliseconds = performance.now() - started;
    assert.ok(milliseconds < 2000, `${text.slice(0, 12)}…: ${Math.round(milliseconds)} ms`);
    assert.equal(problems.length > 0, held, text.slice(0, 12));
  }
});

test('automatic publication finds nothing new when every finding is already discussed on the PR', () => {
  const live = [{ threadId: 281 }, { threadId: 290 }];
  const plan = skipped => ({ summary: { kind: 'summary', content: 'Summary.' }, comments: [], skipped });
  const discussed = (id, threadId = 281) => ({ findingId: id, reason: `Thread ${threadId} covers it.`, cause: 'existing-thread', threadId });
  assert.equal(automaticPublicationRepeats(plan([discussed('F-1'), discussed('F-2', 290), discussed('F-3')]), live),
    'every finding is already discussed on the PR (thread 281, thread 290)');
  for (const [label, value, threads] of [
    ['an inline comment is new', { ...plan([discussed('F-1')]), comments: [{ findingId: 'F-2' }] }, live],
    ['another cause', plan([discussed('F-1'), { findingId: 'F-2', reason: 'Low severity.', cause: 'low-severity' }]), live],
    ['a skip without a cause', plan([discussed('F-1'), { findingId: 'F-2', reason: 'The planner stopped.' }]), live],
    ['a thread that is not live', plan([discussed('F-1', 999)]), live],
    ['threads that could not be read', plan([discussed('F-1')]), null],
    ['nothing skipped', plan([]), live],
  ]) assert.equal(automaticPublicationRepeats(value, threads), '', label);
});

const page = (extra = {}) => ({ status: 'READY', comments: [], skipped: [], summary: 'Purpose.', summaryDetails: '', ...extra });
// The finding a row of a review's record holds: `verifiedFinding` in a verified review of 0.4.x, `finding` otherwise.
const ownFinding = disposition => disposition.verifiedFinding ?? disposition.finding;

eachKind('without adjustments the comment findings, planner input and summary are exactly those of the review', (t, { make }) => {
  const r = make([finding('F-1'), finding('F-2', 'low')]);
  assert.deepEqual(commentFindings(r), publishableFindings(r));
  assert.equal(adjustmentInput(r), undefined);
  assert.equal(describeAdjustments(r), '');
  assert.equal(hasAdjustments(r), false);
  assert.equal(everyFindingExcluded(r), false);
  // An emptied record, as --reset leaves it, is the same as none.
  const reset = { ...r, adjustments: { excluded: [], severity: {}, changes: [{ at: '2026-10-24T00:00:00.000Z', excluded: [], severity: {} }] } };
  assert.deepEqual(commentFindings(reset), publishableFindings(r));
  assert.equal(adjustmentInput(reset), undefined);
  assert.equal(hasAdjustments(reset), false);
  assert.deepEqual(assemblePlan(reset, [page()]), assemblePlan(r, [page()]));
});

eachKind('adjusted findings: excluded ones are left out and a changed severity replaces the review\'s, also in the summary', (t, { make }) => {
  const r = { ...make([finding('F-1'), finding('F-2'), finding('F-3', 'low')]), adjustments: { excluded: ['F-1'], severity: { 'F-2': 'low', 'F-3': 'medium' } } };
  assert.equal(hasAdjustments(r), true);
  assert.deepEqual(commentFindings(r).map(f => [f.id, f.severity]), [['F-2', 'low'], ['F-3', 'medium']]);
  assert.equal(publishableFindings(r).find(f => f.id === 'F-2').severity, 'high', 'The review itself keeps its severities.');
  const input = adjustmentInput(r);
  assert.deepEqual(input.excludedFindings, ['F-1']);
  assert.deepEqual(input.severityChanges, [{ id: 'F-2', from: 'high', to: 'low' }, { id: 'F-3', from: 'low', to: 'medium' }]);
  assert.match(input.rule, /never name, describe or allude to it/);
  const plan = assemblePlan(r, [page()]);
  assert.doesNotMatch(plan.summary.content, /F-1/);
  assert.match(plan.summary.content, /high: 0 · medium: 1 · low: 1/);
  assert.match(describeAdjustments(r), /^Adjusted by a person after the preview \(not stated on the PR\):\n- Excluded from publication: F-1\n- F-2: severity high → low\n- F-3: severity low → medium$/);
  assert.equal(everyFindingExcluded({ ...r, adjustments: { excluded: ['F-1', 'F-2', 'F-3'], severity: {} } }), true);
  assert.equal(everyFindingExcluded({ ...make([]), adjustments: { excluded: ['F-1'], severity: {} } }), false, 'A review without findings is not an excluded one.');
});

eachKind('published text that names an excluded finding gets a correction turn, then is dropped', (t, { make }) => {
  const r = { ...make([finding('F-1'), finding('F-2')]), adjustments: { excluded: ['F-1'], severity: {} } };
  const assigned = [finding('F-2')];
  const text = answer([comment({ findingId: 'F-2', body: '🔴 high: Value is lost\n\nThe same cause as F-1.' })], [],
    { summary: 'Fixes F-1 and F-2.', summaryDetails: '### Additional finding details\n\nF-1 matters too.' });
  const first = evaluatePlanPage(text, { review: r, assigned });
  assert.equal(first.issues.length, 3);
  assert.ok(first.issues.some(issue => /^comment for F-2: body names F-1, which a person excluded from publication; leave it out\.$/.test(issue)));
  assert.ok(first.issues.some(issue => /^summary names F-1, which a person excluded from publication/.test(issue)));
  assert.ok(first.issues.some(issue => /^summaryDetails names F-1, which a person excluded from publication/.test(issue)));
  const last = evaluatePlanPage(text, { review: r, assigned, final: true });
  assert.deepEqual(last.issues, []);
  assert.deepEqual(last.result.comments, []);
  assert.match(last.result.skipped[0].reason, /body names F-1, which a person excluded from publication/);
  assert.equal(last.result.summary, undefined);
  assert.equal(last.result.summaryDetails, '');
  assert.ok(last.corrections.some(c => c.action === 'drop-summary-note-naming-excluded'));
  assert.ok(last.corrections.some(c => c.action === 'drop-summary-details-naming-excluded'));
  // A comment for the excluded finding itself is not assigned, so it is dropped.
  const stray = evaluatePlanPage(answer([comment(), comment({ findingId: 'F-2', body: '🔴 high: Value is lost' })]), { review: r, assigned, final: true });
  assert.deepEqual(stray.result.comments.map(c => c.findingId), ['F-2']);
  assert.ok(stray.corrections.some(c => c.action === 'drop-unassigned-comment'));
  // Without adjustments the same text is accepted as before.
  assert.deepEqual(evaluatePlanPage(text, { review: make([finding('F-1'), finding('F-2')]), assigned }).issues, []);
});

eachKind('adjustment requests name publishable findings and replace whole lists', (t, { make, none }) => {
  const base = make([finding('F-1'), finding('F-2'), finding('R-1', 'medium')]);
  // Rows that are no findings to adjust: a report merged into another one, and a claim the review did not let
  // through (a verifier's rejection in 0.4.x; in this pipeline one the runtime could not check).
  const refused = none ? { id: 'F-9', status: 'NEEDS_INFO', reason: 'The location check failed. [Runtime: not eligible for comments.]', partialFinding: body('F-9') }
    : { id: 'F-9', status: 'REJECTED', reason: 'Not reachable.' };
  base.final.dispositions.push({ id: 'R-2', status: 'MERGED', mergedInto: 'F-1', reason: 'Same cause.' }, refused);
  assert.throws(() => resolveAdjustments(base, { exclude: ['F-7'] }),
    /^Error: \[AZPR\] Nothing was changed: F-7 is not a finding of review abcdef12\. Findings of review abcdef12 you can adjust: F-1, F-2, R-1\.$/);
  assert.throws(() => resolveAdjustments(base, { exclude: ['R-2'] }), /R-2 was merged into F-1; adjust F-1 instead/);
  assert.throws(() => resolveAdjustments(base, { severity: { 'F-9': 'low' } }), new RegExp(`F-9 is ${none ? 'NEEDS_INFO' : 'REJECTED'}, not a finding this review can publish`));
  assert.throws(() => resolveAdjustments(base, { exclude: ['F-1'], severity: { 'F-1': 'low' } }), /F-1 cannot be excluded and given a severity at once/);
  const first = resolveAdjustments(base, { exclude: ['R-1', 'F-1'], severity: { 'F-2': 'medium' } });
  assert.deepEqual(first.next, { excluded: ['F-1', 'R-1'], severity: { 'F-2': 'medium' } });
  assert.deepEqual(first.changes, ['excluded F-1', 'excluded R-1', 'F-2 severity high → medium']);
  const adjusted = { ...base, adjustments: first.next };
  // A list the request names replaces the saved one; the other list is kept.
  const restore = resolveAdjustments(adjusted, { exclude: ['F-1'] });
  assert.deepEqual(restore.next, { excluded: ['F-1'], severity: { 'F-2': 'medium' } });
  assert.deepEqual(restore.changes, ['restored R-1']);
  // A severity for an excluded finding restores it; excluding a finding drops its severity change.
  const restored = resolveAdjustments(adjusted, { severity: { 'F-1': 'low' } });
  assert.deepEqual(restored.next, { excluded: ['R-1'], severity: { 'F-1': 'low' } });
  assert.deepEqual(restored.changes, ['restored F-1', 'F-1 severity high → low', 'F-2 severity medium → high']);
  assert.deepEqual(resolveAdjustments(adjusted, { exclude: ['F-2'] }).next, { excluded: ['F-2'], severity: {} });
  // The review's own severity is no change, and a request that changes nothing says so.
  assert.deepEqual(resolveAdjustments(base, { severity: { 'F-1': 'high' } }).next.severity, {});
  assert.equal(resolveAdjustments(base, { severity: { 'F-1': 'high' } }).unchanged, true);
  assert.equal(resolveAdjustments(adjusted, { exclude: ['F-1', 'R-1'], severity: { 'F-2': 'medium' } }).unchanged, true);
  const reset = resolveAdjustments(adjusted, { reset: true });
  assert.deepEqual(reset.next, { excluded: [], severity: {} });
  assert.deepEqual(reset.changes, ['restored F-1', 'restored R-1', 'F-2 severity medium → high']);
});

test('publication has started once an item was sent, may have landed or was found on the PR', () => {
  assert.equal(publicationStarted({}), false);
  assert.equal(publicationStarted({ publication: new Map() }), false);
  assert.equal(publicationStarted({ publication: new Map([['m1', { state: 'FAILED' }]]) }), false, 'Only definite failures: nothing was created.');
  for (const state of ['SENDING', 'POSTED', 'UNCERTAIN', 'VERIFIED', 'UNVERIFIED', 'DELETED', 'ALREADY_PRESENT']) {
    assert.equal(publicationStarted({ publication: new Map([['m1', { state: 'FAILED' }], ['m2', { state }]]) }), true, state);
  }
});

eachKind('adjustments never change the review: its final record and findings stay as the review left them', (t, { make }) => {
  const r = { ...make([finding('F-1'), finding('F-2', 'low')]), adjustments: { excluded: ['F-1'], severity: { 'F-2': 'high' } } };
  const before = structuredClone(r.final);
  commentFindings(r);
  adjustmentInput(r);
  describeAdjustments(r);
  resolveAdjustments(r, { exclude: ['F-2'] });
  resolveAdjustments(r, { reset: true });
  assemblePlan(r, [page()]);
  evaluatePlanPage(answer([comment({ findingId: 'F-2' })]), { review: r, assigned: commentFindings(r), final: true });
  assert.deepEqual(r.final, before);
  assert.equal(commentFindings(r)[0].severity, 'high', 'The adjusted copy carries the new severity.');
  assert.equal(ownFinding(r.final.dispositions[1]).severity, 'low', 'The review\'s finding keeps its own.');
  assert.deepEqual(r.adjustments, { excluded: ['F-1'], severity: { 'F-2': 'high' } }, 'Resolving a request saves nothing by itself.');
});

test('the receipt note about earlier publications is empty unless the PR keeps something', () => {
  const r = review([finding('F-1')]);
  assert.equal(describeEarlierText(r, 0), '');
  const skipped = new Map([['m', { kind: 'inline', findingId: 'F-1', path: '/src/a.ts', startLine: 2, state: 'ALREADY_PRESENT' }]]);
  assert.equal(describeEarlierText({ ...r, publication: skipped }, 3), '', 'The same text, and nothing excluded.');
  const kept = new Map([['m', { kind: 'inline', findingIds: ['F-1', 'F-2'], path: '/src/a.ts', startLine: 2, state: 'ALREADY_PRESENT', earlierText: true }]]);
  assert.equal(describeEarlierText({ ...r, adjustments: { excluded: [], severity: {} }, publication: kept }, 0),
    'Already on the PR with earlier text, which AZPR does not change, so this preview is not what the PR shows there: F-1, F-2 at /src/a.ts:2. Edit them on the PR if they should change.\n');
  assert.match(describeEarlierText({ ...r, adjustments: { excluded: ['F-1'], severity: {} }, publication: new Map() }, 2), /^The PR has 2 other AZPR comment\(s\) from earlier publications/);
});

eachKind('posted text that names an excluded finding is found, also in the summary rows the runtime renders', (t, { make }) => {
  const cross = make([finding('F-1'), finding('F-2', 'low', { summary: 'Retry failure continues after the F-1 guard is restored' })]);
  const adjusted = { ...cross, adjustments: { excluded: ['F-1'], severity: {} } };
  adjusted.plan = assemblePlan(adjusted, [page()]);
  assert.deepEqual(excludedReferences(adjusted), ['the PR summary names F-1 (in the summary row of F-2)']);
  // Without exclusions, or without a reference, nothing holds the preview.
  assert.deepEqual(excludedReferences({ ...cross, plan: assemblePlan(cross, [page()]) }), []);
  const clean = { ...make([finding('F-1'), finding('F-2')]), adjustments: { excluded: ['F-1'], severity: {} } };
  clean.plan = assemblePlan(clean, [page()]);
  assert.deepEqual(excludedReferences(clean), []);
  // A comment's text is checked as well, as a last line behind the planner checks.
  const comment = { kind: 'inline', findingId: 'F-2', path: '/src/a.ts', startLine: 2, marker: 'm', content: 'Same cause as F-1.' };
  assert.deepEqual(excludedReferences({ ...clean, plan: { ...clean.plan, comments: [comment] } }), ['the comment of F-2 at /src/a.ts:2 names F-1']);
  assert.equal(ownFinding(cross.final.dispositions[1]).summary, 'Retry failure continues after the F-1 guard is restored', 'The review keeps its own text.');
});

eachKind('next steps after a preview need no review ID, use the finding IDs of the review and keep what is already adjusted', (t, { make }) => {
  const commands = text => text.split('\n').slice(1, -1).map(line => line.trim().split(/\s{2,}/)[0]);
  const three = make([finding('F-1'), finding('R-2', 'medium'), finding('F-3', 'low')]);
  const plain = previewNextSteps(three);
  assert.match(plain, /^Next \(no review ID is needed while abcdef12 is this conversation's current review\):\n/);
  assert.match(plain, /\nEach --exclude or --severity list replaces the saved one\. For another review add its ID; \/pr-comment --list shows them\.$/);
  assert.deepEqual(commands(plain), ['/pr-comment --publish', '/pr-comment --exclude F-1,R-2', '/pr-comment --severity F-1=low', '/pr-comment --show']);
  // An example list keeps what is saved: running it must not undo an earlier adjustment.
  const adjusted = { ...three, adjustments: { excluded: ['F-1'], severity: { 'R-2': 'low' } } };
  assert.deepEqual(commands(previewNextSteps(adjusted)), ['/pr-comment --publish', '/pr-comment --exclude F-1,R-2', '/pr-comment --severity R-2=low,F-3=medium', '/pr-comment --reset', '/pr-comment --show']);
  assert.match(previewNextSteps(adjusted), /leave R-2 out as well, then read the new preview/);
  assert.match(previewNextSteps(adjusted), /publish F-3 as medium, then read the new preview/, 'A low finding is offered the next level up.');
  // Every remaining finding already has a changed level: the example changes the first again and keeps the other.
  const both = { ...make([finding('F-1'), finding('R-2')]), adjustments: { excluded: [], severity: { 'F-1': 'low', 'R-2': 'medium' } } };
  assert.ok(commands(previewNextSteps(both)).includes('/pr-comment --severity R-2=medium,F-1=medium'));
  // A held preview is not offered for publication; nothing left to post offers only the way back.
  assert.equal(commands(previewNextSteps(three, { held: true })).includes('/pr-comment --publish'), false);
  const none = { ...make([finding('F-1')]), adjustments: { excluded: ['F-1'], severity: {} } };
  assert.deepEqual(commands(previewNextSteps(none)), ['/pr-comment --reset', '/pr-comment --show']);
  // A review without findings previews a summary only.
  assert.deepEqual(commands(previewNextSteps(make([]))), ['/pr-comment --publish', '/pr-comment --show']);
});

eachKind('the same next steps travel as data for the terminal panel: what can be posted, and each finding as it is adjusted', (t, { make }) => {
  const three = { ...make([finding('F-1'), finding('R-2', 'medium', { summary: 'A summary\nover two lines   with spaces' }), finding('F-3', 'low')]),
    snapshot: { head, base: 'a'.repeat(40), files: ['/src/a.ts'], prId: 7, project: 'proj', repository: 'repo' },
    plan: { summary: { kind: 'summary', marker: 's' }, comments: [{ marker: 'a' }, { marker: 'b' }], skipped: [] } };
  assert.deepEqual(previewActions(three), { review: 'abcdef12', state: commentToken(three), target: 'review abcdef12 (/pr-review) of PR #7 in proj/repo', plan: false, publish: true, posts: 3, adjust: true, findings: [
    { id: 'F-1', severity: 'high', summary: 'Defect F-1' }, { id: 'R-2', severity: 'medium', summary: 'A summary over two lines with spaces' }, { id: 'F-3', severity: 'low', summary: 'Defect F-3' }] });
  // A person's adjustments: the level a finding is published at, the review's own beside it, and what is left out.
  const adjusted = { ...three, adjustments: { excluded: ['F-1'], severity: { 'R-2': 'low' } } };
  assert.deepEqual(previewActions(adjusted).findings, [{ id: 'F-1', severity: 'high', excluded: true, summary: 'Defect F-1' },
    { id: 'R-2', severity: 'low', original: 'medium', summary: 'A summary over two lines with spaces' }, { id: 'F-3', severity: 'low', summary: 'Defect F-3' }]);
  // What the text leaves out, the data leaves out: a held preview, and one with nothing left to post.
  assert.equal(previewActions(three, { held: true }).publish, false);
  assert.equal(previewActions({ ...make([finding('F-1')]), adjustments: { excluded: ['F-1'], severity: {} }, plan: { summary: null, comments: [], skipped: [] } }).publish, false);
  // A review that has no preview yet: one is planned first, so nothing can be posted, and its findings can be adjusted before it.
  const unplanned = previewActions(make([finding('F-1')]));
  assert.deepEqual([unplanned.plan, unplanned.publish, unplanned.posts, unplanned.adjust, unplanned.findings.map(item => item.id)], [true, false, 0, true, ['F-1']]);
  // Once publication has started the findings are not adjusted any more.
  assert.equal(previewActions({ ...three, publication: new Map([['s', { state: 'POSTED' }]]) }).adjust, false);
  assert.equal(previewActions({ ...three, publication: new Map([['s', { state: 'FAILED' }]]) }).adjust, true, 'A definite failure created nothing.');
  // A summary is cut, never a list: a review with more findings than the panel lists is adjusted with typed commands.
  assert.equal(previewActions(make([finding('F-1', 'high', { summary: 'x'.repeat(500) })])).findings[0].summary.length, 160);
  assert.equal(previewActions(make(Array.from({ length: 200 }, (_, index) => finding(`F-${index + 1}`)))).findings.length, 200);
  assert.equal(previewActions(make(Array.from({ length: 201 }, (_, index) => finding(`F-${index + 1}`)))), undefined);
  // No model reads it, and it holds nothing but what the review's own text says of each finding.
  assert.deepEqual(Object.keys(previewActions(three).findings[0]), ['id', 'severity', 'summary']);
});

eachKind('one word names a review\'s preview and adjustments: another preview or another adjustment is another word', (t, { make }) => {
  const planned = { ...make([finding('F-1'), finding('R-2', 'medium')]), plan: { summary: null, comments: [], skipped: [] }, planCreatedAt: '2026-11-19T01:02:03.004Z' };
  const word = commentToken(planned);
  assert.match(word, /^[a-f0-9]{12}$/);
  // The same review says the same word, also from its saved record after a restart, and whatever else it holds.
  assert.equal(commentToken(JSON.parse(JSON.stringify(planned))), word);
  assert.equal(commentToken({ ...planned, usedAt: 'later', publication: new Map([['s', { state: 'POSTED' }]]), commentEvidence: ['x'] }), word, 'Posting what was shown again is still that preview.');
  // Planned again, not planned at all, or another review: another word.
  const others = [{ ...planned, planCreatedAt: '2026-11-19T01:02:03.005Z' }, { ...planned, plan: null }, { ...planned, id: 'abcdef13' },
    // Adjusted: a finding left out, a level changed, and each list by its content, not by the order it was typed in.
    { ...planned, adjustments: { excluded: ['F-1'], severity: {} } }, { ...planned, adjustments: { excluded: [], severity: { 'R-2': 'low' } } },
    { ...planned, adjustments: { excluded: ['F-1'], severity: { 'R-2': 'low' } } }, { ...planned, adjustments: { excluded: ['F-1'], severity: { 'R-2': 'high' } } }];
  const words = others.map(commentToken);
  assert.equal(new Set([word, ...words]).size, others.length + 1);
  assert.equal(commentToken({ ...planned, adjustments: { excluded: ['R-2', 'F-1'], severity: { 'R-2': 'low', 'F-1': 'high' } } }),
    commentToken({ ...planned, adjustments: { excluded: ['F-1', 'R-2'], severity: { 'F-1': 'high', 'R-2': 'low' } } }));
  // Adjustments that were reset are none: the word is that of the review before them, with the preview planned since.
  assert.equal(commentToken({ ...planned, adjustments: { excluded: [], severity: {}, changes: [{ at: 'x', excluded: ['F-1'], severity: {} }] } }), word);
  // The offer carries it.
  assert.equal(previewActions(planned).state, word);
});
