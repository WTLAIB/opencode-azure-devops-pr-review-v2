/**
 * Model output parsing and review acceptance.
 *
 * Parsing is strict JSON: the whole answer, one ```json fence or one embedded
 * object. Anything else is reported as a concrete problem that the runtime
 * sends back to the same session as a repair turn. After the configured repair
 * attempts, acceptance degrades per item instead of discarding the review: a
 * finding that still lacks a field or a checkable location becomes NEEDS_INFO,
 * a merge or a rating that cannot be used is left out, and every other result
 * stays usable.
 */
import { parsePullRequestUrl } from './azure.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const asText = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export const canonicalKey = key => String(key).trim().replace(/[_\s-]/g, '').toLowerCase();
const canonicalEnum = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
const SEVERITIES = ['high', 'medium', 'low'];
export const FINDING_FIELDS = Object.freeze(['id', 'summary', 'evidence', 'counterevidence', 'location', 'severity', 'suggestion']);
const MAX_LISTED_ISSUES = 25;

/** Path part of a location such as "head:/src/a.ts:12-14"; '' when there is none. */
export function locationPath(location) {
  const match = /^(?:head|base)?:?(\/[^:]+)(?::\d+(?:-\d+)?)?$/.exec(String(location ?? '').trim());
  return match ? match[1] : '';
}

export function visibleText(response) {
  return (response?.parts ?? []).filter(p => p.type === 'text' && !p.ignored).map(p => p.text ?? '').join('\n');
}

// Call only after JSON.parse establishes grammar. Repeated keys must never
// silently replace an earlier value.
function rejectDuplicateJSONKeys(content, message) {
  const stack = [];
  for (const [token] of content.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)) stack.at(-1).key = true; }
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const frame = stack.at(-1), key = JSON.parse(token);
      if (frame.keys.has(key)) throw new Error(message);
      frame.keys.add(key); frame.key = false;
    }
  }
}

/** Strict local JSON for settings and stored data; no fences or repair. */
export function parseUniqueJSON(content) {
  const value = JSON.parse(content);
  rejectDuplicateJSONKeys(content, 'Input contains duplicate JSON keys; no field value was accepted.');
  return value;
}

function fencedBlocks(content) {
  const blocks = [];
  let open;
  for (const match of content.matchAll(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/gm)) {
    const [, delimiter, info] = match;
    if (!open) {
      open = { start: match.index, body: match.index + match[0].length, delimiter, json: /^(?:jsonc?)?\s*$/i.test(info.trim()) };
    } else if (!info.trim() && delimiter[0] === open.delimiter[0] && delimiter.length >= open.delimiter.length) {
      blocks.push({ start: open.start, end: match.index + match[0].length,
        text: content.slice(open.body, match.index).replace(/^\r?\n/, ''), json: open.json });
      open = undefined;
    }
  }
  return blocks;
}

/** Balanced top-level objects, ignoring braces inside double-quoted strings. */
function embeddedObjects(content) {
  const objects = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      objects.push({ start, end: i + 1, text: content.slice(start, i + 1) });
      start = -1;
    }
  }
  return objects;
}

/**
 * Narrow local repair for one frequent model slip: unescaped double quotes
 * inside a closed, single-line `inline code` span within a JSON string, as in
 * "evidence": "HEAD reads `cfg["x"]`". Spans that look like a JSON member
 * boundary are left alone. Returns null when nothing applies; the caller still parses and
 * validates the complete result.
 */
