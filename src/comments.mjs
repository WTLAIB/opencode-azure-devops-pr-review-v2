// Tool-agnostic comment plans and explicitly MODEL-REPORTED publication receipts.
// No MCP name mapping, action/field adapter, or provider-response verification.
import { createHash } from 'node:crypto';
import { renderReviewSummary } from './attribution.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const integer = v => Number.isSafeInteger(v) && v > 0;
const fail = message => { throw new Error(`[AZPR comments] ${message}`); };
const exactKeys = (value, keys) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unsupported plan or report fields.');
};

function azurePath(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) fail('Use a canonical HTTPS Azure DevOps Services URL.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let organization;
  if (url.hostname === 'dev.azure.com') organization = parts.shift();
  else if (/^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname)) {
    organization = url.hostname.split('.')[0];
    if (parts[0] === 'DefaultCollection') parts.shift();
  } else fail('Only dev.azure.com and organization.visualstudio.com PR URLs are supported for publication.');
  if (!nonempty(organization) || parts[1] !== '_git' || !nonempty(parts[0]) || !nonempty(parts[2])) fail('Use a canonical project/repository URL.');
  return { organization, project: parts[0], repositoryId: parts[2], rest: parts.slice(3) };
}

export function commentTarget(request, snapshot) {
  const target = azurePath(request.trim().split(/\s+/)[0]);
  if (target.rest.length !== 2 || target.rest[0].toLowerCase() !== 'pullrequest' ||
      !/^[1-9][0-9]*$/.test(target.rest[1]) || Number(target.rest[1]) !== snapshot.prId) fail('Review URL and snapshot PR ID do not match.');
  const { rest, ...identity } = target;
  return { ...identity, pullRequestId: snapshot.prId };
}

export function targetKey(target) {
  return JSON.stringify([target.organization.toLowerCase(), target.project.toLowerCase(), target.repositoryId.toLowerCase(), target.pullRequestId]);
}

export function confirmedFindings(review) {
  // Initial candidates remain audit data. Never resurrect claims or severity
  // that the verifier corrected, even when an original ID was confirmed.
  const confirmed = review.final.dispositions.filter(d => d.status === 'CONFIRMED').map(d => {
    if (!object(d.verifiedFinding) || d.verifiedFinding.id !== d.id) fail('Confirmed disposition is missing its verified finding.');
    return d.verifiedFinding;
  });
  return [...confirmed, ...(review.final.newFindings ?? [])];
}

export function publicationItems(plan) {
  return [...(plan.summary ? [plan.summary] : []), ...plan.comments];
}

function summaryComment(review, note) {
  const tag = `<!-- azpr-comment:${createHash('sha256').update(JSON.stringify([targetKey(review.target), review.id, review.snapshot.head, 'summary'])).digest('hex').slice(0, 32)} -->`;
  // Optional prose cannot block an otherwise valid plan. Never copy the private
  // report wholesale, or ask the model to manufacture counts or publication IDs.
  const valid = nonempty(note) && note.length <= 1200 && !/<!--|-->/.test(note);
  const chinese = /^zh(?:-|$)/i.test(review.outputLanguage ?? '');
  const traditional = chinese && new Intl.Locale(review.outputLanguage).maximize().script === 'Hant';
  const heading = chinese ? traditional ? '審查說明' : '审查说明' : 'Review notes';
  const fallback = chinese
    ? traditional
      ? '未提供審查方式與測試執行情況，不能據此判定測試通過。'
      : '未提供审查方式与测试执行情况，不能据此判定测试通过。'
    : 'Review method and test execution details were not provided. No test outcome is established.';
  const index = renderReviewSummary(confirmedFindings(review), review.outputLanguage ?? 'en');
  const content = `${index}\n\n**${heading}**\n\n${valid ? note.trim() : fallback}\n\nReview: \`${review.id}\` · HEAD: \`${review.snapshot.head}\`${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${tag}`;
  return { kind: 'summary', marker: tag, content };
}

function marker(review, finding, comment) {
  const fingerprint = createHash('sha256').update(JSON.stringify([
    targetKey(review.target), review.snapshot.head, comment.path, comment.startLine, comment.endLine,
    finding.summary.trim().toLowerCase(), finding.evidence.trim(),
  ])).digest('hex').slice(0, 32);
  return `<!-- azpr-comment:${fingerprint} -->`;
}

function argumentStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(argumentStrings);
  return object(value) ? Object.values(value).flatMap(argumentStrings) : [];
}

// Resolve a quoted range in already observed text, without interpreting a tool
// schema. Argument-value matching is not a full-file/provenance certificate.
// Prefer an existing matching location; otherwise require one unique range.
function restoreAnchor(comment, review) {
  const trim = value => value.split(/\r?\n/).map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
  const forms = new Set([trim(comment.anchor), trim(comment.anchor.replace(/\\"/g, '"'))]);
  const declared = new Map(), candidates = new Map();
  const count = comment.endLine - comment.startLine + 1;
  for (const observation of review.toolText ?? []) {
    const values = argumentStrings(observation.input);
    if (!values.includes(comment.path) || !values.includes(review.snapshot.head) || typeof observation.output !== 'string') continue;
    const lines = observation.output.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    for (let start = 0; start + count <= lines.length; start++) {
      const anchor = lines.slice(start, start + count).join('\n');
      if (!forms.has(trim(anchor))) continue;
      const range = { anchor, startLine: start + 1, endLine: start + count };
      const key = JSON.stringify(range);
      candidates.set(key, range);
      if (range.startLine === comment.startLine) declared.set(key, range);
    }
  }
  const matches = declared.size ? declared : candidates;
  return matches.size === 1 ? [...matches.values()][0]
    : { anchor: comment.anchor, startLine: comment.startLine, endLine: comment.endLine };
}

export function validateCommentPlan(result, review) {
  exactKeys(result, ['status', 'comments', 'skipped', 'reason', 'summary']);
  // A diagnostic reason never makes a usable READY plan invalid. Keep the raw
  // value in the response; only nonempty text can explain an incomplete plan.
  if (result.status === 'INCOMPLETE') fail(`Comment planning incomplete: ${nonempty(result.reason) ? result.reason.trim() : 'The model did not explain what could not be verified.'} No comments were published; the completed review remains available.`);
  if (result.status !== 'READY' || !Array.isArray(result.comments) || !Array.isArray(result.skipped)) fail('Planner did not return a READY comment plan.');
  const eligible = new Map(confirmedFindings(review).map(f => [f.id, f]));
  const accounted = new Set();
  const knownExcluded = new Set(review.final.dispositions.filter(d => d.status !== 'CONFIRMED').map(d => d.id));
  const skippedIds = new Set(), anchorRestorations = [], locationRestorations = [];
  const markers = new Set();
  const comments = result.comments.map(c => {
    exactKeys(c, ['findingId', 'severity', 'path', 'startLine', 'endLine', 'anchor', 'body']);
    const finding = eligible.get(c.findingId);
    if (!finding || accounted.has(c.findingId)) fail('Only unique confirmed findings may be posted.');
    if (!['high', 'medium'].includes(finding.severity) || c.severity !== finding.severity) fail('Comment severity must match the verified high/medium finding; skip low-severity findings.');
    if ([...review.attempts.values()].some(a => a.findingId === c.findingId)) fail('This finding was already attempted; skip it instead of changing its wording or anchor.');
    accounted.add(c.findingId);
    if (!['high', 'medium'].includes(c.severity) || !nonempty(c.body) || c.body.length > 1200 ||
        !c.body.startsWith(`issue (${c.severity}): `) || /<!--|-->/.test(c.body)) fail('Invalid severity, title, or comment length.');
    if (!review.snapshot.files.includes(c.path) || !c.path.startsWith('/') || /[\r\n\0]/.test(c.path) ||
        !integer(c.startLine) || !integer(c.endLine) || c.endLine < c.startLine) fail('Use a changed HEAD file and a positive, ordered line range.');
    if (!nonempty(c.anchor) || c.anchor.split(/\r?\n/).length !== c.endLine - c.startLine + 1) fail('Supply exact anchor text for the selected range. The model must verify it against source.');
    const restored = restoreAnchor(c, review), { anchor } = restored;
    if (anchor !== c.anchor || restored.startLine !== c.startLine) anchorRestorations.push(c.findingId);
    if (restored.startLine !== c.startLine) locationRestorations.push({ findingId: c.findingId,
      original: { startLine: c.startLine, endLine: c.endLine }, restored: { startLine: restored.startLine, endLine: restored.endLine } });
    const tag = marker(review, finding, { ...c, ...restored });
    if (markers.has(tag)) fail('Duplicate finding in this plan; select one representative.');
    markers.add(tag);
    // Azure SDK positions are line-local, one-based UTF-16 character offsets.
    // Derive whole-line endpoints from the existing anchor, never file offsets
    // or another model-authored field. An empty final line uses its first column.
    const startOffset = 1, endOffset = Math.max(1, anchor.split(/\r?\n/).at(-1).length);
    return { ...c, ...restored, startOffset, endOffset, marker: tag, content: `${c.body.trim()}${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${tag}` };
  });
  for (const s of result.skipped) {
    exactKeys(s, ['findingId', 'reason']);
    if ((!eligible.has(s.findingId) && !knownExcluded.has(s.findingId)) || accounted.has(s.findingId) || skippedIds.has(s.findingId) || !nonempty(s.reason)) fail('Every skipped finding needs a known, unique ID and reason.');
    skippedIds.add(s.findingId);
    if (eligible.has(s.findingId)) accounted.add(s.findingId);
  }
  if (accounted.size !== eligible.size) fail('Planner omitted confirmed findings instead of explaining exclusions.');
  return { summary: summaryComment(review, result.summary), comments, skipped: result.skipped, ...(anchorRestorations.length ? { anchorRestorations } : {}),
    ...(locationRestorations.length ? { locationRestorations } : {}) };
}

/** Restore a whole marked comment from the saved plan, independent of tool schema.
 * Targets, coordinates, marker searches and unrecognized strings are untouched.
 * A marker identifies saved text; it does not prove where a tool will publish it.
 */
export function restoreSavedCommentText(input, comments) {
  const restored = [];
  function visit(value) {
    if (typeof value === 'string') {
      const tags = value.match(/<!-- azpr-comment:[a-f0-9]{32} -->/g) ?? [];
      if (tags.length !== 1 || !value.endsWith(tags[0])) return value;
      const saved = comments.find(comment => comment.marker === tags[0]);
      if (!saved || !value.startsWith(saved.kind === 'summary' ? '## PR Review Summary' : `issue (${saved.severity}): `) || value === saved.content) return value;
      restored.push(saved.kind === 'summary' ? 'PR summary' : saved.findingId);
      return saved.content;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  }
  return { input: visit(input), restored };
}

/** Validate only the model's report shape, NEVER claim provider verification. */
export function recordPublishResult(result, review) {
  exactKeys(result, ['status', 'posted', 'summaryThreadId']);
  if (!['DONE', 'INCOMPLETE'].includes(result.status) || !Array.isArray(result.posted)) fail('Publisher must return status and posted entries. Inspect Azure; do not retry automatically.');
  const planned = new Map(review.plan.comments.map(c => [c.findingId, c]));
  const validThread = id => integer(id) || (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(id));
  const hasSummary = result.summaryThreadId !== undefined;
  if (hasSummary && (!review.plan.summary || !validThread(result.summaryThreadId))) fail('Invalid model-reported summary publication.');
  const seen = new Set();
  const threads = new Set(hasSummary ? [String(result.summaryThreadId)] : []);
  for (const item of result.posted) {
    exactKeys(item, ['findingId', 'threadId']);
    if (!planned.has(item.findingId) || seen.has(item.findingId) ||
        !validThread(item.threadId) || threads.has(String(item.threadId))) fail('Invalid model-reported publication entry.');
    seen.add(item.findingId);
    threads.add(String(item.threadId));
  }
  // Validate the complete envelope before changing any attempt state.
  if (hasSummary) review.attempts.set(review.plan.summary.marker, { kind: 'summary', state: 'MODEL_REPORTED_POSTED', threadId: result.summaryThreadId });
  for (const item of result.posted) {
    const comment = planned.get(item.findingId);
    review.attempts.set(comment.marker, { findingId: item.findingId, state: 'MODEL_REPORTED_POSTED', threadId: item.threadId });
  }
  return result.status === 'DONE' && seen.size === planned.size && (!review.plan.summary || hasSummary);
}
