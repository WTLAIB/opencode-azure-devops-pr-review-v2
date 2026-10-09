import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelJSON, parseUniqueJSON, evaluateInitial, evaluateFinal, initialRepairPrompt, finalRepairPrompt, assignIds,
  escapeCodeSpanQuotes, parseRepairPrompt, syntaxProblem,
} from '../src/output.mjs';

const finding = (id, extra = {}) => ({ id, summary: `Defect ${id}`, evidence: 'HEAD drops the guard.', counterevidence: 'No caller re-checks.',
  location: 'head:/src/a.ts:12', severity: 'high', suggestion: 'Restore the guard.', ...extra });
const initialAnswer = (findings, extra = {}) => JSON.stringify({ status: 'COMPLETE', coverage: { files: ['/src/a.ts'], gaps: [] }, additionalFiles: [], findings, report: 'Report', ...extra });

test('parseModelJSON accepts a whole object, one fence or one embedded object and keeps surrounding text', () => {
  assert.deepEqual(parseModelJSON('{"status":"COMPLETE"}', { keys: ['status'] }), { value: { status: 'COMPLETE' } });
  const fenced = parseModelJSON('Intro\n```json\n{"status":"READY","comments":[]}\n```\nOutro', { keys: ['status', 'comments'] });
  assert.deepEqual(fenced.value, { status: 'READY', comments: [] });
  assert.equal(fenced.surroundingText, 'Intro\n\nOutro');
  const embedded = parseModelJSON('Result: {"status":"COMPLETE","findings":[{"note":"a } brace"}]} done', { keys: ['status', 'findings'] });
  assert.equal(embedded.value.findings[0].note, 'a } brace');
  // An unrelated example object does not compete with the review object.
  const example = parseModelJSON('See fn({"item": 3}).\n```json\n{"status":"COMPLETE","findings":[]}\n```', { keys: ['status', 'findings'] });
  assert.deepEqual(example.value, { status: 'COMPLETE', findings: [] });
});

test('parseModelJSON reports concrete problems instead of guessing', () => {
  assert.match(parseModelJSON('').problem, /empty/);
  assert.match(parseModelJSON('no json here').problem, /no JSON object/);
  assert.match(parseModelJSON('{"status": "COMPLETE",}', { keys: ['status'] }).problem, /could not be parsed/);
  assert.match(parseModelJSON('{"status":"A","status":"B"}', { keys: ['status'] }).problem, /repeats a key/);
  assert.match(parseModelJSON('```json\n{"status":"A"}\n```\n```json\n{"status":"B"}\n```', { keys: ['status'] }).problem, /2 JSON objects/);
  assert.match(parseModelJSON('[1,2]', { keys: ['status'] }).problem, /not the expected object/);
});

test('settings parsing stays strict', () => {
  assert.deepEqual(parseUniqueJSON('{"a":1}'), { a: 1 });
  assert.throws(() => parseUniqueJSON('{"a":1,"a":2}'), /duplicate JSON keys/);
  assert.throws(() => parseUniqueJSON('```json\n{}\n```'));
});

test('evaluateInitial accepts a good review and normalizes aliases and severity case', () => {
  const answer = JSON.stringify({ Status: 'complete', coverage: { files: ['/src/a.ts'], gaps: [] }, findings: [finding('F-1', { severity: 'High' })], report: 'r' });
  const { result, issues } = evaluateInitial(answer, { prefix: 'F', assigned: ['/src/a.ts'], inventory: ['/src/a.ts'] });
  assert.deepEqual(issues, []);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.findings[0].severity, 'high');
});

test('evaluateInitial lists repairable problems and still returns a usable PARTIAL result', () => {
  const bad = JSON.stringify({ status: 'COMPLETE', findings: [{ id: 'F-1', summary: 'only summary', severity: 'critical' }], report: 'r' });
  const { result, issues } = evaluateInitial(bad, { prefix: 'F', assigned: ['/src/a.ts'] });
  assert.ok(issues.some(issue => /coverage/.test(issue)));
  assert.ok(issues.some(issue => /missing evidence, counterevidence, suggestion/.test(issue)));
  assert.ok(issues.some(issue => /severity must be high, medium or low/.test(issue)));
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.findings.length, 1);
  assert.match(initialRepairPrompt(issues), /complete corrected JSON object/);
});

test('evaluateInitial keeps unstructured text for verification', () => {
  const { result, issues } = evaluateInitial('I found a race in /src/a.ts when two writers overlap.', { prefix: 'R', assigned: ['/src/a.ts'] });
  assert.equal(result.structured, false);
  assert.match(result.report, /race/);
  assert.match(issues[0], /could not be used/);
});

