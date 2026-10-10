import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePlanPage, assemblePlan, inlineMarker, summaryMarker, normalizeTitle, restoreAnchor, confirmedFindings, publicationItems,
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
  const text = answer([], [{ findingId: 'R-12001', reason: '已由先前頁面的F-1009 inline 留言覆蓋相同根因。' }, { findingId: 'F-10', reason: 'Already discussed in thread 42; F-10 is UTF-8 safe there (TF401174).' }]);
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
