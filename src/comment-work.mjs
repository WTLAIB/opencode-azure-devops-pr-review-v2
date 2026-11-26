// Comment planning (model pages) and deterministic, idempotent publication.
import { commentFindings, adjustmentInput, publicationItems, evaluatePlanPage, planRepairPrompt, evaluateGrouping, groupingRepairPrompt, assemblePlan, parseLocation, placeOf, reviewMethod, reviewVerification } from './comments.mjs';
import { observationIndex, evidenceIndex, anchorObservations, compactDispositions, textPages, itemPages, PAGE_CHARACTERS } from './comment-data.mjs';
import { markersInThreads, markerTexts, deletedThreads, threadMarkers } from './azure.mjs';
import { listedPlaces, listablePlace } from './attribution.mjs';
import { parseModelJSON, syntaxProblem } from './output.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
// A short finding can still need substantial source inspection. Bound each
// page's working set; every remaining finding gets its own page.
export const PLANNING_FINDINGS_PER_PAGE = 4;
// Sessions that may continue a page after its first; what is still open then is skipped.
export const PAGE_CONTINUATIONS = 3;
// Pages planned at the same time (the runtime never exceeds workflow.parallelSessions).
export const PLANNING_PARALLEL_PAGES = 2;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const evidenceKeys = evidence => [...new Set(evidence.map(item =>
  JSON.stringify([item.tool, canonical(item.input), item.result?.sha256])))].sort();

const MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
const INLINE_BUDGET = 40000;
// The findings of the grouping pass are always inline. Above this size they go without the evidence, and a
// list that is still larger is not grouped: the pass never gets a reference it would have to read first.
const GROUPING_BUDGET = 60000;
// Up to this size the changed-file list and the dispositions are inline on every
// planning page; above it a page carries those of its findings and a reference.
const PAGE_CONTEXT_CHARACTERS = 2000;

