// Comment planning (model pages) and deterministic, idempotent publication.
import { publishableFindings, publicationItems, evaluatePlanPage, planRepairPrompt, assemblePlan, parseLocation, reviewVerification } from './comments.mjs';
import { observationIndex, anchorObservations, compactDispositions, textPages, itemPages, PAGE_CHARACTERS } from './comment-data.mjs';
import { markersInThreads } from './azure.mjs';
import { parseModelJSON, syntaxProblem } from './output.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
// A short finding can still need substantial source inspection. Bound each
// page's working set; every remaining finding gets its own page.
export const PLANNING_FINDINGS_PER_PAGE = 4;
// Sessions that may continue a page after its first; what is still open then is skipped.
export const PAGE_CONTINUATIONS = 3;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const evidenceKeys = review => [...new Set((review.commentEvidence ?? []).map(item =>
  JSON.stringify([item.tool, canonical(item.input), item.result?.sha256])))].sort();

const MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
const INLINE_BUDGET = 40000;

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
    live.push({
      threadId: thread.id, status: thread.status ?? null,
      ...(context.filePath ? { path: context.filePath, line: context.rightFileStart?.line ?? context.leftFileStart?.line ?? null } : {}),
      author: first.author?.displayName ?? first.author?.uniqueName ?? null,
      comments: comments.length,
      azpr: comments.some(comment => comment.content.match(MARKER)),
      excerpt: first.content.replace(MARKER, '').replace(/\s+/g, ' ').trim().slice(0, 300),
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

/** Numbered source lines: the whole file when small, else a window around the lines. */
export function sourceWindow(text, { start = null, end = null, context = 25, wholeFileLines = 400 } = {}) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let first = 1, last = lines.length;
  if (lines.length > wholeFileLines) {
    if (start) { first = Math.max(1, start - context); last = Math.min(lines.length, (end ?? start) + context); }
    else last = wholeFileLines;
  }
  return { firstLine: first, lastLine: last, totalLines: lines.length,
    text: lines.slice(first - 1, last).map((line, index) => `${first + index} | ${line}`).join('\n') };
}

async function planningInput(review, store, findings, report, work, continuation, prepared, extras) {
  const { files, changes, description, commits, snapshotWarnings, iteration, ...snapshot } = review.snapshot;
  const sources = extras.sourceExcerpts ?? [];
  const covered = new Set(sources.flatMap(item => item.findingIds));
  const needsEvidence = findings.some(finding => !covered.has(finding.id));
  return {
    reviewId: review.id,
    snapshot: { ...snapshot, files: await store.pack(files), description: await store.pack(description ?? '', 3000) },
    outputLanguage: review.outputLanguage,
    findings,
    // Runtime-read HEAD source around each finding; anchors can come straight from here.
    sourceExcerpts: await store.pack(sources, INLINE_BUDGET),
    // Every live thread on the PR, read by the runtime when planning started.
    existingDiscussions: extras.discussions === null ? undefined : await store.pack(extras.discussions, INLINE_BUDGET / 2),
    discussionsRead: extras.discussions !== null,
    report: await store.pack(report, 16000),
    ...(extras.reportSegments > 1 ? { reportReference: await store.put(review.final.report ?? '') } : {}),
    dispositions: await store.pack(compactDispositions(review.final.dispositions)),
    reviewWarnings: await store.pack(review.final.reviewWarnings ?? []),
    ...(needsEvidence ? { evidenceIndex: await observationIndex(store, review.toolText ?? []) } : {}),
    ...(extras.mergeCandidates?.length ? { mergeCandidates: extras.mergeCandidates } : {}),
    ...(prepared.length ? { priorPages: prepared.map(page => ({ comments: page.comments.map(c => ({ findingId: c.findingId, ...(c.findingIds ? { findingIds: c.findingIds } : {}), path: c.path, startLine: c.startLine })),
      skipped: page.skipped.map(item => item.findingId), wroteSummary: Boolean(page.summary) })) } : {}),
    ...(continuation && review.commentEvidence?.length ? { workEvidence: await store.put(review.commentEvidence.map(item => JSON.stringify(item)).join('\n') + '\n', 'jsonl') } : {}),
    continuation: continuation ? await store.pack(continuation, 3000) : undefined,
    commentWork: work,
  };
}

/**
 * Plan comments in bounded pages. Each page is one model stage with repair
 * turns; after repairs, invalid items become local skips instead of failing
 * the whole command.
 * @param {(payload: object, handler: object) => Promise<object>} invoke
 */
export async function prepareComments(review, store, invoke, { progress, fetchSource, discussions = null } = {}) {
  const all = publishableFindings(review);
  // Only a quick review, which has no verifier, offers candidate duplicates to the planner.
  const { pages: groups, offered } = candidatePages(all, reviewVerification(review) === 'none' ? mergeCandidates(all) : []);
  const reports = textPages(review.final.report ?? '');
  const count = Math.max(groups.length, reports.length, 1);
  const pages = [], prepared = [], signatures = new Set();
  const sourceText = new Map();
  const source = path => {
    if (!fetchSource) return Promise.resolve(null);
    if (!sourceText.has(path)) sourceText.set(path, Promise.resolve().then(() => fetchSource(path)).then(text => typeof text === 'string' ? text : null, () => null));
    return sourceText.get(path);
  };
  async function excerpts(findings) {
    const windows = new Map();
    for (const finding of findings) {
      const location = parseLocation(finding.location);
      // Excerpts are HEAD source; BASE line numbers do not point into it.
      if (!location || location.side !== 'head') continue;
      const text = await source(location.path);
      if (text === null) continue;
      const window = sourceWindow(text, location);
      const key = `${location.path}:${window.firstLine}-${window.lastLine}`;
      const entry = windows.get(key) ?? { path: location.path, version: review.snapshot.head, findingIds: [], ...window };
      entry.findingIds.push(finding.id);
      windows.set(key, entry);
    }
    return [...windows.values()];
  }
  let summaryWritten = false;
  for (let index = 0; index < count; index++) {
    let pending = groups[index] ?? [], continuation, sessions = 0;
    const report = reports[index]?.text ?? '';
    progress?.(`Planning comments, page ${index + 1}/${count}`);
    do {
      const assigned = pending;
      // Groups whose findings are all still open on this page.
      const candidates = offered.filter(ids => ids.every(id => assigned.some(item => item.id === id)));
      const sourceExcerpts = await excerpts(assigned);
      const payload = await planningInput(review, store, assigned, report,
        { kind: 'plan', page: index + 1, pages: count, allowSummary: !summaryWritten,
          ...(reports[index] ? { reportRange: { start: reports[index].start, end: reports[index].end } } : {}) },
        continuation, pages, { sourceExcerpts, discussions, reportSegments: reports.length, mergeCandidates: candidates });
      const scoped = async answer => {
        const parsed = parseModelJSON(answer, { keys: ['status', 'comments', 'skipped'] });
        const comments = Array.isArray(parsed.value?.comments) ? parsed.value.comments : [];
        // Source the runtime fetched counts as observed HEAD text for anchor checks.
        const fetched = [];
        for (const [path, pending] of sourceText) {
          const text = await pending;
          if (text !== null) fetched.push({ tool: 'runtime', input: { path, version: review.snapshot.head }, output: text });
        }
        return { ...review, toolText: [...fetched, ...await anchorObservations(store, review.toolText ?? [], comments, review.snapshot.head)] };
      };
      const page = await invoke(payload, {
        async evaluate(answer) {
          const { result, issues, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), assigned, candidates });
          return { result: result && { ...result, corrections }, issues, repairPrompt: issues.length ? planRepairPrompt(issues, { parseOnly: !result && syntaxProblem(issues) }) : undefined };
        },
        async finalize(answer) {
          const { result, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), assigned, final: true, candidates });
          return { ...result, corrections };
        },
      });
      sessions++;
      if (text(page.summary)) summaryWritten = true;
      pages.push(page);
      prepared.push(await store.object({ input: payload, result: page }));
      const accounted = new Set([...page.comments.flatMap(item => item.findingIds ?? [item.findingId]), ...page.skipped.map(item => item.findingId)]);
      pending = pending.filter(item => !accounted.has(item.id));
      continuation = page.status === 'CONTINUE' ? page.continuation : undefined;
      let stopped;
      if (continuation) {
        // Rephrasing a checkpoint or repeating the same reads is not progress, and
        // a page gets PAGE_CONTINUATIONS more sessions at most. Either way the page
        // ends here and keeps its finished work; only what is still open is skipped.
        const details = [...new Set(pages.map(part => part.summaryDetails).filter(text))].sort();
        const signature = JSON.stringify([index, pending.map(item => item.id), details, evidenceKeys(review)]);
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
        pages.push({ status: 'READY', comments: [], skipped: pending.map(item => ({ findingId: item.id, reason: `${reason}; it remains in the summary index.` })), summaryDetails: '' });
      }
    } while (continuation);
  }
  return assemblePlan(review, pages);
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
 * - Refuses if the PR is no longer active or its source commit changed.
 * - Skips items whose marker already exists on the PR (idempotent re-runs).
 * - Coordinates through `attempts` (per PR, shared by every review; not a
 *   lock between processes): an attempt is saved before its request and
 *   nothing is sent if that fails; a create that returned a thread ID is never
 *   sent again, and one with an unknown outcome not within UNCERTAIN_SETTLE_MS.
 * - Reads every created marker back from Azure DevOps.
 */
