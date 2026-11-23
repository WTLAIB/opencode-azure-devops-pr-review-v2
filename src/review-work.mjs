/**
 * Review orchestration: a runtime-owned snapshot, sharded reviewer passes, the
 * runtime's own checks of each finding's form and source, a duplicate check of
 * what different sessions reported in one file, a severity rating and a
 * deterministic final version recheck. Every mode runs this pipeline with its
 * own list of models: pass i of every shard runs with entry i. No stage
 * verifies a finding: the runtime never judges whether a defect is real.
 */
import { ROLES, reviewerRoles, roleFor, stageModel, raterState } from './config.mjs';
import { searchLimitation } from './attribution.mjs';
import { evaluateInitial, evaluateDuplicates, evaluateRatings, duplicateRepairPrompt, ratingRepairPrompt, reviewRepairPrompt, reviewFollowUpPrompt, syntaxProblem, locationPath, FINDING_FIELDS } from './output.mjs';

export { locationPath };
const text = value => typeof value === 'string' && value.trim().length > 0;
/** How a reviewer session is named in notices, titles and receipts: its pass (when a mode has several) and its shard. */
const sessionLabel = task => [task.passes > 1 ? `pass ${task.pass + 1}/${task.passes}` : '',
  task.count > 1 || task.part ? `shard ${task.index + 1}/${task.count}${task.part ?? ''}` : ''].filter(Boolean).join(' ');
/** The reviewer session a finding comes from, as the record names it: its shard and, with several passes, its pass. */
const sessionOf = task => `${task.index + 1}/${task.count}${task.part ?? ''}${task.passes > 1 ? ` pass ${task.pass + 1}` : ''}`;

/** Sorted paths keep a directory's files in the same shard. */
export function shardFiles(files, size) {
  if (!files.length) return [[]];
  const sorted = [...files].sort();
  const shards = [];
  for (let index = 0; index < sorted.length; index += size) shards.push(sorted.slice(index, index + size));
  return shards;
}

/** Run tasks with bounded parallelism; results keep the task order. */
export async function runPool(tasks, limit, worker) {
  const results = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker(tasks[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, lane));
  return results;
}

/** The snapshot fields every model stage receives. Large lists are packed. */
export async function snapshotForModel(snapshot, store) {
  const { files, changes, description, commits, snapshotWarnings, iteration, ...rest } = snapshot;
  return { ...rest, fileCount: files.length, files: await store.pack(files), description: await store.pack(description ?? '', 4000),
    commits: await store.pack(commits ?? [], 8000) };
}

/** The PR snapshot every review starts from, with its warnings. */
async function prepareSnapshot(ctx, run, request) {
  const { azure, progress } = ctx;
  const store = await ctx.dataFor(run);
  const snapshot = await azure.snapshot(run, request.target);
  run.snapshot = snapshot;
  const warnings = [...(snapshot.snapshotWarnings ?? [])];
  if (snapshot.status !== 'active') warnings.push(`The PR status is ${snapshot.status}.`);
  if (!snapshot.filesComplete) warnings.push('Azure DevOps returned an incomplete changed-file list; reviewers were asked to find the remaining paths, which are not verified as complete.');
  progress(run, `PR #${snapshot.prId} at ${snapshot.head.slice(0, 10)}: ${snapshot.files.length} changed file(s)${snapshot.filesComplete ? '' : ' (partial list)'}.`);
  // A partial list asks reviewers to find the remaining paths; a complete empty one leaves nothing to review.
  if (!snapshot.files.length && snapshot.filesComplete) throw new Error(`PR #${snapshot.prId} has no changed files in its latest iteration; there is nothing to review.`);
  return { store, snapshot, warnings, modelSnapshot: await snapshotForModel(snapshot, store) };
}

/**
 * One reviewer session per task (a pass of a shard); a task that fills its
 * model context is split in half and both halves run, as parts of the same
 * pass. `handlerFor(task)` returns the stage handler that accepts answers.
 * Findings are numbered by each answer on its own (F-1, F-2, …): the runtime
 * gives the review's IDs once every pass has answered.
 */
