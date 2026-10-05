import { ROLES } from './config.mjs';
// Internal JSON envelope contracts. MCP tools remain discovered by the V2 host.
const string = { type: 'string' };
const array = items => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const status = (...values) => ({ type: 'string', enum: values });
const snapshotSchema = object({ repository: string, prId: { type: 'integer' }, base: string, head: string, scope: { const: 'cumulative', type: 'string' }, files: array(string) });
const prSnapshot = { ...snapshotSchema, properties: { ...snapshotSchema.properties,
  scope: { const: 'pr', type: 'string', description: 'Current PR changes at the PR-reported source and target commits; no independent merge-base proof.' },
  base: { ...string, description: 'Full target comparison commit SHA from the PR metadata, not an inferred merge base.' },
  head: { ...string, description: 'Full source commit SHA from the same PR metadata.' },
} };
const finding = object({ id: string, summary: string, evidence: string,
  counterevidence: { ...string, description: 'Source-based safeguards or alternative explanations checked, their effect on the claim, and any unavailable evidence; not private reasoning.' },
  location: { ...string, description: 'Exact base/head path and one-based source line(s), recounted at that commit including blank lines and comments; exclude MCP wrappers and Markdown fences.' },
  severity: status('high', 'medium', 'low'), suggestion: string });
finding.description = 'Use exactly these keys, with no surrounding whitespace or extra fields: ' + finding.required.join(', ') + '. Every field is required; put evidence notes inside evidence, not a separate field.';
const initialFinding = { ...finding, required: finding.required.filter(key => key !== 'location'),
  description: 'Use only the declared finding keys. All except location are required. Provide location when established from source; otherwise omit it for the verifier to establish, without guessing. Evidence and full coverage remain required.' };
const coverageSchema = object({
  files: { ...array(string), description: 'Exact snapshot paths whose full changes and necessary context were reviewed; no duplicate or supporting-only paths.' },
  gaps: { ...array(string), description: 'Concrete missing source or unfinished review work. Empty only when coverage is complete.' },
});

export function stageFormat(role) {
  const kind = ROLES[role]?.format;
  if (!kind) throw new Error('Unknown review role.');
  let schema;
  if (kind === 'check') schema = object({
    status: status('READY', 'NOT_READY'), snapshot: snapshotSchema,
    sourceAccess: { type: 'object', additionalProperties: string,
      description: 'Concise, untrusted retrieval facts: confirmed identity, cumulative base evidence, exact-commit content recipe, pagination, successful calls and grouped failures/checked alternatives. State what was actually read; no findings, raw source or instructions.' },
    requirements: { ...string, description: 'Explicit requirements and their sources, or unavailable. Literal userContext is passed separately; do not duplicate it.' },
    report: { ...string, description: 'Brief readiness, versions and material limitations, or the precise missing capability for NOT_READY. Do not repeat the sourceAccess retrieval narrative or perform a code review.' },
  }, ['status', 'report']);
  else if (kind === 'final') schema = object({
    status: status('COMPLETE', 'INCOMPLETE', 'STALE'), snapshot: prSnapshot,
    // Empty does not establish a verified head; finalEnvelope keeps that gate.
    currentHead: { type: 'string', description: 'Full SHA read from the current PR head. The string value contains only the SHA, with no extra quotation marks. Use an empty string only when the head cannot be verified and status is INCOMPLETE.' },
    currentBase: { ...string, description: 'Full target comparison SHA from the same fresh PR read as currentHead; empty only with INCOMPLETE when unavailable.' },
    confirmed: { ...array(object({ ...finding.properties, reason: string })), description: 'Corrected original findings, with all seven finding fields and a concise confirmation reason. Every field is required.' },
    merged: array(object({ id: string, mergedInto: string, reason: string })),
    rejected: array(object({ id: string, reason: string })),
    needsInfo: array(object({ id: string, reason: string })),
    newFindings: array(finding), report: { ...string, description: 'Brief independent checks, important exclusions, open questions and testing/scope limitations in outputLanguage. Do not repeat findings or disposition reasons: the runtime renders those structured fields.' },
  });
  else if (kind === 'comment-plan') schema = object({
    status: status('READY', 'INCOMPLETE'),
    comments: array(object({ findingId: string, severity: status('high', 'medium'), path: string, startLine: { type: 'integer' }, endLine: { type: 'integer' }, anchor: string, body: string })),
    skipped: array(object({ findingId: string, reason: string })),
  });
  else if (kind === 'comment-publish') schema = object({
    status: status('DONE', 'INCOMPLETE'), posted: array(object({ findingId: string, threadId: { type: ['string', 'integer'] } })),
  });
  else schema = object({ status: status('COMPLETE', 'PARTIAL'),
    snapshot: { ...prSnapshot, description: 'Required for COMPLETE. Establish it from the requested PR, without a preflight or ancestry search. Omit only for PARTIAL when PR metadata is unavailable.' },
    coverage: coverageSchema, findings: array(initialFinding),
    report: { ...string, description: 'Review summary and limitations. Submit the full review, never a status-only acknowledgement or placeholder.' },
  }, ['status', 'coverage', 'findings', 'report']);
  return { schema };
}

export function visibleText(response) {
  return (response?.parts ?? []).filter(p => p.type === 'text' && !p.ignored).map(p => p.text ?? '').join('\n');
}

/** A display aid, not a source/commit certificate. Keep the raw output intact. */
export function numberToolText(result, input, snapshot) {
  if (typeof result?.output !== 'string' || !result.output.includes('\n') ||
      result.isError === true || result.metadata?.isError === true || result.metadata?.truncated === true) return result;
  // Never discard wrappers, alternate content, attachments or structured output.
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
  catch { return result; } // An optional display aid must never fail a tool call.
  const matches = [['head', 'HEAD (PR source)'], ['base', 'BASE (PR target reference)']]
    .filter(([key]) => typeof snapshot?.[key] === 'string' && snapshot[key] && values.has(snapshot[key]))
    .map(([, label]) => label);
  if (matches.length) request += `\nReview snapshot argument match: ${matches.join('; ')}. This labels argument values only, not returned-content provenance or a certified merge base.`;
  return { ...result, content: [{ ...(result.content?.[0] ?? {}), type: 'text',
    text: `AZPR numbered tool text (display only).${request}\nRows count this returned text, not wrappers or missing source. The N | prefixes are not part of the original text.\n\n${numbered}` }] };
}
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const findingKey = key => key.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
const finalCategories = ['confirmed', 'merged', 'rejected', 'needsInfo'];
const disposition = object({
  id: string, status: status('CONFIRMED', 'MERGED', 'REJECTED', 'NEEDS_INFO'),
  reason: string, mergedInto: string, verifiedFinding: finding,
}, ['id', 'status', 'reason']);

