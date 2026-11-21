// Comment plans: per-item validation, stable markers and saved publication text.
import { createHash } from 'node:crypto';
import { renderReviewSummary, renderOtherPlaces, listablePlace, OTHER_PLACES_HEADINGS, describeReview } from './attribution.mjs';
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

/** A finding's place as a comment lists it: "/src/a.ts:12-14". */
export function placeOf(finding) {
  const at = parseLocation(finding.location);
  if (!at) return String(finding.location ?? '');
  return `${at.path}${at.start ? `:${at.start}${at.end !== at.start ? `-${at.end}` : ''}` : ''}`;
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
 * Why findings may not share one comment as one defect made at several places;
 * [] when they may. Members are high or medium findings of one severity, each
 * on lines of a HEAD file (a first line and a last one not before it), and no
 * two of them share a line: findings on the same lines are not another place.
 * The comment lists each other place as its finding states it, so a place
 * whose text a list cannot hold unchanged (`listablePlace`) shares no comment.
 * Whether the lines exist in the file is checked where its text is known
 * (`evaluatePlanPage`).
 */
export function repeatProblems(members) {
  const problems = [];
  if (new Set(members.map(member => member.severity)).size !== 1) problems.push('combined findings must have the same severity');
  else if (!['high', 'medium'].includes(members[0].severity)) problems.push('only high and medium findings get inline comments');
  if (members.some(member => member.inline === false)) problems.push('a combined finding has no inline location');
  const at = members.map(member => parseLocation(member.location));
  if (at.some(location => location?.side !== 'head' || !location.start || location.end < location.start)) {
    problems.push('every combined finding must be located on lines of a HEAD file');
    return { problems };
  }
  const unlistable = members.filter(member => !listablePlace(placeOf(member)));
  if (unlistable.length) problems.push(`the file name of ${unlistable.map(member => member.id).join(', ')} cannot be written into a list of places as it is`);
  for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) {
    if (at[i].path === at[j].path && at[i].start <= at[j].end && at[j].start <= at[i].end) {
      problems.push(`${members[i].id} and ${members[j].id} are on the same lines, which is not another place`);
    }
  }
  return { problems };
}

// A finding ID as a text names it (F-1, Q-1001, V-2).
const FINDING_ID = /(?<![A-Za-z0-9_-])[A-Za-z]+-\d+(?!\d)/g;

/**
 * Other findings of this review that a skip reason names. The verifier already
 * merged duplicates, so another finding's comment never covers a finding.
 */
function citedFindings(reason, own, findingIds) {
  const named = String(reason).match(FINDING_ID) ?? [];
  return [...new Set(named)].filter(id => id !== own && findingIds.has(id));
}

/**
 * A person's adjustments of a review's findings after a preview, as saved in
 * `review.adjustments`: findings `excluded` from publication and a changed
 * `severity` per finding ID. A review saved without them has none.
 */
function adjustmentsOf(review) {
  const saved = review?.adjustments;
  const excluded = Array.isArray(saved?.excluded) ? saved.excluded : [];
  const severity = isObject(saved?.severity) ? saved.severity : {};
  return { excluded, severity, active: excluded.length > 0 || Object.keys(severity).length > 0 };
}

export const hasAdjustments = review => adjustmentsOf(review).active;

/**
 * Whether a person ever adjusted the review's findings, also when --reset
 * cleared them since: such a review is posted only from a preview planned
 * after its latest adjustment, exactly as that preview reads.
 */
export const everAdjusted = review => isObject(review?.adjustments);

/**
 * The findings comments are planned for: publishableFindings as a person
 * adjusted them after a preview, without the excluded ones and with the
 * changed severities. Without adjustments, exactly publishableFindings(review).
 */
export function commentFindings(review) {
  const findings = publishableFindings(review);
  const { excluded, severity, active } = adjustmentsOf(review);
  if (!active) return findings;
  const left = new Set(excluded);
  return findings.filter(finding => !left.has(finding.id))
    .map(finding => Object.hasOwn(severity, finding.id) ? { ...finding, severity: severity[finding.id] } : finding);
}

/** Whether a person excluded every finding the review could publish, so there is nothing to post. */
export function everyFindingExcluded(review) {
  return adjustmentsOf(review).excluded.length > 0 && publishableFindings(review).length > 0 && commentFindings(review).length === 0;
}

const ADJUSTMENT_RULE = 'A person read the comment preview and adjusted these findings. An excluded finding is not published: never name, describe or allude to it in a comment, the summary note or summaryDetails, also where the report or dispositions discuss it. A changed severity is final and `findings` already carries it: write and title each comment for that severity.';

/** What the comment planner is told about a person's adjustments; undefined without them, so its input stays unchanged. */
export function adjustmentInput(review) {
  const { excluded, severity, active } = adjustmentsOf(review);
  if (!active) return undefined;
  const original = new Map(publishableFindings(review).map(finding => [finding.id, finding.severity]));
  const changes = Object.entries(severity).map(([id, to]) => ({ id, from: original.get(id), to }));
  return { ...(excluded.length ? { excludedFindings: excluded } : {}), ...(changes.length ? { severityChanges: changes } : {}), rule: ADJUSTMENT_RULE };
}

/** How a preview states a person's adjustments; '' without them. Nothing of this reaches the PR. */
export function describeAdjustments(review) {
  const { excluded, severity, active } = adjustmentsOf(review);
  if (!active) return '';
  const original = new Map(publishableFindings(review).map(finding => [finding.id, finding.severity]));
  const rows = [...(excluded.length ? [`- Excluded from publication: ${excluded.join(', ')}`] : []),
    ...Object.entries(severity).map(([id, to]) => `- ${id}: severity ${original.get(id)} → ${to}`)];
  return `Adjusted by a person after the preview (not stated on the PR):\n${rows.join('\n')}`;
}

/**
 * After a preview: the commands a person is likely to want next, written
 * without the review ID and with this review's own finding IDs. Each
 * adjustment list replaces the saved one, so an example keeps what is saved
 * and adds to it. `held` leaves out publication (the preview says why).
 */