/** Live (not deleted) discussions in a compact, model-readable form. */
export function discussionDigest(threads) {
  const live = [];
  for (const thread of threads ?? []) {
    if (thread?.isDeleted === true) continue;
    const comments = (Array.isArray(thread?.comments) ? thread.comments : [])
      .filter(comment => comment?.isDeleted !== true && comment?.commentType !== 'system' && typeof comment?.content === 'string' && comment.content.trim());
    if (!comments.length) continue;
    const context = thread.threadContext ?? {};
    const first = comments[0];
    // The places a thread covers are read only from the comment that opened it, as AZPR posts its
    // comments (never as a reply), and only in the runtime's own form: a reply that quotes such a
    // comment, marker and all, says nothing about the thread it is in. The opener is comment 1 of
    // its thread, as publication takes it (`deletedThreads`), wherever it stands among the comments;
    // when it is gone, no other comment stands for it. Where the comments carry no such number, it
    // is the comment without a parent.
    const numbered = thread.comments.some(comment => comment?.id === 1);
    const opening = comments.find(comment => numbered ? comment.id === 1 : !(comment.parentCommentId > 0));
    const alsoAt = context.filePath && opening?.content.match(MARKER) ? listedPlaces(opening.content) : [];
    // What a thread is about is said by the comment that opened it, also when a reply comes first in the
    // response: the author, the excerpt and the listed places are that one comment's.
    const lead = opening ?? first;
    live.push({
      threadId: thread.id, status: thread.status ?? null,
      ...(context.filePath ? { path: context.filePath, line: context.rightFileStart?.line ?? context.leftFileStart?.line ?? null } : {}),
      author: lead.author?.displayName ?? lead.author?.uniqueName ?? null,
      comments: comments.length,
      azpr: comments.some(comment => comment.content.match(MARKER)),
      excerpt: lead.content.replace(MARKER, '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ...(alsoAt.length ? { alsoAt } : {}),
    });
  }
  return live;
}

export { parseLocation };

/**
 * Findings of a quick review that one comment might combine: inline-eligible
 * high or medium findings of different review sessions with the same
 * severity on overlapping lines of one HEAD file, joined into groups. Groups
 * larger than a planning page are not offered. Only a candidate: the planner
 * decides whether they state one defect, and the runtime checks the rules of
 * each combination it proposes.
 */
export function mergeCandidates(findings, limit = PLANNING_FINDINGS_PER_PAGE) {
  const located = findings.map(finding => ({ finding, at: parseLocation(finding.location) }))
    .filter(({ finding, at }) => at?.side === 'head' && at.start && finding.inline !== false && finding.shard && ['high', 'medium'].includes(finding.severity));
  const parent = new Map(located.map(({ finding }) => [finding.id, finding.id]));
  const root = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (let i = 0; i < located.length; i++) for (let j = i + 1; j < located.length; j++) {
    const a = located[i], b = located[j];
    if (a.at.path === b.at.path && a.finding.severity === b.finding.severity && a.finding.shard !== b.finding.shard &&
        a.at.start <= b.at.end && b.at.start <= a.at.end) parent.set(root(a.finding.id), root(b.finding.id));
  }
  const groups = new Map();
  for (const { finding } of located) groups.set(root(finding.id), [...(groups.get(root(finding.id)) ?? []), finding.id]);
  return [...groups.values()].filter(ids => ids.length > 1 && ids.length <= limit);
}

/**
 * The findings that may share a comment as one defect made at several places:
 * high and medium ones on lines of a HEAD file that the PR changes (`files`,
 * when given), whose place a list can hold as it is. A quick finding that
 * already is a merge candidate (the same lines, another session) is left to
 * that rule. Whether the lines exist in the file is for the caller, which
 * reads it (`prepareComments`).
 */
export function repeatEligible(findings, duplicates = [], files = null) {
  const taken = new Set(duplicates.flat());
  const changed = files && new Set(files.map(path => path.startsWith('/') ? path : '/' + path));
  return findings.filter(finding => {
    const at = parseLocation(finding.location);
    return ['high', 'medium'].includes(finding.severity) && finding.inline !== false && at?.side === 'head' && Boolean(at.start) && at.end >= at.start &&
      (!changed || changed.has(at.path)) && listablePlace(placeOf(finding)) && !taken.has(finding.id);
  });
}

/** Whether some two of these findings lie at different places (another file, or lines that share none). */
function twoPlaces(findings) {
  const at = findings.map(finding => parseLocation(finding.location));
  return at.some((x, index) => at.slice(index + 1).some(y => x.path !== y.path || x.start > y.end || y.start > x.end));
}

/**
 * The sets of eligible findings that have one severity and lie at two places
 * or more: only within such a set can one comment hold a repeated defect.
 * Findings that all share lines are no such set.
 */
export function severitySets(eligible) {
  return ['high', 'medium'].map(level => eligible.filter(finding => finding.severity === level)).filter(twoPlaces).map(set => set.map(finding => finding.id));
}

/**
 * The eligible findings that fit one planning page together with another one
 * of their severity at a different place. A group shares a page
 * (`boundedGroups`), so a finding without such a partner can be in no group
 * that is used: with several pages nothing is read or asked for it.
 */
export function pairable(eligible, size = PAGE_CHARACTERS) {
  const sized = eligible.map(finding => ({ finding, at: parseLocation(finding.location), length: JSON.stringify(finding).length }));
  const together = (a, b) => a !== b && a.finding.severity === b.finding.severity && a.length + b.length <= size &&
    (a.at.path !== b.at.path || a.at.start > b.at.end || b.at.start > a.at.end);
  return sized.filter(a => sized.some(b => together(a, b))).map(({ finding }) => finding);
}

/**
 * Groups that fit a planning page's text: a larger one is split into
 * consecutive parts of two or more findings, each planned as a group of its
 * own, so that no place is dropped; a single finding left over stays alone.
 */
export function boundedGroups(groups, findings, size = PAGE_CHARACTERS) {
  const length = new Map(findings.map(finding => [finding.id, JSON.stringify(finding).length]));
  const bounded = [];
  for (const ids of groups) {
    let part = [], characters = 0;
    for (const id of ids) {
      const own = length.get(id) ?? 0;
      // A part that the next finding would overfill ends here; one finding alone is no part and is planned by itself.
      if (part.length && characters + own > size) { if (part.length > 1) bounded.push(part); part = []; characters = 0; }
      part.push(id); characters += own;
    }
    if (part.length > 1) bounded.push(part);
  }
  return bounded;
}

/**
 * Planning pages that keep each candidate group on one page. A group that does
 * not fit a page by itself is planned as separate findings, never truncated.
 * @returns {{pages: object[][], offered: string[][]}}
 */
export function candidatePages(findings, candidates, size = PAGE_CHARACTERS, maxItems = PLANNING_FINDINGS_PER_PAGE) {
  if (!candidates.length) return { pages: itemPages(findings, size, maxItems), offered: [] };
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const groupOf = new Map(candidates.flatMap(ids => ids.map(id => [id, ids])));
  const units = [], placed = new Set();
  for (const finding of findings) {
    if (placed.has(finding.id)) continue;
    const ids = groupOf.get(finding.id) ?? [finding.id];
    for (const id of ids) placed.add(id);
    const members = ids.map(id => byId.get(id));
    const length = members.reduce((sum, member) => sum + JSON.stringify(member).length, 0);
    if (members.length > 1 && length > size) units.push(...members.map(member => [member]));
    else units.push(members);
  }
  const pages = [], offered = units.filter(unit => unit.length > 1).map(unit => unit.map(member => member.id));
  let page = [], characters = 0;
  for (const unit of units) {
    const length = unit.reduce((sum, member) => sum + JSON.stringify(member).length, 0);
    if (page.length && (characters + length > size || page.length + unit.length > maxItems)) { pages.push(page); page = []; characters = 0; }
    page.push(...unit); characters += length;
  }
  if (page.length) pages.push(page);
  return { pages, offered };
}

/** The lines of a text as `sourceWindow` numbers them: a line break at the end begins no line. */
const sourceLines = text => {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
const lineTotal = text => sourceLines(text).length;

/** Numbered source lines: the whole file when small, else a window around the lines. */
export function sourceWindow(text, { start = null, end = null, context = 25, wholeFileLines = 400 } = {}) {
  const lines = sourceLines(text);
  let first = 1, last = lines.length;
  if (lines.length > wholeFileLines) {
    if (start) { first = Math.max(1, start - context); last = Math.min(lines.length, (end ?? start) + context); }
    else last = wholeFileLines;
  }
  return { firstLine: first, lastLine: last, totalLines: lines.length,
    text: lines.slice(first - 1, last).map((line, index) => `${first + index} | ${line}`).join('\n') };
}

async function planningInput(review, store, findings, report, work, continuation, extras) {
  const { files, changes, description, commits, snapshotWarnings, iteration, ...snapshot } = review.snapshot;
  const sources = extras.sourceExcerpts ?? [];
  const covered = new Set(sources.flatMap(item => item.findingIds));
  const needsEvidence = findings.some(finding => !covered.has(finding.id));
  // A large PR repeats neither list on every page: the runtime checks against the complete ones.
  const ids = new Set(findings.map(finding => finding.id));
  const paths = new Set(findings.map(finding => parseLocation(finding.location)?.path).filter(Boolean));
  const dispositions = compactDispositions(review.final.dispositions);
  const wholeFiles = JSON.stringify(files).length <= PAGE_CONTEXT_CHARACTERS;
  const wholeDispositions = JSON.stringify(dispositions).length <= PAGE_CONTEXT_CHARACTERS;
  return {
    reviewId: review.id,
    snapshot: { ...snapshot, files: wholeFiles ? files : files.filter(path => paths.has(path)),
      ...(wholeFiles ? {} : { changedFileCount: files.length, allFiles: await store.pack(files, 0) }),
      description: await store.pack(description ?? '', 3000) },
    outputLanguage: review.outputLanguage,
    findings,
    // Only when a person adjusted the findings after a preview; the input is otherwise unchanged.
    ...(extras.adjustments ? { adjustments: extras.adjustments } : {}),
    // Runtime-read HEAD source around each finding; anchors can come straight from here.
    sourceExcerpts: await store.pack(sources, INLINE_BUDGET),
    // Every live thread on the PR, read by the runtime when planning started.
    existingDiscussions: extras.discussions === null ? undefined : await store.pack(extras.discussions, INLINE_BUDGET / 2),
    discussionsRead: extras.discussions !== null,
    report: await store.pack(report, 16000),
    ...(extras.reportSegments > 1 ? { reportReference: await store.put(review.final.report ?? '') } : {}),
    dispositions: wholeDispositions ? dispositions : dispositions.filter(row => ids.has(row.id) || ids.has(row.mergedInto)),
    ...(wholeDispositions ? {} : { allDispositions: await store.pack(dispositions, 0) }),
    reviewWarnings: await store.pack(review.final.reviewWarnings ?? []),
    ...(needsEvidence ? { evidenceIndex: await observationIndex(store, review.toolText ?? []) } : {}),
    ...(extras.mergeCandidates?.length ? { mergeCandidates: extras.mergeCandidates } : {}),
    ...(extras.repeatCandidates?.length ? { repeatCandidates: extras.repeatCandidates } : {}),
    // This page's own earlier reads; pages planned at the same time keep theirs. Their saved references are
    // handed to another session here, so only those the store holds ready now are listed.
    ...(continuation && extras.evidence?.length ? { workEvidence: await evidenceIndex(store, extras.evidence) } : {}),
    continuation: continuation ? await store.pack(continuation, 3000) : undefined,
    commentWork: work,
  };
}

/**
 * Plan comments in bounded pages, `parallel` pages at a time. Each page is one
 * model stage with repair turns, continued in new sessions while it returns
 * CONTINUE; after repairs, invalid items become local skips instead of failing
 * the whole command. Nothing a page sees depends on which page finishes
 * first: only the first page may write the summary note, a page treats the
 * HEAD files of its own and earlier pages as observed source and keeps its own
 * continuation state and evidence, and pages are assembled in page order, so
 * markers and their ordinals match planning one page at a time.
 * After a page fails, no page or continuation session starts; stages already
 * running finish (with their repairs and retries) before the failure of the
 * lowest failed page is thrown.
 * One defect made at several places is several findings. Which findings may
 * be such repeats is settled before the pages are made, so that a group is on
 * one page: when every finding fits one page, that page's findings of equal
 * severity; otherwise what one grouping pass over the high and medium findings
 * proposes (a stage of its own, with repair turns). A grouping pass that fails
 * costs only the grouping: every finding is then planned on its own. `active`
 * tells whether the run still goes on; a stopped run is never continued.
 * A place is listed as its finding states it, so only a finding whose lines
 * the file has, as `fetchSource` reads it at HEAD, can be one of several
 * places: without that text nothing is offered. `posted` are the markers the
 * PR already has, each with its thread (`markersInThreads`; null when
 * unknown), for the page's rule that a comment for several places does not
 * stand on lines that already carry a comment of AZPR's.
 * @param {(payload: object, handler: object) => Promise<object>} invoke
 */
export async function prepareComments(review, store, invoke, { progress, fetchSource, discussions = null, posted = null, parallel = PLANNING_PARALLEL_PAGES, active = () => true } = {}) {
  // Adjusted by a person after a preview, if they did; otherwise the publishable findings unchanged.
  const all = commentFindings(review);
  const adjustments = adjustmentInput(review);
  // Only a quick review saved by 0.4.x, which merged no duplicates, offers candidate duplicates to the planner:
  // a review of this pipeline had its duplicate check, and what that kept apart stays apart.
  const twice = reviewMethod(review) === 'quick' ? mergeCandidates(all) : [];
  // Pages as they are without any repeated defect; they change only when the grouping pass proposes a group.
  let paged = candidatePages(all, twice);
  const sourceText = new Map();
  const source = path => {
    if (!fetchSource) return Promise.resolve(null);
    if (!sourceText.has(path)) sourceText.set(path, Promise.resolve().then(() => fetchSource(path)).then(text => typeof text === 'string' ? text : null, () => null));
    return sourceText.get(path);
  };
  // Only a finding whose lines the HEAD file has is offered as one of several places: a place is
  // listed as the finding states it, and a file that is deleted or shorter has no such lines. The
  // files are read only when findings could share a comment at all; the pages read them anyway.
  // With several pages a group must share one: a finding that fits a page with no other one is left out here,
  // so that no file is read ahead for it and it takes none of the grouping pass's input.
  const usable = findings => paged.pages.length <= 1 ? findings : pairable(findings);
  let eligible = usable(repeatEligible(all, twice, review.snapshot.files));
  if (severitySets(eligible).length) {
    // As many reads at a time as pages are planned, so that one preview never puts all its files
    // ahead of what other conversations ask of Azure DevOps.
    const paths = [...new Set(eligible.map(finding => parseLocation(finding.location).path))];
    let next = 0;
    const reader = async () => { while (next < paths.length && active()) await source(paths[next++]); };
    await Promise.all(Array.from({ length: Math.min(paths.length, Number.isSafeInteger(parallel) && parallel > 1 ? parallel : 1) }, reader));
    // A run that was stopped meanwhile reads no further file and plans nothing.
    if (!active()) throw new Error('Comment planning was stopped.');
    // Lines are counted once for a file, however many findings it holds.
    const lineCounts = new Map();
    for (const path of paths) {
      const head = await source(path);
      if (head !== null) lineCounts.set(path, lineTotal(head));
    }
    // A place the file does not have is none, which may leave another finding without its partner.
    eligible = usable(eligible.filter(finding => (at => at.end <= (lineCounts.get(at.path) ?? 0))(parseLocation(finding.location))));
  }
  let repeats = [];
  if (severitySets(eligible).length) {
    // The pass reads its findings inline and needs no tool. A long list goes without the evidence, and one
    // that is still too long is not grouped: no stored reference, which the pass would have to read first.
    let listed = eligible.map(({ id, severity, location, summary, evidence, suggestion }) => ({ id, severity, location, summary, evidence, suggestion }));
    if (JSON.stringify(listed).length > GROUPING_BUDGET) listed = listed.map(({ evidence: _long, ...short }) => short);
    if (paged.pages.length <= 1) repeats = severitySets(eligible);
    else if (JSON.stringify(listed).length > GROUPING_BUDGET) {
      progress?.(`Planning comments: ${eligible.length} findings are too many to look through for one defect at several places; planning goes on without grouping them.`);
    } else {
      progress?.(`Planning comments: looking for one defect at several places (${eligible.length} findings)`);
      try {
        const grouped = await invoke({ reviewId: review.id, outputLanguage: review.outputLanguage, findings: listed, commentWork: { kind: 'group' } }, {
          async evaluate(answer) {
            const { result, issues, corrections } = evaluateGrouping(answer, { findings: eligible });
            // A parsed answer is usable: if a correction turn fails, it is finalized as it is.
            return { result: result && { ...result, corrections }, issues, usable: Boolean(result), repairPrompt: issues.length ? groupingRepairPrompt(issues, { parseOnly: !result && syntaxProblem(issues) }) : undefined };
          },
          async finalize(answer) {
            const { result, corrections } = evaluateGrouping(answer, { findings: eligible, final: true });
            return { ...result, corrections };
          },
        });
        // A stop that arrived while the pass was ending: no page is prepared.
        if (!active()) throw new Error('Comment planning was stopped.');
        repeats = boundedGroups(grouped.groups, all);
        if (repeats.length) paged = candidatePages(all, [...twice, ...repeats]);
      } catch (error) {
        if (!active() || error?.failureClass === 'cancelled') throw error;
        repeats = [];
        progress?.(`Planning comments: the grouping failed (${String(error?.message ?? error).slice(0, 200)}); planning goes on without grouping repeated places.`);
      }
    }
  }
  const { pages: groups, offered } = paged;
  // On one page the findings of equal severity are offered as they are; otherwise the groups that a page keeps whole.
  const kept = list => offered.filter(ids => list.some(group => group.length === ids.length && group.every(id => ids.includes(id))));
  const offeredTwice = kept(twice), offeredRepeats = groups.length <= 1 ? repeats : kept(repeats);
  const reports = textPages(review.final.report ?? '');
  const count = Math.max(groups.length, reports.length, 1);
  async function excerpts(findings) {
    const windows = new Map();
    for (const finding of findings) {
      const location = parseLocation(finding.location);
      // Excerpts are HEAD source; BASE line numbers do not point into it.
      if (!location || location.side !== 'head') continue;
      const text = await source(location.path);
      if (text === null) continue;
      const window = sourceWindow(text, location);
      // A window with no line (a saved line past the end of the file) is no excerpt: the finding keeps its evidence index.
      if (window.firstLine > window.lastLine) continue;
      const key = `${location.path}:${window.firstLine}-${window.lastLine}`;
      const entry = windows.get(key) ?? { path: location.path, version: review.snapshot.head, findingIds: [], ...window };
      entry.findingIds.push(finding.id);
      windows.set(key, entry);
    }
    return [...windows.values()];
  }
  // A page's observed HEAD source is that of its own and earlier pages' findings,
  // as when pages ran one at a time; never whatever happens to be fetched already.
  const headPaths = [];
  for (let index = 0; index < count; index++) {
    const own = (groups[index] ?? []).map(finding => parseLocation(finding.location)).filter(at => at?.side === 'head').map(at => at.path);
    headPaths.push([...new Set([...(headPaths[index - 1] ?? []), ...own])]);
  }
  let failure; // The lowest failed page: { index, error }.
  async function planPage(index) {
    const parts = [], signatures = new Set();
    let pending = groups[index] ?? [], continuation, sessions = 0, summaryWritten = false;
    const report = reports[index]?.text ?? '';
    // Tool results the runtime recorded for this page's sessions.
    const evidence = () => (review.commentEvidence ?? []).filter(item => item.page === index + 1);
    progress?.(`Planning comments, page ${index + 1}/${count}`);
    do {
      const assigned = pending;
      // Findings reported twice: groups whose findings are all still open on this page. One defect at
      // several places: what is still open of each group, while two or more of its findings are.
      const open = id => assigned.some(item => item.id === id);
      const candidates = offeredTwice.filter(ids => ids.every(open));
      const repeatCandidates = offeredRepeats.map(ids => ids.filter(open)).filter(ids => twoPlaces(ids.map(id => assigned.find(item => item.id === id))));
      const sourceExcerpts = await excerpts(assigned);
      // Only the first page writes the summary note; a note from another page is dropped.
      const allowSummary = index === 0 && !summaryWritten;
      const payload = await planningInput(review, store, assigned, report,
        { kind: 'plan', page: index + 1, pages: count, allowSummary,
          ...(reports[index] ? { reportRange: { start: reports[index].start, end: reports[index].end } } : {}) },
        continuation, { sourceExcerpts, discussions, reportSegments: reports.length, mergeCandidates: candidates, repeatCandidates, evidence: evidence(), adjustments });
      // Another page failed while this input was prepared: start no model work.
      if (failure) return parts;
      const scoped = async answer => {
        const parsed = parseModelJSON(answer, { keys: ['status', 'comments', 'skipped'] });
        const comments = Array.isArray(parsed.value?.comments) ? parsed.value.comments : [];
        // Source the runtime fetched for this and earlier pages counts as observed HEAD text for anchor checks.
        const fetched = [];
        for (const path of headPaths[index]) {
          const text = await source(path);
          if (text !== null) fetched.push({ tool: 'runtime', input: { path, version: review.snapshot.head }, output: text });
        }
        return { ...review, toolText: [...fetched, ...await anchorObservations(store, review.toolText ?? [], comments, review.snapshot.head)] };
      };
      const options = { assigned, candidates, repeats: repeatCandidates, sources: sourceExcerpts, discussions, posted, allowSummary };
      const page = await invoke(payload, {
        async evaluate(answer) {
          const { result, issues, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), ...options });
          // A parsed page is usable: if a correction turn fails, it is finalized as it is, item by item.
          return { result: result && { ...result, corrections }, issues, usable: Boolean(result), repairPrompt: issues.length ? planRepairPrompt(issues, { parseOnly: !result && syntaxProblem(issues) }) : undefined };
        },
        async finalize(answer) {
          const { result, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), ...options, final: true });
          return { ...result, corrections };
        },
      });
      sessions++;
      if (text(page.summary)) summaryWritten = true;
      parts.push(page);
      const accounted = new Set([...page.comments.flatMap(item => item.findingIds ?? [item.findingId]), ...page.skipped.map(item => item.findingId)]);
      pending = pending.filter(item => !accounted.has(item.id));
      continuation = page.status === 'CONTINUE' ? page.continuation : undefined;
      let stopped;
      if (continuation) {
        // Rephrasing a checkpoint or repeating the same reads is not progress, and
        // a page gets PAGE_CONTINUATIONS more sessions at most. Either way the page
        // ends here and keeps its finished work; only what is still open is skipped.
        // Details and reads of other pages are not this page's progress.
        const details = [...new Set(parts.map(part => part.summaryDetails).filter(text))].sort();
        const signature = JSON.stringify([pending.map(item => item.id), details, evidenceKeys(evidence())]);
        if (signatures.has(signature)) stopped = 'repeated a checkpoint without progress';
        else if (sessions > PAGE_CONTINUATIONS) stopped = `did not finish the page in ${sessions} sessions`;
        signatures.add(signature);
        if (stopped) {
          continuation = undefined;
          progress?.(`Planning comments, page ${index + 1}/${count}: the planner ${stopped}; ${pending.length} finding(s) skipped.`);
        }
      }
      if (!continuation && pending.length) {
        // A READY page that left findings unaccounted was already finalized
        // with skips; anything still pending here is recorded explicitly.
        const reason = stopped ? `The comment planner ${stopped}` : 'The comment planner did not address this finding';
        parts.push({ status: 'READY', comments: [], skipped: pending.map(item => ({ findingId: item.id, reason: `${reason}; it remains in the summary index.` })), summaryDetails: '' });
      }
    } while (continuation && !failure);
    return parts;
  }
  // Lanes take pages in order and all finish before this returns or throws,
  // so no planning stage is still running when the command ends.
  const planned = new Array(count);
  let next = 0;
  const lane = async () => {
    while (!failure && next < count) {
      const index = next++;
      try { planned[index] = await planPage(index); }
      catch (error) { if (!failure || index < failure.index) failure = { index, error }; }
    }
  };
  const lanes = Number.isSafeInteger(parallel) && parallel > 1 ? Math.min(parallel, count) : 1;
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure) throw failure.error;
  return assemblePlan(review, planned.flat());
}

