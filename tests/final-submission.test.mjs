import test from 'node:test';
import assert from 'node:assert/strict';
import { finalEnvelope, finalSubmission, finalSubmissionIssues, finalResubmissionPlan, checkFinalResubmission, normalizeFindingFormat, stageFormat } from '../src/output.mjs';

const snapshot = { repository: 'org/project/repo', prId: 123, base: 'a'.repeat(40), head: 'b'.repeat(40), scope: 'pr', files: ['/a.js', '/b.js'] };
const finding = id => ({ id, summary: 'Missing guard', evidence: 'Reachable null input fails at the new dereference.', counterevidence: 'The caller only guards undefined.', location: 'head:/a.js:12', severity: 'medium', suggestion: 'Guard null and test that input.' });
const originals = ['F-1', 'R-1', 'F-2', 'R-2'].map(finding);
const packet = () => ({ status: 'COMPLETE', snapshot: structuredClone(snapshot), currentHead: snapshot.head, currentBase: snapshot.base,
  confirmed: [{ ...finding('F-1'), reason: 'Checked the caller and failing branch.' }],
  merged: [{ id: 'R-1', mergedInto: 'F-1', reason: 'Same trigger and correction.' }],
  rejected: [{ id: 'F-2', reason: 'The caller prevents this input.' }],
  needsInfo: [{ id: 'R-2', reason: 'Deployment configuration is unavailable.' }], newFindings: [], report: 'Source checks complete; deployment-dependent candidate remains unresolved.' });
const validate = value => finalEnvelope(value, snapshot, originals);

for (const mode of ['review', 'deep']) test(`final categories preserve complete corrected findings and explicit decisions (${mode})`, () => {
  const raw = packet(), before = structuredClone(raw), schema = stageFormat(`azpr-${mode}-verifier`).schema;
  assert.deepEqual(schema.properties.confirmed.items.required, [...Object.keys(finding('F-1')), 'reason']);
  for (const key of ['confirmed', 'merged', 'rejected', 'needsInfo', 'newFindings']) assert.ok(schema.required.includes(key));
  assert.equal(schema.properties.dispositions, undefined);
  const result = validate(raw);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.dispositions.map(d => d.status), ['CONFIRMED', 'MERGED', 'REJECTED', 'NEEDS_INFO']);
  assert.deepEqual(result.dispositions[0].verifiedFinding, finding('F-1'));
  assert.deepEqual(raw, before);
  assert.equal(result.confirmed, undefined);
});

for (const [name, edit] of [
  ['missing evidence', p => delete p.confirmed[0].evidence],
  ['missing location', p => delete p.confirmed[0].location],
  ['empty counterevidence', p => p.confirmed[0].counterevidence = ''],
  ['missing category', p => delete p.rejected],
  ['encoded array', p => p.confirmed = JSON.stringify(p.confirmed)],
  ['missing original', p => p.needsInfo = []],
  ['duplicate original', p => p.rejected.push({ id: 'F-1', reason: 'Duplicate' })],
  ['unknown original', p => p.confirmed[0].id = 'F-99'],
  ['invalid target', p => p.merged[0].mergedInto = 'R-99'],
  ['cycle', p => { p.confirmed = []; p.merged.push({ id: 'F-1', mergedInto: 'R-1', reason: 'Cycle' }); }],
  ['mixed formats', p => p.dispositions = []],
  ['unknown decision field', p => p.merged[0].untrusted = 'Conflicting decision'],
]) test(`final categories reject ${name}`, () => { const p = packet(); edit(p); assert.throws(() => validate(p)); });

test('flat findings retain audited key/empty-field normalization and reject collisions', () => {
  const raw = packet(); raw.confirmed[0][' evidence '] = raw.confirmed[0].evidence; delete raw.confirmed[0].evidence;
  raw.confirmed[0].PRIVATE_EXTENSION = ''; const before = structuredClone(raw);
  const prepared = normalizeFindingFormat(raw, 'azpr-review-verifier');
  assert.equal(validate(prepared.envelope).status, 'COMPLETE');
  assert.equal(prepared.corrections.length, 2); assert.deepEqual(raw, before);
  raw.confirmed[0].evidence = 'Conflicting content';
  assert.throws(() => normalizeFindingFormat(raw, 'azpr-review-verifier'), /conflicting/);
  const idKey = packet(); idKey.confirmed[0][' id '] = idKey.confirmed[0].id; delete idKey.confirmed[0].id;
  assert.equal(validate(normalizeFindingFormat(idKey, 'azpr-review-verifier').envelope).status, 'COMPLETE');
});

test('snapshot equality ignores unique file order but not identity, duplicate or missing paths', () => {
  const p = packet(); p.snapshot.files.reverse(); const before = structuredClone(p);
  assert.equal(validate(p).status, 'COMPLETE'); assert.deepEqual(p, before);
  for (const edit of [p => p.snapshot.files.pop(), p => p.snapshot.files.push('/a.js'), p => p.snapshot.prId++, p => p.snapshot.head = 'c'.repeat(40)]) {
    const bad = packet(); edit(bad); assert.throws(() => validate(bad));
  }
});

test('resubmission eligibility requires a complete known identity and fresh unchanged versions', () => {
  for (const raw of [
    { ...finalSubmission(packet()), dispositions: '[{"id":"F-1","reason":"broken "quote""}]' },
    { ...finalSubmission(packet()), dispositions: [{ id: 'F-1', status: 'CONFIRMED', reason: 'Source checked' }] },
    { ...packet(), confirmed: [] },
  ]) {
    assert.throws(() => validate(raw));
    const plan = finalResubmissionPlan(raw, snapshot);
    assert.ok(plan); assert.equal(validate(checkFinalResubmission(packet(), plan)).status, 'COMPLETE');
  }
  for (const edit of [p => p.status = 'INCOMPLETE', p => p.status = 'STALE', p => p.status = 'CREATE',
    p => delete p.snapshot, p => p.snapshot.repository = 'different', p => p.snapshot.files.pop(),
    p => p.currentHead = '', p => p.currentBase = '', p => p.currentHead = 'c'.repeat(40), p => p.currentBase = 'c'.repeat(40)]) {
    const bad = packet(); edit(bad); assert.equal(finalResubmissionPlan(bad, snapshot), undefined);
  }
  const plan = finalResubmissionPlan(packet(), snapshot);
  for (const edit of [p => p.currentHead = 'c'.repeat(40), p => p.currentBase = '', p => p.snapshot.prId++]) {
    const bad = packet(); edit(bad); assert.throws(() => checkFinalResubmission(bad, plan));
  }
  assert.equal(finalResubmissionPlan({ status: 'CREATE' }, snapshot), undefined);
});

test('diagnostics collect missing evidence paths without echoing private field names or values', () => {
  const raw = finalSubmission(packet());
  raw.dispositions = ['F-1', 'F-2', 'R-1'].map(id => ({ id, status: 'CONFIRMED', reason: 'PRIVATE_REASON' }));
  const issues = finalSubmissionIssues(raw);
  assert.equal(issues.filter(x => x.path.endsWith('.verifiedFinding')).length, 3);
  const flat = packet(); delete flat.confirmed[0].evidence; delete flat.confirmed[0].counterevidence;
  flat.merged[0].PRIVATE_FIELD = 'PRIVATE_SECRET';
  const paths = finalSubmissionIssues(flat);
  assert.ok(paths.some(x => x.path === 'confirmed[0].evidence'));
  assert.ok(paths.some(x => x.path === 'confirmed[0].counterevidence'));
  assert.doesNotMatch(JSON.stringify([...issues, ...paths]), /PRIVATE_/);
});
