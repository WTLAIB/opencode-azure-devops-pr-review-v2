// Paginate comment work, not review judgments. Every page receives a new exact
// admission and the existing role/model/permission/cancellation contract.
import { confirmedFindings, publicationItems, validateCommentPlan } from './comments.mjs';
import { observationIndex, anchorObservations, compactDispositions, findingScope,
  publicationPage, textPages, itemPages, PAGE_CHARACTERS } from './comment-data.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
export const publicationPages = plan => itemPages(publicationItems(plan)).map(items => publicationPage(plan, items));

async function planningInput(review, store, findings, report, work, continuation, prepared) {
  const packedFindings = await Promise.all(findings.map(async finding => Object.fromEntries(await Promise.all(
    Object.entries(finding).map(async ([key, value]) => [key, await store.pack(value, 3000)])))));
  return { reviewId: review.id, target: review.target,
    snapshot: { ...review.snapshot, files: await store.pack(review.snapshot.files) },
    outputLanguage: review.outputLanguage, findings: packedFindings,
    report: await store.pack(report),
    reportReference: work.kind === 'plan' ? await store.put(review.final.report ?? '') : undefined,
    dispositions: work.kind === 'publication-check' ? [] : await store.pack(compactDispositions(review.final.dispositions)),
    reviewWarnings: await store.pack(review.final.reviewWarnings ?? []),
    evidenceIndex: work.kind === 'publication-check' ? undefined : await observationIndex(store, review.toolText ?? []),
    priorPlanning: prepared.length ? await store.put(prepared.map(item => JSON.stringify(item)).join('\n') + '\n', 'jsonl') : undefined,
    workEvidence: review.commentEvidence?.length ? await store.put(review.commentEvidence.map(item => JSON.stringify(item)).join('\n') + '\n', 'jsonl') : undefined,
    continuation: continuation ? await store.pack(continuation, 3000) : undefined,
    commentWork: work,
  };
}

export async function prepareComments(review, store, invoke) {
  const all = confirmedFindings(review), groups = itemPages(all), reports = textPages(review.final.report ?? '');
  const count = Math.max(groups.length, reports.length, 1), parts = [], prepared = [], signatures = new Set();
  let intro;
  for (let index = 0; index < count; index++) {
    let pending = groups[index] ?? [], continuation;
    const report = reports[index]?.text ?? '';
    do {
      const payload = await planningInput(review, store, pending, report,
        { kind: 'plan', page: index + 1, pages: count, reportRange: reports[index] && { start: reports[index].start, end: reports[index].end }, allowSummary: !intro }, continuation, prepared);
      const answer = await invoke(payload, async (result, record) => {
        const more = result.status === 'CONTINUE';
        if (more && !text(result.continuation)) throw new Error('A comment checkpoint must identify completed work, exact data references and remaining work.');
        const ids = more ? [...(result.comments ?? []), ...(result.skipped ?? [])].map(item => item.findingId) : pending.map(item => item.id);
        const allowed = new Set(pending.map(item => item.id));
        for (const id of [...(result.comments ?? []), ...(result.skipped ?? [])].map(item => item.findingId)) {
          if (!allowed.has(id) && all.some(item => item.id === id)) throw new Error('Comment page referenced an unassigned finding.');
        }
        const scope = findingScope(review, ids);
        scope.toolText = await anchorObservations(store, review.toolText ?? [], result.comments ?? [], review.snapshot.head);
        const { continuation: next, ...body } = result;
        const plan = validateCommentPlan({ ...body, status: more ? 'READY' : body.status }, scope);
        if (plan.anchorRestorations) record.anchorRestorations = plan.anchorRestorations;
        if (plan.locationRestorations) record.locationRestorations = plan.locationRestorations;
        return { ...body, continuation: next, comments: (result.comments ?? []).map((comment, i) => ({ ...comment,
          anchor: plan.comments[i].anchor, startLine: plan.comments[i].startLine, endLine: plan.comments[i].endLine })) };
      });
      if (!intro && text(answer.summary) && answer.summary.length <= 1200 && !/<!--|-->/.test(answer.summary)) intro = answer.summary;
      parts.push(answer);
      prepared.push(await store.object(answer));
      const accounted = new Set([...answer.comments, ...answer.skipped].map(item => item.findingId));
      pending = pending.filter(item => !accounted.has(item.id));
      continuation = answer.status === 'CONTINUE' ? answer.continuation : undefined;
      if (continuation) {
        const signature = JSON.stringify([index, pending.map(item => item.id), continuation]);
        if (signatures.has(signature)) throw new Error('Comment planning checkpoint repeated without progress; no comments were published.');
        signatures.add(signature);
      }
    } while (continuation);
  }
  const result = { status: 'READY', comments: parts.flatMap(part => part.comments),
    skipped: parts.flatMap(part => part.skipped).filter((item, index, rows) => all.some(f => f.id === item.findingId) || rows.findIndex(row => row.findingId === item.findingId) === index),
    summary: intro, summaryDetails: [...new Set(parts.map(part => part.summaryDetails).filter(text))].join('\n\n') };
  return validateCommentPlan(result, { ...review, toolText: [] });
}

export async function checkPublication(review, store, invoke) {
  const pages = publicationPages(review.plan), checkpoints = new Set();
  for (let index = 0; index < pages.length; index++) {
    let continuation;
    do {
      const payload = await planningInput(review, store, [], '',
        { kind: 'publication-check', page: index + 1, pages: pages.length }, continuation, []);
      payload.savedItems = await store.pack(await Promise.all(publicationItems(pages[index]).map(item => publisherItem(store, item))));
      const answer = await invoke(payload, (result, record) => {
        if (!['READY', 'CONTINUE'].includes(result.status) || !Array.isArray(result.comments) || result.comments.length ||
            !Array.isArray(result.skipped) || result.skipped.length || (result.status === 'CONTINUE' && !text(result.continuation))) {
          throw new Error(`Publication checks incomplete: ${text(result.reason) ? result.reason : 'The read-only checker did not finish the required checks.'}`);
        }
        if (!record.completedTools) throw new Error('Publication checks performed no tool reads; no publisher was started.');
        return result;
      });
      continuation = answer.status === 'CONTINUE' ? answer.continuation : undefined;
      if (continuation) {
        const signature = JSON.stringify([index, continuation]);
        if (checkpoints.has(signature)) throw new Error('Publication checking checkpoint repeated without progress; no publisher was started.');
        checkpoints.add(signature);
      }
    } while (continuation);
  }
}

export async function publisherItem(store, item) {
  const { kind, findingId, severity, path, startLine, endLine, startOffset, endOffset, marker, content } = item;
  const large = content.length > PAGE_CHARACTERS;
  return { kind, findingId, severity, path, startLine, endLine, startOffset, endOffset, marker,
    // Whole-marker restoration copies the exact saved bytes before execution;
    // the model never has to regenerate a large saved summary.
    content: large ? `${kind === 'summary' ? '## PR Review Summary' : `${severity === 'high' ? '🔴' : '🟡'} ${severity}: Saved comment`}\n\n[AZPR saved text; restored verbatim before the tool executes.]\n\n${marker}` : content,
    ...(large ? { savedContent: await store.put(content) } : {}) };
}