/**
 * A create whose outcome is unknown (timeout, lost connection, or a process
 * that stopped mid-request) can still land on the server later. Its item is
 * not written again until its marker appears or this long has passed; a
 * create that Azure DevOps completed even later would then appear twice.
 */
export const UNCERTAIN_SETTLE_MS = 15 * 60 * 1000;

/**
 * Publish a saved plan with deterministic Azure DevOps calls.
 * - Refuses if the PR's source commit changed. The PR's status stops nothing: a
 *   completed or abandoned PR takes comments like an active one, and the
 *   result names such a status (`prStatus`) for the receipt.
 * - Skips items whose marker already exists on the PR (idempotent re-runs).
 * - Coordinates through `attempts` (per PR, shared by every review; not a
 *   lock between processes): an attempt is saved before its request and
 *   nothing is sent if that fails; a create that returned a thread ID is never
 *   sent again, and one with an unknown outcome not within UNCERTAIN_SETTLE_MS.
 *   The thread of an item found on the PR is recorded the same way.
 * - Reads every created marker back from Azure DevOps. A recorded thread whose
 *   comment was deleted on the PR is DELETED: settled, and never sent again.
 * - With `only` (a set of markers), handles just those items; the others stay
 *   in the saved plan for a later publication.
 * - With `compare` (a review a person adjusted), an item already on the PR
 *   with other text is still skipped, marked `earlierText`: the PR keeps that
 *   earlier version, since nothing posted is ever changed. The result then
 *   counts the other AZPR comments on the PR (`otherComments`).
 */
