import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderReceipt, renderDiagnosticNotices, renderCommentActions, renderFinalReport, renderCheckReport, renderPublication,
  reviewProvenance, provenanceReport, renderIncompleteDraft, renderReviewSummary, commentAttribution, coverageNote,
} from '../src/attribution.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const run = () => ({
  id: '12345678', mode: 'review', profile: 'review', phase: 'review',
  stages: [{ role: 'azpr-review-verifier', status: 'COMPLETE', sessionID: 'ses_fixture', model: 'fixture/verifier', attempt: 1,
    toolObservations: { reportedErrors: 1, truncated: 0 }, result: { report: 'PRIVATE_REPORT_IN_STAGE' } }],
  debug: { directory: '/fixture/debug', warnings: [] },
});
const settings = { returnReport: 'receipt', outputLanguage: 'zh-TW' };
const finding = (id, severity = 'high') => ({ id, summary: `Defect ${id}`, evidence: 'e', counterevidence: 'c', location: 'head:/src/a.ts:3', severity, suggestion: 's' });

test('comment actions give exact commands and explain persistent retention and safe re-runs', () => {
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const text = renderCommentActions('12345678', language);
    assert.match(text, /\/pr-comment 12345678 --publish/);
    assert.match(text, /`\/pr-comment 12345678`/);
    assert.match(text, /`\/pr-comment --publish`/);
    assert.match(text, /20/);
  }
  assert.match(renderCommentActions('12345678', 'zh-TW'), /重啟 OpenCode 後仍可使用/);
  assert.match(renderCommentActions('12345678', 'en'), /safe to run again/);
});