export function escapeCodeSpanQuotes(text) {
  let out = '', inString = false, count = 0;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (!inString) { if (char === '"') inString = true; out += char; i++; continue; }
    if (char === '\\') { out += char + (text[i + 1] ?? ''); i += 2; continue; }
    if (char === '"') { inString = false; out += char; i++; continue; }
    if (char === '`') {
      const delimiter = /^`+/.exec(text.slice(i))[0];
      const close = text.indexOf(delimiter, i + delimiter.length);
      const span = close < 0 ? '' : text.slice(i + delimiter.length, close);
      const bare = [...span.matchAll(/\\.|"/g)].filter(([token]) => token === '"').length;
      // `", "` or `": "` inside a span is a JSON member boundary, not code.
      if (close >= 0 && bare && bare % 2 === 0 && !/[\r\n]/.test(span) && !/"\s*[,:]\s*"/.test(span)) {
        out += delimiter + span.replace(/\\.|"/g, token => token === '"' ? '\\"' : token) + delimiter;
        count += bare;
        i = close + delimiter.length;
        continue;
      }
      out += delimiter;
      i += delimiter.length;
      continue;
    }
    out += char; i++;
  }
  return count ? { text: out, count } : null;
}

function tryParse(candidate) {
  const parse = text => {
    const value = JSON.parse(text);
    rejectDuplicateJSONKeys(text, 'the JSON object repeats a key');
    return value;
  };
  try { return { value: parse(candidate) }; }
  catch (error) {
    const repaired = escapeCodeSpanQuotes(candidate);
    if (repaired) {
      try { return { value: parse(repaired.text), corrections: [{ action: 'escape-quotes-in-code-span', count: repaired.count }] }; }
      catch { /* Report the original problem. */ }
    }
    return { error };
  }
}

/**
 * Extract exactly one JSON object from a model answer.
 * @param {string} raw
 * @param {{keys?: string[]}} options canonical keys that identify the expected object
 * @returns {{value?: object, surroundingText?: string, corrections?: object[], problem?: string}}
 */
export function parseModelJSON(raw, { keys = [] } = {}) {
  const content = String(raw ?? '').trim();
  if (!content) return { problem: 'the answer was empty' };
  const relevant = value => isObject(value) && (!keys.length || Object.keys(value).some(key => keys.includes(canonicalKey(key))));
  const whole = tryParse(content);
  const accept = (selected, extra = {}) => ({ value: selected.value, ...(selected.corrections ? { corrections: selected.corrections } : {}), ...extra });
  if (whole.value !== undefined) return relevant(whole.value) ? accept(whole) : { problem: 'the answer is JSON but not the expected object' };
  const blocks = fencedBlocks(content);
  const fenced = blocks.filter(block => block.json).map(block => ({ ...block, ...tryParse(block.text) }));
  const usable = fenced.filter(block => relevant(block.value));
  const surrounding = (selected) => (content.slice(0, selected.start) + content.slice(selected.end)).trim();
  if (usable.length === 1) return accept(usable[0], { surroundingText: surrounding(usable[0]) });
  if (usable.length > 1) return { problem: `the answer contains ${usable.length} JSON objects; return exactly one` };
  let outside = '', end = 0;
  for (const block of blocks) { outside += content.slice(end, block.start) + ' '.repeat(block.end - block.start); end = block.end; }
  outside += content.slice(end);
  const embedded = embeddedObjects(outside).map(object => ({ ...object, ...tryParse(object.text) })).filter(object => relevant(object.value));
  if (embedded.length === 1) return accept(embedded[0], { surroundingText: surrounding(embedded[0]) });
  if (embedded.length > 1) return { problem: `the answer contains ${embedded.length} JSON objects; return exactly one` };
  const failure = fenced.length === 1 ? fenced[0].error : content.includes('{') ? whole.error : null;
  return { problem: failure ? `the JSON could not be parsed (${String(failure.message).slice(0, 200)})` : 'no JSON object was found' };
}

/** Map aliased keys (case, underscores, spaces) onto the expected names. */
function aliasFields(value, names, warnings) {
  if (!isObject(value)) return {};
  const aliases = new Map(names.map(name => [canonicalKey(name), name]));
  const counts = new Map();
  for (const key of Object.keys(value)) {
    const name = aliases.get(canonicalKey(key));
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const result = {};
  for (const [key, content] of Object.entries(value)) {
    const name = aliases.get(canonicalKey(key));
    if (name && counts.get(name) > 1) {
      warnings.add('Conflicting field spellings were kept as written.');
      result[key] = content;
    } else result[name ?? key] = content;
  }
  return result;
}

function rows(value, warnings, label) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* Literal text. */ }
  }
  warnings.add(`${label} was not an array and was kept as one entry.`);
  return [value];
}

function normalizeFinding(value, warnings) {
  const row = isObject(value) ? aliasFields(value, FINDING_FIELDS, warnings) : { summary: asText(value) };
  for (const key of FINDING_FIELDS) {
    if (!Object.hasOwn(row, key)) continue;
    // A field is text or it is missing: false, a list or an object written where text goes is no text, however it
    // would read once turned into one, so the finding names that field as missing for its correction turn.
    if (key !== 'id' && typeof row[key] !== 'string') { row[key] = ''; warnings.add('A finding field that was not text was left out; the correction turn names it.'); continue; }
    row[key] = asText(row[key]).trim();
  }
  if (typeof row.severity === 'string') row.severity = row.severity.toLowerCase();
  return row;
}

/** Problems that make a finding unusable, phrased for a repair request. Every field but the ID is needed, the location included. */
function findingProblems(row) {
  const missing = FINDING_FIELDS.filter(key => key !== 'id' && !text(row[key]));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (text(row.severity) && !SEVERITIES.includes(row.severity)) problems.push('severity must be high, medium or low');
  return problems;
}

/** Give missing, malformed or repeated IDs stable runtime IDs. */
export function assignIds(findings, prefix, warnings) {
  const pattern = new RegExp(`^${prefix}-[1-9][0-9]*$`);
  const reserved = new Set(findings.map(row => row.id).filter(id => typeof id === 'string' && pattern.test(id)));
  const used = new Set();
  let next = 1;
  for (const row of findings) {
    if (typeof row.id !== 'string' || !pattern.test(row.id) || used.has(row.id)) {
      if (text(row.id)) row.originalId = row.id;
      while (reserved.has(`${prefix}-${next}`)) next++;
      row.id = `${prefix}-${next++}`;
      reserved.add(row.id);
      warnings.add('Runtime IDs replaced missing, malformed or repeated finding IDs.');
    }
    used.add(row.id);
  }
}

const listIssues = issues => issues.slice(0, MAX_LISTED_ISSUES).map(issue => `- ${issue}`).join('\n') +
  (issues.length > MAX_LISTED_ISSUES ? `\n- ... and ${issues.length - MAX_LISTED_ISSUES} more` : '');

/**
 * Accept one reviewer answer for an assigned set of files.
 * Always returns a usable result; `issues` lists what a repair turn should fix.
 * `invalid` maps finding IDs to the field problems that make them unusable (a
 * plain object, so stage records keep it), and
 * `envelope` says whether `findings` was an array and `coverage` an object: a
 * parsed answer is not necessarily a usable review.
 * @param {{prefix: string, assigned?: string[], inventory?: string[], filesComplete?: boolean}} options
 */
export function evaluateInitial(answerText, { prefix, assigned = [], inventory = [], filesComplete = true }) {
  const warnings = new Set();
  const parsed = parseModelJSON(answerText, { keys: ['status', 'findings', 'coverage', 'report'] });
  if (!parsed.value) {
    const report = String(answerText ?? '').trim();
    return {
      issues: [`Your answer could not be used: ${parsed.problem}.`],
      result: { status: 'PARTIAL', structured: false, coverage: { files: [], gaps: ['The reviewer answer was not structured JSON.'] },
        additionalFiles: [], findings: [], report, warnings: ['The reviewer answer was not structured; its text is kept as it is.'],
        invalid: {}, envelope: { findings: false, coverage: false } },
    };
  }
  if (parsed.corrections) warnings.add('A JSON formatting slip (unescaped quotes in inline code) was repaired locally.');
  const source = aliasFields(parsed.value, ['status', 'coverage', 'additionalFiles', 'findings', 'report'], warnings);
  const issues = [];
  const coverage = aliasFields(source.coverage, ['files', 'gaps'], warnings);
  const covered = rows(coverage.files, warnings, 'coverage.files').map(asText).filter(text);
  const gaps = rows(coverage.gaps, warnings, 'coverage.gaps').map(asText).filter(text);
  const envelope = { findings: Array.isArray(source.findings), coverage: isObject(source.coverage) };
  if (!envelope.findings) issues.push('"findings" must be an array (use [] when there are none).');
  if (!envelope.coverage) issues.push('"coverage" must be an object with "files" (reviewed paths) and "gaps".');
  const findings = rows(source.findings, warnings, 'findings').map(row => normalizeFinding(row, warnings));
  const problems = findings.map((row, index) => {
    const found = findingProblems(row);
    if (found.length) issues.push(`findings[${index}]${text(row.id) ? ` (${row.id})` : ''}: ${found.join('; ')}.`);
    return found;
  });
  assignIds(findings, prefix, warnings);
  const invalid = Object.fromEntries(findings.map((row, index) => [row.id, problems[index]]).filter(([, found]) => found.length));
  const known = new Set([...inventory, ...assigned]);
  const additionalFiles = [...new Set(rows(source.additionalFiles, warnings, 'additionalFiles').map(asText)
    .filter(path => text(path) && !/[\0\r\n]/.test(path)).map(path => path.startsWith('/') ? path : '/' + path))]
    .filter(path => !known.has(path));
  if (additionalFiles.length && filesComplete) {
    warnings.add('The reviewer listed changed paths outside the complete inventory; the report names them.');
  }
  const missingCoverage = assigned.filter(path => !covered.includes(path));
  let status = canonicalEnum(source.status) === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL';
  if (status === 'COMPLETE' && (missingCoverage.length || gaps.length)) {
    status = 'PARTIAL';
    if (missingCoverage.length) warnings.add(`${missingCoverage.length} assigned file(s) are not listed in coverage.files.`);
  }
  const report = asText(source.report).trim();
  if (!report) warnings.add('The reviewer gave no report text.');
  return {
    issues,
    result: { status, structured: true, coverage: { files: covered, gaps }, additionalFiles, findings, report,
      warnings: [...warnings], ...(parsed.corrections ? { corrections: parsed.corrections } : {}),
      ...(parsed.surroundingText ? { surroundingText: parsed.surroundingText } : {}), invalid, envelope },
  };
}

/**
 * Accept one duplicate check of the findings different reviewer sessions
 * reported in one file. The answer only merges: every finding it does not merge
 * stays reported, so an invalid row is reported for a correction turn and
 * otherwise ignored, never turning into a lost finding. Chains (A into B, B
 * into C) end at the finding that stays; cycles name no survivor and are left
 * unmerged.
 * `sessions` names, per finding, the reviewer sessions that reported it (several
 * for a finding that already stands for identical ones). A session files one
 * finding per place that needs its own correction, so findings of one session
 * never end up in one group, neither directly nor through a third finding:
 * merges are applied in the answer's order, and one that would bring two
 * findings of a session together is refused, reported for a correction turn and
 * otherwise left out.
 * @param {string} answerText
 * @param {{ids: string[], sessions?: Record<string, string[]>}} options the findings of the checked file
 */
export function evaluateDuplicates(answerText, { ids, sessions = {} }) {
  const warnings = new Set();
  const parsed = parseModelJSON(answerText, { keys: ['status', 'merged', 'report'] });
  if (!parsed.value) {
    return { issues: [`Your answer could not be used: ${parsed.problem}.`],
      result: { status: 'COMPLETE', structured: false, merges: [], report: '', warnings: ['The duplicate check gave no usable answer; no finding was merged.'] } };
  }
  if (parsed.corrections) warnings.add('A JSON formatting slip (unescaped quotes in inline code) was repaired locally.');
  const source = aliasFields(parsed.value, ['status', 'merged', 'report'], warnings);
  const assigned = new Set(ids), issues = [], rowsById = new Map();
  if (!Array.isArray(source.merged)) issues.push('"merged" must be an array (use [] when none of the findings are duplicates).');
  for (const [index, item] of rows(source.merged, warnings, 'merged').entries()) {
    const row = aliasFields(isObject(item) ? item : {}, ['id', 'mergedInto', 'reason'], warnings);
    const id = asText(row.id).trim(), into = asText(row.mergedInto).trim(), problems = [];
    if (!assigned.has(id)) problems.push(`id ${JSON.stringify(id)} is not an assigned finding`);
    if (!assigned.has(into) || into === id) problems.push('mergedInto must name another assigned finding');
    if (!text(asText(row.reason))) problems.push('give a concrete reason');
    if (rowsById.has(id)) problems.push(`${id} is merged more than once`);
    if (problems.length) { issues.push(`merged[${index}]: ${problems.join('; ')}.`); continue; }
    rowsById.set(id, { id, mergedInto: into, reason: asText(row.reason).trim() });
  }
  // A cycle names no finding that stays: its rows are reported and left out.
  const cyclic = new Set();
  for (const row of rowsById.values()) {
    const seen = new Set([row.id]);
    let target = row.mergedInto;
    while (rowsById.has(target) && !seen.has(target)) { seen.add(target); target = rowsById.get(target).mergedInto; }
    if (rowsById.has(target)) { cyclic.add(row.id); issues.push(`${row.id}: the merges form a cycle; keep one of these findings and merge the others into it.`); }
  }
  // The groups grow in the answer's order. Each has the finding that stays (`kept`), its members and the sessions
  // that reported them; a merge whose group shares a session with the group it would join is refused.
  const groupOf = new Map(ids.map(id => [id, { kept: id, members: [id], sessions: new Set(sessions[id] ?? []) }]));
  const applied = [];
  let refused = 0;
  for (const row of rowsById.values()) {
    if (cyclic.has(row.id)) continue;
    const from = groupOf.get(row.id), into = groupOf.get(row.mergedInto);
    if (from === into) continue;
    const shared = [...from.sessions].find(session => into.sessions.has(session));
    if (shared !== undefined) {
      const own = from.members.find(id => (sessions[id] ?? []).includes(shared)), twin = into.members.find(id => (sessions[id] ?? []).includes(shared));
      issues.push(`${row.id} into ${row.mergedInto}: ${own} and ${twin} were both reported by the session ${JSON.stringify(shared)}, which filed them as separate findings, so they cannot end up in one finding. Merge only the one that repeats the other session's finding, if any, and leave the other separate.`);
      refused++;
      continue;
    }
    for (const session of from.sessions) into.sessions.add(session);
    into.members.push(...from.members);
    for (const id of from.members) groupOf.set(id, into);
    applied.push(row);
  }
  // Every merged finding names the finding its group keeps, also where its own target was merged later.
  const merges = applied.map(row => ({ ...row, mergedInto: groupOf.get(row.id).kept }));
  // Whether the answer decided anything: a list of merges, also an empty one. Without one it compared nothing.
  const decided = Array.isArray(source.merged);
  const unmerged = issues.length ? [`Some duplicate-check merges were invalid and were not applied${refused ? ` (${refused} would have joined two findings of one reviewer session)` : ''}; those findings stay reported.`] : [];
  return { issues, result: { status: 'COMPLETE', structured: true, decided, merges, refused, report: asText(source.report).trim(), warnings: [...warnings, ...unmerged],
    ...(parsed.corrections ? { corrections: parsed.corrections } : {}) } };
}

