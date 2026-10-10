/**
 * Line diffs for reviewers: BASE → HEAD hunks with both line numbers, more
 * context before a change than after it, and the start of the enclosing block
 * (a function, class, object or section) when it is near. The runtime computes
 * the diff from the two file versions it already reads; nothing here calls
 * Azure DevOps.
 */

// Edits beyond this many lines between the common prefix and suffix are shown
// as one replacement instead of a minimal diff (bounded time and memory).
const MAX_EDITS = 2000;
export const DIFF_DEFAULTS = Object.freeze({ before: 5, after: 3, headerReach: 30, titleReach: 400, foldRepeats: 3 });

export const splitLines = text => {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * Myers' shortest edit script between two line arrays.
 * @returns {{kind: '='|'-'|'+', a: number, b: number}[]} a/b are 0-based indexes (-1 when absent)
 */
export function diffLines(a, b, { maxEdits = MAX_EDITS } = {}) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ kind: '=', a: i, b: i });
  ops.push(...middleScript(a, b, start, endA, start, endB, maxEdits));
  for (let i = 0; i < a.length - endA; i++) ops.push({ kind: '=', a: endA + i, b: endB + i });
  return ops;
}

function middleScript(a, b, a0, a1, b0, b1, maxEdits) {
  const n = a1 - a0, m = b1 - b0;
  const replace = () => [
    ...Array.from({ length: n }, (_, i) => ({ kind: '-', a: a0 + i, b: -1 })),
    ...Array.from({ length: m }, (_, i) => ({ kind: '+', a: -1, b: b0 + i })),
  ];
  if (!n || !m) return replace();
  const limit = Math.min(n + m, maxEdits), offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return replace();
  const script = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d], at = k => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push({ kind: '=', a: a0 + x - 1, b: b0 + y - 1 }); x--; y--; }
    if (down) script.push({ kind: '+', a: -1, b: b0 + y - 1 });
    else script.push({ kind: '-', a: a0 + x - 1, b: -1 });
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { script.push({ kind: '=', a: a0 + x - 1, b: b0 + y - 1 }); x--; y--; }
  return script.reverse();
}

