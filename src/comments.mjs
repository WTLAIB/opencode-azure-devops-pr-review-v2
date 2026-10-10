// Comment plans: per-item validation, stable markers and saved publication text.
import { createHash } from 'node:crypto';
import { renderReviewSummary } from './attribution.mjs';
import { targetKey } from './azure.mjs';
import { parseModelJSON, canonicalKey, parseRepairPrompt } from './output.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const positive = v => Number.isSafeInteger(v) && v > 0;
export const INLINE_SOFT_LIMIT = 1200;
export const INLINE_HARD_LIMIT = 4000;
export const SUMMARY_NOTE_LIMIT = 1200;
const severityIcons = { high: '🔴', medium: '🟡', low: '🔵' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const markerTag = fingerprint => `<!-- azpr-comment:${fingerprint} -->`;
const escapeComments = value => value.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');

export function confirmedFindings(review) {
  // Initial candidates remain audit data. Only verifier-corrected claims count;
  // a moved finding's initial location stays in the report, not in the claim.
  const confirmed = review.final.dispositions.filter(d => d.status === 'CONFIRMED' && isObject(d.verifiedFinding))
    .map(({ id, verifiedFinding: { movedFrom: _initial, ...finding } }) => ({ ...finding, id }));
  return [...confirmed, ...(review.final.newFindings ?? [])];
}

/**
 * Other findings of this review that a skip reason names. The verifier already
 * merged duplicates, so another finding's comment never covers a finding.
 */
function citedFindings(reason, own, findingIds) {
  const named = String(reason).match(/(?<![A-Za-z0-9_-])[A-Za-z]+-\d+(?!\d)/g) ?? [];
  return [...new Set(named)].filter(id => id !== own && findingIds.has(id));
}

export function publicationItems(plan) {
  return [...(plan?.summary ? [plan.summary] : []), ...(plan?.comments ?? [])];
}

/** Whitespace-insensitive anchor text, so re-reviews of unchanged code match. */
export const normalizedAnchor = anchor => anchor.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).join('\n').trim();

/**
 * Stable inline fingerprint: PR + path + normalized anchor (+ ordinal for
 * several comments on identical lines). No review ID or model wording, so a
 * later review of unchanged code finds the earlier comment instead of posting
 * a duplicate. A different issue on exactly the same lines is treated as
 * already discussed; it still appears in the report and the summary index.
 */
export function inlineMarker(target, comment, ordinal = 0) {
  return markerTag(hash([targetKey(target), 'inline', comment.path, normalizedAnchor(comment.anchor), ordinal]));
}

/** One summary per reviewed source commit and set of inline comments. */
export function summaryMarker(target, head, inlineMarkers) {
  return markerTag(hash([targetKey(target), 'summary', head, [...inlineMarkers].sort()]));
}

function argumentStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(argumentStrings);
  return isObject(value) ? Object.values(value).flatMap(argumentStrings) : [];
}

/**
 * Resolve a quoted anchor against source text observed during the review.
 * Prefer the declared lines; otherwise accept one unique matching range.
 */
