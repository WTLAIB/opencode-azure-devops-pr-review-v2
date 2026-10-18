import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePlanPage, assemblePlan, inlineMarker, summaryMarker, normalizeTitle, restoreAnchor, confirmedFindings, publicationItems,
  publishableFindings, reviewVerification, combinationProblems,
  INLINE_SOFT_LIMIT, INLINE_HARD_LIMIT,
} from '../src/comments.mjs';
import { parsePullRequestUrl } from '../src/azure.mjs';

const target = parsePullRequestUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/7');
const head = 'b'.repeat(40);
const finding = (id, severity = 'high', extra = {}) => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/a.ts:2', severity, suggestion: 's', ...extra });
const review = (findings = [finding('F-1')], toolText = []) => ({
  id: 'abcdef12', target, outputLanguage: 'en', attribution: 'AI-generated review; Models: `x/y`',
  snapshot: { head, base: 'a'.repeat(40), files: ['/src/a.ts', '/src/b.ts'] },
  final: { dispositions: findings.map(f => ({ id: f.id, status: 'CONFIRMED', reason: 'ok', verifiedFinding: f })), newFindings: [] },
  toolText,
});
const comment = (extra = {}) => ({ findingId: 'F-1', severity: 'high', path: '/src/a.ts', startLine: 2, endLine: 2, anchor: 'const value = load();', body: '🔴 high: Value is lost\n\nBody.', ...extra });
const answer = (comments, skipped = [], extra = {}) => JSON.stringify({ status: 'READY', comments, skipped, ...extra });

test('titles are normalized to the verified severity label without double prefixes', () => {
  assert.equal(normalizeTitle('🔴 High: Title', 'high'), '🔴 high: Title');
  assert.equal(normalizeTitle('**🟡 medium: Title**', 'medium'), '🟡 medium: **Title**');
  assert.equal(normalizeTitle('issue (high): Title', 'high'), '🔴 high: Title');
  assert.equal(normalizeTitle('Plain title', 'medium'), '🟡 medium: Plain title');
});

test('a clean page is accepted; formatting slips are corrected instead of failing the page', () => {
  const r = review([finding('F-1'), finding('F-2', 'medium')]);
  const { result, issues, corrections } = evaluatePlanPage(answer([
    comment({ severity: 'HIGH', path: 'src/a.ts', body: 'High: lost value <!-- hidden -->' }),
    comment({ findingId: 'F-2', severity: 'high', startLine: 5, endLine: 9, anchor: 'line five\nline six', body: 'Medium thing' }),
  ]), { review: r, assigned: r.final.dispositions.map(d => d.verifiedFinding) });
  assert.deepEqual(issues, []);
  assert.equal(result.comments[0].path, '/src/a.ts');
  assert.equal(result.comments[0].body, '🔴 high: lost value &lt;!-- hidden --&gt;');
  assert.equal(result.comments[1].severity, 'medium', 'The verified severity wins.');
  assert.equal(result.comments[1].endLine, 6, 'The end line follows the quoted anchor.');
  assert.ok(corrections.some(c => c.action === 'use-verified-severity'));
  assert.ok(corrections.some(c => c.action === 'derive-end-line-from-anchor'));
});

test('real problems become repair issues first, then per-item skips on the final pass', () => {
  const r = review([finding('F-1'), finding('F-2'), finding('F-3')]);
  const assigned = r.final.dispositions.map(d => d.verifiedFinding);
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
  const huge = evaluatePlanPage(answer([comment({ body: 'x'.repeat(INLINE_HARD_LIMIT + 1) })]), { review: review(), assigned: [finding('F-1')], final: true });
  assert.equal(huge.result.comments.length, 0);
  assert.match(huge.result.skipped[0].reason, /exceeds/);
});

test('low-severity and unknown findings never become inline comments', () => {
  const r = review([finding('F-1', 'low')]);
  const { result, issues, corrections } = evaluatePlanPage(answer([comment(), comment({ findingId: 'R-9' })]), { review: r, assigned: [finding('F-1', 'low')] });
  assert.deepEqual(issues, []);
  assert.equal(result.comments.length, 0);
  assert.match(result.skipped[0].reason, /Low-severity/);
  assert.ok(corrections.some(c => c.action === 'drop-unassigned-comment'));
});