export async function publishPlan({ run, review, azure, attempts, progress, persist, now = () => Date.now(), settleMs = UNCERTAIN_SETTLE_MS }) {
  const items = publicationItems(review.plan);
  const ledger = review.publication ??= new Map();
  const current = await azure.versions(run, review.snapshot);
  if (current.status !== 'active') return { status: 'INCOMPLETE', reason: `The PR is ${current.status}; nothing was posted.` };
  if (current.head !== review.snapshot.head) {
    return { status: 'STALE', reason: `The PR source commit changed after the review (reviewed ${review.snapshot.head.slice(0, 12)}, current ${current.head.slice(0, 12)}). Run a new review before commenting.` };
  }
  const present = markersInThreads(await azure.threads(run, review.snapshot));
  const at = () => new Date(now()).toISOString();
  const record = (item, entry) => ledger.set(item.marker, {
    ...(item.kind === 'summary' ? { kind: 'summary' } : { kind: 'inline', findingId: item.findingId, ...(item.findingIds ? { findingIds: item.findingIds } : {}), path: item.path, startLine: item.startLine }),
    ...entry, at: at() });
  // Attempts whose marker is now visible are settled.
  const visible = items.filter(item => present.has(item.marker) && attempts.get(item.marker)).map(item => item.marker);
  if (visible.length) await attempts.remove(visible).catch(() => {});
  let written = 0, halted = '';
  for (const [index, item] of items.entries()) {
    if (!run.active) throw new Error(run.reason || 'Publication stopped.');
    if (present.has(item.marker)) { record(item, { state: 'ALREADY_PRESENT', threadId: present.get(item.marker) }); continue; }
    if (halted) { record(item, { state: 'FAILED', error: halted }); continue; }
    const earlier = attempts.get(item.marker);
    if (earlier?.state === 'CREATED') {
      // Azure DevOps returned a thread for it; a lagging thread list is no reason to send it again.
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
    const after = markersInThreads(await azure.threads(run, review.snapshot));
    for (const item of items) {
      const entry = ledger.get(item.marker);
      if (!['POSTED', 'UNCERTAIN', 'FAILED'].includes(entry.state)) continue;
      if (after.has(item.marker)) Object.assign(entry, { state: 'VERIFIED', threadId: after.get(item.marker) });
      else if (entry.state === 'POSTED') entry.state = 'UNVERIFIED';
    }
  } catch (error) {
    if (!run.active) throw error;
    readBack = `unavailable: ${String(error?.message ?? error).slice(0, 300)}`;
  }
  await persist?.();
  const states = items.map(item => ledger.get(item.marker).state);
  const succeeded = states.filter(state => ['VERIFIED', 'ALREADY_PRESENT', 'POSTED'].includes(state)).length;
  const status = succeeded === items.length ? 'POSTED' : succeeded ? 'PARTIALLY_POSTED' : 'FAILED';
  const uncertain = states.filter(state => state === 'UNCERTAIN').length;
  const reason = halted || (uncertain ? `${uncertain} item(s) may still be created by an earlier attempt whose outcome is unknown; they are not posted again until their marker appears or ${Math.round(settleMs / 60000)} minutes have passed since that attempt. Run the same command again later.` : undefined);
  return { status, readBack, ...(reason ? { reason } : {}), counts: Object.fromEntries([...new Set(states)].map(state => [state, states.filter(s => s === state).length])) };
}