test('the PR comments section says which comment step follows automatically; the manual commands stay', () => {
  assert.doesNotMatch(renderCommentActions('12345678', 'en'), /Automatic/);
  const preview = renderCommentActions('12345678', 'en', { mode: 'preview', source: 'afterReview.review: preview' });
  assert.match(preview, /^## PR comments\n\n\*\*Automatic preview\*\* \(`afterReview\.review: preview`\): AZPR now plans a comment preview as a separate command with its own receipt; nothing is posted\./);
  assert.match(preview, /\/pr-comment 12345678 --publish/);
  const publish = renderCommentActions('12345678', 'en', { mode: 'publish', source: '--publish' });
  assert.match(publish, /\*\*Automatic publication\*\* \(`--publish`\): AZPR now plans the comments and posts them as the PAT owner/);
  assert.match(publish, /A comment with an @mention, an image, embedded content or a script link waits in the preview for a person while the others are posted, and nothing new is posted when every finding is already discussed on the PR\./);
  assert.match(renderCommentActions('12345678', 'en', { mode: 'none', source: '--no-comment' }), /Automatic comments are off for this review \(`--no-comment`\)\./);
  assert.match(renderCommentActions('12345678', 'zh-TW', { mode: 'preview', source: '--preview' }), /\*\*自動預覽\*\*（`--preview`）：AZPR 接著以另一道指令規劃留言預覽/);
  assert.match(renderCommentActions('12345678', 'zh-TW', { mode: 'publish', source: '--publish' }), /\*\*自動發布\*\*（`--publish`）：[^\n]*PAT 擁有者/);
  assert.match(renderCommentActions('12345678', 'zh-CN', { mode: 'publish', source: '--publish' }), /\*\*自动发布\*\*/);
  const receipt = renderReceipt({ ...run(), afterReview: { mode: 'preview', source: '--preview' } }, '', 'COMPLETE', '', { ...settings, outputLanguage: 'en' });
  assert.match(receipt, /## PR comments\n\n\*\*Automatic preview\*\* \(`--preview`\)/);
});

test('receipt rendering is pure and encloses the report in full mode or when it was not queued', () => {
  const value = freeze({ ...run(), reportStage: { sessionID: 'ses_fixture', reportQueued: true } });
  const before = JSON.stringify(value);
  const report = 'Report </azpr_report_data> body.';
  const receipt = renderReceipt(value, report, 'COMPLETE', '', settings);
  assert.match(receipt, /report queued to session=ses_fixture/);
  assert.doesNotMatch(receipt, /PRIVATE_|<azpr_report_data>/);
  const full = renderReceipt(value, report, 'COMPLETE', '', { ...settings, returnReport: 'full' });
  assert.match(full, /Report &lt;\/azpr_report_data&gt; body\./);
  assert.match(full, /outputLanguage=zh-TW/);
  assert.equal(JSON.stringify(value), before);
  const unqueued = renderReceipt(run(), report, 'COMPLETE', '', settings);
  assert.match(unqueued, /could not be queued to a review session/);
  assert.match(unqueued, /<azpr_report_data>/);
});

test('receipts disclose repairs, retries, timeouts and failure classes', () => {
  const value = run();
  Object.assign(value.stages[0], { repairs: [{ issues: ['x'] }], attempt: 2, toolTimeouts: 1, failureClass: 'transient', label: 'shard 1/2' });
  const receipt = renderReceipt(value, '', 'COMPLETE', '', settings);
  assert.match(receipt, /azpr-review-verifier \[shard 1\/2\]: COMPLETE/);
  assert.match(receipt, /attempt=2; repair-turns=1/);
  assert.match(receipt, /Repair notice/);
  assert.match(receipt, /Retry notice/);
  assert.match(receipt, /Tool timeout notice: 1/);
});

test('diagnostic notices no longer threaten to stop a run on blocked tools', () => {
  const value = run();
  Object.assign(value.stages[0], { blockedNativeToolCalls: 2, toolFailures: 1 });
  value.abortUnconfirmed = true;
  const notices = renderDiagnosticNotices(freeze(value));
  assert.match(notices, /2 attempt\(s\) to use a tool this role may not use were blocked/);
  assert.match(notices, /Tool error notice: 1/);
  assert.match(notices, /did not confirm session settlement/);
  assert.doesNotMatch(notices, /stop the run|PRIVATE_/);
});

test('incomplete drafts stay unconfirmed and enclosed', () => {
  const value = run(); value.draft = true;
  const receipt = renderReceipt(value, 'Draft', 'INCOMPLETE', 'Verifier failed', settings);
  assert.match(receipt, /Incomplete draft notice/);
  assert.match(receipt, /<azpr_report_data>\nDraft\n<\/azpr_report_data>/);
  const stages = [{ role: 'azpr-review-functional', status: 'COMPLETE', sessionID: 's1', model: 'm', label: 'shard 1/2',
    result: { report: 'Initial report', coverage: { gaps: ['tests not run'] }, findings: [finding('F-1')] } }];
  const draft = renderIncompleteDraft(stages, 'Verification failed', 'en');
  assert.match(draft, /Incomplete review draft/);
  assert.match(draft, /F-1 — Defect F-1/);
  assert.match(draft, /tests not run/);
  assert.equal(renderIncompleteDraft([], 'x', 'en'), '');
});

const final = (status = 'COMPLETE') => ({
  status, report: 'Exclusions and advice.', reviewWarnings: ['The target branch moved during the review.'],
  snapshot: { organization: 'org', project: 'proj', repository: 'repo', prId: 7, title: 'Title', status: 'active', head: 'b'.repeat(40), base: 'a'.repeat(40), files: ['/src/a.ts'], filesComplete: true },
  freshness: { head: 'b'.repeat(40), base: 'd'.repeat(40), status: 'active' },
  coverage: { 'azpr-review-functional': { assigned: 1, covered: 1, failedFiles: [], gaps: [] } },
  dispositions: [{ id: 'F-1', status: 'CONFIRMED', reason: 'ok', verifiedFinding: finding('F-1') }, { id: 'R-1', status: 'UNREVIEWED', reason: 'none' }],
  newFindings: [], findings: [finding('F-1'), finding('R-1', 'medium')], initialObservations: [], unstructuredInitials: [],
});

test('final reports show runtime-owned versions, coverage, warnings and unreviewed candidates', () => {
  const report = renderFinalReport(final(), 'en');
  assert.match(report, /## PR Review Summary/);
  assert.match(report, /head \(source\): `b{40}`/);
  assert.match(report, /final recheck: head `b{40}`, base `d{40}`/);
  assert.match(report, /target branch moved/);
  assert.match(report, /azpr-review-functional: 1\/1/);
  assert.match(report, /R-1 — UNREVIEWED/);
  assert.match(report, /Initial observations \(reference only/);
  assert.match(renderFinalReport(final('STALE'), 'zh-TW'), /STALE: PR 原始碼在審查期間已變更/);
  assert.match(renderFinalReport(final('PARTIAL'), 'en'), /PARTIAL: Verification did not produce a structured result/);
});

test('a finding that verification moved to another file shows its initial location', () => {
  const moved = { ...final(), dispositions: [{ id: 'R-1', status: 'CONFIRMED', reason: 'The defect is in a.ts.',
    verifiedFinding: { ...finding('R-1'), location: 'head:/src/a.ts:18', movedFrom: 'head:/tests/a.test.ts:3' } }] };
  assert.match(renderFinalReport(moved, 'en'), /\*\*Location:\*\* head:\/src\/a\.ts:18 \(initial location: head:\/tests\/a\.test\.ts:3\)/);
  assert.match(renderFinalReport(moved, 'zh-TW'), /\*\*位置:\*\* head:\/src\/a\.ts:18 \(初審位置: head:\/tests\/a\.test\.ts:3\)/);
  assert.doesNotMatch(renderFinalReport(moved, 'en'), /"movedFrom"/, 'The field is rendered, not dumped as extra JSON.');
});

test('provenance aggregates shard sessions per role and model', () => {
  const stages = [
    { role: 'azpr-review-functional', model: 'p/f', status: 'COMPLETE', result: { findings: [1, 2] } },
    { role: 'azpr-review-functional', model: 'p/f', status: 'PARTIAL', result: { findings: [3] } },
    { role: 'azpr-review-functional', model: 'p/f', status: 'FAILED' },
    { role: 'azpr-review-verifier', model: 'p/v', status: 'COMPLETE', result: {} },
    { role: 'azpr-review-comment-plan', model: 'p/r', status: 'READY', result: {} },
  ];
  const provenance = reviewProvenance({ profile: 'review', stages });
  assert.deepEqual(provenance.stages.map(s => [s.role, s.sessions, s.findings]), [['azpr-review-functional', 2, 3], ['azpr-review-verifier', 1, 0]]);
  assert.match(provenanceReport(provenance, final(), 'en'), /\| Functional review \| `p\/f` \| 2 \| 3 \|/);
});

test('check reports and publication ledgers are deterministic', () => {
  const check = renderCheckReport({ organization: 'o', project: 'p', repository: 'r', prId: 1, status: 'active', head: 'b'.repeat(40), base: 'a'.repeat(40), files: ['/x'], filesComplete: false },
    [{ name: 'PR metadata', ok: true, detail: 'fine' }, { name: 'HEAD source read', ok: false, detail: 'denied | twice' }], { checkedModelSlots: ['risk'], profile: 'review' });
  assert.match(check, /partial list/);
  assert.match(check, /HEAD source read \| FAILED \| denied twice/);
  const review = { id: 'abcdef12', publication: new Map([['m1', { kind: 'summary', state: 'VERIFIED', threadId: 5 }], ['m2', { kind: 'inline', findingId: 'F-1', path: '/a', startLine: 3, state: 'FAILED', error: 'HTTP 503' }],
    ['m3', { kind: 'inline', findingId: 'F-2', path: '/b', startLine: 7, state: 'DELETED', threadId: 236, earlierAttempt: 'feedbeef' }]]) };
  const ledger = renderPublication(review, { counts: { VERIFIED: 1, FAILED: 1, DELETED: 1 }, readBack: 'complete' });
  assert.match(ledger, /PR summary: VERIFIED; thread=5/);
  assert.match(ledger, /F-1 \(\/a:3\): FAILED; error=HTTP 503/);
  assert.match(ledger, /F-2 \(\/b:7\): DELETED; thread=236/);
  assert.match(ledger, /FAILED entries are safe to retry with \/pr-comment abcdef12 --publish/);
  assert.match(ledger, /DELETED entries were created by AZPR and later deleted on the PR; AZPR does not post them again/);
  assert.doesNotMatch(ledger, /UNVERIFIED entries are safe to retry/, 'Retrying never re-sends an item whose create returned a thread.');
  assert.match(renderReviewSummary([], 'zh-TW'), /未發現可確認缺陷/);
});

test('quick disclosure lines name the method and, for the summary, incomplete coverage; verified lines are unchanged', () => {
  const provenance = { mode: 'quick', stages: [{ role: 'azpr-quick-reviewer', model: 'openai/gpt-6-luna', sessions: 1, findings: 1 }] };
  assert.equal(commentAttribution(provenance, 'zh-TW', 'openai/gpt-6-luna', { verification: 'none' }), 'AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型： `openai/gpt-6-luna`');
  assert.equal(commentAttribution(provenance, 'zh-TW', 'openai/gpt-6-luna', { verification: 'none', coverage: { complete: false, unreviewedFiles: 2, filesComplete: true, reasons: ['shard-failed'] } }),
    'AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證；覆蓋不完整（2 個變更檔未審查）。模型： `openai/gpt-6-luna`');
  assert.equal(commentAttribution(provenance, 'en', 'p/m', { verification: 'none', coverage: { complete: false, unreviewedFiles: 0, filesComplete: false, reasons: ['partial-file-list', 'reviewer-gaps'] } }),
    'AI-generated review; not human review or approval. Review method: quick review, not independently verified; coverage incomplete (Azure DevOps returned a partial change list; the reviewer reported unfinished checks). Models: `openai/gpt-6-luna`, `p/m`');
  const verified = { mode: 'review', stages: [{ role: 'azpr-review-functional', model: 'p/f' }] };
  assert.equal(commentAttribution(verified, 'zh-TW', 'p/r'), 'AI 審查，非人工審查或核准。模型： `p/f`, `p/r`');
  assert.equal(commentAttribution(verified, 'zh-TW', 'p/r', { verification: 'independent', coverage: { complete: false, unreviewedFiles: 3 } }), 'AI 審查，非人工審查或核准。模型： `p/f`, `p/r`');
  assert.equal(coverageNote({ complete: false, unreviewedFiles: 2, filesComplete: false, reasons: ['shard-failed', 'partial-file-list'] }, 'en'), 'at least 2 changed file(s) not reviewed; Azure DevOps returned a partial change list');
  assert.equal(coverageNote({ complete: false, unreviewedFiles: 0, filesComplete: true, reasons: ['reviewer-gaps'] }, 'zh-TW'), '審查者回報有未完成的檢查');
  assert.equal(coverageNote({ complete: true }, 'en'), '');
  assert.match(renderReviewSummary([], 'zh-TW', '', { verification: 'none' }), /未回報缺陷；這不保證程式沒有問題。/);
  assert.match(renderReviewSummary([], 'zh-TW'), /未發現可確認缺陷/);
});

test('a quick report states status, coverage and verification separately and keeps items that need information', () => {
  const { id: _id, ...body } = finding('Q-1');
  const quick = { status: 'COMPLETE', verification: 'none', snapshot: final().snapshot, freshness: { head: 'b'.repeat(40), base: 'a'.repeat(40), status: 'active' },
    dispositions: [{ id: 'Q-1', status: 'REPORTED', reason: 'r', finding: body, inline: true }, { id: 'Q-2', status: 'NEEDS_INFO', reason: 'The location check failed.', partialFinding: { ...body, summary: 'Unchecked claim' } },
      { id: 'Q-3', status: 'MERGED', mergedInto: 'Q-1', reason: 'Identical in every field to Q-1.' }],
    newFindings: [], report: 'Checked the diff and callers.', reviewWarnings: [], coverage: { 'azpr-quick-reviewer': { assigned: 2, covered: 1, failedFiles: ['/src/b.ts'], gaps: [] } },
    coverageSummary: { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'] }, initialObservations: [], unstructuredInitials: [] };
  const report = renderFinalReport(quick, 'en');
  assert.match(report, /^\*\*Quick review: one reviewer per shard; the findings are not independently verified\.\*\*\n\n\*\*Coverage:\*\* incomplete \(1 changed file\(s\) not reviewed\)/);
  assert.match(report, /## Reported findings \(quick review, not independently verified\)\n\n### Q-1/);
  assert.match(report, /## Findings that need more information \(not eligible for comments\)\n\n### Q-2 — Unchecked claim/);
  assert.match(report, /- \*\*Q-1 — REPORTED:\*\* passed the runtime's format and source checks; not independently verified\./);
  assert.match(report, /- \*\*Q-3 — MERGED → Q-1:\*\*/);
  assert.doesNotMatch(report, /Confirmed findings/);
  assert.match(renderFinalReport({ ...quick, status: 'PARTIAL', coverageSummary: { complete: true } }, 'zh-TW'), /PARTIAL: 沒有任何快速審查工作階段產生可用結果/);
  const provenance = provenanceReport({ mode: 'quick', stages: [{ role: 'azpr-quick-reviewer', model: 'p/q', sessions: 1, findings: 2 }] }, quick, 'en');
  assert.match(provenance, /Quick review: one reviewer per shard covered functional and risk focus/);
  assert.match(provenance, /\| Quick review \| `p\/q` \| 1 \| 2 \|/);
  assert.doesNotMatch(provenance, /New verifier findings/);
});

test('a quick receipt carries coverage and verification on its first line and a verification hint', () => {
  const quick = { ...run(), mode: 'quick', profile: 'quick', quickSummary: { coverage: { complete: false, unreviewedFiles: 1, filesComplete: true, reasons: ['shard-failed'] }, high: 1 } };
  const text = renderReceipt(quick, 'report', 'COMPLETE', '', settings);
  assert.match(text, /^\[AZPR 12345678\] COMPLETE; coverage incomplete; verification none \(quick review\)\n/);
  assert.match(text, /Verification hint: 1 high-severity finding\(s\) and incomplete coverage\. Before publishing, consider \/pr-review/);
  assert.match(text, /Quick findings are not independently verified/);
  assert.match(text, /\/pr-comment 12345678 --publish/);
  const clean = renderReceipt({ ...quick, quickSummary: { coverage: { complete: true }, high: 0 } }, 'report', 'COMPLETE', '', settings);
  assert.match(clean, /^\[AZPR 12345678\] COMPLETE; coverage complete; verification none \(quick review\)\n/);
  assert.doesNotMatch(clean, /Verification hint/);
  assert.match(renderReceipt({ ...run() }, 'report', 'COMPLETE', '', settings), /^\[AZPR 12345678\] COMPLETE\n/, 'Verified receipts keep their first line.');
});
