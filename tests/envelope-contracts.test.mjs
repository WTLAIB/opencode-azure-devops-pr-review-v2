import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEnvelope, finalEnvelope, finalSubmissionIssues, initialEnvelope,
  normalizeFindingFormat, parseJSONReport, parseReviewJSONReport, parseUniqueJSON,
} from '../src/output.mjs';

const snapshot = {
  repository: 'org/project/repo', prId: 123, scope: 'pr',
  base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['/a.js'],
};
const finding = {
  id: 'F-1', summary: 'Missing null guard', severity: 'medium',
  location: 'head:/a.js:12', evidence: 'A reachable null input fails at the new dereference.',
  counterevidence: 'The caller guards undefined only.', suggestion: 'Guard null and test this caller.',
};
function envelope(kind) {
  const common = { status: 'COMPLETE', snapshot: structuredClone(snapshot), report: 'Source checked.' };
  if (kind === 'initial') return {
    ...common, coverage: { files: ['/a.js'], gaps: [] }, findings: [structuredClone(finding)],
  };
  const final = { ...common, currentHead: snapshot.head, currentBase: snapshot.base, newFindings: [] };
  if (kind === 'legacy') return {
    ...final, dispositions: [{ id: 'F-1', status: 'CONFIRMED', reason: 'Checked source.', verifiedFinding: structuredClone(finding) }],
  };
  return {
    ...final, confirmed: [{ ...finding, reason: 'Checked source.' }], merged: [], rejected: [], needsInfo: [],
  };
}
function response(value, transport) {
  const json = JSON.stringify(value);
  return { info: { finish: 'stop' }, parts: [{ type: 'text', text: transport === 'fenced' ? '```json\n' + json + '\n```' : json }] };
}
function validate(value, kind, mode, transport) {
  const role = `azpr-${mode}-${kind === 'initial' ? 'functional' : 'verifier'}`;
  const parsed = parseReviewJSONReport(response(value, transport), role);
  const prepared = normalizeFindingFormat(parsed.envelope, role);
  const result = kind === 'initial'
    ? initialEnvelope(prepared.envelope, snapshot, 'F')
    : finalEnvelope(prepared.envelope, snapshot, [finding]);
  return { result, corrections: prepared.corrections };
}

for (const mode of ['review', 'deep']) {
  for (const transport of ['text', 'fenced']) {
    for (const kind of ['initial', 'categories', 'legacy']) {
      test(`known envelope fields are consistent: ${mode}/${transport}/${kind}`, () => {
        assert.equal(validate(envelope(kind), kind, mode, transport).result.status, 'COMPLETE');
        const targets = [value => value, value => value.snapshot];
        if (kind === 'initial') targets.push(value => value.coverage);
        if (kind === 'legacy') targets.push(value => value.dispositions[0]);
        for (const target of targets) for (const extra of ['', null, 'PRIVATE_CONTENT']) {
          const value = envelope(kind);
          target(value).PRIVATE_FIELD = extra;
          const before = JSON.stringify(value);
          assert.throws(() => validate(value, kind, mode, transport), error => {
            assert.match(error.message, /unexpected.*fields/i);
            assert.doesNotMatch(error.message, /PRIVATE_/);
            return true;
          });
          assert.equal(JSON.stringify(value), before, 'Rejection must preserve the original submission.');
          if (kind !== 'initial') assert.ok(finalSubmissionIssues(value).some(issue => issue.code === 'unexpected-fields'));
        }

        // The known finding-only tolerance must survive envelope consistency.
        const value = envelope(kind);
        const row = kind === 'initial' ? value.findings[0]
          : kind === 'legacy' ? value.dispositions[0].verifiedFinding : value.confirmed[0];
        row[' evidence'] = row.evidence;
        delete row.evidence;
        row.PRIVATE_EMPTY_FIELD = null;
        const accepted = validate(value, kind, mode, transport);
        assert.equal(accepted.result.status, 'COMPLETE');
        assert.equal(accepted.corrections.length, 2);
        assert.doesNotMatch(JSON.stringify(accepted.corrections), /PRIVATE_/);
      });
    }
  }
}

test('category and legacy disposition rows enforce the same declared keys', () => {
  for (const status of ['MERGED', 'REJECTED', 'NEEDS_INFO']) {
    const value = envelope('legacy');
    value.dispositions = [{ id: 'F-1', status, reason: 'Checked source.', PRIVATE_FIELD: '' }];
    assert.throws(() => finalEnvelope(value, snapshot, [finding]), /unexpected.*fields/i);
    assert.ok(finalSubmissionIssues(value).some(issue => issue.path === 'dispositions[0]' && issue.code === 'unexpected-fields'));
  }
});

test('standalone check rejects unknown envelope/snapshot keys in either transport', () => {
  for (const transport of ['text', 'fenced']) {
    const value = { status: 'READY', snapshot: { ...snapshot, scope: 'cumulative' }, report: 'Source ready.', sourceAccess: { arbitraryCapability: 'Available' } };
    const parse = candidate => parseJSONReport(response(candidate, transport));
    assert.equal(checkEnvelope(parse(value)).status, 'READY');
    for (const target of [candidate => candidate, candidate => candidate.snapshot]) {
      const extra = structuredClone(value);
      target(extra).PRIVATE_FIELD = null;
      assert.throws(() => checkEnvelope(parse(extra)), /unexpected.*fields/i);
    }
  }
});

test('known-field checks preserve partial, historical incomplete and original-ID gates', () => {
  const partial = { status: 'PARTIAL', coverage: { files: [], gaps: ['PR metadata unavailable.'] }, findings: [], report: 'Incomplete source.' };
  assert.equal(initialEnvelope(partial, null, 'F').status, 'PARTIAL');
  const value = envelope('legacy');
  value.status = 'INCOMPLETE';
  value.currentHead = null;
  value.currentBase = null;
  assert.equal(finalEnvelope(value, snapshot, [finding]).status, 'INCOMPLETE');
  value.dispositions = [];
  assert.throws(() => finalEnvelope(value, snapshot, [finding]), /disposition/i);
});

test('unique JSON parsing rejects nested and escaped-equivalent keys without exposing values', () => {
  for (const raw of [
    '{"enabled":true,"enabled":false}',
    '{"models":{"functional":"fixture/a","funct\\u0069onal":"fixture/b"}}',
    '{"nested":[{"PRIVATE_KEY":"PRIVATE_VALUE","PRIVATE_KEY":null}]}',
  ]) assert.throws(() => parseUniqueJSON(raw), error => {
    assert.match(error.message, /duplicate JSON keys/);
    assert.doesNotMatch(error.message, /PRIVATE_/);
    return true;
  });
  const value = { first: { model: 'fixture/a' }, second: { model: 'fixture/b' }, source: '{"same":1,"same":2}' };
  assert.deepEqual(parseUniqueJSON(JSON.stringify(value)), value);
  for (const raw of ['{"enabled":true,}', '{"enabled":', '{}{}']) assert.throws(() => parseUniqueJSON(raw));
});