/**
 * Accept one severity rating. The answer only sets levels: a finding it does
 * not rate, or rates with something else than high, medium or low, keeps its
 * reviewer's severity, so an invalid row is reported for a correction turn and
 * otherwise ignored.
 * @param {string} answerText
 * @param {{ids: string[]}} options the findings to rate
 */
export function evaluateRatings(answerText, { ids }) {
  const warnings = new Set();
  const parsed = parseModelJSON(answerText, { keys: ['status', 'ratings', 'report'] });
  if (!parsed.value) {
    return { issues: [`Your answer could not be used: ${parsed.problem}.`],
      result: { status: 'COMPLETE', structured: false, ratings: [], report: '', warnings: ['The severity rating gave no usable answer; the reviewers\' severities are kept.'] } };
  }
  if (parsed.corrections) warnings.add('A JSON formatting slip (unescaped quotes in inline code) was repaired locally.');
  const source = aliasFields(parsed.value, ['status', 'ratings', 'report'], warnings);
  const assigned = new Set(ids), issues = [], byId = new Map();
  if (!Array.isArray(source.ratings)) issues.push('"ratings" must be an array with one entry per assigned finding.');
  for (const [index, item] of rows(source.ratings, warnings, 'ratings').entries()) {
    const row = aliasFields(isObject(item) ? item : {}, ['id', 'severity', 'reason'], warnings);
    const id = asText(row.id).trim(), severity = asText(row.severity).trim().toLowerCase(), problems = [];
    if (!assigned.has(id)) problems.push(`id ${JSON.stringify(id)} is not an assigned finding`);
    if (!SEVERITIES.includes(severity)) problems.push('severity must be high, medium or low');
    if (byId.has(id)) problems.push(`${id} is rated more than once`);
    if (problems.length) { issues.push(`ratings[${index}]: ${problems.join('; ')}.`); continue; }
    byId.set(id, { id, severity, reason: asText(row.reason).trim() });
  }
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) issues.push(`No usable rating for ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}.`);
  const kept = missing.length ? [`${missing.length} finding(s) got no usable rating and keep their reviewer's severity.`] : [];
  return { issues, result: { status: 'COMPLETE', structured: true, ratings: [...byId.values()], report: asText(source.report).trim(), warnings: [...warnings, ...kept],
    ...(parsed.corrections ? { corrections: parsed.corrections } : {}) } };
}