export function previewNextSteps(review, { held = false } = {}) {
  const { excluded, severity, active } = adjustmentsOf(review);
  const remaining = commentFindings(review);
  const rows = [];
  if (!held && !everyFindingExcluded(review)) rows.push(['/pr-comment --publish', 'post this preview as the PAT owner (safe to repeat)']);
  if (remaining.length) {
    const more = remaining.slice(0, excluded.length ? 1 : 2).map(finding => finding.id);
    rows.push([`/pr-comment --exclude ${[...excluded, ...more].join(',')}`, `leave ${more.join(' and ')} out${excluded.length ? ' as well' : ''}, then read the new preview`]);
    const target = remaining.find(finding => !Object.hasOwn(severity, finding.id)) ?? remaining[0];
    const level = target.severity === 'low' ? 'medium' : 'low';
    const kept = Object.entries(severity).filter(([id]) => id !== target.id).map(([id, to]) => `${id}=${to}`);
    rows.push([`/pr-comment --severity ${[...kept, `${target.id}=${level}`].join(',')}`, `publish ${target.id} as ${level}, then read the new preview`]);
  }
  if (active) rows.push(['/pr-comment --reset', 'undo your adjustments, then read the new preview']);
  rows.push(['/pr-comment --show', 'show this preview again (no model)']);
  const width = Math.max(...rows.map(([command]) => command.length));
  return `Next (no review ID is needed while ${review.id} is this conversation's current review):\n${rows.map(([command, effect]) => `  ${command.padEnd(width)}  ${effect}`).join('\n')}\n` +
    `Each --exclude or --severity list replaces the saved one. For another review add its ID; /pr-comment --list shows them.`;
}

// What the terminal panel can list of one review; a review with more findings is adjusted with typed commands.
const ACTION_FINDINGS = 200;

/**
 * What a review's comments are at this moment, as one short word: its saved preview (by the moment it was
 * planned; none while there is no preview) and a person's adjustments. A step that the terminal panel offers
 * carries the word of that moment, and so does the command the panel sends for it (`--seen`): the runtime
 * refuses the command when the word is another one by then. A notice shows what its own conversation was told,
 * and a command typed in another session of the review, or in another client, changes the review without
 * telling it: what is acted on must still be what was on screen. The word survives a restart, since the
 * review's record holds what it is made of.
 */
export function commentToken(review) {
  const { excluded, severity } = adjustmentsOf(review);
  const levels = Object.keys(severity).sort().map(id => [id, severity[id]]);
  return createHash('sha256').update(JSON.stringify([review.id, review.plan ? String(review.planCreatedAt ?? '') : null, [...excluded].sort(), levels])).digest('hex').slice(0, 12);
}

/**
 * After a preview, or after a review that no preview follows by itself: the next steps as data, for the
 * terminal panel, which offers them as rows a person picks instead of typing. It travels in the metadata of
 * that notice, which no model reads.
 * `plan` says that the review has no preview yet: planning one comes first, so nothing can be posted.
 * `publish` says whether the preview can be posted as it is (`held` leaves that out, as the text does),
 * `posts` how many comment items it holds, `target` which review and PR it is, in the runtime's words, and
 * `adjust` whether its findings can still be adjusted (not once its publication has started).
 * `findings` are the findings this review can publish: each with the level it is published at, the level the
 * review gave it where a person changed that (`original`), whether a person left it out (`excluded`), and its
 * summary, which is the review's text and is only ever shown. `state` is the word for the review's comments as
 * they are now (`commentToken`), which a command picked from this offer hands back. Undefined for a review
 * with more findings than the panel lists: half a list would let a person replace adjustments they cannot see.
 */