test('a skip that relies on another finding of this review gets a correction turn', () => {
  // As in a live PR #3 plan: R-12001 skipped because F-1009's comment on an earlier page "covered" it.
  const r = review([finding('F-1009'), finding('R-12001', 'medium'), finding('F-1'), finding('F-10')]);
  const assigned = [finding('R-12001', 'medium'), finding('F-10')];
  const text = answer([], [{ findingId: 'R-12001', cause: 'existing-thread', reason: '已由先前頁面的F-1009 inline 留言覆蓋相同根因。' }, { findingId: 'F-10', cause: 'existing-thread', threadId: 42, reason: 'Already discussed in thread 42; F-10 is UTF-8 safe there (TF401174).' }]);
  const first = evaluatePlanPage(text, { review: r, assigned });
  assert.equal(first.issues.length, 1, 'Only the skip that names another finding is sent back; F-10 may name itself and is not read as F-1.');
  assert.match(first.issues[0], /skip for R-12001 relies on F-1009: findings of this review are separate issues/);
  assert.deepEqual(first.result.skipped.map(s => s.findingId), ['F-10']);
  const final = evaluatePlanPage(text, { review: r, assigned, final: true });
  assert.deepEqual(final.issues, []);
  assert.deepEqual(final.result.skipped.map(s => s.findingId), ['R-12001', 'F-10']);
  assert.match(final.result.skipped[0].reason, /\[Runtime: other findings of this review do not cover this one; it remains in the summary index\.\]$/);
  assert.ok(final.corrections.some(c => c.action === 'keep-skip-citing-other-finding' && c.cited.join() === 'F-1009'));
});