function reviewRunner(ctx, run, request, { snapshot, modelSnapshot, handlerFor }) {
  const { runStage, progress, settings } = ctx;
  const changes = new Map(snapshot.changes.map(change => [change.path, change]));
  async function reviewTask(task) {
    const payload = {
      prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
      assignment: { shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, files: task.files, changes: task.files.map(path => changes.get(path)).filter(Boolean),
        firstFindingId: `${LOCAL_PREFIX}-${task.base ?? 1}`, discoverFiles: !snapshot.filesComplete },
    };
    try {
      const result = await runStage(run, task.role, payload, handlerFor(task), { label: sessionLabel(task) });
      return [{ task, result }];
    } catch (error) {
      if (!run.active) throw error;
      if (error?.failureClass === 'overflow' && task.files.length > 1) {
        const middle = Math.ceil(task.files.length / 2);
        progress(run, `${ROLES[task.role].label}${sessionLabel(task) ? ` ${sessionLabel(task)}` : ''} reached its context limit on ${task.files.length} files; splitting the shard in two.`);
        const halves = [task.files.slice(0, middle), task.files.slice(middle)].map((files, half) => ({ ...task, files, part: `${task.part ?? ''}${half ? 'b' : 'a'}` }));
        return [...await reviewTask(halves[0]), ...await reviewTask(halves[1])];
      }
      return [{ task, error }];
    }
  }
  return reviewTask;
}

/** Deterministic final version recheck. Only a changed source commit is stale. */
async function finalRecheck(ctx, run, snapshot, warnings) {
  let freshness;
  try {
    const now = await ctx.azure.versions(run, snapshot);
    freshness = { ...now, checkedAt: new Date().toISOString() };
    if (now.base && now.base !== snapshot.base) warnings.push(`The PR base moved during the review (${snapshot.base.slice(0, 10)} → ${now.base.slice(0, 10)}). Findings describe the PR source compared with the reviewed base.`);
    if (now.status !== 'active') warnings.push(`The PR is now ${now.status}.`);
  } catch (error) {
    if (!run.active) throw error;
    freshness = { error: String(error?.message ?? error) };
    warnings.push(`The final version recheck failed (${freshness.error}); publication re-checks the source commit before posting.`);
  }
  const stale = Boolean(freshness.head && freshness.head !== snapshot.head);
  if (stale) warnings.unshift(`The PR source changed during the review (${snapshot.head.slice(0, 10)} → ${freshness.head.slice(0, 10)}). Run a new review before commenting.`);
  return { freshness, stale };
}

// ------------------------------------------------------------------ findings and their checks

// The prefix of finding IDs: an answer numbers its own findings F-1, F-2, …, and the review's IDs use it too.
const LOCAL_PREFIX = 'F';
const LOCATION = /^(?:(head|base):)?(\/[^:\n]+?)(?::(\d+)(?:-(\d+))?)?\s*$/;
const lineCount = source => {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
};
export const REPORTED_REASON = 'Reported by its reviewer, which checked it against the source it read; it passed the runtime\'s format and source checks. No separate verification ran.';

/**
 * Check a finding's location against the reviewed commits: the file
 * exists at that version, the lines are in range and this session's own tools
 * showed that file's content. Only form and source are checked, never whether
 * the defect is real. `repairable` problems go back to the reviewer; `inline`
 * says whether the location is on a changed HEAD file.
 * @param {object} finding
 * @param {{snapshot: object, azure: object, run: object, reads?: Set<string>}} context
 */
export async function checkLocation(finding, { snapshot, azure, run, reads }) {
  const match = LOCATION.exec(String(finding.location ?? '').trim());
  if (!match) return { problem: `location ${JSON.stringify(finding.location ?? '')} must be head:/path:line or head:/path:start-end (base: only for content that exists only in BASE).`, repairable: true };
  const side = match[1] ?? 'head', path = match[2], start = match[3] ? Number(match[3]) : null, end = match[4] ? Number(match[4]) : start;
  const version = side === 'base' ? snapshot.base : snapshot.head, label = side.toUpperCase();
  const change = (snapshot.changes ?? []).find(item => item.path === path);
  let file;
  try { file = await azure.readFile(run, snapshot, path, version); }
  catch (error) {
    if (!run.active) throw error;
    if (error?.kind !== 'not-found') return { problem: `the runtime could not check ${path} at ${label} (${String(error?.message ?? error).slice(0, 200)}).`, repairable: false };
    const renamed = (snapshot.changes ?? []).find(item => item.originalPath === path)?.path;
    const hint = side === 'head' && change?.changeType?.includes('delete') ? ` It is deleted in this PR: use base:${path}:<line> for the removed content, or locate the finding at the HEAD code it affects.`
      : side === 'head' && renamed ? ` It was renamed to ${renamed} in HEAD.`
        : side === 'base' && change?.originalPath ? ` Its BASE path is ${change.originalPath}.`
          : side === 'base' && change?.changeType?.includes('add') ? ' It is added in this PR: use head:.' : '';
    return { problem: `${path} does not exist at ${label}.${hint}`, repairable: true };
  }
  if (file.binary || file.tooLarge) {
    return { problem: `${path} is ${file.binary ? 'a binary file' : 'larger than AZPR reads'} at ${label}, so its lines cannot be read: locate the finding at the readable code or configuration that supports it, or move it to report.`, repairable: true };
  }
  if (!start) return { problem: `location ${finding.location} needs a line or line range.`, repairable: true };
  const lines = lineCount(file.text);
  if (end < start || end > lines) return { problem: `lines ${start}${end === start ? '' : `-${end}`} are outside ${path} at ${label}, which has ${lines} line(s).`, repairable: true };
  if (!reads?.has(`${version}\n${path}`)) {
    return { problem: `this session did not read ${path} at ${label} with azpr_read_diff or azpr_read_file; read it and confirm the location, or move the concern to report.`, repairable: true };
  }
  return { ok: true, inline: side === 'head' && Boolean(change) && !change.changeType?.includes('delete') };
}


