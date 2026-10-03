import test from 'node:test';
import assert from 'node:assert/strict';
import * as output from '../src/output.mjs';
import { ROLES } from '../src/config.mjs';

const response = text => ({ info: { finish: 'stop' }, parts: [{ type: 'text', text }] });
const parse = (text, role = 'azpr-review-functional') => output.parseReviewJSONReport(response(text), role);

for (const role of ['azpr-review-functional', 'azpr-review-risk', 'azpr-review-verifier', 'azpr-deep-functional', 'azpr-deep-risk', 'azpr-deep-verifier']) {
  test(`trailing commas preserve values and record exact offsets: ${role}`, () => {
    const expected = { status: 'COMPLETE', evidence: 'literal ,} and ,] with "quotes" and \\ escapes', nested: [{ n: -1.25e2, ok: true, empty: null }, []] };
    const valid = JSON.stringify(expected);
    const raw = valid.slice(0, -2) + ',],}';
    const before = response(raw);
    const saved = JSON.stringify(before);
    const prepared = output.parseReviewJSONReport(before, role);
    assert.deepEqual(prepared.envelope, expected);
    assert.deepEqual(prepared.corrections, [
      { action: 'remove-trailing-comma', offset: raw.length - 4 },
      { action: 'remove-trailing-comma', offset: raw.length - 2 },
    ]);
    assert.equal(JSON.stringify(before), saved);
    assert.throws(() => output.parseJSONReport(before), /required JSON envelope/);
    assert.deepEqual(parse(valid, role), { envelope: expected, corrections: [] });
  });
}

test('one fenced envelope retains punctuation inside strings, Unicode and number lexemes', () => {
  const raw = '{"status":"COMPLETE","notes":"\\u4e2d\\t,}\\n,]","n":-0,"exponent":1.20e+2,"values":[false,{"x":"\\\"\\\\",},],}';
  const plain = parse(raw);
  for (const text of [raw, 'Result:\n```json\n' + raw + '\n```\nEnd.', '```JSON\r\n' + raw + '\r\n```']) {
    const prepared = parse(text);
    assert.deepEqual(prepared, plain);
    assert.equal(Object.is(prepared.envelope.n, -0), true);
    assert.equal(prepared.envelope.notes, '中\t,}\n,]');
    assert.equal(prepared.corrections.length, 3);
    let retained = raw;
    for (const { offset } of [...prepared.corrections].reverse()) {
      assert.equal(retained[offset], ',');
      retained = retained.slice(0, offset) + retained.slice(offset + 1);
    }
    assert.deepEqual(JSON.parse(retained), prepared.envelope);
    assert.match(retained, /1\.20e\+2/);
  }
});

for (const tail of [',}', '[,]', '[1,,]', '{,}', '{"a":,}', '{"a":1,"b":}', '[1,', '{"a":1,',
  '[1,2}', '[01,]', '[1.,]', '[NaN,]', '[True,]', "{'x':1,}", '{"a":1 /* note */,}',
  '{"a":"unclosed,}', '{"a":"bad\\q",}', '{"a":1,}\u00a0']) {
  test(`syntax tolerance rejects ambiguous or non-JSON content: ${JSON.stringify(tail)}`, () => {
    assert.throws(() => parse('{"status":"COMPLETE","value":' + tail + ',}'), /required JSON envelope/);
  });
}

test('syntax tolerance rejects duplicate keys, multiple envelopes and unsafe fencing', () => {
  for (const raw of ['{"status":"COMPLETE","status":"PARTIAL",}', '{"status":"COMPLETE","st\\u0061tus":"PARTIAL",}',
    '{"status":"COMPLETE","value":{"x":1,"\\u0078":2,},}']) {
    for (const text of [raw, '```json\n' + raw + '\n```']) assert.throws(() => parse(text), /duplicate JSON keys/);
  }
  for (const raw of ['{"status":"COMPLETE",}{}', '```json\n{"status":"COMPLETE",}\n```\n```json\n{}\n```',
    '{}\n```json\n{"status":"COMPLETE",}\n```', 'Prefix {\n```json\n{"status":"COMPLETE",}\n```',
    'prefix {"status":"COMPLETE",}', '[{"status":"COMPLETE",},]']) assert.throws(() => parse(raw));
});

test('syntax tolerance is limited to completed normal text reviews with a valid status', () => {
  const raw = '{"status":"COMPLETE",}';
  for (const [role, spec] of Object.entries(ROLES)) {
    if (!['initial', 'final'].includes(spec.format)) assert.throws(() => parse(raw, role));
  }
  assert.throws(() => parse(raw, 'unknown'));
  assert.throws(() => parse('{"status":"CCOMPLETE",}'), /status/);
  for (const finish of ['length', 'content-filter', 'error', 'cancelled', 'tool-calls', undefined]) {
    const value = response(raw); value.info.finish = finish;
    assert.throws(() => output.parseReviewJSONReport(value, 'azpr-review-functional'));
  }
  const value = response(raw); value.info.error = { type: 'api_error', message: 'Fixture error' };
  assert.throws(() => output.parseReviewJSONReport(value, 'azpr-review-functional'), /api_error/);
  assert.throws(() => output.parseReviewJSONReport(response(raw)), /required JSON envelope/);
});

test('deeply nested JSON is normalized without recursion', () => {
  const raw = '{"status":"COMPLETE","nested":' + '['.repeat(2000) + '0' + ',]'.repeat(2000) + ',}';
  const prepared = parse(raw);
  assert.equal(prepared.corrections.length, 2001);
  let value = prepared.envelope.nested;
  for (let i = 0; i < 2000; i++) { assert.equal(value.length, 1); value = value[0]; }
  assert.equal(value, 0);
});
