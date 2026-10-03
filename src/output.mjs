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

export function stageFormat(role, statusOnly = false) {
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
  if (statusOnly === 'disposition') schema = object({ dispositions: array(object({
    id: string, status: status('MERGED'), mergedInto: string,
    reason: { ...string, description: 'Existing source-based reason for the same root cause and correction, in outputLanguage. Do not invent a merge to fill a missing row.' },
  })) });
  else if (statusOnly === 'location') schema = object({ locations: array(object({ id: string,
    location: { ...string, description: 'Exact base:/path:line or head:/path:start-end from source already read in this session. No guesses or new source reads.' },
  })) });
  else if (statusOnly && statusOnly !== 'final') schema = object({ status: schema.properties.status });
  return { schema };
}

export function visibleText(response) {
  return (response?.parts ?? []).filter(p => p.type === 'text' && !p.ignored).map(p => p.text ?? '').join('\n');
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

/** Output defects may be resubmitted only with an already known, fresh frame.
 * This establishes eligibility, not truth or sufficiency of source evidence. */
export function finalResubmissionPlan(original, expected) {
  try {
    if (!isObject(original) || original.status !== 'COMPLETE' || expected.scope !== 'pr' ||
        snapshotKey(original.snapshot) !== snapshotKey(expected) || !sha(original.currentHead) || !sha(original.currentBase) ||
        original.currentHead.toLowerCase() !== expected.head.toLowerCase() || original.currentBase.toLowerCase() !== expected.base.toLowerCase()) return;
    return { snapshot: validateSnapshot(expected), currentHead: original.currentHead, currentBase: original.currentBase };
  } catch { return; }
}

/** Preserve observations that cannot be refreshed in a tool-free resubmission. */
export function checkFinalResubmission(result, plan) {
  if (!isObject(result) || snapshotKey(result.snapshot) !== snapshotKey(plan.snapshot) ||
      !sha(result.currentHead) || !sha(result.currentBase) || result.currentHead.toLowerCase() !== plan.currentHead.toLowerCase() ||
      result.currentBase.toLowerCase() !== plan.currentBase.toLowerCase()) throw new Error('Final resubmission changed or omitted the frozen snapshot/current versions.');
  return result;
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

/** Missing rows may only be amended as merges into already confirmed originals.
 * The temporary NEEDS_INFO rows test other contracts; they are never accepted. */
export function dispositionRepairPlan(original, missingIds, validate) {
  if (!isObject(original) || original.status !== 'COMPLETE' || !missingIds.length ||
      !Array.isArray(original.dispositions)) return;
  try {
    const mergeTargets = original.dispositions.filter(d => d.status === 'CONFIRMED').map(d => d.id);
    if (!mergeTargets.length || original.dispositions.some(d => missingIds.includes(d.id) ||
        (d.status === 'MERGED' && missingIds.includes(d.mergedInto)))) return;
    const probe = JSON.parse(JSON.stringify(original));
    probe.dispositions.push(...missingIds.map(id => ({ id, status: 'NEEDS_INFO', reason: 'ELIGIBILITY PROBE ONLY' })));
    if (validate(probe).status !== 'COMPLETE') return;
    return { missingDispositionIds: [...missingIds], mergeTargets };
  } catch { return; }
}

/** Add only model-authored missing MERGED rows. Never infer a decision from prose. */
export function applyDispositionAmendment(original, plan, amendment) {
  if (!isObject(amendment) || Object.keys(amendment).length !== 1 ||
      !Array.isArray(amendment.dispositions) || amendment.dispositions.length !== plan.missingDispositionIds.length) {
    throw new Error('Disposition retry must return exactly the missing merge rows; no existing fields may change.');
  }
  const remaining = new Set(plan.missingDispositionIds);
  for (const item of amendment.dispositions) {
    if (!isObject(item) || Object.keys(item).length !== 4 ||
        Object.keys(item).some(key => !['id', 'status', 'mergedInto', 'reason'].includes(key)) ||
        !remaining.delete(item.id) || item.status !== 'MERGED' || !plan.mergeTargets.includes(item.mergedInto) ||
        !text(item.reason)) throw new Error('Disposition retry requires unique requested IDs, existing confirmed targets and nonempty merge reasons.');
  }
  if (remaining.size) throw new Error('Disposition retry omitted requested IDs.');
  const amended = JSON.parse(JSON.stringify(original));
  amended.dispositions.push(...JSON.parse(JSON.stringify(amendment.dispositions)));
  return amended;
}

function findingSlots(result, role) {
  if (ROLES[role]?.format === 'initial') return (result.findings ?? []).map((value, i) => ({ value, path: `findings[${i}].location` }));
  if (ROLES[role]?.format === 'final') return [
    ...(result.dispositions ?? []).flatMap((d, i) => d.status === 'CONFIRMED' ? [{ value: d.verifiedFinding, path: `dispositions[${i}].verifiedFinding.location` }] : []),
    ...(result.newFindings ?? []).map((value, i) => ({ value, path: `newFindings[${i}].location` })),
  ];
  return [];
}

/** Check eligibility only: the placeholder is never a result or source evidence.
 * Missing source/evidence/coverage and changed heads must fail this probe. */
export function locationRepairPlan(original, role, validate) {
  if (ROLES[role]?.format !== 'final' || !isObject(original) || original.status !== 'COMPLETE') return;
  try {
    const probe = JSON.parse(JSON.stringify(original));
    const missingLocations = [];
    for (const { value, path } of findingSlots(probe, role)) {
      if (isObject(value) && !Object.hasOwn(value, 'location')) {
        missingLocations.push({ id: value.id, path });
        value.location = 'ELIGIBILITY PROBE ONLY';
      }
    }
    if (!missingLocations.length || validate(probe).status !== 'COMPLETE') return;
    return missingLocations;
  } catch { return; }
}

/** Add only explicitly requested absent location fields. No original value may
 * change; the caller must still validate the entire amended envelope. */
export function applyLocationAmendment(original, role, missingLocations, amendment) {
  if (!isObject(amendment) || Object.keys(amendment).length !== 1 || !Array.isArray(amendment.locations) ||
      amendment.locations.length !== missingLocations.length) throw new Error('Location retry must return exactly the requested locations; no other fields may change.');
  const expected = new Set(missingLocations.map(item => item.id)), received = new Map();
  for (const item of amendment.locations) {
    if (!isObject(item) || Object.keys(item).length !== 2 || !expected.has(item.id) || received.has(item.id) || typeof item.location !== 'string') {
      throw new Error('Location retry has missing, duplicate, unexpected IDs or extra fields.');
    }
    const match = /^(base|head):\/[^\r\n:]+:([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(item.location);
    if (!match || !Number.isSafeInteger(Number(match[2])) || (match[3] && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) < Number(match[2])))) {
      throw new Error('Location retry requires an exact base/head path and positive, ordered source lines; unavailable locations cannot complete a review.');
    }
    received.set(item.id, item.location);
  }
  const amended = JSON.parse(JSON.stringify(original));
  for (const { value } of findingSlots(amended, role)) if (!Object.hasOwn(value, 'location')) value.location = received.get(value.id);
  return amended;
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
// Recognize JSON with only the trailing-separator extension. An iterative stack
// rejects holes/missing values without recursion or editing quoted source. The
// strict parser below still establishes grammar and duplicate-key rejection.
function trailingCommaCandidate(content) {
  const stack = [{ kind: 'root', next: 'value' }], offsets = [];
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  let i = 0;
  while (i < content.length) {
    const char = content[i], frame = stack.at(-1);
    if (' \t\r\n'.includes(char)) { i++; continue; }
    if (char === '}' || char === ']') {
      if (frame.kind !== (char === '}' ? 'object' : 'array')) return;
      if (frame.comma !== undefined) offsets.push(frame.comma);
      else if (!['end', 'first-key', 'first-value'].includes(frame.next)) return;
      stack.pop(); i++; continue;
    }
    if (frame.next === 'colon') {
      if (char !== ':') return;
      frame.next = 'value'; i++; continue;
    }
    if (frame.next === 'end') {
      if (char !== ',' || frame.kind === 'root') return;
      frame.comma = i++;
      frame.next = frame.kind === 'object' ? 'key' : 'value';
      continue;
    }
    if (['key', 'first-key'].includes(frame.next)) {
      if (char !== '"') return;
      token.lastIndex = i;
      const match = token.exec(content);
      if (!match) return;
      i = token.lastIndex; frame.next = 'colon'; delete frame.comma;
      continue;
    }
    if (!['value', 'first-value'].includes(frame.next)) return;
    frame.next = 'end'; delete frame.comma;
    if (char === '{' || char === '[') {
      stack.push({ kind: char === '{' ? 'object' : 'array', next: char === '{' ? 'first-key' : 'first-value' });
      i++; continue;
    }
    token.lastIndex = i;
    if (!token.exec(content)) return;
    i = token.lastIndex;
  }
  if (stack.length !== 1 || stack[0].next !== 'end' || !offsets.length) return;
  let start = 0;
  const pieces = offsets.map(offset => { const piece = content.slice(start, offset); start = offset + 1; return piece; });
  pieces.push(content.slice(start));
  return { text: pieces.join(''), corrections: offsets.map(offset => ({ action: 'remove-trailing-comma', offset })) };
}

/** Strict parsing remains the contract for checks, comments and amendments. */
export function parseJSONReport(response) {
  return parseReport(response).envelope;
}

/** Normal review text only; callers must validate the complete envelope before
 * accepting/disclosing corrections. Offsets are zero-based UTF-16 positions in
 * the selected JSON body. The response and all member/value text stay untouched. */
export function parseReviewJSONReport(response, role) {
  return parseReport(response, role);
}

function parseReport(response, role) {
  const finish = String(response.info?.finish ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (response.info?.error) {
    const name = String(response.info.error.type ?? 'UnknownError').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    throw new Error(`Reviewer returned an OpenCode/model error (${name}; finish=${finish}). Inspect the private session or debug response. No automatic retry.`);
  }
  if (['length', 'content-filter', 'error', 'cancelled'].includes(response.info?.finish)) throw new Error(`Reviewer output did not finish successfully (finish=${finish}); no partial response or output recovery was accepted.`);
  const allowTrailingCommas = response.info?.finish === 'stop' &&
    ['initial', 'final'].includes(ROLES[role]?.format);
  let result, corrections = [];
  let content = visibleText(response).trim();
  if (!content) throw new Error(`Empty reviewer output (finish=${finish}); inspect the session export or debug response.`);
  // Never guess between multiple envelopes. The scoped review extension may
  // remove only grammar-checked trailing separators, never infer missing data.
  const fences = [...content.matchAll(/^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gmi)];
  let jsonContent = content;
  function parse(candidate) {
    try { return { envelope: JSON.parse(candidate), text: candidate, corrections: [] }; }
    catch (error) {
      const normalized = allowTrailingCommas && trailingCommaCandidate(candidate);
      if (!normalized) throw error;
      return { envelope: JSON.parse(normalized.text), ...normalized };
    }
  }
  let parsed;
  try { parsed = parse(content); }
  catch {
    if (fences.length === 1 && !/[{}]|```/.test(content.replace(fences[0][0], ''))) {
      try { parsed = parse(fences[0][1]); } catch { /* Fail closed below. */ }
    }
    if (parsed === undefined) throw new Error(`Reviewer did not return the required JSON envelope (characters=${content.length}; finish=${finish}). Partial output remains in its session. Inspect the private session or debug response. No automatic retry.`);
  }
  ({ envelope: result, text: jsonContent, corrections } = parsed);
  rejectDuplicateJSONKeys(jsonContent, 'Reviewer text contains duplicate JSON keys; no field value was selected or repaired.');
  if (!isObject(result)) throw new Error('Review envelope must be an object.');
  if (corrections.length && !stageFormat(role).schema.properties.status.enum.includes(result.status)) throw new Error('Trailing-comma normalization requires a valid review status; no output recovery.');
  return { envelope: result, corrections };
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
