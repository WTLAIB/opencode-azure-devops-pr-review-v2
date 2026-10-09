// Comment planning (model pages) and deterministic, idempotent publication.
import { confirmedFindings, publicationItems, evaluatePlanPage, planRepairPrompt, assemblePlan } from './comments.mjs';
import { observationIndex, anchorObservations, compactDispositions, textPages, itemPages, PAGE_CHARACTERS } from './comment-data.mjs';
import { markersInThreads } from './azure.mjs';
import { parseModelJSON } from './output.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
// A short finding can still need substantial source inspection. Bound each
// page's working set; every remaining finding gets its own page.
export const PLANNING_FINDINGS_PER_PAGE = 4;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const evidenceKeys = review => [...new Set((review.commentEvidence ?? []).map(item =>
  JSON.stringify([item.tool, canonical(item.input), item.result?.sha256])))].sort();

async function planningInput(review, store, findings, report, work, continuation, prepared) {
  const packedFindings = await Promise.all(findings.map(async finding => Object.fromEntries(await Promise.all(
    Object.entries(finding).map(async ([key, value]) => [key, await store.pack(value, 3000)])))));
  const { files, changes, description, ...snapshot } = review.snapshot;
  return {
    reviewId: review.id,
    snapshot: { ...snapshot, files: await store.pack(files), description: await store.pack(description ?? '', 3000) },
    outputLanguage: review.outputLanguage, findings: packedFindings,
    report: await store.pack(report),
    reportReference: await store.put(review.final.report ?? ''),
    dispositions: await store.pack(compactDispositions(review.final.dispositions)),
    reviewWarnings: await store.pack(review.final.reviewWarnings ?? []),
    evidenceIndex: await observationIndex(store, review.toolText ?? []),
    priorPlanning: prepared.length ? await store.put(prepared.map(item => JSON.stringify(item)).join('\n') + '\n', 'jsonl') : undefined,
    workEvidence: review.commentEvidence?.length ? await store.put(review.commentEvidence.map(item => JSON.stringify(item)).join('\n') + '\n', 'jsonl') : undefined,
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
export async function prepareComments(review, store, invoke, { progress } = {}) {
  const all = confirmedFindings(review);
  const groups = itemPages(all, PAGE_CHARACTERS, PLANNING_FINDINGS_PER_PAGE);
  const reports = textPages(review.final.report ?? '');
  const count = Math.max(groups.length, reports.length, 1);
  const pages = [], prepared = [], signatures = new Set();
  let summaryWritten = false;
  for (let index = 0; index < count; index++) {
    let pending = groups[index] ?? [], continuation;
    const report = reports[index]?.text ?? '';
    progress?.(`Planning comments, page ${index + 1}/${count}`);
    do {
      const assigned = pending;
      const payload = await planningInput(review, store, assigned, report,
        { kind: 'plan', page: index + 1, pages: count, allowSummary: !summaryWritten,
          ...(reports[index] ? { reportRange: { start: reports[index].start, end: reports[index].end } } : {}) },
        continuation, prepared);
      const scoped = async answer => {
        const parsed = parseModelJSON(answer, { keys: ['status', 'comments', 'skipped'] });
        const comments = Array.isArray(parsed.value?.comments) ? parsed.value.comments : [];
        return { ...review, toolText: await anchorObservations(store, review.toolText ?? [], comments, review.snapshot.head) };
      };
      const page = await invoke(payload, {
        async evaluate(answer) {
          const { result, issues, corrections } = evaluatePlanPage(answer, { review: await scoped(answer), assigned });
          return { result: result && { ...result, corrections }, issues, repairPrompt: issues.length ? planRepairPrompt(issues) : undefined };
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
 * Publish a saved plan with deterministic Azure DevOps calls.
 * - Refuses if the PR is no longer active or its source commit changed.
 * - Skips items whose marker already exists on the PR (idempotent re-runs).
 * - Reads every created marker back from Azure DevOps.
 */
export async function publishPlan({ run, review, azure, progress, persist }) {
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
    ...entry, at: new Date().toISOString() });
  let written = 0;
  for (const [index, item] of items.entries()) {
    if (!run.active) throw new Error(run.reason || 'Publication stopped.');
    if (present.has(item.marker)) { record(item, { state: 'ALREADY_PRESENT', threadId: present.get(item.marker) }); continue; }
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
      else if (entry.state === 'UNCERTAIN') entry.state = 'FAILED';
    }
  } catch (error) {
    if (!run.active) throw error;
    readBack = `unavailable: ${String(error?.message ?? error).slice(0, 300)}`;
  }
  await persist?.();
  const states = items.map(item => ledger.get(item.marker).state);
  const succeeded = states.filter(state => ['VERIFIED', 'ALREADY_PRESENT', 'POSTED'].includes(state)).length;
  const status = succeeded === items.length ? 'POSTED' : succeeded ? 'PARTIALLY_POSTED' : 'FAILED';
  return { status, readBack, counts: Object.fromEntries([...new Set(states)].map(state => [state, states.filter(s => s === state).length])) };
}
