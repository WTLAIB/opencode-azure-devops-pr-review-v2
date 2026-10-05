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