export function restoreAnchor(comment, review) {
  const trim = value => value.split(/\r?\n/).map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
  const forms = new Set([trim(comment.anchor), trim(comment.anchor.replace(/\\"/g, '"'))]);
  const count = comment.endLine - comment.startLine + 1;
  const observations = (review.toolText ?? []).filter(observation => {
    const values = argumentStrings(observation.input);
    return values.includes(review.snapshot.head) && (values.includes(comment.path) || values.includes(comment.path.replace(/^\//, ''))) &&
      typeof observation.output === 'string';
  });
  const declared = new Map();
  for (const observation of observations) {
    const lines = observation.output.split(/\r?\n/, comment.endLine + 1);
    const selected = lines.slice(comment.startLine - 1, comment.endLine), anchor = selected.join('\n');
    if (selected.length === count && forms.has(trim(anchor))) declared.set(JSON.stringify([anchor]), { anchor, startLine: comment.startLine, endLine: comment.endLine });
  }
  if (declared.size === 1) return { ...[...declared.values()][0], found: true };
  if (declared.size > 1) return { anchor: comment.anchor, startLine: comment.startLine, endLine: comment.endLine, found: true };
  const candidates = new Map();
  for (const observation of observations) {
    const lines = observation.output.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    for (let start = 0; start + count <= lines.length; start++) {
      const anchor = lines.slice(start, start + count).join('\n');
      if (!forms.has(trim(anchor))) continue;
      candidates.set(`${start}`, { anchor, startLine: start + 1, endLine: start + count });
      if (candidates.size > 1) return { anchor: comment.anchor, startLine: comment.startLine, endLine: comment.endLine, found: false, ambiguous: true };
    }
  }
  return candidates.size === 1 ? { ...[...candidates.values()][0], found: true }
    : { anchor: comment.anchor, startLine: comment.startLine, endLine: comment.endLine, found: false };
}

/** Strip any severity label the model wrote, then apply the canonical one. */
export function normalizeTitle(body, severity) {
  const trimmed = body.trim();
  const label = /^(\*\*)?\s*(?:[🔴🟡🔵]\s*)?(\*\*)?\s*(?:issue\s*\(\s*)?(?:high|medium|low)\s*\)?\s*(\*\*)?\s*[:：]\s*/iu.exec(trimmed);
  if (!label) return `${severityIcons[severity]} ${severity}: ${trimmed}`;
  // "**🔴 high: Title**" keeps its bold title after the canonical label.
  const rest = trimmed.slice(label[0].length);
  const reopen = (label[1] || label[2]) && !label[3] && !rest.startsWith('**') ? '**' : '';
  return `${severityIcons[severity]} ${severity}: ${reopen}${rest}`;
}

const aliases = (value, names) => {
  const map = new Map(names.map(name => [canonicalKey(name), name]));
  return Object.fromEntries(Object.entries(value).map(([key, content]) => [map.get(canonicalKey(key)) ?? key, content]));
};

/**
 * Validate one planning page answer.
 * @returns {{result: object, issues: string[], corrections: object[]}}
 * With `final`, every remaining problem becomes a local skip instead of an issue.
 */
export function evaluatePlanPage(answerText, { review, assigned, final = false }) {
  const corrections = [], issues = [];
  const parsed = parseModelJSON(answerText, { keys: ['status', 'comments', 'skipped'] });
  if (!parsed.value) {
    const problem = `Your answer could not be used: ${parsed.problem}.`;
    if (!final) return { result: null, issues: [problem], corrections };
    return { result: { status: 'READY', comments: [], skipped: assigned.map(f => ({ findingId: f.id, reason: 'The comment planner did not return a usable plan; the finding remains in the summary index.' })), summary: undefined, summaryDetails: '' },
      issues: [], corrections: [{ action: 'skip-unparsed-plan' }] };
  }
  if (parsed.corrections) corrections.push(...parsed.corrections);
  const value = aliases(parsed.value, ['status', 'comments', 'skipped', 'summary', 'summaryDetails', 'continuation', 'reason']);
  let status = String(value.status ?? '').trim().toUpperCase();
  if (!['READY', 'CONTINUE', 'INCOMPLETE'].includes(status)) {
    if (!final && value.status !== undefined) issues.push('status must be READY, CONTINUE or INCOMPLETE.');
    status = 'READY';
  }
  let continuation = nonempty(value.continuation) ? value.continuation.trim() : undefined;
  if (status === 'CONTINUE' && !continuation && nonempty(value.reason)) {
    continuation = value.reason.trim();
    corrections.push({ action: 'copy-reason-to-continuation' });
  }
  if (status === 'CONTINUE' && !continuation) {
    if (!final) issues.push('A CONTINUE answer needs a "continuation" note naming completed work and what remains.');
    status = 'READY';
  }
  const eligible = new Map(assigned.map(finding => [finding.id, finding]));
  const changed = new Set(review.snapshot.files.map(path => path.startsWith('/') ? path : '/' + path));
  const comments = [], skipped = [], handled = new Set(), reported = new Set();
  const skip = (findingId, reason) => { if (!handled.has(findingId)) { handled.add(findingId); skipped.push({ findingId, reason }); } };
  for (const [index, raw] of (Array.isArray(value.comments) ? value.comments : []).entries()) {
    if (!isObject(raw)) { corrections.push({ action: 'drop-non-object-comment', index }); continue; }
    const c = aliases(raw, ['findingId', 'severity', 'path', 'startLine', 'endLine', 'anchor', 'body']);
    const finding = eligible.get(c.findingId);
    if (!finding) { corrections.push({ action: 'drop-unassigned-comment', findingId: String(c.findingId ?? '') }); continue; }
    if (handled.has(finding.id)) { corrections.push({ action: 'drop-duplicate-comment', findingId: finding.id }); continue; }
    if (!['high', 'medium'].includes(finding.severity)) { skip(finding.id, 'Low-severity findings appear in the summary index only.'); continue; }
    const problems = [];
    const severity = finding.severity;
    if (String(c.severity ?? '').toLowerCase() !== severity) corrections.push({ action: 'use-verified-severity', findingId: finding.id });
    let body = nonempty(c.body) ? escapeComments(normalizeTitle(c.body, severity)) : '';
    if (!body) problems.push('body is empty');
    else if (body.length > INLINE_SOFT_LIMIT && !final) problems.push(`body is ${body.length} characters; keep it within ${INLINE_SOFT_LIMIT}`);
    else if (body.length > INLINE_HARD_LIMIT) problems.push(`body exceeds ${INLINE_HARD_LIMIT} characters`);
    const path = nonempty(c.path) ? (c.path.startsWith('/') ? c.path : '/' + c.path) : '';
    if (!changed.has(path) || /[\r\n\0]/.test(path)) problems.push(`path ${JSON.stringify(c.path ?? '')} is not a changed file of this PR`);
    let startLine = Number(c.startLine), endLine = Number(c.endLine);
    const anchor = typeof c.anchor === 'string' ? c.anchor.replace(/\r\n/g, '\n').replace(/\n$/, '') : '';
    if (!nonempty(anchor)) problems.push('anchor must quote the exact source line(s)');
    if (!positive(startLine)) problems.push('startLine must be a positive integer');
    if (nonempty(anchor) && positive(startLine)) {
      const lines = anchor.split('\n').length;
      if (!positive(endLine) || endLine - startLine + 1 !== lines) {
        endLine = startLine + lines - 1;
        corrections.push({ action: 'derive-end-line-from-anchor', findingId: finding.id });
      }
    }
    let restored;
    if (!problems.length) {
      restored = restoreAnchor({ path, startLine, endLine, anchor }, review);
      if (restored.startLine !== startLine) corrections.push({ action: 'restore-anchor-location', findingId: finding.id, from: startLine, to: restored.startLine });
      if (restored.ambiguous && !final) problems.push('the anchor text appears several times in the observed source; quote more lines to make it unique');
    }
    if (problems.length) {
      if (!final) { issues.push(`comment for ${finding.id}: ${problems.join('; ')}.`); reported.add(finding.id); continue; }
      skip(finding.id, `No inline comment: ${problems.join('; ')}. The finding remains in the summary index.`);
      continue;
    }
    if (body.length > INLINE_SOFT_LIMIT) corrections.push({ action: 'accept-long-body', findingId: finding.id, characters: body.length });
    handled.add(finding.id);
    comments.push({ findingId: finding.id, severity, path, startLine: restored.startLine, endLine: restored.endLine, anchor: restored.anchor, body });
  }
  const findingIds = new Set(confirmedFindings(review).map(finding => finding.id));
  for (const [index, raw] of (Array.isArray(value.skipped) ? value.skipped : []).entries()) {
    const s = isObject(raw) ? aliases(raw, ['findingId', 'reason']) : {};
    if (!eligible.has(s.findingId)) { corrections.push({ action: 'drop-unassigned-skip', index }); continue; }
    if (handled.has(s.findingId)) continue;
    const reason = nonempty(s.reason) ? s.reason.trim() : 'Skipped by the comment planner without a stated reason.';
    const cited = citedFindings(reason, s.findingId, findingIds);
    if (cited.length && !final) {
      issues.push(`skip for ${s.findingId} relies on ${cited.join(', ')}: findings of this review are separate issues (the verifier already merged duplicates), so another finding's comment does not cover it. Comment on ${s.findingId} at the lines of its own claim, or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).`);
      reported.add(s.findingId);
      continue;
    }
    if (cited.length) corrections.push({ action: 'keep-skip-citing-other-finding', findingId: s.findingId, cited });
    skip(s.findingId, cited.length ? `${reason} [Runtime: other findings of this review do not cover this one; it remains in the summary index.]` : reason);
  }
  const missing = [...eligible.keys()].filter(id => !handled.has(id));
  if (missing.length && status !== 'CONTINUE') {
    if (status === 'INCOMPLETE' || final) {
      const why = nonempty(value.reason) ? value.reason.trim() : 'The comment planner did not address this finding.';
      for (const id of missing) skip(id, `${why} The finding remains in the summary index.`);
    } else if (missing.some(id => !reported.has(id))) {
      issues.push(`Every assigned finding needs a comment or a skipped entry; missing: ${missing.filter(id => !reported.has(id)).join(', ')}.`);
    }
  }
  if (status === 'INCOMPLETE') { corrections.push({ action: 'accept-incomplete-plan-page', reason: nonempty(value.reason) ? value.reason.trim() : '' }); status = 'READY'; }
  const summary = nonempty(value.summary) && value.summary.length <= SUMMARY_NOTE_LIMIT && !/<!--|-->/.test(value.summary) ? value.summary.trim() : undefined;
  if (nonempty(value.summary) && !summary) corrections.push({ action: 'drop-invalid-summary-note' });
  const summaryDetails = nonempty(value.summaryDetails) ? escapeComments(value.summaryDetails.trim()) : '';
  return { result: { status, comments, skipped, summary, summaryDetails, ...(continuation ? { continuation } : {}) }, issues, corrections };
}

export function planRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  const listed = issues.slice(0, 25).map(issue => `- ${issue}`).join('\n');
  return `AZPR runtime: this comment plan page needs correction before it can be saved.\n${listed}\n\nReturn the complete corrected JSON object for this page (status, comments, skipped, optional summary and summaryDetails). Keep valid comments unchanged.`;
}

function summaryComment(review, note, details, inlineMarkers) {
  const chinese = /^zh(?:-|$)/i.test(review.outputLanguage ?? '');
  const traditional = chinese && new Intl.Locale(review.outputLanguage).maximize().script === 'Hant';
  const heading = chinese ? traditional ? '審查說明' : '审查说明' : 'Review notes';
  const notes = nonempty(note) ? `**${heading}**\n\n${note.trim()}` : '';
  const index = renderReviewSummary(confirmedFindings(review), review.outputLanguage ?? 'en', notes);
  const disclosure = review.attribution ? `🤖 ${review.attribution}\n\n` : '';
  const marker = summaryMarker(review.target, review.snapshot.head, inlineMarkers);
  return { kind: 'summary', marker, content: `${disclosure}${index}${details ? `\n\n${details}` : ''}\n\n${marker}` };
}

/** Assemble validated pages into one saved plan with markers and exact content. */
export function assemblePlan(review, pages) {
  const ordinals = new Map();
  const comments = pages.flatMap(page => page.comments).map(c => {
    const key = `${c.path}\n${normalizedAnchor(c.anchor)}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const marker = inlineMarker(review.target, c, ordinal);
    // Azure positions are one-based UTF-16 offsets within their lines.
    const endOffset = Math.max(1, c.anchor.split('\n').at(-1).length);
    return { ...c, kind: 'inline', startOffset: 1, endOffset, marker,
      content: `${c.body}${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${marker}` };
  });
  const skipped = pages.flatMap(page => page.skipped);
  const intro = pages.map(page => page.summary).find(Boolean);
  const details = [...new Set(pages.map(page => page.summaryDetails).filter(nonempty))].join('\n\n');
  return { summary: summaryComment(review, intro, details, comments.map(c => c.marker)), comments, skipped };
}