/**
 * A parsed reviewer answer is usable only with a findings array and at least
 * one reviewed file or accepted finding. Uses the answer's own IDs, which key
 * `invalid` and `checks`.
 */
export function usableAnswer(result, files) {
  if (!result?.structured || result.envelope?.findings !== true) return false;
  const reviewed = result.envelope?.coverage ? result.coverage.files.filter(path => files.includes(path)) : [];
  const accepted = result.findings.filter(finding => !result.invalid?.[finding.id]?.length && result.checks?.[finding.id]?.ok).length;
  return reviewed.length > 0 || accepted > 0;
}

/**
 * Accept one reviewer answer: the review contract with a required location,
 * plus the runtime's location and source checks. Field and location problems
 * get correction turns; what is still wrong afterwards is NEEDS_INFO.
 * `usable` follows usableAnswer. A usable PARTIAL answer with nothing to repair
 * that names unfinished work (gaps or assigned files not reviewed) also gets a
 * `followUp`: the runtime may ask the same session once to continue.
 */
export async function evaluateReview(answer, { task, snapshot, azure, run, reads }) {
  const { result, issues } = evaluateInitial(answer, { prefix: LOCAL_PREFIX, assigned: task.files, inventory: snapshot.files, filesComplete: snapshot.filesComplete });
  // A plain object, so the stage record shows each finding's check.
  const checks = {};
  for (const finding of result.findings) {
    if (!Object.hasOwn(result.invalid, finding.id)) checks[finding.id] = await checkLocation(finding, { snapshot, azure, run, reads });
  }
  const all = [...issues, ...Object.entries(checks).filter(([, check]) => check.repairable).map(([id, check]) => `${id}: ${check.problem}`)];
  const checked = { ...result, checks };
  const usable = usableAnswer(checked, task.files);
  const uncovered = task.files.filter(path => !result.coverage.files.includes(path));
  const unfinished = result.status === 'PARTIAL' && (result.coverage.gaps.length > 0 || uncovered.length > 0);
  return { result: checked, issues: all, usable,
    repairPrompt: all.length ? reviewRepairPrompt(all, { parseOnly: !result.structured && syntaxProblem(all) }) : undefined,
    ...(usable && !all.length && unfinished ? { followUp: { prompt: reviewFollowUpPrompt({ gaps: result.coverage.gaps, uncovered }), gaps: result.coverage.gaps, uncovered } } : {}) };
}

// Records identical in every field: prose may differ in its whitespace, a location (a path and its lines) may not.
const findingKey = finding => JSON.stringify(FINDING_FIELDS.filter(key => key !== 'id').map(key => key === 'location'
  ? String(finding?.[key] ?? '').trim() : String(finding?.[key] ?? '').replace(/\s+/g, ' ').trim()));
const findingOnly = finding => Object.fromEntries(FINDING_FIELDS.filter(key => key !== 'id' && Object.hasOwn(finding, key)).map(key => [key, finding[key]]));

/**
 * The order in which a review numbers its findings: by side (HEAD first), path
 * and lines, then by where each was reported (pass, shard, part of a split
 * shard, place in its answer). Nothing here depends on which session finished
 * first or on the IDs a model wrote. A finding without a usable location comes
 * after those with one.
 */