export function previewActions(review, { held = false } = {}) {
  const findings = publishableFindings(review);
  if (findings.length > ACTION_FINDINGS) return undefined;
  const { excluded, severity } = adjustmentsOf(review);
  const left = new Set(excluded);
  return {
    review: review.id,
    state: commentToken(review),
    target: describeReview(review),
    plan: !review.plan,
    publish: Boolean(review.plan) && !held && !everyFindingExcluded(review),
    posts: publicationItems(review.plan).length,
    adjust: !publicationStarted(review),
    findings: findings.map(finding => ({
      id: finding.id,
      severity: Object.hasOwn(severity, finding.id) ? severity[finding.id] : finding.severity,
      ...(Object.hasOwn(severity, finding.id) ? { original: finding.severity } : {}),
      ...(left.has(finding.id) ? { excluded: true } : {}),
      summary: String(finding.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    })),
  };
}

/**
 * Apply a /pr-comment adjustment request to a review. `exclude` and `severity`
 * each replace their whole list when given (empty: none); `reset` clears both.
 * Every ID must name a finding this review can publish (a merged duplicate
 * points to the finding it was merged into). The list a request names wins
 * over the kept other one: excluding a finding drops its severity change, and
 * a severity for an excluded finding restores it; naming one finding in both
 * lists is refused. A severity equal to the review's is no change. Throws,
 * changing nothing, on any problem. Returns the adjustments to save
 * (`next`), what changes (`changes`, readable rows) and `unchanged`.
 */
export function resolveAdjustments(review, { exclude, severity, reset = false }) {
  const findings = publishableFindings(review);
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const problems = [];
  const check = id => {
    if (byId.has(id)) return;
    const row = (review.final?.dispositions ?? []).find(item => item.id === id);
    problems.push(row?.status === 'MERGED' && row.mergedInto ? `${id} was merged into ${row.mergedInto}; adjust ${row.mergedInto} instead`
      : row ? `${id} is ${row.status}, not a finding this review can publish` : `${id} is not a finding of review ${review.id}`);
  };
  for (const id of [...(exclude ?? []), ...Object.keys(severity ?? {})]) check(id);
  for (const id of exclude ?? []) if (severity && Object.hasOwn(severity, id)) problems.push(`${id} cannot be excluded and given a severity at once`);
  if (problems.length) throw new Error(`[AZPR] Nothing was changed: ${[...new Set(problems)].join('; ')}. Findings of review ${review.id} you can adjust: ${[...byId.keys()].join(', ') || 'none'}.`);
  const current = adjustmentsOf(review);
  let excluded = reset ? [] : exclude ?? current.excluded;
  const changed = reset ? {} : { ...(severity ?? current.severity) };
  if (exclude && !severity) for (const id of exclude) delete changed[id];
  if (severity && !exclude) excluded = excluded.filter(id => !Object.hasOwn(severity, id));
  for (const [id, level] of Object.entries(changed)) if (byId.get(id)?.severity === level) delete changed[id];
  const order = id => findings.findIndex(finding => finding.id === id);
  const next = { excluded: [...new Set(excluded)].sort((a, b) => order(a) - order(b)),
    severity: Object.fromEntries(Object.entries(changed).sort(([a], [b]) => order(a) - order(b))) };
  const before = new Set(current.excluded), after = new Set(next.excluded);
  const level = (adjustments, id) => adjustments.severity[id] ?? byId.get(id)?.severity;
  const changes = [
    ...next.excluded.filter(id => !before.has(id)).map(id => `excluded ${id}`),
    ...current.excluded.filter(id => !after.has(id)).map(id => `restored ${id}`),
    ...[...new Set([...Object.keys(current.severity), ...Object.keys(next.severity)])].sort((a, b) => order(a) - order(b))
      .filter(id => !after.has(id) && level(current, id) !== level(next, id)).map(id => `${id} severity ${level(current, id)} → ${level(next, id)}`),
  ];
  return { next, changes, unchanged: changes.length === 0 };
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
 * Whether publication of the review's saved plan began: an item was sent, may
 * have landed or was found on the PR. Items that only failed with a definite
 * error, so that nothing was created, leave the plan open to adjustments.
 */
export function publicationStarted(review) {
  const ledger = review?.publication instanceof Map ? [...review.publication.values()] : [];
  return ledger.some(entry => entry?.state !== 'FAILED');
}

/**
 * For a review a person adjusted: what the PR keeps from earlier publications
 * after this one, since AZPR never changes a posted comment. Names the items
 * of the preview the PR already had with other text (`earlierText` in the
 * ledger), marks those the adjustments concern, and counts the other AZPR
 * comments on the PR where an excluded finding may still show. '' when none.
 */
export function describeEarlierText(review, otherComments = 0) {
  const { excluded, severity, active } = adjustmentsOf(review);
  const kept = review?.publication instanceof Map ? [...review.publication.values()].filter(entry => entry?.earlierText) : [];
  const rows = kept.map(entry => {
    if (entry.kind === 'summary') return `the PR summary${active ? ' (it may still list findings you excluded or show earlier severities)' : ''}`;
    const ids = entry.findingIds ?? [entry.findingId];
    return `${ids.join(', ')} at ${entry.path}:${entry.startLine}${ids.some(id => Object.hasOwn(severity, id)) ? ' (you changed its severity)' : ''}`;
  });
  const lines = [];
  if (rows.length) lines.push(`Already on the PR with earlier text, which AZPR does not change, so this preview is not what the PR shows there: ${rows.join('; ')}. Edit them on the PR if they should change.`);
  if (excluded.length && otherComments > 0) lines.push(`The PR has ${otherComments} other AZPR comment(s) from earlier publications that are not part of this preview; AZPR does not change them, so a finding you excluded may still be visible there.`);
  return lines.map(line => `${line}\n`).join('');
}

/**
 * Where the text a saved preview would post still names a finding a person
 * excluded. The planner's own text is checked page by page; this checks the
 * items as they would be posted, including the summary rows the runtime
 * renders from the review's own finding summaries, which no planner turn can
 * change. Only IDs written as the runtime writes them are found. Returns
 * readable rows; [] when nothing names an excluded finding.
 */
export function excludedReferences(review) {
  const excluded = new Set(adjustmentsOf(review).excluded);
  if (!excluded.size || !review?.plan) return [];
  const rows = [];
  for (const item of publicationItems(review.plan)) {
    const names = namedExcluded(item.content, excluded);
    if (!names.length) continue;
    if (item.kind === 'summary') {
      const sources = commentFindings(review).filter(finding => namedExcluded(finding.summary, excluded).length).map(finding => finding.id);
      rows.push(`the PR summary names ${names.join(', ')}${sources.length ? ` (in the summary row of ${sources.join(', ')})` : ''}`);
    } else rows.push(`the comment of ${(item.findingIds ?? [item.findingId]).join(', ')} at ${item.path}:${item.startLine} names ${names.join(', ')}`);
  }
  return rows;
}

/** Findings a person excluded that a text names, read as `citedFindings` reads IDs. */
function namedExcluded(text, excluded) {
  if (!excluded.size || !text) return [];
  return [...new Set(String(text).match(FINDING_ID) ?? [])].filter(id => excluded.has(id));
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
// only as written, since a decoded character never forms markup. A browser
// drops tabs and line breaks from a URL, so the script-link check also reads
// the text without them. Literal code renders as text, so only the mention
// check reads it (see withoutCode): Azure DevOps may resolve a mention wherever
// it is written.
const ACTIVE_ATTRIBUTES = 'on[a-z]+|src|srcset|style|background|poster|xlink:href';
const ACTIVE_ATTRIBUTE = new RegExp(`^(?:${ACTIVE_ATTRIBUTES})$`);
const UNSEEN_TEXT = [
  ['a script, data or local-file link', [/\b(?:javascript|vbscript):/i, /\bdata:[a-z]+\//i, /\bfile:\/\//i], { decoded: true, url: true }],
  ['an @mention', [/@</], { decoded: true, code: true }],
  ['an image', [/!\[/], {}],
  ['HTML that embeds content or runs a script', [/<\/?(?:img|image|iframe|frame|frameset|object|embed|applet|video|audio|source|track|picture|svg|script|style|link|meta|base|portal)(?=[\s/>]|$)/im,
    new RegExp(`<[a-z][a-z0-9-]*\\s[^<>]*?\\b(?:${ACTIVE_ATTRIBUTES})\\s*=`, 'i'), { test: hasActiveAttribute }], {}],
  // A comment, declaration, processing instruction or malformed end tag, which a browser does not show.
  ['HTML that hides text', [/<[!?]|<\/(?![a-z])/i], {}],
];
const OWN_MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
// The named character references for ASCII punctuation, tab and line feed: besides
// letters and digits, the only characters the script-link and mention checks read.
const NAMED_REFERENCES = Object.freeze({
  excl: '!', quot: '"', QUOT: '"', num: '#', dollar: '$', percnt: '%', amp: '&', AMP: '&', apos: "'", lpar: '(', rpar: ')',
  ast: '*', midast: '*', plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', lt: '<', LT: '<', equals: '=',
  gt: '>', GT: '>', quest: '?', commat: '@', lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', Hat: '^',
  lowbar: '_', UnderBar: '_', grave: '`', DiacriticalGrave: '`', lcub: '{', lbrace: '{', verbar: '|', vert: '|',
  VerticalLine: '|', rcub: '}', rbrace: '}', Tab: '\t', NewLine: '\n',
});
/**
 * What CommonMark makes of escapes and character references in link
 * destinations and text, and a browser of character references in raw HTML:
 * `java&#115;cript:` and `javascript\:` are script links, `@&lt;…&gt;` a
 * mention. Decoding errs towards finding more (a reference after a backslash
 * is decoded too); a numeric reference counts with any number of digits and
 * without a semicolon, as a browser reads it, and `&lt`, `&gt`, `&amp` and
 * `&quot` count without a semicolon.
 */
function decodedText(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?/g, (_, decimal, hex) => {
      const code = decimal === undefined ? parseInt(hex, 16) : Number(decimal);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/&([A-Za-z][A-Za-z0-9]*);|&(lt|gt|amp|quot|LT|GT|AMP|QUOT)(?![A-Za-z0-9;])/g, (whole, name, legacy) => Object.hasOwn(NAMED_REFERENCES, name ?? legacy) ? NAMED_REFERENCES[name ?? legacy] : whole);
}

/**
 * Whether a start tag has an attribute that loads content or runs a script,
 * read the way a browser reads an HTML block: a tag name runs to a space, a
 * slash or >, slashes separate attributes, and only a value that opens with a
 * quote is quoted, so it may hold < and >. A tag ends at the first > outside
 * such a value. Every < counts as a possible start, since a renderer may show
 * an earlier one as text; a reading that reaches a point between attributes
 * where an earlier one was continues as that one did, so it stops there. The
 * end of every name and value is looked up in tables built once, so the work
 * stays linear in the length of the text, however many < it holds.
 */
function hasActiveAttribute(text) {
  if (!/<[a-z]/i.test(text)) return false;
  const length = text.length, space = char => /[\t\n\f\r ]/.test(char);
  // For each offset, the first offset at or after it whose character passes the test.
  const next = test => {
    const found = new Int32Array(length + 1).fill(length);
    for (let k = length - 1; k >= 0; k--) found[k] = test(text[k]) ? k : found[k + 1];
    return found;
  };
  const tagEnd = next(char => space(char) || char === '/' || char === '>'), solid = next(char => !space(char));
  const nameEnd = next(char => space(char) || char === '/' || char === '>' || char === '=');
  const valueEnd = next(char => space(char) || char === '>');
  const quoteEnd = { '"': next(char => char === '"'), "'": next(char => char === "'") };
  // An event handler name of any length is "on" and letters; other names are short enough to compare.
  const letters = new Int32Array(length + 1);
  for (let k = length - 1; k >= 0; k--) letters[k] = /[a-z]/i.test(text[k]) ? letters[k + 1] + 1 : 0;
  const active = (from, to) => to - from <= 32 ? ACTIVE_ATTRIBUTE.test(text.slice(from, to).toLowerCase())
    : /^on/i.test(text.slice(from, from + 2)) && letters[from] >= to - from;
  const read = new Uint8Array(length + 1);
  for (let start = text.indexOf('<'); start !== -1; start = text.indexOf('<', start + 1)) {
    if (!/[a-z]/i.test(text[start + 1] ?? '')) continue;
    for (let i = tagEnd[start + 1]; i < length && text[i] !== '>' && !read[i];) {
      read[i] = 1;
      if (space(text[i]) || text[i] === '/') { i++; continue; }
      // A name may open with =; a value follows an = after the name and any spaces.
      const end = nameEnd[i + 1], equals = solid[end];
      if (active(i, end)) return true;
      if (text[equals] !== '=') { i = end; continue; }
      const value = solid[equals + 1], open = text[value];
      i = open === '"' || open === "'" ? Math.min(length, quoteEnd[open][value + 1] + 1) : open === '>' ? value : valueEnd[value];
    }
  }
  return false;
}

/**
 * The text with its literal code blanked: the content lines of fenced code
 * blocks and the code spans, which render as text. Recognition errs towards
 * checking, since a wrong guess would hide markup that renders. A fence counts
 * only in column 0 and outside a table; from the first line that may start an
 * HTML block, or a fence that is indented or inside a quote or list, nothing
 * more is blanked, nor in the paragraph that line may continue. Code spans
 * follow codeSpans, paragraph by paragraph.
 */
function withoutCode(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), shown = [...lines];
  let closer = null, table = false, paragraph = [];
  const blankSpans = () => {
    if (!paragraph.length) return;
    const joined = paragraph.map(n => lines[n]).join('\n');
    let blanked = '', at = 0;
    for (const [start, end] of codeSpans(joined) ?? []) { blanked += `${joined.slice(at, start)} `; at = end; }
    `${blanked}${joined.slice(at)}`.split('\n').forEach((line, index) => { shown[paragraph[index]] = line; });
    paragraph = [];
  };
  for (const [n, line] of lines.entries()) {
    if (closer) {
      if (closer.test(line)) closer = null;
      else shown[n] = '';
      continue;
    }
    const open = /^(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(line);
    if (open && !table && !line.includes('|')) {
      blankSpans();
      closer = new RegExp(`^ {0,3}${open[1] ? '`' : '~'}{${(open[1] ?? open[2]).length},}[ \\t]*$`);
    } else if (open || /^[\s>*+\-.)\d]*</.test(line) || /^[\s>*+\-.)\d]+(?:`{3}|~{3})/.test(line)) {
      // The paragraph may go on in this line, whose backticks could pair with its own.
      paragraph = [];
      break;
    } else if (/^[ \t]*$/.test(line)) {
      blankSpans();
      table = false;
    } else {
      table ||= line.includes('|');
      paragraph.push(n);
    }
  }
  blankSpans();
  return shown.join('\n');
}

/**
 * The [start, end) offsets of one paragraph's code spans, or null when their
 * pairing is uncertain: a backtick run without a partner on its line (it may
 * pair across lines), a span with a pipe (a table splits its cells first), or a
 * backtick after something that can swallow one: a link destination or label,
 * an HTML tag with quotes or without an end, a comment, math, or a bare
 * address that a renderer may turn into a link, backslash included.
 */
function codeSpans(paragraph) {
  const spans = [], last = paragraph.lastIndexOf('`'), closers = new Map(), found = {};
  // Running tallies, so that each look back or ahead below takes constant time.
  const address = [false], quotes = [0], nesting = [0], pipes = [0];
  for (let i = 0; i < paragraph.length; i++) {
    const char = paragraph[i];
    address.push(!/[\s<]/.test(char) && (address[i] || /[:.@]/.test(char)));
    quotes.push(quotes[i] + /[`"']/.test(char));
    nesting.push(nesting[i] + /[`"'(<\\]/.test(char));
    pipes.push(pipes[i] + (char === '|'));
  }
  const ahead = (char, from) => {
    if (!(found[char] >= from)) found[char] = paragraph.indexOf(char, from) === -1 ? Infinity : paragraph.indexOf(char, from);
    return found[char];
  };
  for (let i = 0; i < paragraph.length; i++) {
    const char = paragraph[i], next = paragraph[i + 1] ?? '', later = i < last;
    // A renderer that links a bare address may take the backslash along, so it escapes nothing there.
    if (char === '\\' && /[!-/:-@[-`{-~]/.test(next) && !address[i]) i++;
    else if (char === '`') {
      let run = 1;
      while (paragraph[i + run] === '`') run++;
      if (!closers.has(run)) closers.set(run, new RegExp(`(?<!\`)\`{${run}}(?!\`)`, 'g'));
      const closer = closers.get(run);
      closer.lastIndex = i + run;
      const close = closer.exec(paragraph);
      if (!close || close.index > ahead('\n', i) || pipes[close.index] > pipes[i + run] || address[i]) return null;
      spans.push([i, close.index + run]);
      i = close.index + run - 1;
    } else if (!later) break;
    else if (char === '<' && /\S/.test(next)) {
      const end = ahead('>', i);
      if (end === Infinity || /[!?]/.test(next) || quotes[end] > quotes[i]) return null;
    } else if (char === ']' && /[([]/.test(next)) {
      // A link that ends at the first closing bracket without quotes, escapes or nesting swallows no backtick.
      const end = ahead(next === '(' ? ')' : ']', i + 2);
      if (end === Infinity || nesting[end] > nesting[i + 2]) return null;
    } else if (char === '$') return null;
  }
  return spans;
}

/** The saved items whose text automatic publication leaves to a person: { marker, reason } each. */
export function automaticPublicationProblems(plan) {
  return publicationItems(plan).flatMap(item => {
    const text = item.content.replace(OWN_MARKER, ''), shown = withoutCode(text);
    const forms = { all: [text, decodedText(text)], shown: [shown, decodedText(shown)] };
    const kinds = UNSEEN_TEXT.filter(([, patterns, { decoded, code, url }]) => {
      const [plain, decodedForm] = code ? forms.all : forms.shown;
      const read = (decoded ? [plain, decodedForm] : [plain]).flatMap(form => url ? [form, form.replace(/[\t\n\r]/g, '')] : [form]);
      return patterns.some(pattern => read.some(form => pattern.test(form)));
    }).map(([kind]) => kind);
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

/**
 * The fingerprint of a comment that stands for one defect at several places:
 * PR + path + normalized anchor + the other places it lists. Such a comment
 * is a comment of its own: publication skips it only when this marker is on
 * the PR, so the comment found there is this very comment, with every place,
 * and nothing has to be read out of a posted text to know what it covers.
 * The ordinal tells apart two comments with the same quoted lines and the
 * same other places, which two defects at the same places would have.
 */
export function sharedMarker(target, comment, ordinal = 0) {
  return markerTag(hash([targetKey(target), 'shared', comment.path, normalizedAnchor(comment.anchor), comment.otherPlaces.map(other => other.place).sort(), ordinal]));
}

/**
 * The second marker of a comment for several places: PR + path + normalized
 * anchor, nothing else. It says that such a comment stands on these quoted
 * lines, whatever it lists and whichever plan wrote it. Only planning reads
 * it, to keep another comment off those lines (`occupiedLines`); publication,
 * its ledger and its attempt records know a comment by its own marker alone.
 */
export function linesMarker(target, comment) {
  return markerTag(hash([targetKey(target), 'lines', comment.path, normalizedAnchor(comment.anchor)]));
}

/** How many comments on the same quoted lines the planning rule looks for on the PR (their markers count from 0). */
const SAME_LINES = 8;

/**
 * Why a planned comment may not stand on its quoted lines, given the markers
 * the PR already has (`posted`, marker to thread): a comment for several
 * places and a comment for one place do not find each other by marker, so
 * one of them would be posted next to the other. A comment for several
 * places stays off lines that carry any comment of AZPR's, unless the PR has
 * this very comment; a comment for one place (or for findings on the same
 * lines) stays off lines that carry a comment for several places, unless the
 * PR has a comment of its own kind there, which it then finds by marker as
 * always. Nothing here depends on other comments of the plan. '' when it may.
 */
function occupiedLines(target, comment, posted) {
  const first = make => Array.from({ length: SAME_LINES }, (_, ordinal) => posted.get(make(ordinal))).find(thread => thread !== undefined);
  const single = first(ordinal => inlineMarker(target, comment, ordinal)), several = posted.get(linesMarker(target, comment));
  const says = thread => `the PR already has a comment of AZPR's on these quoted lines${thread ? ` (thread ${thread})` : ''}, and a second one is not put on them`;
  if (comment.otherPlaces) return (single ?? several) !== undefined && first(ordinal => sharedMarker(target, comment, ordinal)) === undefined ? says(single ?? several) : '';
  return several !== undefined && single === undefined ? says(several) : '';
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

/**
 * Whether a text ends inside a fenced code block of its own: a fence at the
 * start of a line (up to three spaces in) that no later line closes. A fence
 * inside a quote or a list ends with it, so it is none.
 */
function leavesFenceOpen(text) {
  let open = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (open) {
      if (new RegExp(`^ {0,3}${open.mark}{${open.length},}[ \\t]*$`).test(line)) open = null;
      continue;
    }
    const fence = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(line);
    if (fence) open = { mark: fence[1] ? '`' : '~', length: (fence[1] ?? fence[2]).length };
  }
  return open !== null;
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
 * may combine (`findingIds`): one defect reported twice on the same lines.
 * `repeats` lists the groups, of any review, whose findings may be one defect
 * made at several places; a comment that combines some of them stands at one
 * place and carries the others as `otherPlaces`, which the runtime renders.
 * The runtime never combines findings itself.
 * `sources` are the page's source excerpts and `discussions` the live threads
 * the runtime read (null when it could not): skip causes are checked against them.
 * `posted` maps the markers the PR already has to their threads
 * (`markersInThreads`; null when the threads could not be read): a comment
 * for several places and a comment for one place are not put on the same
 * quoted lines (`occupiedLines`).
 * With `allowSummary: false` a summary note is dropped, never repaired: only
 * the page the runtime chose writes it.
 */
export function evaluatePlanPage(answerText, { review, assigned, final = false, candidates = [], repeats = [], sources = [], discussions = null, posted = null, allowSummary = true }) {
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
  // Findings a person excluded after a preview: no published text may name them.
  const excluded = new Set(adjustmentsOf(review).excluded);
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
    const named = namedExcluded(body, excluded);
    if (named.length) problems.push(`body names ${named.join(', ')}, which a person excluded from publication; leave ${named.length === 1 ? 'it' : 'them'} out`);
    // The list of other places is the runtime's: its heading appears nowhere in a body, however it is
    // indented, quoted or continued, so that no text a planner wrote reads like the runtime's list.
    if (OTHER_PLACES_HEADINGS.some(heading => body.includes(heading))) problems.push('body holds the heading of the list of other places, which only the runtime writes; leave that list out');
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
    return { problems, found: restored.found, comment: { severity, path, startLine: restored.startLine, endLine: restored.endLine, anchor: restored.anchor, body } };
  }
  // One comment for findings of a listed group: one defect reported twice on
  // the same lines (`candidates`, quick reviews) or made at several places
  // (`repeats`). The planner decides whether they state one defect; the runtime
  // checks only the group rules.
  function combine(c, ids) {
    const label = ids.join('+');
    const members = ids.map(id => eligible.get(id));
    const problems = [];
    const listed = group => ids.every(id => group.includes(id));
    const twice = quick && candidates.some(listed), repeated = !twice && repeats.some(listed);
    let lines;
    if (!(quick && candidates.length) && !repeats.length) problems.push('findingIds may combine only the findings of one listed group (mergeCandidates or repeatCandidates)');
    else if (members.some(member => !member)) problems.push(`${ids.filter(id => !eligible.has(id)).join(', ')} not assigned to this page`);
    else if (!twice && !repeated) problems.push('the findings are not all in one listed group (mergeCandidates or repeatCandidates)');
    else if (members.some(member => handled.has(member.id))) problems.push('a combined finding already has a comment or skip');
    else {
      const checked = twice ? combinationProblems(members) : repeatProblems(members);
      problems.push(...checked.problems);
      lines = checked.lines;
      // Every place a comment lists is a place of this PR's changes as it is at HEAD: a changed
      // file whose text the runtime read for this page, and lines that file has.
      const absent = twice ? [] : members.filter(member => {
        const at = parseLocation(member.location);
        const read = sources.find(item => item.path === at?.path);
        return !at || !changed.has(at.path) || !read || !(at.end <= (read.totalLines ?? read.lastLine));
      });
      if (absent.length) problems.push(`${absent.map(member => `${member.id} (${placeOf(member)})`).join(', ')} ${absent.length === 1 ? 'is' : 'are'} not on lines of a changed file as the runtime read it at HEAD`);
      if (!nonempty(c.mergeReason)) problems.push('a combined comment needs a mergeReason');
    }
    let drafted, first;
    if (!problems.length) {
      drafted = draft(c, label, members[0].severity, lines);
      problems.push(...drafted.problems);
      // Where the comment stands follows from the lines it quotes, so they must be lines the file has:
      // the quote is found in the HEAD text, also for a review whose single comments need not be, and
      // ends within the file (a quote that adds an empty line after the last one is found, but is no line).
      if (!problems.length && repeated && !drafted.found) problems.push('the anchor text was not found in the HEAD source; quote the exact lines from sourceExcerpts');
      // (An anchor in a file that holds none of the findings is refused below, where the place is looked for.)
      // The list follows the body: a code fence the body leaves open would take it into the code.
      if (!problems.length && repeated && leavesFenceOpen(drafted.comment.body)) problems.push('body leaves a code fence open, which would take the list of other places into the code; close the fence');
      const lineCount = (read => read && (read.totalLines ?? read.lastLine))(repeated && drafted.comment && sources.find(item => item.path === drafted.comment.path));
      if (!problems.length && lineCount && drafted.comment.endLine > lineCount) {
        problems.push(`the anchor (lines ${drafted.comment.startLine}-${drafted.comment.endLine}) reaches past the end of ${drafted.comment.path}, which has ${lineCount} line(s); quote lines the file has`);
      }
    }
    if (!problems.length && repeated) {
      // The comment stands at one of the places: the one finding whose lines its anchor touches.
      // Members never share a line, but quoted lines can reach from one into the next: such an
      // anchor names no place, and the runtime does not choose one.
      const { path, startLine, endLine } = drafted.comment;
      const touched = members.filter(member => (at => at.path === path && startLine <= at.end && endLine >= at.start)(parseLocation(member.location)));
      if (touched.length === 1) [first] = touched;
      else if (!touched.length) problems.push(`the anchor must lie on the lines of one of the combined findings (${members.map(member => `${member.id} at ${placeOf(member)}`).join(', ')})`);
      else problems.push(`the anchor (lines ${startLine}-${endLine}) touches the lines of ${touched.map(member => `${member.id} at ${placeOf(member)}`).join(' and ')}; quote lines of one of them only`);
    }
    if (!problems.length && posted) {
      // Comments for one place and comments for several do not find each other by marker: neither is put
      // on quoted lines that carry the other kind (`occupiedLines`).
      const others = repeated ? members.filter(member => member !== first).map(member => ({ place: placeOf(member) })) : undefined;
      const taken = occupiedLines(review.target, { ...drafted.comment, ...(others ? { otherPlaces: others } : {}) }, posted);
      if (taken) {
        problems.push(repeated ? `${taken}. Anchor this comment on the lines of another of its findings, or leave ${first.id} out of it; a finding that an existing thread covers is skipped with cause existing-thread`
          : `${taken}. Skip these findings with cause existing-thread when that thread covers them, or quote other lines`);
      }
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
    if (!repeated) { comments.push({ findingId: ids[0], findingIds: ids, ...drafted.comment, mergeReason: c.mergeReason.trim() }); return; }
    // The place of the comment first, the others in the order of the page; their
    // locations are the findings' own, never text the planner wrote.
    const position = new Map(assigned.map((finding, index) => [finding.id, index]));
    const others = members.filter(member => member !== first).sort((a, b) => position.get(a.id) - position.get(b.id));
    comments.push({ findingId: first.id, findingIds: [first.id, ...others.map(member => member.id)], ...drafted.comment, mergeReason: c.mergeReason.trim(),
      otherPlaces: others.map(member => ({ findingId: member.id, place: placeOf(member) })) });
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
    // A comment for one place is not put on quoted lines that carry a comment for several places.
    const taken = !problems.length && posted ? occupiedLines(review.target, comment, posted) : '';
    if (taken) problems.push(`${taken}. Skip ${finding.id} with cause existing-thread when that thread covers it, or quote other lines`);
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
        ? `skip for ${s.findingId} relies on ${cited.join(', ')}: another finding's comment does not cover it. Comment on ${s.findingId} at the lines of its own claim, combine it with findingIds only when a listed mergeCandidates or repeatCandidates group holds both and they state one defect, or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).`
        : `skip for ${s.findingId} relies on ${cited.join(', ')}: findings of this review are separate issues (the verifier already merged duplicates), so another finding's comment does not cover it. Comment on ${s.findingId} at the lines of its own claim, give one comment findingIds with both only when a listed repeatCandidates group holds them and they are one defect made at several places, or skip it only when it cannot be anchored, cannot be stated faithfully within the limit, or an existing PR thread already covers it (name the thread, not a finding).`);
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
  let summary = note && allowSummary && note.length <= SUMMARY_NOTE_LIMIT && !/<!--|-->/.test(note) ? note.trim() : undefined;
  if (note && !allowSummary) corrections.push({ action: 'drop-unallowed-summary' });
  else if (note && !summary) corrections.push({ action: 'drop-invalid-summary-note' });
  let summaryDetails = nonempty(value.summaryDetails) ? escapeComments(value.summaryDetails.trim()) : '';
  // A finding a person excluded appears nowhere in the summary either; after repairs the text that names it is dropped.
  for (const [field, text] of [['summary', summary], ['summaryDetails', summaryDetails]]) {
    const named = namedExcluded(text, excluded);
    if (!named.length) continue;
    if (!final) issues.push(`${field} names ${named.join(', ')}, which a person excluded from publication; leave ${named.length === 1 ? 'it' : 'them'} out.`);
    else if (field === 'summary') { summary = undefined; corrections.push({ action: 'drop-summary-note-naming-excluded', findingIds: named }); }
    else { summaryDetails = ''; corrections.push({ action: 'drop-summary-details-naming-excluded', findingIds: named }); }
  }
  return { result: { status, comments, skipped, summary, summaryDetails, ...(continuation ? { continuation } : {}) }, issues, corrections };
}

export function planRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  const listed = issues.slice(0, 25).map(issue => `- ${issue}`).join('\n');
  return `AZPR runtime: this comment plan page needs correction before it can be saved.\n${listed}\n\nReturn the complete corrected JSON object for this page (status, comments, skipped, optional summary and summaryDetails). Keep valid comments unchanged.`;
}

/**
 * Validate the grouping pass: which findings may be one defect made at several
 * places. Only a proposal: each planning page still decides whether a group
 * gets one comment, and the runtime checks that comment's rules. A group holds
 * two or more of `findings` (the high and medium ones on lines of a HEAD file)
 * under `repeatProblems`, and a finding belongs to at most one group. With
 * `final`, a group that breaks a rule is dropped instead of reported.
 * @returns {{result: {status: string, groups: string[][]}|null, issues: string[], corrections: object[]}}
 */
export function evaluateGrouping(answerText, { findings, final = false }) {
  const corrections = [], issues = [];
  const parsed = parseModelJSON(answerText, { keys: ['status', 'groups'] });
  if (!parsed.value) {
    if (!final) return { result: null, issues: [`Your answer could not be used: ${parsed.problem}.`], corrections };
    return { result: { status: 'READY', groups: [] }, issues: [], corrections: [{ action: 'no-usable-grouping' }] };
  }
  if (parsed.corrections) corrections.push(...parsed.corrections);
  const value = aliases(parsed.value, ['status', 'groups']);
  // The pass has one answer and no continuation: any other status is an answer that stopped early,
  // which a correction turn may finish. After the repairs the groups it did name are kept, since each
  // is only a proposal that meets the rules.
  // A missing status is no READY either: an answer may name unfinished work without one.
  const status = String(value.status ?? '').trim().toUpperCase();
  if (status !== 'READY') {
    if (final) corrections.push({ action: 'accept-grouping-without-ready', status: status.slice(0, 40) });
    else issues.push('status must be READY: this pass has no continuation. Name the groups you are sure of and return READY; use [] when nothing repeats.');
  }
  const order = new Map(findings.map((finding, index) => [finding.id, index]));
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const taken = new Set(), groups = [];
  const refuse = (ids, problem) => {
    if (final) corrections.push({ action: 'drop-invalid-group', findingIds: ids, problem });
    else issues.push(`group ${ids.join(', ')}: ${problem}. Correct it or leave it out.`);
  };
  // An answer without `groups` (a page's answer, say) is no grouping: it gets its correction turn like any other.
  if (!Array.isArray(value.groups) && !final) issues.push(value.groups === undefined ? 'groups is missing: answer with {"status": "READY", "groups": [...]}, and "groups": [] when nothing repeats.'
    : 'groups must be an array of {"findingIds": [...], "reason": "..."}; use [] when nothing repeats.');
  for (const [index, raw] of (Array.isArray(value.groups) ? value.groups : []).entries()) {
    const group = Array.isArray(raw) ? { findingIds: raw } : isObject(raw) ? aliases(raw, ['findingIds', 'reason']) : {};
    // An entry that is no group at all (its findings are not a list) is a mistake to correct; a list of fewer
    // than two findings is a group of nothing, and nothing to correct.
    if (!Array.isArray(group.findingIds)) {
      if (final) corrections.push({ action: 'drop-malformed-group', index });
      else issues.push(`group ${index + 1}: findingIds must be an array of finding IDs, as in {"findingIds": ["F-2", "F-5"], "reason": "..."}.`);
      continue;
    }
    const ids = [...new Set(group.findingIds.map(id => String(id)))];
    if (ids.length < 2) { corrections.push({ action: 'drop-group-without-two-findings', index }); continue; }
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) { refuse(ids, `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in findings`); continue; }
    const again = ids.filter(id => taken.has(id));
    if (again.length) { refuse(ids, `${again.join(', ')} already ${again.length === 1 ? 'belongs' : 'belong'} to another group`); continue; }
    const { problems } = repeatProblems(ids.map(id => byId.get(id)));
    if (problems.length) { refuse(ids, problems.join('; ')); continue; }
    for (const id of ids) taken.add(id);
    // In the order of the findings, so that pages and their comments do not depend on how the answer listed them.
    groups.push(ids.sort((a, b) => order.get(a) - order.get(b)));
  }
  groups.sort((a, b) => order.get(a[0]) - order.get(b[0]));
  return { result: { status: 'READY', groups }, issues, corrections };
}

export function groupingRepairPrompt(issues, { parseOnly = false } = {}) {
  if (parseOnly) return parseRepairPrompt(issues);
  const listed = issues.slice(0, 25).map(issue => `- ${issue}`).join('\n');
  return `AZPR runtime: this grouping needs correction before it can be used.\n${listed}\n\nReturn the complete corrected JSON object (status, groups). When unsure whether findings are one defect, leave them out of every group.`;
}

function summaryComment(review, note, details, inlineMarkers, groups = []) {
  const chinese = /^zh(?:-|$)/i.test(review.outputLanguage ?? '');
  const traditional = chinese && new Intl.Locale(review.outputLanguage).maximize().script === 'Hant';
  const heading = chinese ? traditional ? '審查說明' : '审查说明' : 'Review notes';
  const notes = nonempty(note) ? `**${heading}**\n\n${note.trim()}` : '';
  // Only combinations the plan accepted share an index row.
  const index = renderReviewSummary(commentFindings(review), review.outputLanguage ?? 'en', notes, { verification: reviewVerification(review), groups });
  // The summary's disclosure may add incomplete coverage of a quick review.
  const attribution = review.summaryAttribution ?? review.attribution;
  const disclosure = attribution ? `🤖 ${attribution}\n\n` : '';
  const marker = summaryMarker(review.target, review.snapshot.head, inlineMarkers);
  return { kind: 'summary', marker, content: `${disclosure}${index}${details ? `\n\n${details}` : ''}\n\n${marker}` };
}

/** Assemble validated pages into one saved plan with markers and exact content. */
export function assemblePlan(review, pages) {
  const ordinals = new Map();
  // Comments that are alike in what their marker is made of are told apart by their order in the plan.
  const ordinalOf = (...key) => {
    const name = JSON.stringify(key), ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    return ordinal;
  };
  const comments = pages.flatMap(page => page.comments).map(c => {
    // Azure positions are one-based UTF-16 offsets within their lines.
    const endOffset = Math.max(1, c.anchor.split('\n').at(-1).length);
    const anchor = normalizedAnchor(c.anchor);
    if (!c.otherPlaces?.length) {
      const marker = inlineMarker(review.target, c, ordinalOf('inline', c.path, anchor));
      return { ...c, kind: 'inline', startOffset: 1, endOffset, marker,
        content: `${c.body}${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${marker}` };
    }
    // One defect made at several places: the runtime lists the other places under the comment's own text.
    // The comment is known by a marker of its own (`sharedMarker`); before it stands the marker that says a
    // comment for several places is on these quoted lines (`linesMarker`), which planning reads.
    const places = c.otherPlaces.map(other => other.place).sort();
    const marker = sharedMarker(review.target, c, ordinalOf('shared', c.path, anchor, places)), lines = linesMarker(review.target, c);
    const list = escapeComments(renderOtherPlaces(c.otherPlaces, review.outputLanguage ?? 'en'));
    return { ...c, kind: 'inline', startOffset: 1, endOffset, marker, linesMarker: lines,
      content: `${c.body}\n\n${list}${review.attribution ? `\n\n---\n${review.attribution}` : ''}\n\n${lines}\n\n${marker}` };
  });
  const skipped = pages.flatMap(page => page.skipped);
  const intro = pages.map(page => page.summary).find(Boolean);
  const details = [...new Set(pages.map(page => page.summaryDetails).filter(nonempty))].join('\n\n');
  // Findings reported twice on the same lines share an index row; the places of
  // one repeated defect are findings of their own and keep their rows.
  const groups = comments.filter(c => c.findingIds?.length > 1 && !c.otherPlaces).map(c => c.findingIds);
  return { summary: summaryComment(review, intro, details, comments.map(c => c.marker), groups), comments, skipped };
}
