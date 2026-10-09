/**
 * Model output parsing and review acceptance.
 *
 * Parsing is strict JSON: the whole answer, one ```json fence or one embedded
 * object. Anything else is reported as a concrete problem that the runtime
 * sends back to the same session as a repair turn. After the configured repair
 * attempts, acceptance degrades per item instead of discarding the review:
 * missing verifier decisions become UNREVIEWED and incomplete confirmations
 * become NEEDS_INFO, while every other result stays usable.
 */
import { parsePullRequestUrl } from './azure.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const asText = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export const canonicalKey = key => String(key).trim().replace(/[_\s-]/g, '').toLowerCase();
const canonicalEnum = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
const SEVERITIES = ['high', 'medium', 'low'];
export const FINDING_FIELDS = Object.freeze(['id', 'summary', 'evidence', 'counterevidence', 'location', 'severity', 'suggestion']);
const DECISIONS = ['CONFIRMED', 'MERGED', 'REJECTED', 'NEEDS_INFO'];
const MAX_LISTED_ISSUES = 25;

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
  for (const key of FINDING_FIELDS) if (Object.hasOwn(row, key)) row[key] = asText(row[key]).trim();
  if (typeof row.severity === 'string') row.severity = row.severity.toLowerCase();
  return row;
}

/** Problems that make a finding unusable, phrased for a repair request. */
function findingProblems(row, { requireLocation }) {
  const missing = FINDING_FIELDS.filter(key => key !== 'id' && (key !== 'location' || requireLocation) && !text(row[key]));
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
 * Accept one initial-review answer for an assigned set of files.
 * Always returns a usable result; `issues` lists what a repair turn should fix.
 */
export function evaluateInitial(answerText, { prefix, assigned = [], inventory = [], filesComplete = true }) {
  const warnings = new Set();
  const parsed = parseModelJSON(answerText, { keys: ['status', 'findings', 'coverage', 'report'] });
  if (!parsed.value) {
    const report = String(answerText ?? '').trim();
    return {
      issues: [`Your answer could not be used: ${parsed.problem}.`],
      result: { status: 'PARTIAL', structured: false, coverage: { files: [], gaps: ['The reviewer answer was not structured JSON.'] },
        additionalFiles: [], findings: [], report, warnings: ['The initial answer was not structured; its text is passed to verification as-is.'] },
    };
  }
  if (parsed.corrections) warnings.add('A JSON formatting slip (unescaped quotes in inline code) was repaired locally.');
  const source = aliasFields(parsed.value, ['status', 'coverage', 'additionalFiles', 'findings', 'report'], warnings);
  const issues = [];
  const coverage = aliasFields(source.coverage, ['files', 'gaps'], warnings);
  const covered = rows(coverage.files, warnings, 'coverage.files').map(asText).filter(text);
  const gaps = rows(coverage.gaps, warnings, 'coverage.gaps').map(asText).filter(text);
  if (!Array.isArray(source.findings)) issues.push('"findings" must be an array (use [] when there are none).');
  if (!isObject(source.coverage)) issues.push('"coverage" must be an object with "files" (reviewed paths) and "gaps".');
  const findings = rows(source.findings, warnings, 'findings').map(row => normalizeFinding(row, warnings));
  findings.forEach((row, index) => {
    const problems = findingProblems(row, { requireLocation: false });
    if (problems.length) issues.push(`findings[${index}]${text(row.id) ? ` (${row.id})` : ''}: ${problems.join('; ')}.`);
  });
  assignIds(findings, prefix, warnings);
  const known = new Set([...inventory, ...assigned]);
  const additionalFiles = [...new Set(rows(source.additionalFiles, warnings, 'additionalFiles').map(asText)
    .filter(path => text(path) && !/[\0\r\n]/.test(path)).map(path => path.startsWith('/') ? path : '/' + path))]
    .filter(path => !known.has(path));
  if (additionalFiles.length && filesComplete) {
    warnings.add('The reviewer listed changed paths outside the complete inventory; they are kept for verification only.');
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
      ...(parsed.surroundingText ? { surroundingText: parsed.surroundingText } : {}) },
  };
}