export function ratingRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  return `AZPR runtime: your severity rating needs correction.\n${listIssues(issues)}\n\nReturn the complete JSON object again (status, ratings, report) with exactly one rating (high, medium or low) for every ID in assignment.findingIds.`;
}

export function duplicateRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  return `AZPR runtime: your duplicate check needs correction.\n${listIssues(issues)}\n\nReturn the complete JSON object again (status, merged, report). Merge an assigned finding only into another assigned finding that stays, and only when both state the same root cause and need the same correction; two findings of one session stay separate.`;
}

// When only the JSON syntax was wrong, the content must come back unchanged:
// a free-form resend tends to shorten evidence.
const VERBATIM = 'Send the same answer again with identical content: do not shorten, summarize, reorder or reword any field. Only fix the JSON so it parses: escape every double quote inside a string as \\" (also inside `code`), write line breaks as \\n, and return exactly one JSON object.';
/** The answer had JSON with a syntax error (as opposed to no JSON at all). */
export const syntaxProblem = issues => issues.some(issue => /could not be parsed|repeats a key/.test(issue));
export const parseRepairPrompt = issues => `AZPR runtime: your previous answer was not valid JSON.\n${listIssues(issues)}\n\n${VERBATIM}`;

/** Repair request for a reviewer: the whole object, with what to do about failed locations. */
export function reviewRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  return `AZPR runtime: your previous answer needs correction before it can be used.\n${listIssues(issues)}\n\nReturn the complete corrected JSON object for the same review (status, coverage, additionalFiles, findings, report). For a location problem, read the file with azpr_read_diff or azpr_read_file and correct the location, locate the finding at readable source that supports it, or move the concern to report. Keep every finding you still stand behind and keep the existing wording of fields that need no correction.`;
}

