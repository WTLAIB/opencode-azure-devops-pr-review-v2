// Comment planning (model pages) and deterministic, idempotent publication.
import { confirmedFindings, publicationItems, evaluatePlanPage, planRepairPrompt, assemblePlan } from './comments.mjs';
import { observationIndex, anchorObservations, compactDispositions, textPages, itemPages, PAGE_CHARACTERS } from './comment-data.mjs';
import { markersInThreads } from './azure.mjs';
import { parseModelJSON, syntaxProblem } from './output.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
// A short finding can still need substantial source inspection. Bound each
// page's working set; every remaining finding gets its own page.
export const PLANNING_FINDINGS_PER_PAGE = 4;
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

/** "head:/src/a.ts:12-14" -> { path, start, end }; null when no path. */
export function parseLocation(location) {
  const match = /^(?:head|base)?:?(\/[^:]+?)(?::(\d+)(?:-(\d+))?)?\s*$/.exec(String(location ?? '').trim());
  if (!match) return null;
  const start = match[2] ? Number(match[2]) : null;
  return { path: match[1], start, end: match[3] ? Number(match[3]) : start };
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
    ...(prepared.length ? { priorPages: prepared.map(page => ({ comments: page.comments.map(c => ({ findingId: c.findingId, path: c.path, startLine: c.startLine })),
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
  const all = confirmedFindings(review);
  const groups = itemPages(all, PAGE_CHARACTERS, PLANNING_FINDINGS_PER_PAGE);
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
      if (!location) continue;
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
    let pending = groups[index] ?? [], continuation;
    const report = reports[index]?.text ?? '';
    progress?.(`Planning comments, page ${index + 1}/${count}`);
    do {
      const assigned = pending;
      const sourceExcerpts = await excerpts(assigned);
      const payload = await planningInput(review, store, assigned, report,
        { kind: 'plan', page: index + 1, pages: count, allowSummary: !summaryWritten,
          ...(reports[index] ? { reportRange: { start: reports[index].start, end: reports[index].end } } : {}) },
        continuation, pages, { sourceExcerpts, discussions, reportSegments: reports.length });
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
          const { result, issues, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), assigned });
          return { result: result && { ...result, corrections }, issues, repairPrompt: issues.length ? planRepairPrompt(issues, { parseOnly: !result && syntaxProblem(issues) }) : undefined };
        },
        async finalize(answer) {
          const { result, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), assigned, final: true });
          return { ...result, corrections };
        },
      });
      if (text(page.summary)) summaryWritten = true;
      pages.push(page);
      prepared.push(await store.object({ input: payload, result: page }));
      const accounted = new Set([...page.comments, ...page.skipped].map(item => item.findingId));
      pending = pending.filter(item => !accounted.has(item.id));
      continuation = page.status === 'CONTINUE' ? page.continuation : undefined;
      if (continuation) {
        // Rephrasing a checkpoint or repeating the same reads is not progress.
        const details = [...new Set(pages.map(part => part.summaryDetails).filter(text))].sort();
        const signature = JSON.stringify([index, pending.map(item => item.id), details, evidenceKeys(review)]);
        if (signatures.has(signature)) throw new Error('Comment planning repeated a checkpoint without progress; nothing was published.');
        signatures.add(signature);
      } else if (pending.length) {
        // A READY page that left findings unaccounted was already finalized
        // with skips; anything still pending here is recorded explicitly.
        pages.push({ status: 'READY', comments: [], skipped: pending.map(item => ({ findingId: item.id, reason: 'The comment planner did not address this finding; it remains in the summary index.' })), summaryDetails: '' });
      }
    } while (continuation);
  }
  return assemblePlan(review, pages);
}

/**
 * A create whose outcome is unknown (timeout, lost connection, or a process
 * that stopped mid-request) can still land on the server later. Its item is
 * not written again until its marker appears or this long has passed.
 */
export const UNCERTAIN_SETTLE_MS = 15 * 60 * 1000;

/**
 * Publish a saved plan with deterministic Azure DevOps calls.
 * - Refuses if the PR is no longer active or its source commit changed.
 * - Skips items whose marker already exists on the PR (idempotent re-runs).
 * - Saves each attempt before sending it and never repeats an uncertain one
 *   within UNCERTAIN_SETTLE_MS, even across restarts.
 * - Reads every created marker back from Azure DevOps.
 */
export async function publishPlan({ run, review, azure, progress, persist, now = () => Date.now(), settleMs = UNCERTAIN_SETTLE_MS }) {
  const items = publicationItems(review.plan);
  const ledger = review.publication ??= new Map();
  const current = await azure.versions(run, review.snapshot);
  if (current.status !== 'active') return { status: 'INCOMPLETE', reason: `The PR is ${current.status}; nothing was posted.` };
  if (current.head !== review.snapshot.head) {
    return { status: 'STALE', reason: `The PR source commit changed after the review (reviewed ${review.snapshot.head.slice(0, 12)}, current ${current.head.slice(0, 12)}). Run a new review before commenting.` };
  }
  const present = markersInThreads(await azure.threads(run, review.snapshot));
  const record = (item, entry) => ledger.set(item.marker, {
    ...(item.kind === 'summary' ? { kind: 'summary' } : { kind: 'inline', findingId: item.findingId, path: item.path, startLine: item.startLine }),
    ...entry, at: new Date(now()).toISOString() });
  let written = 0;
  for (const [index, item] of items.entries()) {
    if (!run.active) throw new Error(run.reason || 'Publication stopped.');
    if (present.has(item.marker)) { record(item, { state: 'ALREADY_PRESENT', threadId: present.get(item.marker) }); continue; }
    const earlier = ledger.get(item.marker);
    if (['SENDING', 'UNCERTAIN'].includes(earlier?.state) && !(now() - Date.parse(earlier.at) >= settleMs)) {
      earlier.state = 'UNCERTAIN';
      continue;
    }
    // Saved before sending: a stop or crash mid-request leaves SENDING, which
    // the next run treats as uncertain.
    record(item, { state: 'SENDING' });
    await persist?.();
    try {
      const created = await azure.createThread(run, review.snapshot, item);
      record(item, { state: 'POSTED', threadId: created.threadId, ...(created.contentMatches === false ? { contentMismatch: true } : {}) });
    } catch (error) {
      if (!run.active) throw error;
      record(item, { state: error?.uncertain ? 'UNCERTAIN' : 'FAILED', error: String(error?.message ?? error).slice(0, 600) });
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
  const reason = uncertain ? `${uncertain} item(s) may still be created by an earlier attempt whose outcome is unknown; they are not posted again until their marker appears or ${Math.round(settleMs / 60000)} minutes have passed since that attempt. Run the same command again later.` : undefined;
  return { status, readBack, ...(reason ? { reason } : {}), counts: Object.fromEntries([...new Set(states)].map(state => [state, states.filter(s => s === state).length])) };
}
