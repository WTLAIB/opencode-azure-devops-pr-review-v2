import test from 'node:test';
import assert from 'node:assert/strict';
import { numberToolText } from '../src/output.mjs';

test('numbered display keeps source bytes, blank rows, Unicode and commit arguments', () => {
  const source = 'header\r\n\r\n    change("中文😀");\r\n';
  const original = { output: source, content: [{ type: 'text', text: source }], metadata: { note: 'retained' } };
  const input = { revision: 'b'.repeat(40), path: '/example.js' };
  const result = numberToolText(original, input);
  assert.equal(result.output, source);
  assert.deepEqual(original.content, [{ type: 'text', text: source }]);
  assert.equal(result.metadata, original.metadata);
  assert.match(result.content[0].text, /1 \| header\n2 \| \n3 \|     change\("中文😀"\);$/);
  assert.ok(result.content[0].text.includes(JSON.stringify(input)));
  assert.doesNotMatch(result.content[0].text, /4 \|/);
});

test('numbered display preserves final blank source lines and accepts absent display content', () => {
  assert.match(numberToolText({ output: 'a\n\n' }).content[0].text, /1 \| a\n2 \| $/);
  assert.match(numberToolText({ output: 'a\nb' }).content[0].text, /1 \| a\n2 \| b$/);
});

for (const [key, label] of [['head', 'HEAD (PR source)'], ['base', 'BASE (PR target)']]) {
  test(`numbered display labels exact nested ${key} arguments from the existing snapshot`, () => {
    const snapshot = { head: 'b'.repeat(40), base: 'a'.repeat(40) };
    const source = 'first\nsecond', result = numberToolText({ output: source }, { arbitrary: [{ value: snapshot[key] }] }, snapshot);
    assert.ok(result.content[0].text.includes(`Version argument: ${label}.`));
    assert.equal(result.output, source);
  });
}

test('snapshot labels do not infer a version from object keys, substrings or an absent snapshot', () => {
  const snapshot = { head: 'b'.repeat(40), base: 'a'.repeat(40) };
  for (const [input, reference] of [[{ [snapshot.head]: 'key only' }, snapshot],
    [{ command: 'show ' + snapshot.head }, snapshot], [{ revision: snapshot.head }, undefined]]) {
    assert.doesNotMatch(numberToolText({ output: 'first\nsecond' }, input, reference).content[0].text, /Version argument/);
  }
});

test('snapshot labels preserve both matches without choosing a side or certifying selector semantics', () => {
  const revision = 'b'.repeat(40);
  const display = numberToolText({ output: 'first\nsecond' }, { arbitraryText: revision }, { head: revision, base: revision }).content[0].text;
  assert.match(display, /HEAD \(PR source\); BASE \(PR target\)/);
});

test('errors, truncation, wrappers, attachments and structured results pass through unchanged', () => {
  for (const result of [
    undefined, { output: 'single line' }, { output: { code: 'a\nb' } },
    { output: 'a\nb', isError: true }, { output: 'a\nb', metadata: { isError: true } },
    { output: 'a\nb', metadata: { truncated: true } },
    { output: 'a\nb', content: [{ type: 'text', text: '<untrusted>a\nb</untrusted>' }] },
    { output: 'a\nb', content: [{ type: 'text', text: 'a\nb' }, { type: 'file', uri: 'fixture' }] },
    { output: 'a\nb', content: [] },
  ]) assert.equal(numberToolText(result, {}), result);
  const cycle = {}; cycle.self = cycle;
  const result = { output: 'a\nb' };
  assert.equal(numberToolText(result, cycle), result);
});