/**
 * The one follow-up turn for a reviewer whose answer is PARTIAL with work it named:
 * the same session continues where the source is readable and keeps honest limits.
 */
export function reviewFollowUpPrompt({ gaps = [], uncovered = [] }) {
  const listed = uncovered.slice(0, 20).join(', ') + (uncovered.length > 20 ? `, and ${uncovered.length - 20} more` : '');
  const items = [...gaps, ...(uncovered.length ? [`Assigned files not listed as reviewed: ${listed}`] : [])];
  return `AZPR runtime: your answer is PARTIAL and names work that is not finished.\n${listIssues(items)}\n\nWhere a check you need is unfinished and the source it needs is readable with AZPR's tools, continue it now. Keep a gap only for a limit you cannot close (binary, oversized or missing content, a tool that keeps failing) and say what stopped you. Then return the complete JSON object again (status, coverage, additionalFiles, findings, report): every finding you still stand behind and any you found now, with status COMPLETE only when every assigned file is reviewed and no gap remains.`;
}

/** The flags a review command takes right after the PR URL, and the afterReview mode each sets for that run. */
export const REVIEW_FLAGS = Object.freeze({ '--preview': 'preview', '--publish': 'publish', '--no-comment': 'none' });
const FLAG_NAMES = '--preview, --publish or --no-comment';
// What looks like an option: dashes (also typographic ones) directly followed by a name.
const OPTION = /^([-–—]\S+)(?:\s+([\s\S]*))?$/;