function normalizeDecisionRows(value, warnings) {
  const source = aliasFields(value, ['status', 'dispositions', 'confirmed', 'merged', 'rejected', 'needsInfo', 'newFindings', 'report'], warnings);
  const decisions = [];
  for (const item of rows(source.dispositions, warnings, 'dispositions')) {
    const row = aliasFields(isObject(item) ? item : { reason: asText(item) }, ['id', 'status', 'reason', 'mergedInto', 'verifiedFinding'], warnings);
    decisions.push({ ...row, id: asText(row.id).trim(), status: canonicalEnum(row.status) });
  }
  for (const [category, status] of Object.entries({ confirmed: 'CONFIRMED', merged: 'MERGED', rejected: 'REJECTED', needsInfo: 'NEEDS_INFO' })) {
    for (const item of rows(source[category], warnings, category)) {
      const row = aliasFields(isObject(item) ? item : { reason: asText(item) }, [...FINDING_FIELDS, 'reason', 'mergedInto', 'verifiedFinding'], warnings);
      if (status === 'CONFIRMED') {
        const { reason, verifiedFinding, mergedInto, ...finding } = row;
        decisions.push({ id: asText(row.id ?? verifiedFinding?.id).trim(), status, reason, verifiedFinding: verifiedFinding ?? finding });
      } else decisions.push({ ...row, id: asText(row.id).trim(), status });
    }
  }
  return { source, decisions };
}

/**
 * Accept one verifier answer for its assigned original findings.
 * @param {string} answerText
 * @param {{originals: object[], allIds?: string[], previous?: object, supplement?: boolean}} options
 */
export function evaluateFinal(answerText, { originals, allIds = originals.map(f => f.id), previous, supplement = false }) {
  // A supplement merges into the previous result and keeps its normalization
  // notes; a full resend starts clean so a failed first answer leaves no trace.
  const warnings = new Set(supplement && previous?.structured ? previous.baseWarnings ?? [] : []);
  const parsed = parseModelJSON(answerText, { keys: ['status', 'confirmed', 'merged', 'rejected', 'needsinfo', 'newfindings', 'dispositions', 'report'] });
  if (parsed.corrections) warnings.add('A JSON formatting slip (unescaped quotes in inline code) was repaired locally.');
  const assignedIds = originals.map(f => f.id);
  if (!parsed.value) {
    if (previous?.structured) {
      return { issues: [`Your correction could not be used: ${parsed.problem}.`], result: previous, repairIds: previous.pendingIds ?? [] };
    }
    return {
      issues: [`Your answer could not be used: ${parsed.problem}.`],
      repairIds: assignedIds,
      result: finishFinal({ structured: false, modelStatus: 'UNSPECIFIED', decisions: new Map(), newFindings: [],
        report: String(answerText ?? '').trim(), warnings: new Set(['The verifier answer was not structured; its text is shown as-is.']) }, originals),
    };
  }
  const { source, decisions } = normalizeDecisionRows(parsed.value, warnings);
  const byId = new Map(supplement && previous?.structured ? previous.decisionRows.map(row => [row.id, row]) : []);
  const issues = [];
  const assigned = new Set(assignedIds), all = new Set(allIds);
  for (const row of decisions) {
    if (!assigned.has(row.id)) { warnings.add(`Ignored a decision for unassigned ID ${row.id || '(blank)'}.`); continue; }
    if (!supplement && byId.has(row.id)) { warnings.add(`Kept the first of several decisions for ${row.id}.`); continue; }
    byId.set(row.id, row);
  }
  const repairIds = new Set(), invalid = { confirm: new Set(), merge: new Set() };
  for (const id of assignedIds) {
    const row = byId.get(id);
    if (!row) { repairIds.add(id); continue; }
    if (!DECISIONS.includes(row.status)) { issues.push(`${id}: status must be one of ${DECISIONS.join(', ')}.`); repairIds.add(id); continue; }
    if (!text(row.reason)) { issues.push(`${id}: give a concrete reason.`); repairIds.add(id); }
    if (row.status === 'MERGED' && (!all.has(row.mergedInto) || row.mergedInto === id)) {
      issues.push(`${id}: mergedInto must name another original finding ID.`); repairIds.add(id); invalid.merge.add(id);
    }
    if (row.status === 'CONFIRMED') {
      row.verifiedFinding = normalizeFinding(row.verifiedFinding, warnings);
      row.verifiedFinding.id = id;
      const problems = findingProblems(row.verifiedFinding, { requireLocation: true });
      if (problems.length) { issues.push(`${id}: the confirmed finding is ${problems.join('; ')}.`); repairIds.add(id); invalid.confirm.add(id); }
    }
  }
  const missing = assignedIds.filter(id => !byId.has(id));
  if (missing.length) issues.unshift(`No decision was given for: ${missing.join(', ')}.`);
  const sourceNew = supplement && !Object.hasOwn(source, 'newFindings') ? null : source.newFindings;
  const newFindings = sourceNew === null ? [...(previous?.newFindings ?? []), ...(previous?.incompleteNewFindings ?? [])]
    : rows(sourceNew, warnings, 'newFindings').map(row => normalizeFinding(row, warnings));
  if (sourceNew !== null) newFindings.forEach((row, index) => {
    const problems = findingProblems(row, { requireLocation: true });
    if (problems.length) issues.push(`newFindings[${index}]: ${problems.join('; ')}.`);
  });
  const report = supplement && !text(asText(source.report)) ? previous?.report ?? '' : asText(source.report).trim();
  const modelStatus = supplement ? previous?.modelStatus ?? 'UNSPECIFIED' : canonicalEnum(source.status) || 'UNSPECIFIED';
  const state = { structured: true, modelStatus, decisions: byId, newFindings, report, warnings, corrections: parsed.corrections };
  return { issues, repairIds: [...repairIds], result: finishFinal(state, originals, invalid, [...repairIds]) };
}