test('evaluateInitial downgrades COMPLETE when assigned files are missing and records discovered paths', () => {
  const { result } = evaluateInitial(initialAnswer([], { coverage: { files: [], gaps: [] }, additionalFiles: ['src/extra.ts', '/src/a.ts'] }),
    { prefix: 'F', assigned: ['/src/a.ts'], inventory: ['/src/a.ts'], filesComplete: false });
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.additionalFiles, ['/src/extra.ts']);
});

test('assignIds keeps valid IDs and renumbers missing or repeated ones', () => {
  const warnings = new Set();
  const rows = [{ id: 'F-1' }, { id: 'F-1' }, {}, { id: 'X-9' }];
  assignIds(rows, 'F', warnings);
  assert.deepEqual(rows.map(row => row.id), ['F-1', 'F-2', 'F-3', 'F-4']);
  assert.equal(rows[3].originalId, 'X-9');
  assert.equal(warnings.size, 1);
});

test('evaluateFinal: complete decisions are accepted as-is', () => {
  const originals = [finding('F-1'), finding('R-1')];
  const answer = JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...finding('F-1'), reason: 'Checked.' }], merged: [{ id: 'R-1', mergedInto: 'F-1', reason: 'Same cause.' }], rejected: [], needsInfo: [], newFindings: [finding('V-1')], report: 'Report' });
  const { result, issues } = evaluateFinal(answer, { originals });
  assert.deepEqual(issues, []);
  assert.deepEqual(result.dispositions.map(d => `${d.id}:${d.status}`), ['F-1:CONFIRMED', 'R-1:MERGED']);
  assert.equal(result.newFindings.length, 1);
});

test('evaluateFinal: missing decisions become a supplement request and are merged back', () => {
  const originals = [finding('F-1'), finding('F-2'), finding('R-1')];
  const first = evaluateFinal(JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...finding('F-1'), reason: 'ok' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'Report' }), { originals });
  assert.deepEqual(first.repairIds.sort(), ['F-2', 'R-1']);
  assert.match(first.issues[0], /No decision was given for: F-2, R-1/);
  const prompt = finalRepairPrompt(first.issues, first.repairIds);
  assert.match(prompt, /decisions only for: F-2, R-1/);
  const second = evaluateFinal(JSON.stringify({ dispositions: [{ id: 'F-2', status: 'REJECTED', reason: 'Guarded.' }, { id: 'R-1', status: 'merged', mergedInto: 'F-1', reason: 'Same.' }] }),
    { originals, previous: first.result, supplement: true });
  assert.deepEqual(second.issues, []);
  assert.deepEqual(second.result.dispositions.map(d => `${d.id}:${d.status}`), ['F-1:CONFIRMED', 'F-2:REJECTED', 'R-1:MERGED']);
  assert.equal(second.result.report, 'Report', 'A supplement keeps the earlier report.');
});

test('evaluateFinal degrades per item after repairs: UNREVIEWED and NEEDS_INFO, never discarding the rest', () => {
  const originals = [finding('F-1'), finding('F-2'), finding('F-3')];
  const { result, issues } = evaluateFinal(JSON.stringify({ status: 'COMPLETE',
    confirmed: [{ id: 'F-1', summary: 'Only a summary', reason: 'ok' }, { ...finding('F-2'), reason: 'ok' }],
    merged: [], rejected: [], needsInfo: [], newFindings: [{ id: 'V-1', summary: 'incomplete' }], report: 'r' }), { originals });
  assert.ok(issues.some(issue => /F-1: the confirmed finding is missing/.test(issue)));
  assert.ok(issues.some(issue => /newFindings\[0\]/.test(issue)));
  const statuses = Object.fromEntries(result.dispositions.map(d => [d.id, d.status]));
  assert.deepEqual(statuses, { 'F-1': 'NEEDS_INFO', 'F-2': 'CONFIRMED', 'F-3': 'UNREVIEWED' });
  assert.equal(result.newFindings.length, 0);
  assert.equal(result.incompleteNewFindings.length, 1);
  assert.ok(result.warnings.some(w => /UNREVIEWED/.test(w)));
});

test('evaluateFinal rejects invalid merges and cycles per item', () => {
  const originals = [finding('F-1'), finding('F-2'), finding('F-3')];
  const { result } = evaluateFinal(JSON.stringify({ status: 'COMPLETE', confirmed: [], rejected: [], needsInfo: [], newFindings: [], report: 'r',
    merged: [{ id: 'F-1', mergedInto: 'F-2', reason: 'a' }, { id: 'F-2', mergedInto: 'F-1', reason: 'b' }, { id: 'F-3', mergedInto: 'F-9', reason: 'c' }] }), { originals });
  assert.deepEqual(result.dispositions.map(d => d.status), ['UNREVIEWED', 'UNREVIEWED', 'UNREVIEWED']);
});