/**
 * Keep supplementary text literal; do not shell-tokenize, unquote or expand it.
 * At most one flag may follow the URL directly (`flags: false` for a command
 * without comments takes none); anything else there that looks like an
 * option is refused, so a mistyped --no-comment never falls back to the
 * afterReview setting. Context starts with the first word after that.
 */
export function parseReviewRequest(raw, { flags = true } = {}) {
  if (typeof raw !== 'string' || raw.length > 16000 || raw.includes('\0')) throw new Error('[AZPR] Supply a PR URL and optional context (maximum 16000 characters).');
  const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error('[AZPR] Supply a PR URL and optional context.');
  if (OPTION.test(match[1])) throw new Error(`[AZPR] Put the PR URL first${flags ? `, then at most one of ${FLAG_NAMES}, then your context` : ''}.`);
  const target = parsePullRequestUrl(match[1]);
  const option = OPTION.exec(match[2] ?? '');
  if (option && !flags) throw new Error('[AZPR] This command makes no comments and takes no option after the PR URL; start any context with a word.');
  if (option && !Object.hasOwn(REVIEW_FLAGS, option[1])) throw new Error(`[AZPR] Unknown option after the PR URL. Use ${FLAG_NAMES} right after the URL, and start your context with a word.`);
  const userContext = option ? option[2] ?? '' : match[2] ?? '';
  if (option && OPTION.test(userContext)) throw new Error(`[AZPR] Use at most one of ${FLAG_NAMES}, right after the PR URL, and start your context with a word.`);
  return { request: raw, prUrl: match[1], userContext, target, ...(option ? { flag: option[1], afterReview: REVIEW_FLAGS[option[1]] } : {}) };
}