const indentOf = line => {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
};
// Lines that cannot open a block: blank, comments and closers.
const opensNothing = line => {
  const trimmed = line.trim();
  return !trimmed || /^(?:#|\/\/|\/\*|\*|--|;|<!--)/.test(trimmed) || /^[)\]}>]+[;,]?$/.test(trimmed) || /^(?:end|fi|done|esac)\b/.test(trimmed);
};

/**
 * The nearest line above `index` that is indented less than the changed line:
 * the opening of the enclosing function, class, object or section.
 */
function enclosingLine(rows, index, reach) {
  const changed = rows.slice(index).find(row => !opensNothing(row.text));
  const reference = changed ? indentOf(changed.text) : 0;
  if (!reference) return -1;
  for (let i = index - 1, seen = 0; i >= 0 && seen < reach; i--, seen++) {
    if (rows[i].kind === '-' || opensNothing(rows[i].text)) continue;
    if (indentOf(rows[i].text) < reference) return i;
  }
  return -1;
}

// Strings and numbers; a repeated change differs only in these.
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b/g;
const span = (lines, side) => {
  const numbers = lines.map(row => row[side]).filter(number => number > 0);
  return numbers.length ? `${numbers[0]}-${numbers.at(-1)}` : 'none';
};

/**
 * Runs of changed rows. A run whose lines match an earlier run except for
 * string and number literals is a repeat of it (a mechanical edit applied in
 * many places, as in data migrations, renames or generated code).
 */
function changeBlocks(rows, foldRepeats) {
  const blocks = [];
  rows.forEach((row, index) => {
    if (row.kind === '=') return;
    const last = blocks.at(-1);
    if (last && last.end === index - 1) last.end = index;
    else blocks.push({ start: index, end: index });
  });
  const groups = new Map();
  for (const block of blocks) {
    const lines = rows.slice(block.start, block.end + 1);
    block.values = lines.flatMap(row => row.text.match(LITERAL) ?? []);
    const signature = lines.map(row => row.kind + row.text.replace(LITERAL, '\u0000').trim()).join('\n');
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(block);
  }
  for (const group of groups.values()) {
    if (group.length < foldRepeats) continue;
    for (const block of group.slice(1)) block.repeats = group[0];
  }
  return blocks;
}

/**
 * Hunks of a line diff with context. When one change is repeated at least
 * `foldRepeats` times in a file, later repeats away from shown hunks are
 * folded to one line naming the hunk they repeat and the values that differ.
 * @param {string} baseText
 * @param {string} headText
 * @param {{before?: number, after?: number, headerReach?: number, titleReach?: number, foldRepeats?: number}} options
 */
export function diffHunks(baseText, headText, options = {}) {
  const { before, after, headerReach, titleReach, foldRepeats } = { ...DIFF_DEFAULTS, ...options };
  const a = splitLines(baseText), b = splitLines(headText);
  const rows = diffLines(a, b).map(op => ({ kind: op.kind, base: op.a + 1, head: op.b + 1, text: op.kind === '+' ? b[op.b] : a[op.a] }));
  const blocks = changeBlocks(rows, foldRepeats);
  if (!blocks.length) return { hunks: [], baseLines: a.length, headLines: b.length };
  // Every changed row of a block is shown; nearby blocks share one hunk.
  const windows = [];
  for (const block of blocks.filter(block => !block.repeats)) {
    const last = windows.at(-1);
    if (last && block.start <= last.end + 1 + after + before) { last.end = block.end; continue; }
    windows.push({ first: block.start, end: block.end });
  }
  const hunks = windows.map(({ first, end }) => {
    const header = enclosingLine(rows, first, Math.max(headerReach, titleReach));
    let start = Math.max(0, first - before);
    if (header >= 0 && first - header <= headerReach) start = Math.min(start, header);
    const stop = Math.min(rows.length - 1, end + after);
    return { start, stop, title: header >= 0 && header < start ? rows[header].text.trim().slice(0, 160) : '' };
  });
  // A repeat that a hunk reaches into is shown whole in that hunk, not cut.
  for (const block of blocks.filter(block => block.repeats)) {
    const hunk = hunks.find(item => block.start <= item.stop && block.end >= item.start);
    if (hunk) { hunk.start = Math.min(hunk.start, block.start); hunk.stop = Math.max(hunk.stop, block.end); }
  }
  // Extended starts can overlap the previous hunk; merge those.
  const merged = [];
  for (const hunk of hunks) {
    const last = merged.at(-1);
    if (last && hunk.start <= last.stop + 1) last.stop = Math.max(last.stop, hunk.stop);
    else merged.push({ ...hunk });
  }
  // A repeat inside a shown hunk stays visible there; the others fold.
  const shownIn = index => merged.findIndex(hunk => index >= hunk.start && index <= hunk.stop);
  const folds = blocks.filter(block => block.repeats && shownIn(block.start) < 0 && shownIn(block.end) < 0);
  const items = [...merged.map(hunk => ({ ...hunk, position: hunk.start })), ...folds.map(block => ({ block, position: block.start }))]
    .sort((x, y) => x.position - y.position);
  const numberOf = block => items.findIndex(item => !item.block && block.start >= item.start && block.start <= item.stop) + 1;
  return {
    baseLines: a.length, headLines: b.length,
    hunks: items.map((item, index) => {
      if (!item.block) {
        const lines = rows.slice(item.start, item.stop + 1);
        return { number: index + 1, base: span(lines, 'base'), head: span(lines, 'head'), title: item.title, lines };
      }
      const { block } = item, lines = rows.slice(block.start, block.end + 1);
      const differences = block.values.flatMap((value, position) => value === block.repeats.values[position] ? [] : [`${block.repeats.values[position]}→${value}`]);
      return { number: index + 1, base: span(lines, 'base'), head: span(lines, 'head'), repeats: numberOf(block.repeats), differences, folded: lines.length };
    }),
  };
}

/** One hunk as text: "<mark> <BASE line> <HEAD line> | text"; a folded repeat is one line. */
export function renderHunk(hunk, width) {
  const where = `@@ #${hunk.number} BASE ${hunk.base} → HEAD ${hunk.head} @@`;
  if (hunk.repeats) {
    const values = hunk.differences.join(', ');
    const shown = values.length > 300 ? `${values.slice(0, 300)}…` : values;
    return `${where} folded: ${hunk.folded} changed line(s) repeating #${hunk.repeats}${hunk.differences.length ? ` with ${shown}` : ' exactly'}`;
  }
  const pad = number => (number > 0 ? String(number) : '').padStart(width);
  const mark = { '=': ' ', '-': '-', '+': '+' };
  const title = hunk.title ? ` in: ${hunk.title}` : '';
  return [`${where}${title}`,
    ...hunk.lines.map(row => `${mark[row.kind]} ${pad(row.kind === '+' ? 0 : row.base)} ${pad(row.kind === '-' ? 0 : row.head)} | ${row.text}`)].join('\n');
}