test('a skip names its cause, and the runtime checks the facts the cause states', () => {
  // As in a live PR #3 plan: F-1 skipped for "no source passage" while the page showed its whole file.
  const r = review([finding('F-1', 'medium', { location: 'head:/src/a.ts:18' }), finding('F-2', 'low'), finding('F-3'), finding('F-4'), finding('F-5', 'high', { location: 'head:/src/b.ts:2' })]);
  const assigned = r.final.dispositions.map(d => d.verifiedFinding);
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

test('CONTINUE checkpoints, INCOMPLETE pages and unparseable answers degrade safely', () => {
  const r = review([finding('F-1'), finding('F-2')]);
  const assigned = r.final.dispositions.map(d => d.verifiedFinding);
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
  const r = review([finding('F-1')], [{ input: { path: '/src/a.ts', version: head }, output: 'x\nx\n' }]);
  const page = evaluatePlanPage(answer([comment({ anchor: 'x', startLine: 9, endLine: 9 })]), { review: r, assigned: [finding('F-1')] });
  assert.ok(page.issues.some(issue => /appears several times/.test(issue)));
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

test('assemblePlan builds exact saved content, offsets, ordinals and one summary', () => {
  const r = review([finding('F-1'), finding('F-2'), finding('F-3', 'low')]);
  const plan = assemblePlan(r, [
    { comments: [comment(), comment({ findingId: 'F-2', body: '🔴 high: Second issue on the same line' })], skipped: [{ findingId: 'F-3', reason: 'Low severity.' }], summary: 'Purpose of the change.', summaryDetails: '### 💡 Improvement suggestions\n\n- Idea.' },
  ]);
  assert.equal(plan.comments.length, 2);
  assert.notEqual(plan.comments[0].marker, plan.comments[1].marker, 'Two comments on identical lines get distinct ordinals.');
  for (const item of plan.comments) {
    assert.ok(item.content.endsWith(item.marker));
    assert.match(item.content, /AI-generated review/);
    assert.equal(item.startOffset, 1);
    assert.equal(item.endOffset, 'const value = load();'.length);
  }
  assert.equal(plan.summary.kind, 'summary');
  assert.match(plan.summary.content, /^🤖 AI-generated review/);
  assert.match(plan.summary.content, /\*\*Review notes\*\*\n\nPurpose of the change\./);
  assert.match(plan.summary.content, /F-3/, 'Low findings stay in the index.');
  assert.match(plan.summary.content, /Improvement suggestions/);
  assert.deepEqual(publicationItems(plan).map(item => item.kind), ['summary', 'inline', 'inline']);
  assert.equal(confirmedFindings(r).length, 3);
});

const body = id => { const { id: _id, ...rest } = finding(id); return rest; };
const quickReview = (dispositions, toolText = []) => ({ ...review([]), profile: 'quick', verification: 'none', toolText,
  attribution: 'AI-generated review; not human review or approval. Review method: quick review, not independently verified. Models: `x/y`',
  final: { dispositions, newFindings: [], coverageSummary: { complete: true, unreviewedFiles: 0, filesComplete: true, reasons: [] } } });

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

test('quick inline comments need a checked location and an anchor found in the HEAD source', () => {
  const observed = [{ input: { path: '/src/a.ts', version: head }, output: 'line one\nconst value = load();\n' }];
  const quick = quickReview([
    { id: 'Q-1', status: 'REPORTED', reason: 'r', finding: body('Q-1'), inline: true },
    { id: 'Q-2', status: 'REPORTED', reason: 'r', finding: body('Q-2'), inline: false },
  ], observed);
  const assigned = publishableFindings(quick);
  const page = answer([comment({ findingId: 'Q-1' }), comment({ findingId: 'Q-2' })]);
  const accepted = evaluatePlanPage(page, { review: quick, assigned });
  assert.deepEqual(accepted.issues, []);
  assert.deepEqual(accepted.result.comments.map(c => c.findingId), ['Q-1']);
  assert.match(accepted.result.skipped.find(s => s.findingId === 'Q-2').reason, /cannot carry an inline comment/);
  assert.ok(accepted.corrections.some(c => c.action === 'skip-location-without-inline'));
  // An anchor that is not in the source is a correction turn, then a skip.
  const unfound = answer([comment({ findingId: 'Q-1', anchor: 'not in the source' })], [{ findingId: 'Q-2', cause: 'no-inline-location', reason: 'Summary only.' }]);
  assert.match(evaluatePlanPage(unfound, { review: quick, assigned }).issues.join('\n'), /anchor text was not found in the HEAD source/);
  const final = evaluatePlanPage(unfound, { review: quick, assigned, final: true });
  assert.deepEqual(final.result.comments, []);
  assert.match(final.result.skipped.find(s => s.findingId === 'Q-1').reason, /No inline comment: the anchor text was not found/);
  // Verified reviews keep their behavior.
  const verified = review([finding('F-1')], observed);
  assert.deepEqual(evaluatePlanPage(answer([comment({ anchor: 'not in the source' })]), { review: verified, assigned: confirmedFindings(verified) }).issues, []);
});

test('a quick summary uses the quick disclosure and says no defects were reported', () => {
  const quick = { ...quickReview([]), summaryAttribution: 'AI-generated review; not human review or approval. Review method: quick review, not independently verified; coverage incomplete (1 changed file(s) not reviewed). Models: `x/y`' };
  const plan = assemblePlan(quick, [{ status: 'READY', comments: [], skipped: [], summaryDetails: '' }]);
  assert.match(plan.summary.content, /^🤖 AI-generated review; not human review or approval\. Review method: quick review, not independently verified; coverage incomplete \(1 changed file\(s\) not reviewed\)\./);
  assert.match(plan.summary.content, /No defects reported; this does not establish that the code is bug-free\./);
  assert.doesNotMatch(plan.summary.content, /confirmed/i);
  // The marker depends on the PR, head and inline markers only, never on the disclosure.
  assert.equal(plan.summary.marker, summaryMarker(quick.target, quick.snapshot.head, []));
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
  assert.match(refused([combined(['Q-1', 'Q-1001'])], { candidates: [] }), /only the findings of a listed mergeCandidates group/);
  // Verified reviews never combine findings.
  const verified = review([finding('F-1'), finding('F-2')], [{ input: { path: '/src/a.ts', version: head }, output: lines }]);
  assert.match(evaluatePlanPage(answer([combined(['F-1', 'F-2'], { severity: 'high' })]), { review: verified, assigned: confirmedFindings(verified), candidates }).issues.join('\n'), /only the findings of a listed mergeCandidates group/);
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