/** A finding ID as the runtime writes it (F-1, Q-1001, V-2); f1 and F1 read as F-1. null otherwise. */
export function normalizeFindingId(value) {
  const match = /^([A-Za-z]+)-?(\d+)$/.exec(String(value ?? '').trim());
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

const COMMENT_USAGE = '[AZPR] Usage: /pr-comment [review-id] [--publish | --show], or with --exclude <IDs|none> and/or --severity <ID=high|medium|low,…|none>, or --reset; /pr-comment --list shows the saved reviews. Without an ID the command acts on this conversation\'s current review. /pr-comment --help has examples.';
const COMMENT_OPTIONS = ['publish', 'show', 'list', 'exclude', 'severity', 'reset', 'seen'];
// The word for what a review's comments were when a step was offered (`commentToken` in comments.mjs).
const SEEN = /^[a-f0-9]{12}$/;

/**
 * /pr-comment's arguments: an optional review ID, then at most one of
 * --publish and --show, or adjustments of the review's findings:
 * --exclude and --severity (each at most once, each a complete list; `none`
 * for an empty one) or --reset alone. List items are separated by commas or
 * spaces. --list stands alone and names no review. Anything else is refused.
 * Without an ID the runtime picks the conversation's current review.
 * --seen <word> goes with any of them but --show and --list: it names what the
 * review's preview and adjustments were when the step was offered, and the
 * runtime refuses the command when they are something else by now. The
 * terminal panel adds it to the commands it sends; a typed command needs none.
 */
export function parseCommentRequest(raw) {
  const args = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const reviewId = /^[a-f0-9]{8}$/.test(args[0] ?? '') ? args.shift() : undefined;
  const values = new Map();
  let open = null;
  for (const token of args) {
    const option = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(token);
    if (option) {
      if (!COMMENT_OPTIONS.includes(option[1]) || values.has(option[1])) throw new Error(COMMENT_USAGE);
      open = ['exclude', 'severity', 'seen'].includes(option[1]) ? option[1] : null;
      if (option[2] !== undefined && !open) throw new Error(COMMENT_USAGE);
      values.set(option[1], option[2] === undefined ? [] : [option[2]]);
      continue;
    }
    if (!open) throw new Error(COMMENT_USAGE);
    values.get(open).push(token);
  }
  const seen = values.get('seen');
  if (seen && (seen.length !== 1 || !SEEN.test(seen[0]) || values.has('show') || values.has('list'))) {
    throw new Error('[AZPR] --seen takes the one word the terminal panel adds to its commands, and goes with neither --show nor --list; a typed command needs none.');
  }
  values.delete('seen');
  const named = [...values.keys()];
  const request = { ...(reviewId ? { reviewId } : {}), publish: values.has('publish'), show: values.has('show'), ...(seen ? { seen: seen[0] } : {}) };
  if (values.has('list')) {
    if (named.length > 1 || reviewId) throw new Error(COMMENT_USAGE);
    return { list: true };
  }
  if (!named.some(name => ['exclude', 'severity', 'reset'].includes(name))) {
    if (named.length > 1) throw new Error(COMMENT_USAGE);
    return request;
  }
  if (named.some(name => ['publish', 'show'].includes(name)) || (values.has('reset') && named.length > 1)) throw new Error(COMMENT_USAGE);
  const items = name => values.get(name).join(' ').split(/[\s,]+/).filter(Boolean);
  const adjust = values.has('reset') ? { reset: true } : {};
  if (values.has('exclude')) {
    const listed = items('exclude');
    if (!listed.length) throw new Error('[AZPR] --exclude needs the finding IDs to exclude, or none.');
    if (listed.length === 1 && listed[0].toLowerCase() === 'none') adjust.exclude = [];
    else {
      const ids = listed.map(normalizeFindingId);
      const bad = listed.filter((_, index) => !ids[index]);
      if (bad.length) throw new Error(`[AZPR] Not a finding ID: ${bad.join(', ')}. Use the IDs of the review report, such as F-1 or R-2, or none.`);
      adjust.exclude = [...new Set(ids)];
    }
  }
  if (values.has('severity')) {
    const listed = items('severity');
    if (!listed.length) throw new Error('[AZPR] --severity needs ID=high, ID=medium or ID=low entries, or none.');
    if (listed.length === 1 && listed[0].toLowerCase() === 'none') adjust.severity = {};
    else {
      adjust.severity = {};
      for (const entry of listed) {
        const match = /^([^=]+)=(high|medium|low)$/i.exec(entry), id = match && normalizeFindingId(match[1]);
        if (!id) throw new Error(`[AZPR] Not a severity change: ${entry}. Write ID=high, ID=medium or ID=low, such as F-2=low.`);
        if (Object.hasOwn(adjust.severity, id)) throw new Error(`[AZPR] --severity names ${id} twice.`);
        adjust.severity[id] = match[2].toLowerCase();
      }
    }
  }
  return { ...request, adjust };
}
