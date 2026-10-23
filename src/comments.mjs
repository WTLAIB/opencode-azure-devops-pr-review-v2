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
 * Whether a saved review's findings were independently verified: "none" for a
 * quick review, "independent" for review and deep. Reviews saved before this
 * field existed are known only by their profile; anything else is null and is
 * never commented on.
 */
export function reviewVerification(review) {
  if (review?.verification === 'none' || review?.verification === 'independent') return review.verification;
  if (review?.verification === undefined && ['review', 'deep'].includes(review?.profile)) return 'independent';
  return null;
}

/**
 * The findings comment planning may use: verified ones (CONFIRMED and verifier
 * additions) for review and deep; for a quick review the REPORTED ones, which
 * passed the runtime's checks but were not independently verified. A quick
 * finding whose location cannot carry an inline comment says `inline: false`.
 */
export function publishableFindings(review) {
  if (reviewVerification(review) !== 'none') return confirmedFindings(review);
  return review.final.dispositions.filter(d => d.status === 'REPORTED' && isObject(d.finding))
    .map(({ id, finding, inline, shard }) => ({ ...finding, id, ...(inline === false ? { inline: false } : {}), ...(shard ? { shard } : {}) }));
}

/** "head:/src/a.ts:12-14" -> { side, path, start, end }; null when no path. A location without a side is HEAD. */
export function parseLocation(location) {
  const match = /^(?:(head|base):?)?:?(\/[^:]+?)(?::(\d+)(?:-(\d+))?)?\s*$/.exec(String(location ?? '').trim());
  if (!match) return null;
  const start = match[3] ? Number(match[3]) : null;
  return { side: match[1] ?? 'head', path: match[2], start, end: match[4] ? Number(match[4]) : start };
}

/**
 * Why findings may not share one comment; [] when they may. Members must be
 * inline-eligible quick findings of different sessions with the same
 * severity, on one HEAD file, whose line ranges all share at least one line.
 * Returns the shared lines as `lines`.
 */
export function combinationProblems(members) {
  const problems = [];
  const shards = members.map(member => member.shard);
  if (shards.some(shard => !shard) || new Set(shards).size !== shards.length) problems.push('combined findings must come from different review sessions');
  if (new Set(members.map(member => member.severity)).size !== 1) problems.push('combined findings must have the same severity');
  else if (!['high', 'medium'].includes(members[0].severity)) problems.push('only high and medium findings get inline comments');
  if (members.some(member => member.inline === false)) problems.push('a combined finding has no inline location');
  const at = members.map(member => parseLocation(member.location));
  if (at.some(location => location?.side !== 'head' || !location.start) || new Set(at.map(location => location?.path)).size !== 1) {
    problems.push('combined findings must be located on lines of one HEAD file');
    return { problems };
  }
  const lines = { path: at[0].path, start: Math.max(...at.map(location => location.start)), end: Math.min(...at.map(location => location.end)) };
  if (lines.start > lines.end) problems.push('the findings share no common line');
  return { problems, lines };
}

/**
 * Other findings of this review that a skip reason names. The verifier already
 * merged duplicates, so another finding's comment never covers a finding.
 */
function citedFindings(reason, own, findingIds) {
  const named = String(reason).match(/(?<![A-Za-z0-9_-])[A-Za-z]+-\d+(?!\d)/g) ?? [];
  return [...new Set(named)].filter(id => id !== own && findingIds.has(id));
}

/** Why a planner may skip a finding: the policy's grounds, one cause each. */
export const SKIP_CAUSES = Object.freeze(['low-severity', 'no-inline-location', 'existing-thread', 'cannot-anchor', 'too-long']);

/**
 * The facts a skip's cause states that the runtime can check: a low finding,
 * no location that can carry an inline comment, a live thread of this PR, and
 * lines the page did not show. Whether a finding deserves a comment stays the
 * planner's judgment; `too-long` is not checked. '' when nothing is wrong.
 */