function placeKey(entry) {
  const match = LOCATION.exec(String(entry.finding.location ?? '').trim());
  const start = match?.[3] ? Number(match[3]) : 0;
  return { located: match ? 0 : 1, side: match?.[1] === 'base' ? 1 : 0, path: match?.[2] ?? '', start, end: match?.[4] ? Number(match[4]) : start };
}
function byPlaceAndSource(a, b) {
  const x = placeKey(a), y = placeKey(b);
  return x.located - y.located || x.side - y.side || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || x.start - y.start || x.end - y.end ||
    a.task.pass - b.task.pass || a.task.index - b.task.index || ((a.task.part ?? '') < (b.task.part ?? '') ? -1 : (a.task.part ?? '') > (b.task.part ?? '') ? 1 : 0) || a.position - b.position;
}

/**
 * The findings a duplicate check compares: those still reported on one side of
 * one file, where two of them come from different reviewer sessions (a finding
 * that stands for identical records of several sessions shares each of them). Groups
 * are sorted by side and path and keep the findings in the review's order, so a
 * check's input is the same whatever order the sessions finished in.
 * @param {{id: string, status: string, finding?: object, sessions: string[]}[]} dispositions
 */
export function duplicateGroups(dispositions) {
  const groups = new Map();
  for (const entry of dispositions) {
    if (entry.status !== 'REPORTED') continue;
    const match = LOCATION.exec(String(entry.finding.location ?? '').trim());
    if (!match) continue;
    const side = match[1] ?? 'head', key = `${side}\n${match[2]}`;
    if (!groups.has(key)) groups.set(key, { side, path: match[2], items: [] });
    groups.get(key).items.push(entry);
  }
  // Worth a check only where two findings could be merged at all: two that share no session.
  const comparable = items => items.some((a, index) => items.slice(index + 1).some(b => !a.sessions.some(session => b.sessions.includes(session))));
  return [...groups.entries()].filter(([, group]) => comparable(group.items))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => group);
}

/** Findings one severity-rating session receives. */
const RATING_BATCH = 25;
const RATING_DESCRIPTION_CHARACTERS = 4000;
// What a rating session sees of a finding: its text and its place, never a level, a count or where it came from.
const RATED_FIELDS = Object.freeze(['summary', 'location', 'evidence', 'counterevidence', 'suggestion']);

/**
 * Severity rating: sessions without tools rate the findings that are still
 * reported from their text alone, without the level their reviewer gave them,
 * so that the findings of different reviewers are levelled on one scale. It
 * runs with models.<mode>.rater, or with the first reviewer model where that is
 * empty; rater: false switches it off. A finding the rating does not cover, and
 * every finding of a failed batch, keeps its reviewer's severity, which the
 * record keeps in any case (`reviewerSeverity`). Returns what the method
 * description says of the rating.
 */
async function rateSeverities(ctx, run, { snapshot, dispositions, warnings }) {
  const { runStage, progress, settings } = ctx;
  const rater = roleFor(run.profile, 'rating');
  const state = raterState(settings, run.profile);
  if (state === 'off' || !stageModel(settings, rater)) return { state: 'off', sessions: 0, failed: 0, rated: 0, kept: 0 };
  const rated = dispositions.filter(row => row.status === 'REPORTED');
  const outcome = { state, model: stageModel(settings, rater), sessions: 0, failed: 0, rated: 0, kept: 0 };
  if (!rated.length) return outcome;
  const batches = [];
  for (let at = 0; at < rated.length; at += RATING_BATCH) batches.push(rated.slice(at, at + RATING_BATCH));
  outcome.sessions = batches.length;
  progress(run, `Severity rating: ${rated.length} finding(s) in ${batches.length} session(s).`);
  const description = text(snapshot.description) ? snapshot.description : '';
  const change = { title: snapshot.title ?? '', description: description.length > RATING_DESCRIPTION_CHARACTERS
    ? `${description.slice(0, RATING_DESCRIPTION_CHARACTERS)} […]` : description };
  const outcomes = await runPool(batches.map((items, index) => ({ items, index, count: batches.length })), settings.workflow.parallelSessions, async task => {
    const ids = task.items.map(item => item.id);
    const payload = {
      outputLanguage: settings.outputLanguage, change,
      assignment: { kind: 'rating', findingIds: ids,
        findings: task.items.map(item => ({ id: item.id, ...Object.fromEntries(RATED_FIELDS.filter(key => Object.hasOwn(item.finding, key)).map(key => [key, item.finding[key]])) })) },
    };
    try {
      const result = await runStage(run, rater, payload, {
        evaluate(answer) {
          const { result, issues } = evaluateRatings(answer, { ids });
          // Usable where it rated something: its valid ratings stand if a correction turn fails.
          return { result, issues, usable: result.structured && result.ratings.length > 0,
            repairPrompt: issues.length ? ratingRepairPrompt(issues, { parseOnly: !result.structured && syntaxProblem(issues) }) : undefined };
        },
      }, { label: task.count > 1 ? `${task.index + 1}/${task.count}` : '' });
      return { ...task, result };
    } catch (error) {
      if (!run.active) throw error;
      return { ...task, error };
    }
  });
  if (!run.active) throw new Error(run.reason || 'Review stopped.');
  for (const { items, result, error } of outcomes) {
    if (!result) {
      outcome.failed++;
      outcome.kept += items.length;
      warnings.push(`The severity rating failed (${error?.message ?? 'unknown error'}); its ${items.length} finding(s) keep their reviewer's severity.`);
      continue;
    }
    const byId = new Map(result.ratings.map(row => [row.id, row]));
    for (const item of items) {
      const row = byId.get(item.id);
      if (!row) { outcome.kept++; continue; }
      outcome.rated++;
      item.finding = { ...item.finding, severity: row.severity };
      item.ratedSeverity = row.severity;
    }
    warnings.push(...result.warnings.map(message => `Severity rating: ${message}`));
  }
  return outcome;
}