// JSON validation and value-free diagnostics share the internal key catalogs.
// Domain validators still own conditional requirements, versions and evidence.
function hasUnexpectedFields(value, schema) {
  return isObject(value) && schema.additionalProperties === false &&
    Object.keys(value).some(key => !Object.hasOwn(schema.properties, key));
}
function requireKnownFields(value, schema, label) {
  if (hasUnexpectedFields(value, schema)) {
    throw new Error(`Invalid ${label}: unexpected fields; names and values omitted.`);
  }
}
function finalContract(result) {
  const schema = stageFormat('azpr-review-verifier').schema;
  if (!isObject(result) || !Object.hasOwn(result, 'dispositions')) return schema;
  const { confirmed, merged, rejected, needsInfo, ...properties } = schema.properties;
  return object({ ...properties, dispositions: array(disposition) },
    ['status', 'snapshot', 'currentHead', 'currentBase', 'dispositions', 'report']);
}

/** Convert explicit categories, never infer a verdict or copy initial evidence.
 * Disposition rows remain an alternate bounded model-output representation. */
export function finalSubmission(result) {
  if (!isObject(result)) return result;
  if (Object.keys(result).length === 1 && Object.hasOwn(result, 'status')) throw new Error('Invalid final-review envelope: status-only submission; snapshot, current versions, dispositions and report are required.');
  const categories = finalCategories.some(key => Object.hasOwn(result, key));
  if (Object.hasOwn(result, 'dispositions')) {
    if (categories) throw new Error('Final submission mixes categories and legacy dispositions.');
    requireKnownFields(result, finalContract(result), 'final submission');
    return result;
  }
  const schema = finalContract(result);
  requireKnownFields(result, schema, 'final submission');
  for (const key of [...finalCategories, 'newFindings']) {
    if (!Array.isArray(result[key])) throw new Error(`Invalid final submission: ${key} must be an array.`);
  }
  const dispositions = [];
  for (const key of finalCategories) for (const [i, item] of result[key].entries()) {
    if (!isObject(item)) throw new Error(`Invalid final submission: ${key}[${i}] must be an object.`);
    if (key === 'confirmed') {
      // Retain all finding fields for strict validation and audited normalization.
      const { reason, ...verifiedFinding } = item;
      dispositions.push({ id: item.id, status: 'CONFIRMED', reason, verifiedFinding });
    } else {
      requireKnownFields(item, schema.properties[key].items, `final submission ${key}[${i}]`);
      dispositions.push({ ...item, status: { merged: 'MERGED', rejected: 'REJECTED', needsInfo: 'NEEDS_INFO' }[key] });
    }
  }
  const { confirmed, merged, rejected, needsInfo, ...rest } = result;
  return { ...rest, dispositions };
}

/** Bounded, value-free diagnostics; never an evidence validator or repair. */
export function finalSubmissionIssues(result) {
  const issues = [];
  const add = (path, code) => { if (issues.length < 32) issues.push({ path, code }); };
  const scan = (value, schema, path) => {
    if (issues.length >= 32) return;
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type !== actual) { add(path, `expected-${schema.type}`); return; }
    if (schema.enum && !schema.enum.includes(value)) add(path, 'invalid-enum');
    if (schema.const !== undefined && value !== schema.const) add(path, 'invalid-constant');
    if (actual === 'string' && !text(value)) add(path, 'empty-text');
    if (actual === 'array') value.forEach((item, i) => scan(item, schema.items, `${path}[${i}]`));
    if (actual === 'object') {
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) add(path ? `${path}.${key}` : key, 'missing-field');
      for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) scan(value[key], child, path ? `${path}.${key}` : key);
      if (hasUnexpectedFields(value, schema)) add(path || '$', 'unexpected-fields');
    }
  };
  const schema = finalContract(result);
  if (isObject(result) && Object.hasOwn(result, 'dispositions')) {
    if (Array.isArray(result.dispositions)) result.dispositions.forEach((item, i) => {
      if (item?.status === 'CONFIRMED' && !isObject(item.verifiedFinding)) add(`dispositions[${i}].verifiedFinding`, 'missing-corrected-finding');
    });
  }
  scan(result, schema, '');
  return issues;
}

/** Narrow, auditable formatting only. The caller must validate the entire result
 * before accepting these changes. Never mutate the raw response or add evidence. */
export function normalizeFindingFormat(result, role) {
  const corrections = [];
  const kind = ROLES[role]?.format;
  if (!['initial', 'final'].includes(kind) || !isObject(result) ||
      !stageFormat(role).schema.properties.status.enum.includes(result.status)) return { envelope: result, corrections };
  const categoryInput = kind === 'final' && !Object.hasOwn(result, 'dispositions');
  if (kind === 'final') result = finalSubmission(result);
  function normalize(value, path) {
    if (!isObject(value)) return value;
    const entries = [], seen = new Set();
    for (const [propertyIndex, [key, content]] of Object.entries(value).entries()) {
      const canonical = findingKey(key);
      if (Object.hasOwn(finding.properties, canonical)) {
        // Reject even equal values: choosing between competing keys hides an
        // ambiguous submission. Values (including whitespace) stay untouched.
        if (seen.has(canonical)) throw new Error(`Invalid finding: ${path}.${canonical} has conflicting keys after whitespace normalization.`);
        seen.add(canonical);
        entries.push([canonical, content]);
        if (canonical !== key) corrections.push({ path: `${path}.${canonical}`, action: 'trim-key-whitespace' });
      } else if (content === '' || content === null) {
        // No names/values from unknown fields enter public receipts or notices.
        corrections.push({ path, action: content === null ? 'remove-null-unknown-field' : 'remove-empty-unknown-field', propertyIndex });
      } else entries.push([key, content]);
    }
    return Object.fromEntries(entries);
  }
  const envelope = { ...result };
  if (kind === 'initial' && Array.isArray(result.findings)) envelope.findings = result.findings.map((value, i) => normalize(value, `findings[${i}]`));
  if (kind === 'final') {
    if (Array.isArray(result.dispositions)) envelope.dispositions = result.dispositions.map((value, i) => {
      if (!isObject(value) || value.status !== 'CONFIRMED') return value;
      const verifiedFinding = normalize(value.verifiedFinding, `dispositions[${i}].verifiedFinding`);
      return { ...value, ...(categoryInput ? { id: verifiedFinding?.id } : {}), verifiedFinding };
    });
    if (Array.isArray(result.newFindings)) envelope.newFindings = result.newFindings.map((value, i) => normalize(value, `newFindings[${i}]`));
    if (Array.isArray(envelope.dispositions) && Array.isArray(envelope.newFindings)) {
      const completeFinding = value => isObject(value) && Object.keys(value).length === finding.required.length &&
        finding.required.every(key => Object.hasOwn(value, key) && text(value[key]));
      envelope.dispositions = envelope.dispositions.filter((item, i, items) => {
        if (!isObject(item) || !/^V-[1-9][0-9]*$/.test(item.id) || item.status !== 'CONFIRMED' || !text(item.reason) ||
            Object.keys(item).some(key => !['id', 'status', 'reason', 'verifiedFinding'].includes(key)) ||
            items.filter(other => other?.id === item.id).length !== 1) return true;
        const matches = envelope.newFindings.map((value, index) => ({ value, index })).filter(({ value }) => value?.id === item.id);
        if (matches.length !== 1 || !completeFinding(item.verifiedFinding) || !completeFinding(matches[0].value) ||
            !finding.required.every(key => item.verifiedFinding[key] === matches[0].value[key])) return true;
        // This is only a redundant V entry, never an original F/R disposition.
        // Its reason and full original object remain in the raw response.
        corrections.push({ path: `dispositions[${i}]`, action: 'deduplicate-new-finding', newFindingPath: `newFindings[${matches[0].index}]` });
        return false;
      });
    }
  }
  return { envelope: corrections.length ? envelope : result, corrections };
}