function skipProblem(finding, skip, { sources, discussions, inlineEligible }) {
  const cause = String(skip.cause ?? '').trim().toLowerCase();
  if (!SKIP_CAUSES.includes(cause)) return `a skip needs "cause": one of ${SKIP_CAUSES.join(', ')}`;
  if (cause === 'low-severity' && finding.severity !== 'low') return `${finding.id} is ${finding.severity}, not low`;
  if (cause === 'no-inline-location' && inlineEligible(finding)) return `${finding.id} is located on lines of a changed HEAD file that sourceExcerpts shows, so it can carry an inline comment`;
  if (cause === 'existing-thread' && Array.isArray(discussions) && !discussions.some(thread => thread.threadId === Number(skip.threadId))) {
    return `thread ${skip.threadId ?? '(none given)'} is not a live thread of this PR; give the "threadId" of the existingDiscussions thread that covers it`;
  }
  if (cause === 'cannot-anchor') {
    const at = parseLocation(finding.location);
    const shown = at?.side === 'head' && at.start && sources.find(item => item.path === at.path && item.firstLine <= at.start && at.end <= item.lastLine);
    if (shown) return `its lines ${at.path}:${at.start}${at.end !== at.start ? `-${at.end}` : ''} are in sourceExcerpts (lines ${shown.firstLine}-${shown.lastLine}); quote them as the anchor`;
  }
  return '';
}

export function publicationItems(plan) {
  return [...(plan?.summary ? [plan.summary] : []), ...(plan?.comments ?? [])];
}

/**
 * Why automatic publication has nothing new to post: the plan has no inline
 * comment, and the planner skipped every finding because a live thread of the
 * PR already discusses it (checked against `discussions`, the threads the
 * runtime read before planning), typically AZPR's own comment from an earlier
 * run. The summary's marker follows the inline comments, so posting it would
 * add a second summary for the same findings. '' otherwise, also when the
 * threads could not be read.
 */
export function automaticPublicationRepeats(plan, discussions) {
  const skipped = plan?.skipped ?? [];
  if (plan?.comments?.length || !skipped.length || !Array.isArray(discussions)) return '';
  const live = new Set(discussions.map(thread => thread.threadId));
  if (!skipped.every(skip => skip.cause === 'existing-thread' && live.has(skip.threadId))) return '';
  return `every finding is already discussed on the PR (${[...new Set(skipped.map(skip => `thread ${skip.threadId}`))].join(', ')})`;
}