/**
 * One review. Each entry of the mode's model list is a pass: an independent
 * reviewer session per shard that covers functional and failure focus and
 * checks its own findings against the source. The runtime then checks each
 * finding's form and source (REPORTED, or NEEDS_INFO), numbers the findings in
 * a fixed order, removes records identical in every field, has a duplicate
 * check merge repeated reports of one defect, and has the findings rated.
 * Status, coverage and method are reported separately: a parsed answer without
 * a usable review never makes a commentable COMPLETE, zero findings never hide
 * files that were not reviewed, and a pass that fails leaves the others' work.
 * @param {object} ctx { azure, runStage, progress, settings, dataFor }
 * @param {object} run
 * @param {object} request parsed /pr-review arguments
 */
export async function runReview(ctx, run, request) {
  const { azure, runStage, progress, settings } = ctx;
  const { store, snapshot, warnings, modelSnapshot } = await prepareSnapshot(ctx, run, request);
  const shards = shardFiles(snapshot.files, settings.workflow.shardFiles);
  const roles = reviewerRoles(settings, run.profile), passes = roles.length;
  // One pool for every pass of every shard: the session limit holds for the review, not per pass.
  // A shard's sessions number their findings in a range of the shard's own (F-1001, F-2001, …), apart from the
  // review's IDs, which the runtime gives once every pass has answered: a reference in an answer's text to one of its
  // own findings can then not be taken for another finding of the review. Every pass of a shard gets the same range,
  // so that no pass's input differs from another's.
  const tasks = roles.flatMap((role, pass) => shards.map((files, index) => ({ role, pass, passes, files, index, count: shards.length, base: (index + 1) * 1000 + 1 })));
  progress(run, `Review: ${tasks.length} session(s) for ${shards.length} shard(s)${passes > 1 ? ` in ${passes} independent passes` : ''}; no separate verification follows.`);
  const reviewTask = reviewRunner(ctx, run, request, { snapshot, modelSnapshot, handlerFor: task => ({
    evaluate: (answer, _previous, session) => evaluateReview(answer, { task, snapshot, azure, run, reads: session?.reads }),
    // Only a shard of several files can be split: one of one file keeps an answer it gave before its context overflowed.
    splittable: task.files.length > 1,
  }) });
  const outcomes = (await runPool(tasks, settings.workflow.parallelSessions, reviewTask)).flat();
  if (!run.active) throw new Error(run.reason || 'Review stopped.');
  if (!outcomes.some(outcome => outcome.result)) throw new Error(`Every review session failed: ${[...new Set(outcomes.map(outcome => outcome.error?.message).filter(Boolean))].slice(0, 3).join(' | ')}`);

  const collected = [], reports = [], answerReports = [], initialReports = [], unusableTexts = [], discovered = new Set();
  // Per pass: the assigned paths a usable answer reported as reviewed. Retries, follow-ups and the parts of a
  // split shard belong to their pass; a path counts once per pass however often it is named.
  const reviewedBy = roles.map(() => new Set());
  const coverage = Object.fromEntries(roles.map(role => [role, { assigned: 0, covered: 0, failedFiles: [], gaps: [] }]));
  // Per pass, the shard sessions whose outcome its coverage rests on: a split shard counts its two halves, not the
  // session that overflowed, and a session retried after a transient failure counts once. The stage records and the
  // receipt list every session that ran.
  const passRecords = roles.map((role, pass) => ({ pass: pass + 1, model: stageModel(settings, role), sessions: 0, failed: 0 }));
  let usable = 0, failedSessions = 0, reviewerGaps = false;
  for (const { task, result, error } of outcomes) {
    const label = sessionLabel(task), named = `The review ${label || 'session'}`, entry = coverage[task.role], record = passRecords[task.pass];
    entry.assigned += task.files.length;
    record.sessions++;
    if (!result) {
      failedSessions++; record.failed++;
      entry.failedFiles.push(...task.files);
      warnings.push(`${named} failed (${error?.message ?? 'unknown error'}); its ${task.files.length || 'unknown'} file(s) were not reviewed${passes > 1 ? ' in this pass' : ''}.`);
      continue;
    }
    const isUsable = usableAnswer(result, task.files);
    const reviewed = result.envelope?.coverage ? [...new Set(result.coverage.files.filter(path => task.files.includes(path)))] : [];
    if (!isUsable) {
      failedSessions++; record.failed++;
      entry.failedFiles.push(...task.files);
      warnings.push(`${named} returned no usable review (${result.structured ? 'no reviewed file or usable finding' : 'no structured answer'}); its ${task.files.length} file(s) count as not reviewed${passes > 1 ? ' in this pass' : ''}.`);
      if (text(result.report)) unusableTexts.push({ session: sessionOf(task), label, text: result.report });
    } else {
      usable++;
      for (const path of reviewed) reviewedBy[task.pass].add(path);
      entry.covered += reviewed.length;
      entry.gaps.push(...result.coverage.gaps);
      if (result.coverage.gaps.length) reviewerGaps = true;
      for (const path of result.additionalFiles) discovered.add(path);
      if (text(result.report)) answerReports.push({ session: sessionOf(task), label, text: result.report });
    }
    // The session that reported a finding is recorded by the runtime, never derived from IDs. The checks are
    // keyed by the answer's own IDs, which stay with the finding (`localId`).
    const session = sessionOf(task);
    result.findings.forEach((finding, position) => {
      const problems = result.invalid?.[finding.id] ?? [], check = result.checks?.[finding.id];
      const verdict = !isUsable ? { status: 'NEEDS_INFO', reason: 'The finding comes from a reviewer answer that was not usable. [Runtime: not eligible for comments.]' }
        : problems.length ? { status: 'NEEDS_INFO', reason: `The finding is ${problems.join('; ')} after the correction turns. [Runtime: not eligible for comments.]` }
          : !check?.ok ? { status: 'NEEDS_INFO', reason: `The location check failed: ${check?.problem ?? 'it was not checked.'} [Runtime: not eligible for comments.]` }
            : { status: 'REPORTED', reason: REPORTED_REASON, inline: check.inline };
      collected.push({ ...verdict, finding: findingOnly(finding), localId: finding.id, task, session, position });
    });
    initialReports.push({ role: task.role, shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, ...(passes > 1 ? { pass: task.pass + 1 } : {}), files: task.files.length, status: result.status,
      structured: result.structured, usable: isUsable, report: result.report, gaps: result.coverage.gaps, warnings: result.warnings });
    warnings.push(...result.warnings.map(message => `Review${label ? ` ${label}` : ''}: ${message}`));
  }

  // The review's IDs, in a fixed order, before anything is merged.
  collected.sort(byPlaceAndSource);
  const findings = [], dispositions = [];
  // What the answers wrote stays as they wrote it, quoted code included: a reference to one of an answer's own
  // findings uses that answer's ID, of its shard's range (which no finding of the review is given) unless the answer
  // left it. Above an answer's notes the runtime names the review ID of each of its own IDs the notes mention.
  const ownIds = new Map();
  collected.forEach((entry, index) => {
    if (!ownIds.has(entry.session)) ownIds.set(entry.session, new Map());
    ownIds.get(entry.session).set(entry.localId, `${LOCAL_PREFIX}-${index + 1}`);
  });
  const reportOf = ({ session, label, text: body }) => {
    const ids = ownIds.get(session) ?? new Map();
    const named = [...new Set(body.match(new RegExp(`\\b${LOCAL_PREFIX}-[1-9]\\d*\\b`, 'g')) ?? [])].filter(id => ids.has(id) && ids.get(id) !== id);
    const key = named.length ? `Finding IDs in these notes are this session's own: ${named.map(id => `${id} is ${ids.get(id)}`).join(', ')} in this review.\n\n` : '';
    return label ? `### ${label}\n\n${key}${body}` : `${key}${body}`;
  };
  reports.push(...answerReports.map(reportOf));
  collected.forEach((entry, index) => {
    const id = `${LOCAL_PREFIX}-${index + 1}`;
    findings.push({ ...entry.finding, id, origin: entry.task.role });
    dispositions.push({ id, status: entry.status, reason: entry.reason,
      ...(entry.status === 'REPORTED' ? { finding: entry.finding, inline: entry.inline, reviewerSeverity: entry.finding.severity } : { partialFinding: entry.finding }),
      shard: entry.session, pass: entry.task.pass + 1, localId: entry.localId, sessions: [entry.session] });
  });
  // Only records identical in every field are duplicates; findings on the same lines stay separate. The first in
  // the review's order stays, and it stands for the sessions that reported the same record as a usable finding.
  const kept = new Map();
  let duplicates = 0;
  for (const status of ['REPORTED', 'NEEDS_INFO']) for (const entry of dispositions.filter(row => row.status === status)) {
    const key = findingKey(entry.finding ?? entry.partialFinding);
    if (!kept.has(key)) { kept.set(key, entry); continue; }
    const first = kept.get(key);
    if (status === 'REPORTED' && first.status === 'REPORTED') first.sessions = [...new Set([...first.sessions, ...entry.sessions])];
    Object.assign(entry, { status: 'MERGED', mergedInto: first.id, reason: `Identical in every field to ${first.id}. [Runtime: exact duplicate.]`, mergedFinding: entry.finding ?? entry.partialFinding });
    delete entry.finding; delete entry.inline; delete entry.partialFinding;
    duplicates++;
  }
  if (duplicates) warnings.push(`Removed ${duplicates} exact duplicate finding(s); findings that differ in any field are kept.`);

  // The duplicate check: what different sessions reported on one side of one file is compared by the first
  // reviewer model. It only merges, and never two findings of one session; a failed check keeps every finding.
  const groups = duplicateGroups(dispositions);
  const duplicateCheck = { groups: groups.length, failed: 0, merged: 0, refused: 0 };
  if (groups.length) {
    progress(run, `Duplicate check: ${groups.length} file(s) hold findings from more than one reviewer session.`);
    const checker = roleFor(run.profile, 'dedupe');
    const checks = await runPool(groups.map((group, index) => ({ group, index, count: groups.length })), settings.workflow.parallelSessions, async task => {
      const ids = task.group.items.map(item => item.id);
      const sessions = Object.fromEntries(task.group.items.map(item => [item.id, item.sessions]));
      const candidates = task.group.items.map(({ id, sessions: reportedBy, finding }) => ({ ...finding, id, session: reportedBy.join(' + ') }));
      try {
        // Preparing the input is part of the check: a write that fails costs this file's check, not the review.
        const payload = {
          prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
          assignment: { kind: 'duplicates', file: task.group.path, side: task.group.side, findingIds: ids, findings: await store.pack(candidates, 40000) },
        };
        const result = await runStage(run, checker, payload, {
          evaluate(answer) {
            const { result, issues } = evaluateDuplicates(answer, { ids, sessions });
            // Usable where it decided something: its valid merges stand if a correction turn fails.
            return { result, issues, usable: result.structured && result.decided === true,
              repairPrompt: issues.length ? duplicateRepairPrompt(issues, { parseOnly: !result.structured && syntaxProblem(issues) }) : undefined };
          },
        }, { label: task.count > 1 ? `${task.index + 1}/${task.count}` : '' });
        return { ...task, result };
      } catch (error) {
        if (!run.active) throw error;
        return { ...task, error };
      }
    });
    if (!run.active) throw new Error(run.reason || 'Review stopped.');
    const byId = new Map(dispositions.map(row => [row.id, row]));
    for (const { group, result, error } of checks) {
      if (!result) {
        duplicateCheck.failed++;
        warnings.push(`The duplicate check of ${group.path} failed (${error?.message ?? 'unknown error'}); its ${group.items.length} findings stay reported and may include duplicates.`);
        continue;
      }
      // An answer without usable JSON, or without a list of merges, also after the correction turns, decided
      // nothing: a failed check, whose findings stay as they are.
      if (result.structured === false || result.decided !== true) duplicateCheck.failed++;
      duplicateCheck.refused += result.refused ?? 0;
      for (const merge of result.merges) {
        const entry = byId.get(merge.id), target = byId.get(merge.mergedInto);
        if (entry?.status !== 'REPORTED' || target?.status !== 'REPORTED') continue;
        target.sessions = [...new Set([...target.sessions, ...entry.sessions])];
        // What the kept finding stands for: each merged report with its session and the level its reviewer gave it.
        target.alsoReported = [...(target.alsoReported ?? []), { id: entry.id, sessions: entry.sessions, severity: entry.reviewerSeverity }, ...(entry.alsoReported ?? [])];
        Object.assign(entry, { status: 'MERGED', mergedInto: target.id, reason: `${merge.reason} [Runtime: merged by the duplicate check of independent reviewer sessions.]`, mergedFinding: entry.finding });
        delete entry.finding; delete entry.inline; delete entry.alsoReported;
        duplicateCheck.merged++;
      }
      if (text(result.report)) reports.push(`### Duplicate check: ${group.path}\n\n${result.report}`);
      warnings.push(...result.warnings.map(message => `Duplicate check of ${group.path}: ${message}`));
    }
    progress(run, `Duplicate check finished: ${duplicateCheck.merged} finding(s) merged into another session's finding.`);
  }
  // A record merged as an exact duplicate into a finding the duplicate check merged in turn names the finding that
  // stays, so that every merged ID leads to one that a person can see, adjust and comment on.
  const byIdAll = new Map(dispositions.map(row => [row.id, row]));
  for (const row of dispositions) {
    if (row.status !== 'MERGED') continue;
    const seen = new Set([row.id]);
    let target = byIdAll.get(row.mergedInto);
    while (target?.status === 'MERGED' && !seen.has(target.id)) { seen.add(target.id); target = byIdAll.get(target.mergedInto); }
    if (target && target.id !== row.mergedInto) row.mergedInto = target.id;
  }

  const rating = await rateSeverities(ctx, run, { snapshot, dispositions, warnings });

  const search = searchLimitation(run, settings);
  if (search) warnings.push(search);
  if (discovered.size) warnings.push(`Reviewers reported ${discovered.size} changed path(s) missing from Azure's list: ${[...discovered].slice(0, 20).join(', ')}${discovered.size > 20 ? ', ...' : ''}`);
  // Two numbers, of the changed files Azure listed: reviewed in at least one pass, and reviewed in every pass.
  const reviewedOnce = snapshot.files.filter(path => reviewedBy.some(set => set.has(path))).length;
  const reviewedByAll = snapshot.files.filter(path => reviewedBy.every(set => set.has(path))).length;
  const unreviewedFiles = snapshot.files.length - reviewedOnce;
  const reasons = [...(failedSessions && unreviewedFiles ? ['shard-failed'] : []), ...(snapshot.filesComplete ? [] : ['partial-file-list']), ...(reviewerGaps ? ['reviewer-gaps'] : [])];
  const coverageSummary = { complete: !unreviewedFiles && !reasons.length, unreviewedFiles, filesComplete: snapshot.filesComplete, reasons,
    files: snapshot.files.length, passes, reviewedOnce, reviewedByAll, failedSessions };
  const reported = dispositions.filter(row => row.status === 'REPORTED').length;
  progress(run, `Review finished: ${reported} reported finding(s), ${dispositions.filter(row => row.status === 'NEEDS_INFO').length} need more information; ${reviewedOnce}/${snapshot.files.length} file(s) reviewed${passes > 1 ? `, ${reviewedByAll}/${snapshot.files.length} in every pass` : ''}.`);

  const { freshness, stale } = await finalRecheck(ctx, run, snapshot, warnings);
  const status = stale ? 'STALE' : usable ? 'COMPLETE' : 'PARTIAL';
  return {
    status, snapshot, freshness, dispositions, newFindings: [], findings,
    report: reports.join('\n\n'),
    reviewWarnings: [...new Set(warnings)],
    coverage, coverageSummary, discoveredFiles: [...discovered], initialReports, verification: 'none',
    // How the findings were produced, for every later reader of the record: which models were asked for, what each
    // pass did, and whether the duplicate check and the rating ran.
    method: { kind: 'reviewers', version: 1, requested: [...settings.models[run.profile].reviewers], passes: passRecords, duplicateCheck, rating },
    initialObservations: status === 'COMPLETE' ? [] : findings,
    unstructuredInitials: unusableTexts.map(reportOf),
    shards: { initial: shards.length, passes, duplicateChecks: groups.length, ratings: rating.sessions },
  };
}