test('evaluateFinal: cross-shard merge targets are allowed when listed in allIds', () => {
  const { result, issues } = evaluateFinal(JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-1', mergedInto: 'R-7', reason: 'Same.' }], confirmed: [], rejected: [], needsInfo: [], newFindings: [], report: '' }),
    { originals: [finding('F-1')], allIds: ['F-1', 'R-7'] });
  assert.deepEqual(issues, []);
  assert.equal(result.dispositions[0].status, 'MERGED');
});

test('evaluateFinal keeps an unstructured verifier answer visible and asks for the full object', () => {
  const { result, issues, repairIds } = evaluateFinal('The guard is missing; I confirm F-1.', { originals: [finding('F-1')] });
  assert.equal(result.structured, false);
  assert.equal(result.dispositions[0].status, 'UNREVIEWED');
  assert.deepEqual(repairIds, ['F-1']);
  assert.match(finalRepairPrompt(issues, repairIds, { full: true }), /complete verification JSON object/);
});

test('unescaped quotes inside inline code are repaired locally and disclosed', () => {
  const broken = '{"status":"COMPLETE","findings":[],"coverage":{"files":["/a.ts"],"gaps":[]},"report":"HEAD returns `{"stock": s}.copy()` and `x`."}';
  assert.throws(() => JSON.parse(broken));
  const parsed = parseModelJSON(broken, { keys: ['status'] });
  assert.equal(parsed.value.report, 'HEAD returns `{"stock": s}.copy()` and `x`.');
  assert.deepEqual(parsed.corrections, [{ action: 'escape-quotes-in-code-span', count: 2 }]);
  const { result, issues } = evaluateInitial(broken, { prefix: 'F', assigned: ['/a.ts'], inventory: ['/a.ts'] });
  assert.deepEqual(issues, []);
  assert.ok(result.warnings.some(w => /repaired locally/.test(w)));
  // A backtick span that crosses JSON members is never touched.
  assert.equal(escapeCodeSpanQuotes('{"a":"x `y", "b": "z` w"}'), null);
  assert.equal(escapeCodeSpanQuotes('{"a":"plain"}'), null);
});

test('a verifier resend after an unparsable answer carries no stale warnings (B1)', () => {
  const originals = [finding('F-1'), finding('R-1')];
  const first = evaluateFinal('{"status":"COMPLETE","confirmed":[{"id":"F-1" "summary": "x"}]}', { originals });
  assert.equal(first.result.structured, false);
  assert.ok(syntaxProblem(first.issues));
  assert.match(parseRepairPrompt(first.issues), /identical content: do not shorten/);
  const resend = evaluateFinal(JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...finding('F-1'), reason: 'ok' }], merged: [{ id: 'R-1', mergedInto: 'F-1', reason: 'same' }],
    rejected: [], needsInfo: [], newFindings: [], report: 'r' }), { originals, previous: first.result, supplement: Boolean(first.result.structured) });
  assert.deepEqual(resend.issues, []);
  assert.deepEqual(resend.result.warnings, [], 'Warnings from the failed first answer must not survive.');
});

test('a supplement keeps normalization notes but recomputes derived warnings', () => {
  const originals = [finding('F-1'), finding('R-1')];
  const first = evaluateFinal(JSON.stringify({ Status: 'COMPLETE', confirmed: [{ ...finding('F-1'), reason: 'ok' }], merged: 'not-an-array', rejected: [], needsInfo: [], newFindings: [], report: 'r' }), { originals });
  assert.ok(first.result.warnings.some(w => /UNREVIEWED/.test(w)));
  const merged = evaluateFinal(JSON.stringify({ dispositions: [{ id: 'R-1', status: 'MERGED', mergedInto: 'F-1', reason: 'same' }] }),
    { originals, previous: first.result, supplement: true });
  assert.equal(merged.result.warnings.some(w => /UNREVIEWED/.test(w)), false, 'Resolved items no longer count as unreviewed.');
  assert.ok(merged.result.warnings.some(w => /non-array review section/i.test(w) || /kept as one entry/.test(w)), 'Normalization notes carry over.');
});

test('repair prompts: syntax errors ask for the same content; missing JSON asks for the full object', () => {
  assert.equal(syntaxProblem(['Your answer could not be used: no JSON object was found.']), false);
  assert.match(initialRepairPrompt(['x could not be parsed'], { parseOnly: true }), /not valid JSON[\s\S]*identical content/);
  assert.match(initialRepairPrompt(['coverage missing']), /keep the existing wording/);
  assert.match(finalRepairPrompt(['no JSON object was found'], ['F-1'], { full: true }), /complete verification JSON object/);
  assert.match(finalRepairPrompt(['bad'], ['F-1'], { parseOnly: true }), /identical content/);
});
