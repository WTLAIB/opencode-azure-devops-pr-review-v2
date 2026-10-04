import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptInitialReview, acceptFinalReview, selectReviewSnapshot,
  readReviewOutput, parseReviewJSONReport, parseUniqueJSON,
} from '../src/output.mjs';
import { renderFinalReport, renderReceipt } from '../src/attribution.mjs';

const PR = 'https://dev.azure.com/org/project/_git/repo/pullrequest/123';
const snapshot = { repository: 'org/project/repo', prId: 123, scope: 'pr', base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['/file.js'] };
const finding = id => ({ id, summary: 'A reachable input loses data', severity: 'medium', location: 'head:/file.js:4',
  evidence: 'The changed assignment erases the existing value.', counterevidence: 'The caller guard covers a different path.', suggestion: 'Preserve the previous value and test the failing input.' });
const initial = () => ({ status: 'COMPLETE', snapshot: structuredClone(snapshot), coverage: { files: [...snapshot.files], gaps: [] }, findings: [finding('F-1')], report: 'Tests were not run.' });
const final = () => ({ status: 'COMPLETE', snapshot: structuredClone(snapshot), currentHead: snapshot.head, currentBase: snapshot.base,
  confirmed: [{ ...finding('F-1'), reason: 'Checked the source and caller.' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'Tests were not run.' });
const response = text => ({ info: { finish: 'stop' }, parts: [{ type: 'text', text }] });
const parse = text => parseReviewJSONReport(response(text), 'azpr-review-functional');

for (const [name, raw, expected] of [
  ['extra root closers', '{"a":[1,{"source":"literal } ] , and \\\"quotes\\\""}]}}]', { a: [1, { source: 'literal } ] , and "quotes"' }] }],
  ['missing root closer', '{"a":[1,2]', { a: [1, 2] }],
  ['missing nested closers', '{"a":[{"b":"unchanged"}', { a: [{ b: 'unchanged' }] }],
  ['missing separators', '{"a":1 "b":[true false {"c":null}{"d":2}]}', { a: 1, b: [true, false, { c: null }, { d: 2 }] }],
  ['missing colon', '{"a" "literal value"}', { a: 'literal value' }],
  ['bare keys and single quotes', "{a:'it\\'s literal', b: 'a \\\"quote\\\"'}", { a: "it's literal", b: 'a "quote"' }],
  ['smart quotes', '{“a”:“literal value”}', { a: 'literal value' }],
  ['literal newline', '{"a":"line one\nline two"}', { a: 'line one\nline two' }],
  ['comments outside source strings', '{"url":"https://example.test",/* text */"code":"/* keep */ // keep",}', { url: 'https://example.test', code: '/* keep */ // keep' }],
  ['unusual whitespace', '{"a":1,\u00a0}', { a: 1 }],
]) test(`review syntax recovery preserves values: ${name}`, () => {
  const saved = response(raw), before = JSON.stringify(saved);
  const result = parse(raw);
  assert.deepEqual(result.envelope, expected);
  assert.ok(result.corrections.length);
  assert.equal(JSON.stringify(saved), before);
  assert.throws(() => parseUniqueJSON(raw), 'Settings parsing must remain strict.');
});

for (const raw of ['{"a":', '{"a":"unfinished', '{"a":1,"b":', '{"a":[1,', '{"a":[1,,2]}',
  '{"a":truefalse}', '{"a":1.}', '{"a":"x\\q"}', '{"a":1} {"a":2}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}']) {
  test(`ambiguous or unfinished data is retained literally: ${raw}`, () => {
    assert.throws(() => parse(raw));
    const recovered = readReviewOutput(response(raw), 'azpr-review-functional');
    assert.equal(recovered.envelope.report, raw);
    assert.equal(recovered.envelope.unstructured, true);
    assert.equal(acceptInitialReview(recovered.envelope, 'F', PR).status, 'PARTIAL');
  });
}

test('failed, truncated and interrupted execution cannot become a completed prose review', () => {
  for (const finish of ['length', 'content-filter', 'error', 'cancelled', undefined, 'tool-calls']) {
    const value = response('Useful but unaccepted text'); value.info.finish = finish;
    assert.throws(() => readReviewOutput(value, 'azpr-review-functional'));
  }
  const value = response('Useful but unaccepted text'); value.info.error = { type: 'api_error' };
  assert.throws(() => readReviewOutput(value, 'azpr-review-functional'));
});

test('a JSON code example in a prose review does not replace the actual review', () => {
  const raw = 'The changed default disables the guard. Example:\n```json\n{"enabled":false}\n```\nThe caller does not restore it.';
  const parsed = readReviewOutput(response(raw), 'azpr-review-functional');
  assert.equal(parsed.envelope.unstructured, true); assert.equal(parsed.envelope.report, raw);
});

test('text outside a structured JSON fence is retained with the review', () => {
  const raw = 'Coverage excludes unavailable integration tests.\n```json\n' + JSON.stringify(initial()) + '\n```\nA deployment assumption remains unresolved.';
  const parsed = readReviewOutput(response(raw), 'azpr-review-functional');
  assert.deepEqual(parsed.envelope.findings, initial().findings);
  assert.match(parsed.envelope.surroundingText, /Coverage excludes/);
  assert.match(parsed.envelope.surroundingText, /deployment assumption/);
});

for (const wrapper of [
  json => 'Example: `reserve({"item": 3})` preserves the trigger.\n```json\n' + json + '\n```\nAn unmatched prose brace { is commentary.',
  json => '```python\nreserve({"item": 3})\n```\n```json\n' + json + '\n```',
  json => 'Configuration example:\n```json\n{"enabled":false}\n```\nFinal review:\n```json\n' + json + '\n```',
  json => 'Here is the final review:\n' + json + '\nEnd of review.',
  json => 'Example `{x: 1}`.\n~~~~json\n' + json + '\n~~~~',
  json => 'Example `{x: 1}`.\n````json\n' + json + '\n````',
]) test('a unique review envelope survives surrounding examples without losing their text', () => {
  const value = final(), raw = wrapper(JSON.stringify(value));
  const parsed = readReviewOutput(response(raw), 'azpr-review-verifier');
  assert.deepEqual(parsed.envelope.confirmed, value.confirmed);
  assert.ok(parsed.envelope.surroundingText);
  assert.equal(acceptFinalReview(parsed.envelope, snapshot, [finding('F-1')], PR).status, 'COMPLETE');
  assert.equal(raw, wrapper(JSON.stringify(value)), 'The original output is unchanged.');
});

for (const other of [
  JSON.stringify(final()),
  '{"status":"PARTIAL","findings":[]}',
  '{"status":"INCOMPLETE"}',
  '{"status":"COMPLETE","confirmed":',
  '{"status":"COMPLETE","confirmed":[],"confirmed":[',
]) test('a competing complete or unfinished review cannot be hidden by a JSON fence', () => {
  const raw = other + '\n```json\n' + JSON.stringify(final()) + '\n```';
  const parsed = readReviewOutput(response(raw), 'azpr-review-verifier');
  assert.equal(parsed.envelope.unstructured, true);
  assert.equal(parsed.envelope.report, raw);
});

test('duplicate keys inside a selected fenced review remain ambiguous', () => {
  const raw = 'Example: `fn({x: 1})`.\n```json\n' + JSON.stringify(final()).replace('"status":"COMPLETE"', '"status":"PARTIAL","status":"COMPLETE"') + '\n```';
  assert.equal(readReviewOutput(response(raw), 'azpr-review-verifier').envelope.report, raw);
});

test('the trailing-brace failure shape keeps every finding and supplemental field', () => {
  const original = initial(); original.findings.push(finding('F-2'), finding('F-3'));
  original.findings[1].counterevidence_note = '';
  original.findings[2].counterevidence_note = '';
  const raw = JSON.stringify(original) + '}';
  const recovered = readReviewOutput(response(raw), 'azpr-review-functional');
  const accepted = acceptInitialReview(recovered.envelope, 'F', PR);
  assert.equal(accepted.status, 'COMPLETE'); assert.equal(accepted.contractComplete, true);
  assert.deepEqual(accepted.findings, original.findings);
  assert.deepEqual(recovered.corrections, [{ action: 'remove-redundant-closing-delimiter', offset: raw.length - 1 }]);
});

test('known key spelling, status case and optional overview do not gate a complete review', () => {
  const value = initial(), before = structuredClone(value);
  value.Status = ' complete '; delete value.status; delete value.report;
  value.snapshot.prId = '123'; value.snapshot.files.push('/file.js');
  value.findings[0][' Evidence '] = value.findings[0].evidence; delete value.findings[0].evidence;
  value.findings[0].severity = 'Medium'; value.findings[0].notes = 'Additional source detail';
  value.extra = { important: 'Keep this context' };
  const accepted = acceptInitialReview(value, 'F', PR);
  assert.equal(accepted.status, 'COMPLETE'); assert.equal(accepted.contractComplete, true);
  assert.equal(accepted.findings[0].evidence, before.findings[0].evidence);
  assert.equal(accepted.findings[0].notes, value.findings[0].notes);
  assert.deepEqual(accepted.extra, value.extra);
  assert.equal(value.Status, ' complete ', 'Input is not mutated.');
});

test('missing fields, repeated IDs and prose candidates remain visible without fabricated evidence', () => {
  const value = initial(); value.findings.push({ id: 'F-1', summary: 'A different issue', explanation: 'Supplemental claim' }, 'Another observation');
  delete value.findings[0].counterevidence;
  const accepted = acceptInitialReview(value, 'F', PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.equal(accepted.contractComplete, false);
  assert.equal(accepted.findings.length, 3); assert.equal(new Set(accepted.findings.map(row => row.id)).size, 3);
  assert.equal(accepted.findings[1].originalId, 'F-1'); assert.equal(accepted.findings[1].explanation, 'Supplemental claim');
  assert.equal(accepted.findings[2].summary, 'Another observation');
  assert.equal(accepted.findings[0].counterevidence, undefined);
  assert.ok(accepted.reviewWarnings.length);
});

test('alias conflicts retain both values and disable publication eligibility', () => {
  const value = initial(); value.findings[0][' evidence '] = 'Contradictory second value';
  const accepted = acceptInitialReview(value, 'F', PR);
  assert.equal(accepted.findings[0][' evidence '], 'Contradictory second value');
  assert.equal(accepted.findings[0].evidence, value.findings[0].evidence);
  assert.equal(accepted.contractComplete, false);
});

test('missing and conflicting initial metadata stays explicit in the verifier packet', () => {
  const a = acceptInitialReview(initial(), 'F', PR);
  const b = structuredClone(a); b.snapshot.head = 'c'.repeat(40); b.snapshot.files = ['/other.js'];
  const missing = acceptInitialReview({ report: 'Review text with unavailable metadata' }, 'R', PR);
  const selected = selectReviewSnapshot([a, b, missing], PR);
  assert.deepEqual(selected.snapshot, snapshot);
  assert.ok(selected.warnings.some(note => /conflicting/.test(note)));
  assert.equal(selectReviewSnapshot([missing], PR).snapshot, null);
});

test('malformed snapshot path entries remain visible and cannot silently reduce coverage', () => {
  const value = initial(), extra = { path: '/unread.js' }; value.snapshot.files.push(extra);
  const accepted = acceptInitialReview(value, 'F', PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.equal(accepted.contractComplete, false);
  assert.deepEqual(accepted.snapshot.files, ['/file.js', extra]);
});

test('missing empty sections and overview are optional when final evidence is otherwise complete', () => {
  const value = final(); for (const field of ['merged', 'rejected', 'needsInfo', 'newFindings', 'report']) delete value[field];
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'COMPLETE'); assert.equal(accepted.contractComplete, true);
});

test('a locally normalized single-row final section stays complete with its warning visible', () => {
  const value = final(); value.confirmed = value.confirmed[0];
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'COMPLETE'); assert.equal(accepted.contractComplete, true);
  assert.ok(accepted.reviewWarnings.some(message => /non-array/.test(message)));
  assert.match(renderFinalReport(accepted, 'en'), /non-array/);
});

test('a missing verifier snapshot or conflicting aliases still cannot be declared complete', () => {
  const missing = final(); delete missing.snapshot;
  assert.equal(acceptFinalReview(missing, snapshot, [finding('F-1')], PR).status, 'PARTIAL');
  const conflict = final(); conflict.confirmed[0][' Evidence '] = 'Conflicting evidence';
  assert.equal(acceptFinalReview(conflict, snapshot, [finding('F-1')], PR).status, 'PARTIAL');
});

test('normalizing the verifier snapshot key preserves its own established identity', () => {
  const value = final(); value.Snapshot = value.snapshot; delete value.snapshot;
  assert.equal(acceptFinalReview(value, snapshot, [finding('F-1')], PR).status, 'COMPLETE');
});

test('quote wrappers around full SHAs are formatting, not invented versions', () => {
  const value = final(); value.currentHead = '"' + snapshot.head.toUpperCase() + '"';
  value.snapshot.base = '`' + snapshot.base + '`';
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'COMPLETE'); assert.equal(accepted.currentHead, snapshot.head);
  assert.equal(accepted.snapshot.base, snapshot.base);
  value.currentHead = 'missing';
  assert.equal(acceptFinalReview(value, snapshot, [finding('F-1')], PR).status, 'PARTIAL');
});

test('unaccounted originals remain unreviewed and their full observations are rendered', () => {
  const value = final(), original = finding('R-1'); original.summary = 'Omitted original observation';
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1'), original], PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.equal(accepted.contractComplete, false);
  assert.equal(accepted.dispositions.at(-1).status, 'UNREVIEWED');
  assert.deepEqual(accepted.unreviewedFindings, [original]);
  const report = renderFinalReport(accepted, 'en');
  assert.match(report, /Omitted original observation/); assert.match(report, /Runtime notice/);
});

test('missing final evidence and freshness retain a usable, non-publishable report', () => {
  const value = final(); delete value.currentHead; delete value.confirmed[0].evidence; value.confirmed[0].notes = 'Useful extra context';
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.equal(accepted.currentHead, '');
  assert.equal(accepted.dispositions[0].verifiedFinding.evidence, undefined);
  const report = renderFinalReport(accepted, 'en');
  assert.match(report, /Useful extra context/); assert.doesNotMatch(report, /undefined/);
});

test('a null legacy confirmed finding does not prevent delivery of the partial report', () => {
  const value = { status: 'COMPLETE', snapshot, currentHead: snapshot.head, currentBase: snapshot.base,
    dispositions: [{ id: 'F-1', status: 'CONFIRMED', reason: 'A decision without its evidence packet.', verifiedFinding: null }],
    report: 'The review summary remains useful.' };
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.equal(accepted.contractComplete, false);
  const report = renderFinalReport(accepted, 'en');
  assert.match(report, /The review summary remains useful/);
  assert.match(report, /A decision without its evidence packet/);
  assert.doesNotMatch(report, /undefined/);
});

test('stale versions remain stale even when other fields are missing', () => {
  const value = final(); value.currentHead = 'c'.repeat(40); delete value.snapshot; delete value.confirmed[0].evidence;
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1')], PR);
  assert.equal(accepted.status, 'STALE'); assert.equal(accepted.contractComplete, false);
});

test('literal final review is delivered even with receipt-only preferences', () => {
  const raw = '## Review\n\nA concrete issue with supporting source.\n\nCoverage is limited.';
  const parsed = readReviewOutput(response(raw), 'azpr-review-verifier');
  const accepted = acceptFinalReview(parsed.envelope, snapshot, [finding('F-1')], PR);
  const report = renderFinalReport(accepted, 'en');
  const receipt = renderReceipt({ id: 'fixture', mode: 'review', stages: [], publicationUnavailable: true }, report, accepted.status, '', { returnReport: 'receipt', outputLanguage: 'en' });
  assert.equal(accepted.status, 'PARTIAL'); assert.match(receipt, /<azpr_report_data>/);
  assert.ok(receipt.includes(raw)); assert.match(receipt, /UNREVIEWED/);
});

test('merge cycles and unknown disposition IDs retain results with explicit limitations', () => {
  const value = final(); value.confirmed = []; value.merged = [{ id: 'F-1', mergedInto: 'R-1', reason: 'First merge' }, { id: 'R-1', mergedInto: 'F-1', reason: 'Second merge' }];
  const accepted = acceptFinalReview(value, snapshot, [finding('F-1'), finding('R-1')], PR);
  assert.equal(accepted.status, 'PARTIAL'); assert.match(renderFinalReport(accepted, 'en'), /cycle/);
  value.merged.push({ id: 'OTHER', mergedInto: 'F-1', reason: 'An unmatched observation' });
  assert.match(renderFinalReport(acceptFinalReview(value, snapshot, [finding('F-1'), finding('R-1')], PR), 'en'), /An unmatched observation/);
});
