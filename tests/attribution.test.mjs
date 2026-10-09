import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt, renderDiagnosticNotices, renderCommentActions } from '../src/attribution.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const run = () => ({
  id: '12345678', mode: 'review', profile: 'review', phase: 'final verification',
  stages: [{
    role: 'azpr-review-verifier', status: 'COMPLETE', sessionID: 'ses_fixture', model: 'fixture/verifier',
    toolObservations: { reportedErrors: 1, truncated: 0 },
    result: { report: 'PRIVATE_REPORT_IN_STAGE', toolArguments: 'PRIVATE_ARGUMENTS' },
  }],
  debug: { directory: '/fixture/debug', warnings: [] },
});
const settings = { returnReport: 'receipt', outputLanguage: 'zh-TW' };

test('comment actions include exact direct and preview commands with process retention limits', () => {
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const text = renderCommentActions('12345678', language);
    assert.match(text, /\/pr-comment 12345678 --publish/);
    assert.match(text, /`\/pr-comment 12345678`/);
    assert.match(text, /`\/pr-comment --publish`/);
    assert.match(text, /20/);
  }
  assert.match(renderCommentActions('12345678', 'zh-TW'), /重啟後清除/);
});

test('receipt rendering is pure and exposes report content only in explicit full mode', () => {
  const value = freeze(run());
  const before = JSON.stringify(value);
  const report = 'Report </azpr_report_data> with complete attribution.';
  const receipt = renderReceipt(value, report, 'COMPLETE', '', settings);
  assert.match(receipt, /No report body is enclosed/);
  assert.match(receipt, /reported-tool-errors=1/);
  assert.doesNotMatch(receipt, /PRIVATE_|with complete attribution/);
  const full = renderReceipt(value, report, 'COMPLETE', '', { ...settings, returnReport: 'full' });
  assert.match(full, /Report &lt;\/azpr_report_data&gt; with complete attribution\./);
  assert.equal(full.split('</azpr_report_data>').length - 1, 1);
  assert.match(full, /outputLanguage=zh-TW/);
  assert.doesNotMatch(full, /PRIVATE_/);
  assert.equal(JSON.stringify(value), before);
});

test('diagnostic notices distinguish prevented native attempts from overlapping execution observations', () => {
  const value = run();
  Object.assign(value.stages[0], { blockedNativeToolCalls: 1, toolFailures: 1 });
  Object.assign(value.stages[0].toolObservations, { reportedErrors: 1, truncated: 1 });
  value.abortUnconfirmed = true;
  const notices = renderDiagnosticNotices(freeze(value));
  assert.match(notices, /Native tool notice: 1.*blocked before execution/);
  assert.match(notices, /Tool error notice: 1.*V2 terminal execution observations/);
  assert.match(notices, /Tool result notice: 1.*1 result\(s\) signalled truncation.*can overlap/);
  assert.match(notices, /did not confirm session settlement/);
  assert.doesNotMatch(notices, /PRIVATE_|invalid tool|StructuredOutput|host events/);
  const unobserved = run();
  delete unobserved.stages[0].toolObservations;
  assert.doesNotMatch(renderDiagnosticNotices(unobserved), /Tool result notice/);
});

test('a queued report is acknowledged without claiming UI presentation', () => {
  const value = run();
  value.stages[0].reportQueued = true;
  value.stages[0].displayed = false;
  const receipt = renderReceipt(value, 'Saved report', 'COMPLETE', '', settings);
  assert.match(receipt, /synthetic report queued to session=ses_fixture/);
  assert.match(receipt, /Queue acknowledgement does not certify UI display/);
  assert.match(receipt, /original model JSON is separate/);
  assert.doesNotMatch(receipt, /The full report is in|opencode export|Present the status|Reproduce the entire|Task|noReply/);
});

test('failed queuing offers original JSON and private diagnostics without promising an appended report', () => {
  const value = run(); value.stages[0].status = 'FAILED';
  const receipt = renderReceipt(value, 'Unconfirmed observations', 'INCOMPLETE', 'Invalid final output', settings);
  assert.match(receipt, /no appended synthetic report was confirmed/);
  assert.match(receipt, /original JSON in the review session or private report\/draft diagnostics/);
  assert.match(receipt, /sending another prompt is a new model request/);
  assert.doesNotMatch(receipt, /opencode export|The full report is in|synthetic report queued to/);
});

test('accepted local corrections and pending locations remain disclosed with an initial failure', () => {
  const value = run();
  value.stages[0].status = 'FAILED'; value.stages[0].error = 'Missing original disposition';
  value.stages.push({
    role: 'azpr-review-verifier', status: 'COMPLETE', sessionID: 'ses_verifier',
    model: 'fixture/verifier', outputFormatCorrections: [{ kind: 'finding-key-whitespace' }], pendingLocations: ['F1'],
  });
  const receipt = renderReceipt(value, 'Report', 'COMPLETE', '', settings);
  for (const notice of ['Output format notice', 'Pending location notice']) assert.ok(receipt.includes(notice));
  assert.match(receipt, /error=Missing original disposition/);
  assert.match(receipt, /This notice does not claim they were resolved/);
  assert.doesNotMatch(receipt, /StructuredOutput|transport fallback|invalid-structured-output/);
});

test('incomplete drafts remain unconfirmed and cannot be used for comments', () => {
  const value = run(); value.draft = true;
  const receipt = renderReceipt(value, 'Draft', 'INCOMPLETE', 'Verifier failed', { ...settings, returnReport: 'full' });
  assert.match(receipt, /Incomplete draft notice:.*remain unconfirmed/);
  assert.match(receipt, /not a completed review or input for PR comments/);
  assert.match(receipt, /Failed final claims are not accepted findings/);
  assert.match(receipt, /<azpr_report_data>\nDraft\n<\/azpr_report_data>/);
});