export class OutputStatusError extends Error {
  constructor(label, value, allowed) {
    // Receipts must not echo arbitrary model text, source, or credentials.
    const shown = typeof value === 'string' && /^[A-Z_]{1,24}$/.test(value) ? JSON.stringify(value) : `<${value === null ? 'null' : typeof value}>`;
    super(`Invalid ${label} envelope: status received ${shown}; expected ${allowed.join(' or ')}.`);
    this.name = 'OutputStatusError';
  }
}
export class OutputLocationError extends Error {}
export class OutputDispositionError extends Error {
  constructor(missingIds) {
    const shown = missingIds.filter(id => typeof id === 'string' && /^[FR]-[1-9][0-9]{0,20}$/.test(id)).slice(0, 20);
    super(`Final reviewer omitted one or more original findings. Missing disposition IDs: ${shown.join(', ')}${missingIds.length > shown.length ? ' (additional IDs in diagnostics)' : ''}.`);
    this.name = 'OutputDispositionError';
    this.missingIds = [...missingIds];
  }
}

function requireStatus(result, allowed, label) {
  if (!allowed.includes(result.status)) throw new OutputStatusError(label, result.status, allowed);
}
// Call only after JSON.parse establishes grammar. Repeated keys must never
// replace earlier evidence, even when the escaped spelling or value differs.
function rejectDuplicateJSONKeys(content, message) {
  const stack = [];
  for (const [token] of content.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)) {
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

/** Strict local JSON, including settings; no fencing, normalization or repair.
 * Callers must replace syntax errors before exposing potentially private input. */
export function parseUniqueJSON(content) {
  const value = JSON.parse(content);
  rejectDuplicateJSONKeys(content, 'Input contains duplicate JSON keys; no field value was accepted.');
  return value;
}
// Review-only syntax recovery. An iterative grammar preserves complete values;
// it never removes an unfinished member or invents a missing value. Offsets refer
// to the original body, including when punctuation is inserted. Settings,
// publication and source-readiness parsing do not use this extension.
function reviewJSONCandidate(content) {
  const stack = [{ kind: 'root', next: 'value' }], edits = [], pieces = [];
  const token = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  let i = 0, lastValueEnd = 0;
  const change = (action, offset, replacement = '') => edits.push({ action, offset, replacement });
  const quoted = () => {
    const start = i, quote = content[i++], close = quote === '“' ? '”' : quote;
    let value = '';
    while (i < content.length) {
      const char = content[i++];
      if (char === close) {
        const raw = content.slice(start, i);
        if (quote === '"') {
          try { JSON.parse(raw); return raw; } catch { /* Literal controls only. */ }
        }
        change('normalize-string-delimiters-or-controls', start);
        return JSON.stringify(value);
      }
      if (char !== '\\') { value += char; continue; }
      const escaped = content[i++];
      if (escaped === "'" && quote === "'") { value += "'"; continue; }
      const length = escaped === 'u' ? 4 : 0;
      const escape = '\\' + escaped + content.slice(i, i + length);
      try { value += JSON.parse('"' + escape + '"'); } catch { return; }
      i += length;
    }
    // Closing an unfinished string would invent its content boundary.
  };
  while (i < content.length) {
    const char = content[i], frame = stack.at(-1);
    if (/\s/u.test(char)) { pieces.push(' \t\r\n'.includes(char) ? char : ' '); i++; continue; }
    if (content.startsWith('//', i) || content.startsWith('/*', i)) {
      const start = i, line = content[i + 1] === '/';
      const end = content.indexOf(line ? '\n' : '*/', i + 2);
      if (!line && end < 0) return;
      i = end < 0 ? content.length : end + (line ? 0 : 2);
      pieces.push(' '); change('remove-json-comment', start); continue;
    }
    if (char === '}' || char === ']') {
      if (frame.kind === 'root' && frame.next === 'end') {
        change('remove-redundant-closing-delimiter', i++); continue;
      }
      if (frame.kind !== (char === '}' ? 'object' : 'array')) return;
      if (frame.comma !== undefined) {
        pieces[frame.commaPiece] = ''; change('remove-trailing-comma', frame.comma);
      }
      else if (!['end', 'first-key', 'first-value'].includes(frame.next)) return;
      stack.pop(); pieces.push(char); lastValueEnd = ++i; continue;
    }
    if (frame.next === 'colon') {
      if (char === ':') { pieces.push(char); i++; }
      else { pieces.push(':'); change('insert-missing-colon', i, ':'); }
      frame.next = 'value'; continue;
    }
    if (frame.next === 'end') {
      if (frame.kind === 'root') return; // Never select one of multiple roots.
      if (char === ',') {
        frame.comma = i++; frame.commaPiece = pieces.length; pieces.push(',');
      } else {
        // Adjacent numeric/literal fragments are not missing separators.
        if (i === lastValueEnd && !['{', '[', '"', "'", '“'].includes(char)) return;
        pieces.push(','); change('insert-missing-comma', i, ',');
      }
      frame.next = frame.kind === 'object' ? 'key' : 'value';
      continue;
    }
    if (['key', 'first-key'].includes(frame.next)) {
      let key;
      if (['"', "'", '“'].includes(char)) key = quoted();
      else {
        const match = /^[A-Za-z_$][\w$-]*(?=\s*:)/.exec(content.slice(i));
        if (!match) return;
        key = JSON.stringify(match[0]); change('quote-object-key', i); i += match[0].length;
      }
      if (key === undefined) return;
      pieces.push(key); frame.next = 'colon'; delete frame.comma;
      continue;
    }
    if (!['value', 'first-value'].includes(frame.next)) return;
    frame.next = 'end'; delete frame.comma;
    if (char === '{' || char === '[') {
      stack.push({ kind: char === '{' ? 'object' : 'array', next: char === '{' ? 'first-key' : 'first-value' });
      pieces.push(char); i++; continue;
    }
    if (['"', "'", '“'].includes(char)) {
      const value = quoted(); if (value === undefined) return; pieces.push(value);
    } else {
      token.lastIndex = i;
      const match = token.exec(content); if (!match) return;
      pieces.push(match[0]); i = token.lastIndex;
    }
    lastValueEnd = i;
  }
  while (stack.length > 1) {
    const frame = stack.pop();
    if (!['end', 'first-key', 'first-value'].includes(frame.next)) return;
    const close = frame.kind === 'object' ? '}' : ']';
    pieces.push(close); change('insert-missing-closing-delimiter', i, close);
  }
  if (stack[0].next !== 'end' || !edits.length) return;
  return { text: pieces.join(''), corrections: edits.map(({ action, offset, replacement }) =>
    replacement ? { action, offset, replacement } : { action, offset }) };
}

/** Strict parsing remains the contract for checks and comments. */
export function parseJSONReport(response) {
  return parseReport(response).envelope;
}

/** Normal review text only; callers must validate the complete envelope before
 * accepting/disclosing corrections. Offsets are zero-based UTF-16 positions in
 * the selected JSON body. The response and all member/value text stay untouched. */
export function parseReviewJSONReport(response, role) {
  return parseReport(response, role);
}

const reviewSections = ['findings', 'report', 'confirmed', 'merged', 'rejected', 'needsInfo', 'newFindings', 'dispositions'];
const looksLikeReview = value => isObject(value) && Object.keys(value).some(key =>
  reviewSections.some(known => canonicalKey(key) === canonicalKey(known)));

// Consume all Markdown fences in order. A Python block's closing delimiter is
// not the opening delimiter of the following JSON block.
function fencedBlocks(content) {
  const blocks = [];
  let open;
  for (const match of content.matchAll(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/gm)) {
    const [, delimiter, info] = match;
    if (!open) {
      open = { start: match.index, body: match.index + match[0].length,
        delimiter, json: /^(?:jsonc?)?\s*$/i.test(info.trim()) };
    } else if (!info.trim() && delimiter[0] === open.delimiter[0] && delimiter.length >= open.delimiter.length) {
      blocks.push({ start: open.start, end: match.index + match[0].length,
        text: content.slice(open.body, match.index).replace(/^\r?\n/, ''), json: open.json });
      open = undefined;
    }
  }
  return blocks;
}

/** Locate whole objects in commentary without treating braces inside strings or
 * comments as delimiters. Keep unfinished objects as ambiguity candidates too.
 * This scanner is iterative and has no output/depth budget. */
function embeddedObjects(content) {
  const objects = [];
  let start = -1, depth = 0, quote = '', escaped = false, comment = '';
  for (let i = 0; i < content.length; i++) {
    const char = content[i], next = content[i + 1];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (comment) {
      if (comment === 'line' && /[\r\n]/.test(char)) comment = '';
      else if (comment === 'block' && char === '*' && next === '/') { comment = ''; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (['"', "'", '“'].includes(char)) { quote = char === '“' ? '”' : char; continue; }
    if (char === '/' && ['/', '*'].includes(next)) { comment = next === '/' ? 'line' : 'block'; i++; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) {
      objects.push({ start, end: i + 1, text: content.slice(start, i + 1) }); start = -1;
    }
  }
  if (start >= 0) objects.push({ start, end: content.length, text: content.slice(start) });
  return objects;
}

/** Choose one identifiable review, never one of competing review submissions.
 * Incidental JSON/code examples and every surrounding character remain data. */
function embeddedReview(content, blocks, parse, commentPlan = false) {
  let outside = '', end = 0;
  for (const block of blocks) {
    outside += content.slice(end, block.start) + ' '.repeat(block.end - block.start); end = block.end;
  }
  outside += content.slice(end);
  const candidates = [];
  const identifiable = commentPlan
    ? value => isObject(value) && ['comments', 'skipped'].some(key => Object.hasOwn(value, key))
    : looksLikeReview;
  const sections = commentPlan ? ['status', 'comments', 'skipped']
    : [...reviewSections, 'status', 'snapshot', 'currentHead', 'currentBase'];
  const statuses = commentPlan ? ['READY', 'INCOMPLETE'] : ['COMPLETE', 'PARTIAL', 'INCOMPLETE', 'STALE'];
  for (const block of [...blocks.filter(block => block.json), ...embeddedObjects(outside)]) {
    let parsed;
    try { parsed = parse(block.text); } catch { /* Do not overlook an unfinished competing review. */ }
    const firstKey = /^\{\s*["'“]?([A-Za-z_$][\w$ -]*?)["'”]?\s*:/.exec(block.text)?.[1];
    const unfinishedReview = !parsed && firstKey && sections
      .some(key => canonicalKey(key) === canonicalKey(firstKey));
    const verdict = isObject(parsed?.envelope) && Object.entries(parsed.envelope).some(([key, value]) =>
      canonicalKey(key) === 'status' && statuses.includes(canonicalEnum(value)));
    if (identifiable(parsed?.envelope) || verdict || unfinishedReview) candidates.push({ ...block, parsed });
  }
  if (candidates.length !== 1 || !identifiable(candidates[0].parsed?.envelope)) return;
  const selected = candidates[0];
  return { ...selected.parsed,
    corrections: [...selected.parsed.corrections, { action: commentPlan ? 'extract-comment-plan-envelope' : 'extract-review-envelope' }],
    surroundingText: (content.slice(0, selected.start) + content.slice(selected.end)).trim() };
}

function parseReport(response, role) {
  const finish = String(response.info?.finish ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (response.info?.error) {
    const name = String(response.info.error.type ?? 'UnknownError').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    throw new Error(`Reviewer returned an OpenCode/model error (${name}; finish=${finish}). Inspect the private session or debug response. No automatic retry.`);
  }
  if (['length', 'content-filter', 'error', 'cancelled'].includes(response.info?.finish)) throw new Error(`Reviewer output did not finish successfully (finish=${finish}); no partial response or output recovery was accepted.`);
  const allowRecovery = response.info?.finish === 'stop' &&
    ['initial', 'final'].includes(ROLES[role]?.format);
  const commentPlan = response.info?.finish === 'stop' && ROLES[role]?.format === 'comment-plan';
  let result, corrections = [];
  let content = visibleText(response).trim();
  if (!content) throw new Error(`Empty reviewer output (finish=${finish}); inspect the session export or debug response.`);
  // Never guess between multiple envelopes. Review recovery handles syntax;
  // it does not fill missing values or discard an unfinished finding.
  const blocks = fencedBlocks(content), fences = blocks.filter(block => block.json);
  let jsonContent = content;
  function parse(candidate) {
    try { return { envelope: JSON.parse(candidate), text: candidate, corrections: [] }; }
    catch (error) {
      const normalized = allowRecovery && reviewJSONCandidate(candidate);
      if (!normalized) throw error;
      return { envelope: JSON.parse(normalized.text), ...normalized };
    }
  }
  let parsed, surroundingText;
  try { parsed = parse(content); }
  catch {
    const outsideFence = fences.length === 1 ? content.slice(0, fences[0].start) + content.slice(fences[0].end) : '';
    if (fences.length === 1 && !/[{}]|```|~~~/.test(outsideFence)) {
      try {
        parsed = parse(fences[0].text);
        surroundingText = outsideFence.trim();
      } catch { /* Retain the entire text in the review fallback. */ }
    }
    if (parsed === undefined && (allowRecovery || commentPlan)) {
      parsed = embeddedReview(content, blocks, parse, commentPlan);
      surroundingText = parsed?.surroundingText;
    }
    if (parsed === undefined) throw new Error(`Reviewer did not return the required JSON envelope (characters=${content.length}; finish=${finish}). Partial output remains in its session. Inspect the private session or debug response. No automatic retry.`);
  }
  ({ envelope: result, text: jsonContent, corrections } = parsed);
  rejectDuplicateJSONKeys(jsonContent, 'Reviewer text contains duplicate JSON keys; no field value was selected or repaired.');
  if (!isObject(result)) throw new Error('Review envelope must be an object.');
  return { envelope: result, corrections, ...(surroundingText ? { surroundingText } : {}) };
}

/** A successfully completed review may still be useful without structured JSON.
 * Keep that text literal for the verifier/report. Never salvage failed execution
 * as a completed answer, and never pick a winner among duplicate JSON keys. */
export function readReviewOutput(response, role) {
  if (!['initial', 'final'].includes(ROLES[role]?.format)) return parseReviewJSONReport(response, role);
  if (response.info?.error) return parseReviewJSONReport(response, role);
  if (response.info?.finish !== 'stop') throw new Error('Reviewer output did not finish successfully; retained text cannot substitute for completed execution.');
  try {
    const parsed = parseReviewJSONReport(response, role);
    if (!looksLikeReview(parsed.envelope)) {
      throw new Error('A JSON example is not a structured review.');
    }
    if (parsed.surroundingText) parsed.envelope = { ...parsed.envelope,
      surroundingText: Object.hasOwn(parsed.envelope, 'surroundingText')
        ? [parsed.envelope.surroundingText, parsed.surroundingText] : parsed.surroundingText };
    return parsed;
  }
  catch {
    const report = visibleText(response).trim();
    if (!report) throw new Error('Reviewer returned no visible review content.');
    return { envelope: { report, unstructured: true }, corrections: [{ action: 'retain-unstructured-review' }] };
  }
}

/** Keep supplementary text literal; do not shell-tokenize, unquote, or expand it. */
export function parseReviewRequest(raw) {
  if (typeof raw !== 'string' || raw.length > 16000 || raw.includes('\0')) throw new Error('[AZPR] Supply a PR URL and optional context (maximum 16000 characters).');
  const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error('[AZPR] Supply a PR URL and optional context.');
  let url;
  try { url = new URL(match[1]); } catch { throw new Error('[AZPR] The first argument must be an absolute HTTPS PR URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/\/pullrequest\/[1-9][0-9]*\/?$/i.test(url.pathname)) {
    throw new Error('[AZPR] Use an HTTPS Azure PR URL ending in /pullrequest/<id>, without embedded credentials.');
  }
  const urlIdentity = identityFromURL(url);
  return { request: raw, prUrl: match[1], userContext: match[2] ?? '', ...(urlIdentity ? { urlIdentity } : {}) };
}

/** URL-derived hints, not server-verified identity or MCP argument bindings. */
function identityFromURL(url) {
  let match, organization, project, repository;
  if (url.hostname === 'dev.azure.com') {
    match = /^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/[1-9][0-9]*\/?$/i.exec(url.pathname);
    if (match) [, organization, project, repository] = match;
  } else if (/^[^.]+\.visualstudio\.com$/.test(url.hostname)) {
    match = /^\/([^/]+)\/_git\/([^/]+)\/pullrequest\/[1-9][0-9]*\/?$/i.exec(url.pathname);
    if (match) { organization = url.hostname.split('.')[0]; [, project, repository] = match; }
  }
  if (!match) return; // Preserve custom server/collection URLs without guessing.
  try {
    const values = [organization, project, repository].map(decodeURIComponent);
    if (values.some(value => !value.trim() || /[\x00-\x1f\x7f]/.test(value))) return;
    return Object.fromEntries(['organization', 'project', 'repository'].map((key, i) => [key, values[i]]));
  } catch { /* Malformed encoding remains in the original URL for source checking. */ }
}

const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export function validateSnapshot(s) {
  requireKnownFields(s, snapshotSchema, 'snapshot');
  if (!isObject(s) || !text(s.repository) || !Number.isInteger(s.prId) || s.prId < 1 ||
      !sha(s.base) || !sha(s.head) || !['pr', 'cumulative'].includes(s.scope) || !Array.isArray(s.files) ||
      s.files.length === 0 || !s.files.every(text) || new Set(s.files).size !== s.files.length) {
    throw new Error('Missing full base/head SHA, PR scope or complete unique file list.');
  }
  return { repository: s.repository, prId: s.prId, base: s.base.toLowerCase(), head: s.head.toLowerCase(), scope: s.scope, files: [...s.files] };
}
function snapshotKey(s) { const value = validateSnapshot(s); value.files.sort(); return JSON.stringify(value); }
export function checkEnvelope(result, prUrl) {
  if (!isObject(result) || !text(result.report)) throw new Error('Invalid source-check envelope: a status and report are required.');
  requireKnownFields(result, stageFormat('azpr-review-check').schema, 'source-check envelope');
  requireKnownFields(result.snapshot, snapshotSchema, 'snapshot');
  requireStatus(result, ['READY', 'NOT_READY'], 'source-check');
  if (result.requirements !== undefined && typeof result.requirements !== 'string') throw new Error('Source-check requirements must be text.');
  if (result.sourceAccess !== undefined && (!isObject(result.sourceAccess) || Object.values(result.sourceAccess).some(value => typeof value !== 'string'))) throw new Error('Source-check sourceAccess must describe capabilities as text fields.');
  if (result.status !== 'READY') return result;
  const snapshot = validateSnapshot(result.snapshot);
  if (snapshot.scope !== 'cumulative') throw new Error('Standalone source-check requires cumulative scope.');
  if (prUrl && String(snapshot.prId) !== new URL(prUrl).pathname.split('/').filter(Boolean).at(-1)) throw new Error('Source-check snapshot PR ID does not match the requested URL.');
  return { ...result, snapshot };
}
function validateFinding(value, prefix, ids, path, allowMissingLocation = false) {
  if (!isObject(value)) throw new Error(`Invalid finding: ${path} must be an object.`);
  const issues = [];
  for (const key of finding.required) {
    if (key === 'location' && allowMissingLocation && !Object.hasOwn(value, key)) continue;
    if (!Object.hasOwn(value, key)) {
      const whitespace = Object.keys(value).some(raw => raw !== key && findingKey(raw) === key);
      issues.push(`${path}.${key} is missing${whitespace ? ' (a matching key has surrounding ASCII whitespace)' : ''}`);
    } else if (!text(value[key])) issues.push(`${path}.${key} must be nonempty text`);
  }
  if (text(value.id)) {
    if (!new RegExp(`^${prefix}-[1-9][0-9]*$`).test(value.id)) issues.push(`${path}.id has an invalid prefix or number`);
    else if (ids.has(value.id)) issues.push(`${path}.id duplicates an earlier finding`);
  }
  if (text(value.severity) && !finding.properties.severity.enum.includes(value.severity)) issues.push(`${path}.severity must be high, medium, or low`);
  const extra = Object.keys(value).filter(key => !Object.hasOwn(finding.properties, key)).length;
  if (extra) issues.push(`${path} contains ${extra} unexpected field(s); names and values omitted`);
  if (issues.length) {
    const ErrorType = !allowMissingLocation && issues.length === 1 && !Object.hasOwn(value, 'location') ? OutputLocationError : Error;
    throw new ErrorType(`Invalid finding: ${issues.join('; ')}.`);
  }
  ids.add(value.id);
}
function validateFindings(findings, prefix, path = 'findings', allowMissingLocation = false) {
  if (!Array.isArray(findings)) throw new Error('Invalid findings array.');
  const ids = new Set();
  findings.forEach((value, i) => validateFinding(value, prefix, ids, `${path}[${i}]`, allowMissingLocation));
}
export function initialEnvelope(result, expected, prefix, prUrl) {
  if (!isObject(result)) throw new Error('Invalid initial-review envelope: expected an object.');
  requireKnownFields(result, stageFormat('azpr-review-functional').schema, 'initial-review envelope');
  requireKnownFields(result.coverage, coverageSchema, 'coverage ledger');
  const missingSnapshot = result.status === 'PARTIAL' && result.snapshot === undefined && !expected;
  const invalid = [
    !missingSnapshot && !isObject(result.snapshot) && 'snapshot must be an object',
    !isObject(result.coverage) && 'coverage must be an object',
    !Array.isArray(result.findings) && 'findings must be an array',
    !text(result.report) && 'report must be nonempty text',
  ].filter(Boolean);
  const statusOnly = Object.keys(result).length === 1 && Object.hasOwn(result, 'status');
  if (invalid.length) throw new Error(`Invalid initial-review envelope: ${statusOnly ? 'status-only submission; ' : ''}${invalid.join('; ')}.`);
  requireStatus(result, ['COMPLETE', 'PARTIAL'], 'initial-review');
  const selected = missingSnapshot ? null : validateSnapshot(result.snapshot);
  if (expected && snapshotKey(result.snapshot) !== snapshotKey(expected)) throw new Error('Initial reviewer used a different snapshot or file list.');
  if (!expected && selected?.scope !== 'pr' && !missingSnapshot) throw new Error('Direct initial review requires PR scope, not ancestry certification.');
  if (selected && prUrl && String(selected.prId) !== new URL(prUrl).pathname.split('/').filter(Boolean).at(-1)) throw new Error('Initial reviewer snapshot PR ID does not match the requested URL.');
  const files = selected?.files ?? [];
  const coverage = result.coverage;
  if (!isObject(coverage) || !Array.isArray(coverage.files) || !Array.isArray(coverage.gaps) ||
      !coverage.files.every(file => text(file) && files.includes(file)) ||
      new Set(coverage.files).size !== coverage.files.length || !coverage.gaps.every(text)) throw new Error('Invalid coverage ledger: list unique reviewed snapshot files and concrete gaps.');
  if (result.status === 'COMPLETE' && (coverage.files.length !== files.length || coverage.gaps.length)) throw new Error('COMPLETE requires coverage of every snapshot file with no review gaps.');
  if (result.status === 'PARTIAL' && !coverage.gaps.length) throw new Error('PARTIAL requires an explanation of the review gaps.');
  if (missingSnapshot && result.findings.length) throw new Error('An initial review without a snapshot cannot report findings.');
  validateFindings(result.findings, prefix, 'findings', true);
  return result;
}
/** Compare metadata already read by the two initials; no tool/model request. */
export function mergeInitialSnapshots(reviews) {
  const snapshots = reviews.map(review => validateSnapshot(review.snapshot));
  const first = snapshots[0];
  if (!first || first.scope !== 'pr' || snapshots.some(s =>
      ['repository', 'prId', 'base', 'head', 'scope'].some(key => s[key] !== first[key]))) {
    throw new Error('Initial reviewers used different PR identities or source/target commits. Start a new review for a stable PR version.');
  }
  // Preserve both discovery results in reviews. The verifier examines every
  // reported path; ordering or a different file set is not a version mismatch.
  return { ...first, files: [...new Set(snapshots.flatMap(s => s.files))].sort() };
}
export function finalEnvelope(result, expected, originals) {
  result = finalSubmission(result);
  if (!isObject(result) || !text(result.report) || !Array.isArray(result.dispositions)) throw new Error('Invalid final-review envelope.');
  requireStatus(result, ['COMPLETE', 'INCOMPLETE', 'STALE'], 'final-review');
  if (snapshotKey(result.snapshot) !== snapshotKey(expected)) throw new Error('Final reviewer used a different snapshot.');
  result = { ...result, snapshot: validateSnapshot(result.snapshot) };
  result.snapshot.files.sort(); // Stable rendering; the unmodified raw response remains diagnostic data.
  const ids = new Set(originals.map(f => f.id));
  const accounted = new Set();
  for (const [i, item] of result.dispositions.entries()) {
    requireKnownFields(item, disposition, `dispositions[${i}]`);
    if (!isObject(item) || !ids.has(item.id) || accounted.has(item.id) || !['CONFIRMED','NEEDS_INFO','REJECTED','MERGED'].includes(item.status) || !text(item.reason)) {
      throw new Error('Final review has an invalid/missing disposition or silently changed a finding ID.');
    }
    if (item.status === 'MERGED' && (!ids.has(item.mergedInto) || item.mergedInto === item.id)) throw new Error('Merged finding must reference another original finding.');
    if (item.status !== 'MERGED' && item.mergedInto !== undefined) throw new Error('Only a MERGED finding may contain mergedInto.');
    if (item.status === 'CONFIRMED') {
      if (!isObject(item.verifiedFinding) || item.verifiedFinding.id !== item.id) throw new Error('CONFIRMED requires the verifier\'s corrected finding with the same original ID.');
      validateFinding(item.verifiedFinding, '[FR]', new Set(), `dispositions[${i}].verifiedFinding`);
    } else if (item.verifiedFinding !== undefined) throw new Error('Only a CONFIRMED disposition may contain verifiedFinding.');
    accounted.add(item.id);
  }
  if (accounted.size !== ids.size) throw new OutputDispositionError([...ids].filter(id => !accounted.has(id)));
  const dispositions = new Map(result.dispositions.map(item => [item.id, item]));
  const resolved = new Set();
  for (let item of result.dispositions) {
    const path = new Set();
    while (item.status === 'MERGED' && !resolved.has(item.id)) {
      if (path.has(item.id)) throw new Error('Merged findings form a cycle with no final disposition.');
      path.add(item.id); item = dispositions.get(item.mergedInto);
    }
    for (const id of path) resolved.add(id);
  }
  if (result.newFindings !== undefined) validateFindings(result.newFindings, 'V', 'newFindings');
  if (!sha(result.currentHead) && result.status !== 'INCOMPLETE') throw new Error('Final reviewer did not verify the current PR head.');
  if (expected.scope === 'pr' && !sha(result.currentBase) && result.status !== 'INCOMPLETE') throw new Error('Final reviewer did not verify the current PR target base.');
  const changedHead = sha(result.currentHead) && result.currentHead.toLowerCase() !== expected.head.toLowerCase();
  const changedBase = expected.scope === 'pr' && sha(result.currentBase) && result.currentBase.toLowerCase() !== expected.base.toLowerCase();
  if (changedHead || changedBase) result = { ...result, status: 'STALE' }; // No automatic rerun.
  else if (result.status === 'STALE') throw new Error('STALE verdict contradicts reported versions; require manual verification.');
  return result;
}

// Review delivery is deliberately more permissive than publication. The strict
// validators above assess structured evidence independently of presentation
// warnings. Initial limitations inform the verifier, not a second publication veto.
const initialKeys = ['status', 'snapshot', 'coverage', 'findings', 'report'];
const finalKeys = ['status', 'snapshot', 'currentHead', 'currentBase', 'confirmed', 'merged', 'rejected', 'needsInfo', 'newFindings', 'dispositions', 'report'];
const canonicalKey = key => key.trim().replace(/[_\s-]/g, '').toLowerCase();
const asText = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const canonicalEnum = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const reviewSHA = value => asText(value).trim().replace(/^["'`]*([0-9a-f]{40}|[0-9a-f]{64})["'`]*$/i, '$1').toLowerCase();
const select = (value, keys) => isObject(value) ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : value;
const note = (notes, message) => { if (!notes.includes(message)) notes.push(message); };

function reviewFields(value, keys, notes) {
  if (!isObject(value)) return {};
  const aliases = new Map(keys.map(key => [canonicalKey(key), key]));
  const entries = Object.entries(value), counts = new Map();
  for (const [key] of entries) {
    const name = aliases.get(canonicalKey(key));
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(entries.map(([key, content]) => {
    const name = aliases.get(canonicalKey(key));
    if (name && counts.get(name) > 1) {
      note(notes, 'Conflicting field aliases were retained for inspection; no alias was silently overwritten.');
      return [key, content];
    }
    return [name ?? key, content];
  }));
}
function reviewRows(value, notes) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = parseUniqueJSON(value); if (Array.isArray(parsed)) return parsed; } catch { /* Keep literal content. */ }
  }
  note(notes, 'A non-array review section was retained as one entry.');
  return [value];
}
function reviewSnapshot(value, notes) {
  if (!isObject(value)) return null;
  const result = reviewFields(value, Object.keys(snapshotSchema.properties), notes);
  if (typeof result.prId === 'string' && /^[1-9][0-9]*$/.test(result.prId.trim())) result.prId = Number(result.prId);
  for (const key of ['repository', 'base', 'head', 'scope']) if (typeof result[key] === 'string') result[key] = result[key].trim();
  for (const key of ['base', 'head']) if (Object.hasOwn(result, key)) result[key] = reviewSHA(result[key]);
  if (typeof result.scope === 'string') result.scope = result.scope.toLowerCase();
  if (Array.isArray(result.files)) result.files = [...new Set(result.files)];
  return result;
}
function snapshotView(value) { return select(value, Object.keys(snapshotSchema.properties)); }
function findingView(value) { return select(value, finding.required); }
function reviewFinding(value, notes) {
  const row = isObject(value) ? reviewFields(value, finding.required, notes) : { summary: asText(value) };
  for (const key of finding.required) if (Object.hasOwn(row, key)) row[key] = asText(row[key]);
  if (typeof row.id === 'string') row.id = row.id.trim();
  if (typeof row.severity === 'string') row.severity = row.severity.trim().toLowerCase();
  if (finding.required.some(key => key !== 'id' && !text(row[key]))) note(notes, 'Some findings omit evidence, counterevidence, severity, a correction, a summary or a source location. Missing details were not invented.');
  return row;
}

function assignTrackingIds(findings, prefix, notes) {
  const used = new Set(), reserved = new Set(findings.map(row => row.id).filter(text));
  let nextId = 1;
  for (const row of findings) {
    if (!text(row.id) || !new RegExp(`^${prefix}-[1-9][0-9]*$`).test(row.id) || used.has(row.id)) {
      if (Object.hasOwn(row, 'id')) row.originalId = row.id;
      while (reserved.has(`${prefix}-${nextId}`)) nextId++;
      row.id = `${prefix}-${nextId++}`; reserved.add(row.id);
      note(notes, 'Runtime tracking IDs were assigned to missing, malformed or repeated IDs; original IDs and finding content remain available.');
    }
    used.add(row.id);
  }
}

/** Stable tracking IDs are bookkeeping, never generated source evidence. All
 * supplied rows, including prose, duplicates and extra fields, remain available. */
export function acceptInitialReview(value, prefix, prUrl) {
  const notes = [], source = isObject(value) ? value : { report: asText(value), unstructured: true };
  const result = reviewFields(source, initialKeys, notes);
  result.snapshot = reviewSnapshot(result.snapshot, notes);
  result.coverage = reviewFields(result.coverage, ['files', 'gaps'], notes);
  if (!Array.isArray(result.coverage.files) || !Array.isArray(result.coverage.gaps)) note(notes, 'The initial coverage ledger is missing or incomplete; the verifier must establish coverage independently.');
  result.coverage.files = reviewRows(result.coverage.files, notes).map(asText);
  result.coverage.gaps = reviewRows(result.coverage.gaps, notes).map(asText);
  result.findings = reviewRows(result.findings, notes).map(row => reviewFinding(row, notes));
  assignTrackingIds(result.findings, prefix, notes);
  result.report = asText(result.report);
  result.status = canonicalEnum(result.status);
  if (result.unstructured) note(notes, 'Unstructured initial output was retained literally for independent verification.');
  let complete = false;
  try {
    const assessed = initialEnvelope({ ...select(result, initialKeys), snapshot: snapshotView(result.snapshot),
      coverage: select(result.coverage, ['files', 'gaps']), findings: result.findings.map(findingView),
      // Overview wording is presentation, not an evidence gate.
      report: result.report || 'No separate overview supplied.' }, null, prefix, prUrl);
    complete = assessed.status === 'COMPLETE';
  } catch (error) { note(notes, `Initial review limitation: ${error.message}`); }
  if (!complete) note(notes, 'This initial review has unresolved coverage or structured-evidence gaps.');
  result.status = complete ? 'COMPLETE' : 'PARTIAL';
  result.reviewWarnings = notes;
  result.contractComplete = complete && !source.unstructured && !notes.some(message => /Conflicting|tracking IDs/.test(message));
  return result;
}

/** Use established frames when available, and give the verifier every original
 * report, including conflicting frames. Missing metadata never becomes a fake SHA. */
export function selectReviewSnapshot(reviews, prUrl) {
  const frames = [], warnings = [];
  for (const review of reviews) {
    try {
      const frame = validateSnapshot(snapshotView(review.snapshot));
      if (frame.scope !== 'pr' || (prUrl && String(frame.prId) !== new URL(prUrl).pathname.split('/').filter(Boolean).at(-1))) throw new Error();
      frames.push(frame);
    } catch { note(warnings, 'An initial reviewer did not establish a usable PR snapshot.'); }
  }
  if (!frames.length) return { snapshot: null, warnings: [...warnings, 'The verifier must establish the requested PR identity and versions independently.'] };
  const first = frames[0];
  const same = frame => ['repository', 'prId', 'base', 'head', 'scope'].every(key => frame[key] === first[key]);
  if (frames.some(frame => !same(frame))) note(warnings, 'Initial reviewers reported conflicting PR identities or versions. Their observations must not be combined as one verified snapshot.');
  return { snapshot: { ...first, files: [...new Set(frames.filter(same).flatMap(frame => frame.files))].sort() }, warnings };
}

/** Missing decisions are visible runtime UNREVIEWED rows, never fabricated
 * model verdicts. Quality gaps retain a usable PARTIAL report without a retry. */
export function acceptFinalReview(value, expected, originals, prUrl) {
  const notes = [], source = isObject(value) ? value : { report: asText(value), unstructured: true };
  const result = reviewFields(source, finalKeys, notes);
  result.report = asText(result.report);
  result.snapshot = reviewSnapshot(result.snapshot, notes);
  const verifierSnapshot = result.snapshot !== null;
  if (!result.snapshot && expected) {
    result.snapshot = structuredClone(expected);
    note(notes, 'The displayed snapshot comes from the initial reviews; the verifier omitted its snapshot.');
  }
  result.currentHead = reviewSHA(result.currentHead);
  result.currentBase = reviewSHA(result.currentBase);
  const modelStatus = canonicalEnum(result.status);
  let rows = reviewRows(result.dispositions, notes).map(item => reviewFields(isObject(item) ? item : { reason: asText(item) }, Object.keys(disposition.properties), notes));
  for (const [category, status] of Object.entries({ confirmed: 'CONFIRMED', merged: 'MERGED', rejected: 'REJECTED', needsInfo: 'NEEDS_INFO' })) {
    for (const value of reviewRows(result[category], notes)) {
      const item = reviewFields(isObject(value) ? value : { reason: asText(value) }, [...finding.required, 'reason', 'mergedInto', 'verifiedFinding', 'status'], notes);
      if (status === 'CONFIRMED') {
        const { reason, verifiedFinding, ...finding } = item;
        rows.push({ id: item.id ?? verifiedFinding?.id, status, reason, verifiedFinding: verifiedFinding ?? finding });
      } else rows.push({ ...item, status });
    }
  }
  result.dispositions = rows.map(item => {
    const row = { ...item, id: asText(item.id), status: canonicalEnum(item.status) || 'UNREVIEWED', reason: asText(item.reason) };
    if (row.verifiedFinding != null) row.verifiedFinding = reviewFinding(row.verifiedFinding, notes);
    return row;
  });
  result.newFindings = reviewRows(result.newFindings, notes).map(item => reviewFinding(item, notes));
  // New verifier findings have no original reviewer decision to correlate.
  // Assign bookkeeping IDs without rewriting dispositions or inventing evidence.
  assignTrackingIds(result.newFindings, 'V', notes);
  const accounted = new Set(result.dispositions.map(row => row.id));
  result.unreviewedFindings = originals.filter(row => !accounted.has(row.id));
  for (const row of result.unreviewedFindings) result.dispositions.push({ id: row.id, status: 'UNREVIEWED',
    reason: 'Runtime notice: the verifier supplied no decision for this original finding. The initial observation remains unconfirmed.' });
  if (result.unreviewedFindings.length) note(notes, 'The verifier omitted decisions. Original observations are shown separately as unreviewed, not silently rejected or confirmed.');
  if (source.unstructured) note(notes, 'Unstructured final output is shown literally; its claims and freshness were not machine-validated.');
  result.modelStatus = modelStatus || 'UNSPECIFIED';
  result.status = modelStatus;
  let complete = false;
  try {
    const frame = expected ?? validateSnapshot(snapshotView(result.snapshot));
    if (prUrl && String(result.snapshot?.prId) !== new URL(prUrl).pathname.split('/').filter(Boolean).at(-1)) throw new Error('Final snapshot PR ID does not match the requested URL.');
    const assessed = finalEnvelope({ status: modelStatus, snapshot: snapshotView(result.snapshot), currentHead: result.currentHead, currentBase: result.currentBase,
      report: result.report || 'No separate overview supplied.', newFindings: result.newFindings.map(findingView),
      dispositions: result.dispositions.map(row => ({ ...select(row, Object.keys(disposition.properties)),
        ...(row.verifiedFinding ? { verifiedFinding: findingView(row.verifiedFinding) } : {}) })) }, frame, originals);
    complete = assessed.status === 'COMPLETE';
    result.status = assessed.status;
  } catch (error) { note(notes, `Final review limitation: ${error.message}`); }
  const frame = expected ?? result.snapshot;
  const changed = ['Head', 'Base'].some(side => sha(result[`current${side}`]) && sha(frame?.[side.toLowerCase()]) && result[`current${side}`].toLowerCase() !== frame[side.toLowerCase()].toLowerCase());
  if (changed) note(notes, 'Reported current PR versions differ from the reviewed snapshot. This report is stale.');
  // A repaired section shape or supplementary note cannot invalidate a final
  // result that passed the full evidence contract. Borrowed identity and
  // conflicting aliases still cannot stand in for the verifier's own evidence.
  const ambiguous = notes.some(message => message.startsWith('Conflicting field aliases'));
  result.status = changed || modelStatus === 'STALE' ? 'STALE' : complete && !source.unstructured &&
    verifierSnapshot && !ambiguous ? 'COMPLETE' : 'PARTIAL';
  result.reviewWarnings = notes;
  result.contractComplete = result.status === 'COMPLETE';
  return result;
}