/** Degrade unresolved items per finding; nothing else is discarded. */
function finishFinal(state, originals, invalid = { confirm: new Set(), merge: new Set() }, pendingIds = []) {
  const { decisions } = state;
  // Normalization notes carry over into a merged supplement; warnings derived
  // from the current decisions are recomputed every time.
  const base = [...state.warnings], derived = [];
  const dispositions = [];
  const resolved = new Map();
  for (const original of originals) {
    const row = decisions.get(original.id);
    if (!row) {
      dispositions.push({ id: original.id, status: 'UNREVIEWED', reason: 'The verifier gave no decision for this finding; it is not confirmed.' });
      continue;
    }
    if (!DECISIONS.includes(row.status)) {
      dispositions.push({ id: original.id, status: 'UNREVIEWED', reason: asText(row.reason) || 'The verifier decision was malformed.' });
      continue;
    }
    if (row.status === 'CONFIRMED' && invalid.confirm.has(original.id)) {
      const absent = FINDING_FIELDS.filter(key => !text(row.verifiedFinding?.[key]));
      dispositions.push({ id: original.id, status: 'NEEDS_INFO', reason: `${asText(row.reason)} [Runtime: the confirmation lacks ${absent.join(', ') || 'valid fields'}, so it is not eligible for comments.]`.trim(),
        partialFinding: row.verifiedFinding });
      continue;
    }
    if (row.status === 'MERGED' && invalid.merge.has(original.id)) {
      dispositions.push({ id: original.id, status: 'UNREVIEWED', reason: `${asText(row.reason)} [Runtime: the merge target is invalid.]`.trim() });
      continue;
    }
    const entry = { id: original.id, status: row.status, reason: asText(row.reason).trim() || 'No reason given.',
      ...(row.status === 'MERGED' ? { mergedInto: row.mergedInto } : {}),
      ...(row.status === 'CONFIRMED' ? { verifiedFinding: row.verifiedFinding } : {}) };
    dispositions.push(entry);
    resolved.set(entry.id, entry);
  }
  // A merge chain must end at a non-merged decision; cycles become UNREVIEWED.
  const cyclic = new Set();
  for (const entry of dispositions) {
    if (entry.status !== 'MERGED') continue;
    const seen = new Set([entry.id]);
    let target = resolved.get(entry.mergedInto);
    while (target?.status === 'MERGED' && !seen.has(target.id)) { seen.add(target.id); target = resolved.get(target.mergedInto); }
    if (target?.status === 'MERGED') cyclic.add(entry.id);
  }
  for (const entry of dispositions) {
    if (!cyclic.has(entry.id)) continue;
    entry.status = 'UNREVIEWED';
    entry.reason = `${entry.reason} [Runtime: the merge chain forms a cycle.]`;
    delete entry.mergedInto;
  }
  const unreviewed = dispositions.filter(row => row.status === 'UNREVIEWED').length;
  if (unreviewed) derived.push(`${unreviewed} finding(s) have no usable verifier decision and are shown as UNREVIEWED.`);
  const newFindings = state.newFindings.filter(row => !findingProblems(row, { requireLocation: true }).length);
  if (newFindings.length < state.newFindings.length) derived.push(`${state.newFindings.length - newFindings.length} new verifier finding(s) were incomplete and are listed in the report only.`);
  return {
    status: !state.structured ? 'PARTIAL' : state.modelStatus === 'INCOMPLETE' ? 'INCOMPLETE' : 'COMPLETE',
    structured: state.structured, modelStatus: state.modelStatus, dispositions, newFindings,
    incompleteNewFindings: state.newFindings.filter(row => !newFindings.includes(row)),
    report: state.report, warnings: [...base, ...derived], baseWarnings: base,
    ...(state.corrections ? { corrections: state.corrections } : {}),
    decisionRows: [...decisions.values()], pendingIds,
  };
}

