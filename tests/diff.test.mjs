import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffHunks, renderHunk, splitLines } from '../src/diff.mjs';

const lcs = (a, b) => {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
  return table[a.length][b.length];
};

test('line diffs rebuild both sides with the fewest edits', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lines = () => Array.from({ length: Math.floor(random() * 14) }, () => 'abcde'[Math.floor(random() * 5)]);
  for (let round = 0; round < 2000; round++) {
    const a = lines(), b = lines(), ops = diffLines(a, b);
    assert.deepEqual(ops.filter(op => op.kind !== '+').map(op => a[op.a]), a);
    assert.deepEqual(ops.filter(op => op.kind !== '-').map(op => op.kind === '+' ? b[op.b] : a[op.a]), b);
    assert.equal(ops.filter(op => op.kind !== '=').length, a.length + b.length - 2 * lcs(a, b), `${a.join('')} -> ${b.join('')}`);
  }
});

test('beyond the edit bound a change is one replacement, still exact', () => {
  const a = Array.from({ length: 60 }, (_, i) => `old ${i}`), b = Array.from({ length: 50 }, (_, i) => `new ${i}`);
  const ops = diffLines(['same', ...a, 'tail'], ['same', ...b, 'tail'], { maxEdits: 10 });
  assert.deepEqual(ops.map(op => op.kind).join(''), '=' + '-'.repeat(60) + '+'.repeat(50) + '=');
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
});

test('hunks keep more context before than after, merge when close and open at the enclosing block', () => {
  const base = ['import os', '', 'class Shop:', '    def cancel(self, order, units):', '        """Return released units."""', '        if order.status == "cancelled":',
    '            return units', '        order.status = "cancelled"', '        return units + order.units', '', ...Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`), 'VERSION = 1'];
  const head = base.filter((_, i) => i !== 5 && i !== 6).map(line => line === 'VERSION = 1' ? 'VERSION = 2' : line);
  const { hunks, baseLines, headLines } = diffHunks(base.join('\n') + '\n', head.join('\n') + '\n', { before: 1, after: 1 });
  assert.deepEqual([baseLines, headLines], [31, 29]);
  assert.equal(hunks.length, 2);
  // One line of context would start at the docstring; the enclosing def is near, so the hunk opens there.
  assert.equal(hunks[0].base, '4-8');
  assert.equal(hunks[0].head, '4-6');
  assert.equal(renderHunk(hunks[0], 2), [
    '@@ #1 BASE 4-8 → HEAD 4-6 @@',
    '   4  4 |     def cancel(self, order, units):',
    '   5  5 |         """Return released units."""',
    '-  6    |         if order.status == "cancelled":',
    '-  7    |             return units',
    '   8  6 |         order.status = "cancelled"'].join('\n'));
  assert.equal(hunks[1].title, '', 'A top-level change has no enclosing block.');
  // Distant blocks are named in the hunk title instead of being included.
  const far = ['def handler(event):', ...Array.from({ length: 60 }, (_, i) => `    step_${i}()`), '    return event'];
  const changed = far.map(line => line === '    step_50()' ? '    step_50(retry=False)' : line);
  const [hunk] = diffHunks(far.join('\n'), changed.join('\n')).hunks;
  assert.equal(hunk.title, 'def handler(event):');
  assert.match(renderHunk(hunk, 2), /^@@ #1 BASE 47-55 → HEAD 47-55 @@ in: def handler\(event\):\n/);
  // Two changes a few lines apart share one hunk.
  const near = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const both = near.map((line, i) => i === 10 || i === 16 ? `${line}!` : line);
  assert.equal(diffHunks(near.join('\n'), both.join('\n')).hunks.length, 1);
  assert.deepEqual(diffHunks('same\n', 'same\n').hunks, []);
});

test('a change repeated across a file folds to one line per repeat with the values that differ', () => {
  const route = (id, delay) => [`    {`, `      "route_id": "${id}",`, `      "retry_attempts": 3,`, `      "retry_delay_ms": ${delay},`, `      "audit": true`, `    },`];
  const migrated = (id, delay, region) => [`    {`, `      "route_id": "${id}",`, `      "audit": true,`, `      "retry": { "attempts": 3, "delay_ms": ${delay} },`, `      "fallback": "${region}"`, `    },`];
  const ids = Array.from({ length: 6 }, (_, i) => [`r-${i}`, 250 + 25 * i]);
  const base = ['{', '  "routes": [', ...ids.flatMap(([id, delay]) => route(id, delay)), '  ]', '}'].join('\n');
  const head = ['{', '  "routes": [', ...ids.flatMap(([id, delay], i) => migrated(id, delay, i === 4 ? 'region-x' : 'region-9')), '  ]', '}'].join('\n');
  const { hunks } = diffHunks(base, head);
  const shown = hunks.filter(hunk => !hunk.repeats), folded = hunks.filter(hunk => hunk.repeats);
  assert.equal(shown.length, 1, 'Only the first occurrence is shown with context.');
  assert.ok(folded.length >= 4 && folded.every(hunk => hunk.repeats === 1));
  const rendered = hunks.map(hunk => renderHunk(hunk, 2));
  assert.match(rendered.find(text => text.includes('"region-9"→"region-x"')), /^@@ #\d+ BASE \d+-\d+ → HEAD \d+-\d+ @@ folded: \d+ changed line\(s\) repeating #1 with 250→350, 250→350, "region-9"→"region-x"$/);
  // Two repeats are not enough to fold, and a change that differs in more than literals never folds.
  const twice = diffHunks(['a = 1', ...Array(20).fill('x'), 'a = 2'].join('\n'), ['a = 10', ...Array(20).fill('x'), 'a = 20'].join('\n')).hunks;
  assert.equal(twice.filter(hunk => hunk.repeats).length, 0);
  const renamed = Array.from({ length: 5 }, (_, i) => [`call(${i})`, ...Array(10).fill('pad')]).flat();
  const edited = renamed.map((line, i) => line.startsWith('call') ? (i % 2 ? `invoke(${i})` : `invoke${i}(x)`) : line);
  assert.ok(diffHunks(renamed.join('\n'), edited.join('\n')).hunks.filter(hunk => hunk.repeats).length < 4);
});