// Comment text that automatic publication leaves to a person, item by item:
// it would notify people, load content when the comment is viewed, or run a
// script. Ordinary links are posted. The checks are literal and prefer a false
// alarm to a miss; AZPR's own marker is removed first. Script links and
// mentions are also checked after decoding (see decodedText); images and HTML
// only as written, since a decoded character never forms markup.
const UNSEEN_TEXT = [
  ['a script, data or local-file link', [/\b(?:javascript|vbscript):/i, /\bdata:[a-z]+\//i, /\bfile:\/\//i], true],
  ['an @mention', [/@</], true],
  ['an image', [/!\[/]],
  ['HTML that embeds content or runs a script', [/<\/?(?:img|image|iframe|frame|frameset|object|embed|applet|video|audio|source|track|picture|svg|script|style|link|meta|base|portal)(?=[\s/>]|$)/im,
    /<[a-z][a-z0-9-]*\s[^<>]*?\b(?:on[a-z]+|src|srcset|style|background|poster|xlink:href)\s*=/i, /<!--/]],
];
const OWN_MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
// The named character references that stand for ASCII punctuation, the only
// characters besides letters and digits that the script-link and mention checks look for.
const PUNCTUATION_REFERENCES = Object.freeze({
  excl: '!', quot: '"', QUOT: '"', num: '#', dollar: '$', percnt: '%', amp: '&', AMP: '&', apos: "'", lpar: '(', rpar: ')',
  ast: '*', midast: '*', plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', lt: '<', LT: '<', equals: '=',
  gt: '>', GT: '>', quest: '?', commat: '@', lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', Hat: '^',
  lowbar: '_', UnderBar: '_', grave: '`', DiacriticalGrave: '`', lcub: '{', lbrace: '{', verbar: '|', vert: '|',
  VerticalLine: '|', rcub: '}', rbrace: '}',
});
/**
 * What CommonMark makes of escapes and character references in link
 * destinations and text: `java&#115;cript:` and `javascript\:` are script
 * links, `@&lt;…&gt;` a mention. Decoding errs towards finding more (a
 * reference after a backslash is decoded too); `&lt`, `&gt`, `&amp` and `&quot`
 * count without a semicolon.
 */
function decodedText(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (_, decimal, hex) => {
      const code = decimal === undefined ? parseInt(hex, 16) : Number(decimal);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/&([A-Za-z][A-Za-z0-9]*);|&(lt|gt|amp|quot|LT|GT|AMP|QUOT)(?![A-Za-z0-9;])/g, (whole, name, legacy) => Object.hasOwn(PUNCTUATION_REFERENCES, name ?? legacy) ? PUNCTUATION_REFERENCES[name ?? legacy] : whole);
}

/** The saved items whose text automatic publication leaves to a person: { marker, reason } each. */
export function automaticPublicationProblems(plan) {
  return publicationItems(plan).flatMap(item => {
    const text = item.content.replace(OWN_MARKER, ''), decoded = decodedText(text);
    const kinds = UNSEEN_TEXT.filter(([, patterns, decodes]) => patterns.some(pattern => pattern.test(text) || (decodes && pattern.test(decoded)))).map(([kind]) => kind);
    if (!kinds.length) return [];
    const name = item.kind === 'summary' ? 'the PR summary' : `the comment for ${(item.findingIds ?? [item.findingId]).join(', ')} (${item.path}:${item.startLine})`;
    return [{ marker: item.marker, reason: `${name} contains ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0]}` }];
  });
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
 * `candidates` lists the groups of a quick review whose findings one comment
 * may combine (`findingIds`); the runtime never combines findings itself.
 * `sources` are the page's source excerpts and `discussions` the live threads
 * the runtime read (null when it could not): skip causes are checked against them.
 * With `allowSummary: false` a summary note is dropped, never repaired: only
 * the page the runtime chose writes it.
 */
export function evaluatePlanPage(answerText, { review, assigned, final = false, candidates = [], sources = [], discussions = null, allowSummary = true }) {
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
  // Quick findings were not independently verified: an inline comment needs a
  // checked location and an anchor found in source text the runtime read.
  const quick = reviewVerification(review) === 'none';
  const comments = [], skipped = [], handled = new Set(), reported = new Set(), refusedCombinations = [];
  const skip = (findingId, reason, extra = {}) => { if (!handled.has(findingId)) { handled.add(findingId); skipped.push({ findingId, reason, ...extra }); } };
  // A location that can carry an inline comment: on a changed HEAD file whose text the page shows.
  const inlineEligible = finding => {
    if (finding.inline === false) return false;
    const at = parseLocation(finding.location);
    return at?.side === 'head' && changed.has(at.path) && sources.some(item => item.path === at.path);
  };
  // Body, path and anchor of one inline comment; `lines` bounds the anchor of a combined comment.
  function draft(c, label, severity, lines) {
    const problems = [];
    if (String(c.severity ?? '').toLowerCase() !== severity) corrections.push({ action: 'use-verified-severity', findingId: label });
    const body = nonempty(c.body) ? escapeComments(normalizeTitle(c.body, severity)) : '';
    if (!body) problems.push('body is empty');
    else if (body.length > INLINE_SOFT_LIMIT && !final) problems.push(`body is ${body.length} characters; keep it within ${INLINE_SOFT_LIMIT}`);
    else if (body.length > INLINE_HARD_LIMIT) problems.push(`body exceeds ${INLINE_HARD_LIMIT} characters`);
    const path = nonempty(c.path) ? (c.path.startsWith('/') ? c.path : '/' + c.path) : '';
    if (!changed.has(path) || /[\r\n\0]/.test(path)) problems.push(`path ${JSON.stringify(c.path ?? '')} is not a changed file of this PR`);
    else if (lines && path !== lines.path) problems.push(`path must be ${lines.path}, where the combined findings are`);
    let startLine = Number(c.startLine), endLine = Number(c.endLine);
    const anchor = typeof c.anchor === 'string' ? c.anchor.replace(/\r\n/g, '\n').replace(/\n$/, '') : '';
    if (!nonempty(anchor)) problems.push('anchor must quote the exact source line(s)');
    if (!positive(startLine)) problems.push('startLine must be a positive integer');
    if (nonempty(anchor) && positive(startLine)) {
      const count = anchor.split('\n').length;
      if (!positive(endLine) || endLine - startLine + 1 !== count) {
        endLine = startLine + count - 1;
        corrections.push({ action: 'derive-end-line-from-anchor', findingId: label });
      }
    }
    let restored;
    if (!problems.length) {
      restored = restoreAnchor({ path, startLine, endLine, anchor }, review);
      if (restored.startLine !== startLine) corrections.push({ action: 'restore-anchor-location', findingId: label, from: startLine, to: restored.startLine });
      if (restored.ambiguous && !final) problems.push('the anchor text appears several times in the observed source; quote more lines to make it unique');
      else if (quick && !restored.found) problems.push('the anchor text was not found in the HEAD source; quote the exact lines from sourceExcerpts');
      else if (lines && (restored.startLine < lines.start || restored.endLine > lines.end)) problems.push(`the anchor must lie within lines ${lines.start}-${lines.end}, which every combined finding covers`);
    }
    if (problems.length) return { problems };
    if (body.length > INLINE_SOFT_LIMIT) corrections.push({ action: 'accept-long-body', findingId: label, characters: body.length });
    return { problems, comment: { severity, path, startLine: restored.startLine, endLine: restored.endLine, anchor: restored.anchor, body } };
  }
  // One comment for findings of a listed candidate group. The planner decides
  // whether they state one defect; the runtime checks only the group rules.
  function combine(c, ids) {
    const label = ids.join('+');
    const members = ids.map(id => eligible.get(id));
    const problems = [];
    let lines;
    if (!quick || !candidates.length) problems.push('findingIds may combine only the findings of a listed mergeCandidates group');
    else if (members.some(member => !member)) problems.push(`${ids.filter(id => !eligible.has(id)).join(', ')} not assigned to this page`);
    else if (!candidates.some(group => ids.every(id => group.includes(id)))) problems.push('the findings are not all in one mergeCandidates group');
    else if (members.some(member => handled.has(member.id))) problems.push('a combined finding already has a comment or skip');
    else {
      const checked = combinationProblems(members);
      problems.push(...checked.problems);
      lines = checked.lines;
      if (!nonempty(c.mergeReason)) problems.push('a combined comment needs a mergeReason');
    }
    let drafted;
    if (!problems.length) {
      drafted = draft(c, label, members[0].severity, lines);
      problems.push(...drafted.problems);
    }
    if (problems.length) {
      if (!final) {
        issues.push(`combined comment for ${ids.join(', ')}: ${problems.join('; ')}. Correct it, or comment on each finding separately.`);
        for (const id of ids) if (eligible.has(id) && !handled.has(id)) reported.add(id);
        return;
      }
      // The runtime cannot split one text into reliable comments: what the
      // combination named stays in the summary index unless it has its own comment.
      corrections.push({ action: 'drop-invalid-combined-comment', findingIds: ids, problems });
      refusedCombinations.push({ ids, reason: `A combined comment for ${ids.join(', ')} did not meet the combination rules (${problems.join('; ')}); the finding remains in the summary index.` });
      return;
    }
    for (const id of ids) handled.add(id);
    comments.push({ findingId: ids[0], findingIds: ids, ...drafted.comment, mergeReason: c.mergeReason.trim() });
  }
  for (const [index, raw] of (Array.isArray(value.comments) ? value.comments : []).entries()) {
    if (!isObject(raw)) { corrections.push({ action: 'drop-non-object-comment', index }); continue; }
    const c = aliases(raw, ['findingId', 'findingIds', 'mergeReason', 'severity', 'path', 'startLine', 'endLine', 'anchor', 'body']);
    const ids = Array.isArray(c.findingIds) ? [...new Set(c.findingIds.map(id => String(id)))] : [];
    if (ids.length > 1) { combine(c, ids); continue; }
    const findingId = c.findingId === undefined && ids.length === 1 ? ids[0] : c.findingId;
    const finding = eligible.get(findingId);
    if (!finding) { corrections.push({ action: 'drop-unassigned-comment', findingId: String(findingId ?? '') }); continue; }
    if (handled.has(finding.id)) { corrections.push({ action: 'drop-duplicate-comment', findingId: finding.id }); continue; }
    if (!['high', 'medium'].includes(finding.severity)) { skip(finding.id, 'Low-severity findings appear in the summary index only.'); continue; }
    if (finding.inline === false) {
      corrections.push({ action: 'skip-location-without-inline', findingId: finding.id });
      skip(finding.id, 'Its location is not on a changed HEAD file, so it cannot carry an inline comment; it remains in the summary index.');
      continue;
    }
    const { problems, comment } = draft(c, finding.id, finding.severity);
    if (problems.length) {
      if (!final) { issues.push(`comment for ${finding.id}: ${problems.join('; ')}.`); reported.add(finding.id); continue; }
      skip(finding.id, `No inline comment: ${problems.join('; ')}. The finding remains in the summary index.`);
      continue;
    }
    handled.add(finding.id);
    comments.push({ findingId: finding.id, ...comment });
  }
  const findingIds = new Set(publishableFindings(review).map(finding => finding.id));
  for (const [index, raw] of (Array.isArray(value.skipped) ? value.skipped : []).entries()) {
    const s = isObject(raw) ? aliases(raw, ['findingId', 'reason', 'cause', 'threadId']) : {};
    if (!eligible.has(s.findingId)) { corrections.push({ action: 'drop-unassigned-skip', index }); continue; }
    if (handled.has(s.findingId)) continue;
    const reason = nonempty(s.reason) ? s.reason.trim() : 'Skipped by the comment planner without a stated reason.';
    const cited = citedFindings(reason, s.findingId, findingIds);
    if (cited.length && !final) {
      issues.push(quick
        ? `skip for ${s.findingId} relies on ${cited.join(', ')}: another finding's comment does not cover it. Comment on ${s.findingId} at the lines of its own claim, combine it with findingIds only when a listed mergeCandidates group holds both and they state one defect, or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).`
        : `skip for ${s.findingId} relies on ${cited.join(', ')}: findings of this review are separate issues (the verifier already merged duplicates), so another finding's comment does not cover it. Comment on ${s.findingId} at the lines of its own claim, or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).`);
      reported.add(s.findingId);
      continue;
    }
    const problem = skipProblem(eligible.get(s.findingId), s, { sources, discussions, inlineEligible });
    if (problem && !final) {
      issues.push(`skip for ${s.findingId}: ${problem}. Comment on it, or skip it with the cause that applies.`);
      reported.add(s.findingId);
      continue;
    }
    if (cited.length) corrections.push({ action: 'keep-skip-citing-other-finding', findingId: s.findingId, cited });
    if (problem) corrections.push({ action: 'keep-skip-with-unconfirmed-cause', findingId: s.findingId, problem });
    const cause = String(s.cause ?? '').trim().toLowerCase();
    skip(s.findingId, cited.length ? `${reason} [Runtime: other findings of this review do not cover this one; it remains in the summary index.]`
      : problem ? `${reason} [Runtime: ${problem}; it remains in the summary index.]` : reason,
    SKIP_CAUSES.includes(cause) ? { cause, ...(cause === 'existing-thread' && s.threadId !== undefined ? { threadId: Number(s.threadId) } : {}) } : {});
  }
  // A refused combination accounts for every finding it named that has no comment or skip of its own.
  for (const { ids, reason } of refusedCombinations) for (const id of ids) if (eligible.has(id)) skip(id, reason);
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
  const note = nonempty(value.summary) ? value.summary : '';
  const summary = note && allowSummary && note.length <= SUMMARY_NOTE_LIMIT && !/<!--|-->/.test(note) ? note.trim() : undefined;
  if (note && !allowSummary) corrections.push({ action: 'drop-unallowed-summary' });
  else if (note && !summary) corrections.push({ action: 'drop-invalid-summary-note' });
  const summaryDetails = nonempty(value.summaryDetails) ? escapeComments(value.summaryDetails.trim()) : '';
  return { result: { status, comments, skipped, summary, summaryDetails, ...(continuation ? { continuation } : {}) }, issues, corrections };
}

export function planRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  const listed = issues.slice(0, 25).map(issue => `- ${issue}`).join('\n');
  return `AZPR runtime: this comment plan page needs correction before it can be saved.\n${listed}\n\nReturn the complete corrected JSON object for this page (status, comments, skipped, optional summary and summaryDetails). Keep valid comments unchanged.`;
}

function summaryComment(review, note, details, inlineMarkers, groups = []) {
  const chinese = /^zh(?:-|$)/i.test(review.outputLanguage ?? '');
  const traditional = chinese && new Intl.Locale(review.outputLanguage).maximize().script === 'Hant';
  const heading = chinese ? traditional ? '審查說明' : '审查说明' : 'Review notes';
  const notes = nonempty(note) ? `**${heading}**\n\n${note.trim()}` : '';
  // Only combinations the plan accepted share an index row.
  const index = renderReviewSummary(publishableFindings(review), review.outputLanguage ?? 'en', notes, { verification: reviewVerification(review), groups });
  // The summary's disclosure may add incomplete coverage of a quick review.
  const attribution = review.summaryAttribution ?? review.attribution;
  const disclosure = attribution ? `🤖 ${attribution}\n\n` : '';
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
  const groups = comments.filter(c => c.findingIds?.length > 1).map(c => c.findingIds);
  return { summary: summaryComment(review, intro, details, comments.map(c => c.marker), groups), comments, skipped };
}