export async function publishPlan({ run, review, azure, attempts, progress, persist, now = () => Date.now(), settleMs = UNCERTAIN_SETTLE_MS, only, compare = false }) {
  const items = publicationItems(review.plan).filter(item => !only || only.has(item.marker));
  const ledger = review.publication ??= new Map();
  const current = await azure.versions(run, review.snapshot);
  if (current.head !== review.snapshot.head) {
    return { status: 'STALE', reason: `The PR source commit changed after the review (reviewed ${review.snapshot.head.slice(0, 12)}, current ${current.head.slice(0, 12)}). Run a new review before commenting.` };
  }
  const listed = await azure.threads(run, review.snapshot);
  const present = markersInThreads(listed);
  const texts = compare ? markerTexts(listed) : null;
  const at = () => new Date(now()).toISOString();
  const record = (item, entry) => ledger.set(item.marker, {
    ...(item.kind === 'summary' ? { kind: 'summary' } : { kind: 'inline', findingId: item.findingId, ...(item.findingIds ? { findingIds: item.findingIds } : {}), path: item.path, startLine: item.startLine }),
    ...entry, at: at() });
  // Remember the thread of every item found on the PR (also one an uncertain create or an earlier
  // version left without a record), so a comment deleted there later is not posted again.
  for (const item of items) {
    const threadId = present.get(item.marker), earlier = attempts.get(item.marker);
    if (threadId === undefined || (earlier?.state === 'CREATED' && earlier.threadId === threadId)) continue;
    await attempts.set(item.marker, { state: 'CREATED', threadId, at: earlier?.at ?? at(), ...(earlier?.review ? { review: earlier.review } : {}) }).catch(() => {});
  }
  let written = 0, halted = '';
  for (const [index, item] of items.entries()) {
    if (!run.active) throw new Error(run.reason || 'Publication stopped.');
    if (present.has(item.marker)) {
      record(item, { state: 'ALREADY_PRESENT', threadId: present.get(item.marker), ...(texts && texts.get(item.marker) !== item.content ? { earlierText: true } : {}) });
      continue;
    }
    if (halted) { record(item, { state: 'FAILED', error: halted }); continue; }
    const earlier = attempts.get(item.marker);
    if (earlier?.state === 'CREATED') {
      // Azure DevOps returned a thread for it; a lagging thread list is no reason to send it again,
      // and a comment someone deleted on the PR stays deleted (read-back reports it).
      record(item, { state: 'POSTED', threadId: earlier.threadId, earlierAttempt: earlier.review ?? true });
      continue;
    }
    if (earlier?.state === 'SENDING' && !(now() - Date.parse(earlier.at) >= settleMs)) {
      record(item, { state: 'UNCERTAIN', error: `An earlier attempt (${earlier.at}) has an unknown outcome.` });
      continue;
    }
    try { await attempts.set(item.marker, { state: 'SENDING', at: at(), review: review.id }); }
    catch (error) {
      halted = `The publication attempt could not be saved (${String(error?.message ?? error).slice(0, 200)}); nothing was sent.`;
      record(item, { state: 'FAILED', error: halted });
      continue;
    }
    record(item, { state: 'SENDING' });
    await persist?.();
    try {
      const created = await azure.createThread(run, review.snapshot, item);
      record(item, { state: 'POSTED', threadId: created.threadId, ...(created.contentMatches === false ? { contentMismatch: true } : {}) });
      try { await attempts.set(item.marker, { state: 'CREATED', threadId: created.threadId, at: at(), review: review.id }); }
      catch (error) { halted = `The created thread could not be recorded (${String(error?.message ?? error).slice(0, 200)}); publication stopped.`; }
    } catch (error) {
      if (!run.active) throw error;
      if (error?.uncertain) record(item, { state: 'UNCERTAIN', error: String(error?.message ?? error).slice(0, 600) });
      else {
        record(item, { state: 'FAILED', error: String(error?.message ?? error).slice(0, 600) });
        // Nothing was created, so the item may be sent again.
        await attempts.remove([item.marker]).catch(() => {});
      }
    }
    written++;
    await persist?.();
    if (written % 10 === 0) progress?.(`Posted ${index + 1}/${items.length} comment item(s)`);
  }
  let readBack = 'complete';
  try {
    const listedAfter = await azure.threads(run, review.snapshot);
    const after = markersInThreads(listedAfter), removedAfter = deletedThreads(listedAfter);
    const textsAfter = compare ? markerTexts(listedAfter) : null;
    for (const item of items) {
      const entry = ledger.get(item.marker);
      if (!['POSTED', 'UNCERTAIN', 'FAILED'].includes(entry.state)) continue;
      if (after.has(item.marker)) {
        // A comment this run did not create (an earlier attempt's, or one the first list did not show yet,
        // also after a refused write) keeps its own text.
        const earlierText = textsAfter && (entry.state !== 'POSTED' || entry.earlierAttempt) && textsAfter.get(item.marker) !== item.content;
        Object.assign(entry, { state: 'VERIFIED', threadId: after.get(item.marker), ...(earlierText ? { earlierText: true } : {}) });
      }
      else if (entry.state === 'POSTED') entry.state = removedAfter.has(entry.threadId) ? 'DELETED' : 'UNVERIFIED';
    }
  } catch (error) {
    if (!run.active) throw error;
    readBack = `unavailable: ${String(error?.message ?? error).slice(0, 300)}`;
  }
  await persist?.();
  const states = items.map(item => ledger.get(item.marker).state);
  const succeeded = states.filter(state => ['VERIFIED', 'ALREADY_PRESENT', 'POSTED', 'DELETED'].includes(state)).length;
  const status = succeeded === items.length ? 'POSTED' : succeeded ? 'PARTIALLY_POSTED' : 'FAILED';
  const uncertain = states.filter(state => state === 'UNCERTAIN').length;
  const reason = halted || (uncertain ? `${uncertain} item(s) may still be created by an earlier attempt whose outcome is unknown; they are not posted again until their marker appears or ${Math.round(settleMs / 60000)} minutes have passed since that attempt. Run the same command again later.` : undefined);
  // The other AZPR comments on the PR, counted by thread: a comment for several places has two markers and
  // a reply may quote another thread's, so a thread is another comment when none of the markers it holds is
  // a marker of this preview. That does not depend on the order of the threads.
  const planned = new Set(items.map(item => item.marker));
  return { status, readBack, ...(reason ? { reason } : {}), ...(current.status !== 'active' ? { prStatus: current.status } : {}),
    counts: Object.fromEntries([...new Set(states)].map(state => [state, states.filter(s => s === state).length])),
    ...(compare ? { otherComments: [...threadMarkers(listed).values()].filter(markers => ![...markers].some(marker => planned.has(marker))).length } : {}) };
}
