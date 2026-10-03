// Tool-agnostic comment plans and explicitly MODEL-REPORTED publication receipts.
// No MCP name mapping, argument adapter, or provider-response verification.
import { createHash } from 'node:crypto';

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

function marker(review, finding, comment) {
  const fingerprint = createHash('sha256').update(JSON.stringify([
    targetKey(review.target), review.snapshot.head, comment.path, comment.startLine, comment.endLine,
    finding.summary.trim().toLowerCase(), finding.evidence.trim(),
  ])).digest('hex').slice(0, 32);
  return `<!-- azpr-comment:${fingerprint} -->`;
}

export function validateCommentPlan(result, review, maxComments) {
  exactKeys(result, ['status', 'comments', 'skipped']);
  if (result.status !== 'READY' || !Array.isArray(result.comments) || !Array.isArray(result.skipped)) fail('Planner did not return a READY comment plan.');
  if (result.comments.length > maxComments) fail('Comment limit exceeded.');
  const eligible = new Map(confirmedFindings(review).map(f => [f.id, f]));
  const accounted = new Set();
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
        !integer(c.startLine) || !integer(c.endLine) || c.endLine < c.startLine || c.endLine - c.startLine > 4) fail('Use a changed HEAD file and a 1-5 line range.');
    if (!nonempty(c.anchor) || c.anchor.split(/\r?\n/).length !== c.endLine - c.startLine + 1) fail('Supply exact anchor text for the selected range. The model must verify it against source.');
    const tag = marker(review, finding, c);
    if (markers.has(tag)) fail('Duplicate finding in this plan; select one representative.');
    markers.add(tag);
    return { ...c, marker: tag, content: `${c.body.trim()}${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${tag}` };
  });
  for (const s of result.skipped) {
    exactKeys(s, ['findingId', 'reason']);
    if (!eligible.has(s.findingId) || accounted.has(s.findingId) || !nonempty(s.reason)) fail('Every skipped confirmed finding needs a unique ID and reason.');
    accounted.add(s.findingId);
  }
  if (accounted.size !== eligible.size) fail('Planner omitted confirmed findings instead of explaining exclusions.');
  return { comments, skipped: result.skipped };
}

/** Validate only the model's report shape, NEVER claim provider verification. */
export function recordPublishResult(result, review) {
  exactKeys(result, ['status', 'posted']);
  if (!['DONE', 'INCOMPLETE'].includes(result.status) || !Array.isArray(result.posted)) fail('Publisher must return status and posted entries. Inspect Azure; do not retry automatically.');
  const planned = new Map(review.plan.comments.map(c => [c.findingId, c]));
  const seen = new Set();
  for (const item of result.posted) {
    exactKeys(item, ['findingId', 'threadId']);
    if (!planned.has(item.findingId) || seen.has(item.findingId) ||
        !(integer(item.threadId) || (typeof item.threadId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(item.threadId)))) fail('Invalid model-reported publication entry.');
    seen.add(item.findingId);
  }
  // Validate the complete envelope before changing any attempt state.
  for (const item of result.posted) {
    const comment = planned.get(item.findingId);
    review.attempts.set(comment.marker, { findingId: item.findingId, state: 'MODEL_REPORTED_POSTED', threadId: item.threadId });
  }
  return result.status === 'DONE' && seen.size === planned.size;
}