// When only the JSON syntax was wrong, the content must come back unchanged:
// a free-form resend tends to shorten evidence.
const VERBATIM = 'Send the same answer again with identical content: do not shorten, summarize, reorder or reword any field. Only fix the JSON so it parses: escape every double quote inside a string as \\" (also inside `code`), write line breaks as \\n, and return exactly one JSON object.';
/** The answer had JSON with a syntax error (as opposed to no JSON at all). */
export const syntaxProblem = issues => issues.some(issue => /could not be parsed|repeats a key/.test(issue));
export const parseRepairPrompt = issues => `AZPR runtime: your previous answer was not valid JSON.\n${listIssues(issues)}\n\n${VERBATIM}`;

/** Repair request for an initial review: resend the whole corrected object. */
export function initialRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  return `AZPR runtime: your previous answer needs correction before it can be used.\n${listIssues(issues)}\n\nReturn the complete corrected JSON object for the same review (status, coverage, additionalFiles, findings, report). Keep every finding you still stand behind and keep the existing wording of fields that need no correction; read more source only if a correction needs it.`;
}

/** Repair request for a verifier: only the decisions that are missing or invalid. */
export function finalRepairPrompt(issues, ids, { includeNewFindings = false, full = false, parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  if (full) return `AZPR runtime: your previous answer needs correction before it can be used.\n${listIssues(issues)}\n\nReturn the complete verification JSON object (status, confirmed, merged, rejected, needsInfo, newFindings, report) with exactly one decision for each assigned finding ID.`;
  return `AZPR runtime: some decisions need correction.\n${listIssues(issues)}\n\nReturn one JSON object {"dispositions": [...]${includeNewFindings ? ', "newFindings": [...]' : ''}} containing decisions only for: ${ids.join(', ')}. Each row has id, status (CONFIRMED, MERGED, REJECTED or NEEDS_INFO) and reason; CONFIRMED rows include "verifiedFinding" with summary, evidence, counterevidence, location, severity and suggestion; MERGED rows include "mergedInto". Earlier decisions are kept.`;
}

/** Keep supplementary text literal; do not shell-tokenize, unquote or expand it. */
export function parseReviewRequest(raw) {
  if (typeof raw !== 'string' || raw.length > 16000 || raw.includes('\0')) throw new Error('[AZPR] Supply a PR URL and optional context (maximum 16000 characters).');
  const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error('[AZPR] Supply a PR URL and optional context.');
  const target = parsePullRequestUrl(match[1]);
  return { request: raw, prUrl: match[1], userContext: match[2] ?? '', target };
}

/** A display aid, not a source/commit certificate. Keep the raw output intact. */
export function numberToolText(result, input, snapshot) {
  if (typeof result?.output !== 'string' || !result.output.includes('\n') ||
      result.isError === true || result.metadata?.isError === true || result.metadata?.truncated === true) return result;
  if (result.content !== undefined && (!Array.isArray(result.content) || result.content.length !== 1 ||
      result.content[0]?.type !== 'text' || result.content[0].text !== result.output)) return result;
  const lines = result.output.split('\n');
  if (lines.at(-1) === '') lines.pop(); // A terminal newline does not add a source line.
  const numbered = lines.map((line, index) => `${index + 1} | ${line.replace(/\r$/, '')}`).join('\n');
  let request = '';
  const values = new Set();
  try { if (input !== undefined) request = `\nRequest arguments: ${JSON.stringify(input, (_key, value) => {
    if (typeof value === 'string') values.add(value);
    return value;
  })}`; }
  catch { return result; }
  const matches = [['head', 'HEAD (PR source)'], ['base', 'BASE (PR target)']]
    .filter(([key]) => typeof snapshot?.[key] === 'string' && snapshot[key] && values.has(snapshot[key]))
    .map(([, label]) => label);
  if (matches.length) request += `\nVersion argument: ${matches.join('; ')}.`;
  return { ...result, content: [{ ...(result.content?.[0] ?? {}), type: 'text',
    text: `AZPR numbered tool text (display only).${request}\nThe N | prefixes count returned lines; they are not part of the text.\n\n${numbered}` }] };
}
