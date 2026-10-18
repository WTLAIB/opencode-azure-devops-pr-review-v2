/**
 * Review orchestration: runtime-owned snapshot, sharded initial reviews,
 * sharded verification, a duplicate check for files whose findings different
 * verifiers confirmed, and a deterministic final version recheck. A quick
 * review has one reviewer per shard and no verification: the runtime checks
 * only the form and source of its findings, never whether they are right.
 */
import { ROLES, initialRoles, roleFor } from './config.mjs';
import { breakMergeCycles, settleMergeTargets, evaluateInitial, evaluateFinal, evaluateDuplicates, initialRepairPrompt, finalRepairPrompt, duplicateRepairPrompt, quickRepairPrompt, quickFollowUpPrompt, syntaxProblem, locationPath, FINDING_FIELDS } from './output.mjs';

export { locationPath };
const ID_SPAN = 1000;
const text = value => typeof value === 'string' && value.trim().length > 0;
const shardLabel = task => task.count > 1 || task.part ? `shard ${task.index + 1}/${task.count}${task.part ?? ''}` : '';

/** Sorted paths keep a directory's files in the same shard. */
export function shardFiles(files, size) {
  if (!files.length) return [[]];
  const sorted = [...files].sort();
  const shards = [];
  for (let index = 0; index < sorted.length; index += size) shards.push(sorted.slice(index, index + size));
  return shards;
}

/**
 * Group findings for verification by file so related claims share a session:
 * shards end only between files. One file's findings are split only when that
 * file alone has more findings than a shard holds.
 */
export function shardFindings(findings, size) {
  if (!findings.length) return [[]];
  const sorted = [...findings].sort((a, b) => locationPath(a.location).localeCompare(locationPath(b.location)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const files = [];
  for (const finding of sorted) {
    const path = locationPath(finding.location);
    if (files.at(-1)?.path === path) files.at(-1).findings.push(finding);
    else files.push({ path, findings: [finding] });
  }
  const shards = [];
  let current = [];
  for (const { findings: group } of files) {
    if (current.length && current.length + group.length > size) { shards.push(current); current = []; }
    if (group.length > size) {
      for (let index = 0; index < group.length; index += size) shards.push(group.slice(index, index + size));
      continue;
    }
    current.push(...group);
  }
  if (current.length) shards.push(current);
  return shards;
}

/**
 * Confirmed claims that ended in one file although different verification
 * shards decided them: a verifier moved a finding into another shard's file, or
 * a file had more findings than one shard holds. Only these files lost the
 * "one verifier per file" guarantee, so only they get a duplicate check.
 * @param {{id: string, shard: object, finding: object}[]} claims
 */
export function sameFileGroups(claims) {
  const byFile = new Map();
  for (const claim of claims) {
    const path = locationPath(claim.finding.location);
    if (!path) continue;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(claim);
  }
  return [...byFile].filter(([, items]) => new Set(items.map(item => item.shard)).size > 1).map(([path, items]) => ({ path, items }));
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

/** Make finding IDs unique across shards; keep the model's ID when it is free. */
function uniqueIds(findings, prefix, used, valid = () => true) {
  let next = 1;
  for (const finding of findings) {
    if (valid(finding.id) && !used.has(finding.id)) { used.add(finding.id); continue; }
    while (used.has(`${prefix}-${next}`)) next++;
    finding.shardId = finding.id;
    finding.id = `${prefix}-${next}`;
    used.add(finding.id);
  }
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
 * One initial session per task; a task that fills its model context is split
 * in half and both halves run (`counter.next` hands out their ID ranges).
 * `handlerFor(task, prefix)` returns the stage handler that accepts answers.
 */
function initialRunner(ctx, run, request, { snapshot, modelSnapshot, counter, handlerFor }) {
  const { runStage, progress, settings } = ctx;
  const changes = new Map(snapshot.changes.map(change => [change.path, change]));
  async function initialTask(task) {
    const prefix = ROLES[task.role].prefix;
    const payload = {
      prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
      assignment: { shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, files: task.files, changes: task.files.map(path => changes.get(path)).filter(Boolean),
        firstFindingId: `${prefix}-${task.idBase + 1}`, discoverFiles: !snapshot.filesComplete },
    };
    try {
      const result = await runStage(run, task.role, payload, handlerFor(task, prefix), { label: shardLabel(task) });
      return [{ task, result }];
    } catch (error) {
      if (!run.active) throw error;
      if (error?.failureClass === 'overflow' && task.files.length > 1) {
        const middle = Math.ceil(task.files.length / 2);
        progress(run, `${task.role} reached its context limit on ${task.files.length} files; splitting the shard in two.`);
        const halves = [task.files.slice(0, middle), task.files.slice(middle)].map((files, half) => ({ ...task, files, idBase: (counter.next += ID_SPAN), part: `${task.part ?? ''}${half ? 'b' : 'a'}` }));
        return [...await initialTask(halves[0]), ...await initialTask(halves[1])];
      }
      return [{ task, error }];
    }
  }
  return initialTask;
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

/**
 * @param {object} ctx { azure, runStage, progress, settings, dataFor }
 * @param {object} run
 * @param {object} request parsed /pr-review arguments
 */
export async function runReview(ctx, run, request) {
  if (run.profile === 'quick') return runQuickReview(ctx, run, request);
  const { runStage, progress, settings } = ctx;
  const { store, snapshot, warnings, modelSnapshot } = await prepareSnapshot(ctx, run, request);
  const shards = shardFiles(snapshot.files, settings.workflow.shardFiles);
  const roles = initialRoles(run.profile);
  const counter = { next: shards.length * ID_SPAN };
  const tasks = roles.flatMap(role => shards.map((files, index) => ({ role, files, index, count: shards.length, idBase: index * ID_SPAN })));
  progress(run, `Initial review: ${tasks.length} session(s) for ${roles.length} roles and ${shards.length} shard(s).`);
  const initialTask = initialRunner(ctx, run, request, { snapshot, modelSnapshot, counter, handlerFor: (task, prefix) => ({
    evaluate(answer) {
      const { result, issues } = evaluateInitial(answer, { prefix, assigned: task.files, inventory: snapshot.files, filesComplete: snapshot.filesComplete });
      return { result, issues, repairPrompt: issues.length ? initialRepairPrompt(issues, { parseOnly: !result.structured && syntaxProblem(issues) }) : undefined };
    },
  }) });

  const outcomes = (await runPool(tasks, settings.workflow.parallelSessions, initialTask)).flat();
  if (!run.active) throw new Error(run.reason || 'Review stopped.');
  const succeeded = outcomes.filter(outcome => outcome.result);
  if (!succeeded.length) throw new Error(`Every initial review session failed: ${[...new Set(outcomes.map(outcome => outcome.error?.message).filter(Boolean))].slice(0, 3).join(' | ')}`);

  // Merge initial work per role.
  const findings = [], initialReports = [], coverage = {}, discovered = new Set();
  for (const role of roles) {
    const prefix = ROLES[role].prefix, used = new Set();
    const roleOutcomes = outcomes.filter(outcome => outcome.task.role === role);
    coverage[role] = { assigned: 0, covered: 0, failedFiles: [], gaps: [] };
    for (const { task, result, error } of roleOutcomes) {
      coverage[role].assigned += task.files.length;
      if (!result) {
        coverage[role].failedFiles.push(...task.files);
        warnings.push(`${role} shard ${task.index + 1}/${task.count}${task.part ?? ''} failed (${error?.message ?? 'unknown error'}); its ${task.files.length || 'unknown'} file(s) lack this role's review.`);
        continue;
      }
      uniqueIds(result.findings, prefix, used);
      for (const finding of result.findings) findings.push({ ...finding, origin: role });
      coverage[role].covered += result.coverage.files.filter(path => task.files.includes(path)).length;
      coverage[role].gaps.push(...result.coverage.gaps);
      for (const path of result.additionalFiles) discovered.add(path);
      initialReports.push({ role, shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, files: task.files.length, status: result.status,
        structured: result.structured, report: result.report, gaps: result.coverage.gaps, warnings: result.warnings });
    }
  }
  if (discovered.size) warnings.push(`Reviewers reported ${discovered.size} changed path(s) missing from Azure's list: ${[...discovered].slice(0, 20).join(', ')}${discovered.size > 20 ? ', ...' : ''}`);
  progress(run, `Initial review finished: ${findings.length} candidate finding(s). Verifying.`);

  // Verification, sharded by finding. Without candidates one verifier still
  // runs: it checks the initial reports and writes the checks and limitations.
  const verifier = roleFor(run.profile, 'verifier');
  const groups = shardFindings(findings, settings.workflow.shardFindings);
  const allIds = findings.map(finding => finding.id);
  const packedReports = await store.pack(initialReports);
  let nextNewBase = groups.length * ID_SPAN;
  // Like initial shards, a verifier assignment that overflows the context is
  // split (between files where possible) and only an indivisible one fails.
  async function verifyTask(task) {
    const payload = {
      prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
      assignment: { shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, findingIds: task.assigned.map(f => f.id), findings: task.assigned,
        allFindingIds: await store.pack(allIds, 4000), firstNewFindingId: `V-${task.idBase + 1}` },
      initialReports: packedReports, discoveredFiles: [...discovered],
    };
    try {
      const result = await runStage(run, verifier, payload, {
        evaluate(answer, previous) {
          const { result, issues, repairIds } = evaluateFinal(answer, { originals: task.assigned, allIds, previous, supplement: Boolean(previous?.structured) });
          if (!issues.length) return { result, issues };
          return { result, issues, repairPrompt: finalRepairPrompt(issues, repairIds, { parseOnly: !result.structured && syntaxProblem(issues), full: !result.structured, includeNewFindings: issues.some(issue => issue.startsWith('newFindings')) }) };
        },
      }, { label: task.count > 1 || task.part ? `shard ${task.index + 1}/${task.count}${task.part ?? ''}` : '' });
      return [{ task, result }];
    } catch (error) {
      if (!run.active) throw error;
      if (error?.failureClass === 'overflow' && task.assigned.length > 1) {
        progress(run, `The verifier reached its context limit on ${task.assigned.length} findings; splitting the shard.`);
        const parts = shardFindings(task.assigned, Math.ceil(task.assigned.length / 2));
        const smaller = parts.map((assigned, index) => ({ ...task, assigned, idBase: (nextNewBase += ID_SPAN), part: `${task.part ?? ''}${String.fromCharCode(97 + index)}` }));
        const outcomes = [];
        for (const part of smaller) outcomes.push(...await verifyTask(part));
        return outcomes;
      }
      return [{ task, error }];
    }
  }
  const verifications = (await runPool(groups.map((assigned, index) => ({ assigned, index, count: groups.length, idBase: index * ID_SPAN })),
    settings.workflow.parallelSessions, verifyTask)).flat();
  if (!run.active) throw new Error(run.reason || 'Review stopped.');

  const dispositions = [], newFindings = [], reports = [], usedNew = new Set(allIds), decidedIn = new Map();
  let verified = 0;
  for (const { task, result, error } of verifications) {
    const label = task.count > 1 || task.part ? `Verification shard ${task.index + 1}/${task.count}${task.part ?? ''}` : '';
    if (!result) {
      warnings.push(`${label || 'Verification'} failed (${error?.message ?? 'unknown error'}); its findings are UNREVIEWED.`);
      for (const finding of task.assigned) dispositions.push({ id: finding.id, status: 'UNREVIEWED', reason: 'The verification session failed; this finding is not confirmed.' });
      continue;
    }
    if (result.structured) verified++;
    dispositions.push(...result.dispositions);
    // New findings need IDs unique across the review: never a missing ID or one of an original finding.
    uniqueIds(result.newFindings, 'V', usedNew, id => typeof id === 'string' && /^V-\d+$/.test(id));
    for (const decided of [...result.dispositions, ...result.newFindings]) decidedIn.set(decided.id, task);
    newFindings.push(...result.newFindings);
    for (const row of result.incompleteNewFindings ?? []) reports.push(`Incomplete new finding (not eligible for comments): ${row.summary || row.id || 'unnamed'}`);
    if (text(result.report)) reports.push(label ? `### ${label}\n\n${result.report}` : result.report);
    if (result.modelStatus === 'INCOMPLETE') warnings.push(`${label || 'The verifier'} reported unfinished checks; see its report.`);
    warnings.push(...result.warnings.map(message => label ? `${label}: ${message}` : message));
  }

  // Same-file duplicate check. Shards keep a file's findings together, but a
  // moved finding or a split crowded file can bring findings that different
  // verifiers confirmed into one file; a model compares only those, and a
  // failed check keeps every finding.
  const claims = [
    ...dispositions.filter(d => d.status === 'CONFIRMED' && d.verifiedFinding).map(d => ({ id: d.id, shard: decidedIn.get(d.id), finding: d.verifiedFinding, reason: d.reason })),
    ...newFindings.map(finding => ({ id: finding.id, shard: decidedIn.get(finding.id), finding })),
  ];
  const sameFile = sameFileGroups(claims);
  if (sameFile.length) {
    progress(run, `Duplicate check: ${sameFile.length} file(s) hold findings that different verification shards confirmed.`);
    const checker = roleFor(run.profile, 'dedupe');
    const checks = await runPool(sameFile.map((group, index) => ({ group, index, count: sameFile.length })), settings.workflow.parallelSessions, async task => {
      const ids = task.group.items.map(item => item.id);
      const findings = task.group.items.map(({ id, shard, finding, reason }) => ({ ...finding, id,
        verificationShard: `${shard.index + 1}/${shard.count}`, ...(text(reason) ? { verifierReason: reason } : {}) }));
      const payload = {
        prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
        assignment: { kind: 'duplicates', file: task.group.path, findingIds: ids, findings: await store.pack(findings, 40000) },
      };
      try {
        const result = await runStage(run, checker, payload, {
          evaluate(answer) {
            const { result, issues } = evaluateDuplicates(answer, { ids });
            return { result, issues, repairPrompt: issues.length ? duplicateRepairPrompt(issues, { parseOnly: !result.structured && syntaxProblem(issues) }) : undefined };
          },
        }, { label: task.count > 1 ? `${task.index + 1}/${task.count}` : '' });
        return { ...task, result };
      } catch (error) {
        if (!run.active) throw error;
        return { ...task, error };
      }
    });
    if (!run.active) throw new Error(run.reason || 'Review stopped.');
    for (const { group, result, error } of checks) {
      if (!result) {
        warnings.push(`The duplicate check of ${group.path} failed (${error?.message ?? 'unknown error'}); its ${group.items.length} findings stay confirmed and may include duplicates.`);
        continue;
      }
      for (const merge of result.merges) {
        const reason = `${merge.reason} [Runtime: merged by the same-file duplicate check after verification had confirmed it.]`;
        const entry = dispositions.find(d => d.id === merge.id && d.status === 'CONFIRMED');
        if (entry) Object.assign(entry, { status: 'MERGED', mergedInto: merge.mergedInto, reason });
        else {
          const index = newFindings.findIndex(finding => finding.id === merge.id);
          if (index >= 0) dispositions.push({ id: merge.id, status: 'MERGED', mergedInto: merge.mergedInto, reason, verifiedFinding: newFindings.splice(index, 1)[0] });
        }
      }
      if (text(result.report)) reports.push(`### Duplicate check: ${group.path}\n\n${result.report}`);
      warnings.push(...result.warnings.map(message => `Duplicate check of ${group.path}: ${message}`));
    }
  }

  // A merge may name a finding another shard decided; a cycle across shards
  // would otherwise hide every finding in it without a warning.
  const cyclic = breakMergeCycles(dispositions);
  if (cyclic.length) warnings.push(`Merges across verification shards formed a cycle; ${cyclic.join(', ')} ${cyclic.length === 1 ? 'is' : 'are'} shown as UNREVIEWED.`);
  // A verifier may merge into a finding that another shard rejected or left
  // undecided; only the combined decisions can tell, and such a merged finding
  // must not vanish behind the rejection. Surviving verifier-added findings are
  // confirmed targets (the duplicate check may merge into them).
  const dangling = settleMergeTargets(dispositions, { unknownIsDangling: true, confirmedIds: new Set(newFindings.map(finding => finding.id)) });
  if (dangling.length) warnings.push(`Merged into findings that were not confirmed and shown as UNREVIEWED: ${dangling.map(row => `${row.id} → ${row.target} (${row.status})`).join(', ')}.`);

  const { freshness, stale } = await finalRecheck(ctx, run, snapshot, warnings);
  const status = stale ? 'STALE' : verified ? 'COMPLETE' : 'PARTIAL';
  return {
    status, snapshot, freshness, dispositions, newFindings, findings,
    report: reports.join('\n\n'),
    reviewWarnings: [...new Set(warnings)],
    coverage, discoveredFiles: [...discovered], initialReports,
    initialObservations: status === 'COMPLETE' ? [] : findings,
    unstructuredInitials: status === 'COMPLETE' ? [] : initialReports.filter(item => !item.structured).map(item => item.report),
    shards: { initial: shards.length, verification: groups.length, duplicateChecks: sameFile.length },
  };
}

// ------------------------------------------------------------------ quick review

const QUICK_LOCATION = /^(?:(head|base):)?(\/[^:\n]+?)(?::(\d+)(?:-(\d+))?)?\s*$/;
const lineCount = source => {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
};
export const QUICK_REPORTED_REASON = 'Reported by the quick reviewer; it passed the runtime\'s format and source checks and was not independently verified.';

/**
 * Check a quick finding's location against the reviewed commits: the file
 * exists at that version, the lines are in range and this session's own tools
 * showed that file's content. Only form and source are checked, never whether
 * the defect is real. `repairable` problems go back to the reviewer; `inline`
 * says whether the location is on a changed HEAD file.
 * @param {object} finding
 * @param {{snapshot: object, azure: object, run: object, reads?: Set<string>}} context
 */
export async function checkQuickLocation(finding, { snapshot, azure, run, reads }) {
  const match = QUICK_LOCATION.exec(String(finding.location ?? '').trim());
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
 * Accept one quick-review answer: the initial-review contract with a required
 * location, plus the runtime's location and source checks. Field and location
 * problems get correction turns; what is still wrong afterwards is NEEDS_INFO.
 */
/**
 * A parsed quick answer is usable only with a findings array and at least one
 * reviewed file or accepted finding. Uses the answer's own IDs (before they are
 * made unique), which key `invalid` and `checks`.
 */
export function quickUsable(result, files) {
  if (!result?.structured || result.envelope?.findings !== true) return false;
  const reviewed = result.envelope?.coverage ? result.coverage.files.filter(path => files.includes(path)) : [];
  const accepted = result.findings.filter(finding => !result.invalid?.[finding.id]?.length && result.checks?.[finding.id]?.ok).length;
  return reviewed.length > 0 || accepted > 0;
}

/**
 * `usable` follows quickUsable. A usable PARTIAL answer with nothing to repair
 * that names unfinished work (gaps or assigned files not reviewed) also gets a
 * `followUp`: the runtime may ask the same session once to continue.
 */
export async function evaluateQuick(answer, { task, snapshot, azure, run, reads }) {
  const { result, issues } = evaluateInitial(answer, { prefix: 'Q', assigned: task.files, inventory: snapshot.files, filesComplete: snapshot.filesComplete, requireLocation: true });
  // A plain object, so the stage record shows each finding's check.
  const checks = {};
  for (const finding of result.findings) {
    if (!Object.hasOwn(result.invalid, finding.id)) checks[finding.id] = await checkQuickLocation(finding, { snapshot, azure, run, reads });
  }
  const all = [...issues, ...Object.entries(checks).filter(([, check]) => check.repairable).map(([id, check]) => `${id}: ${check.problem}`)];
  const checked = { ...result, checks };
  const usable = quickUsable(checked, task.files);
  const uncovered = task.files.filter(path => !result.coverage.files.includes(path));
  const unfinished = result.status === 'PARTIAL' && (result.coverage.gaps.length > 0 || uncovered.length > 0);
  return { result: checked, issues: all, usable,
    repairPrompt: all.length ? quickRepairPrompt(all, { parseOnly: !result.structured && syntaxProblem(all) }) : undefined,
    ...(usable && !all.length && unfinished ? { followUp: { prompt: quickFollowUpPrompt({ gaps: result.coverage.gaps, uncovered }), gaps: result.coverage.gaps, uncovered } } : {}) };
}

const findingKey = finding => JSON.stringify(FINDING_FIELDS.filter(key => key !== 'id').map(key => String(finding?.[key] ?? '').replace(/\s+/g, ' ').trim()));
const findingOnly = finding => Object.fromEntries(FINDING_FIELDS.filter(key => key !== 'id' && Object.hasOwn(finding, key)).map(key => [key, finding[key]]));

/**
 * Quick review: one reviewer per shard covers functional and risk focus and
 * checks its own findings against the source; no verifier, duplicate check or
 * summary session runs. Findings that pass the runtime's checks are REPORTED
 * (not independently verified); the rest are NEEDS_INFO. Status, coverage and
 * verification are reported separately: a parsed answer without a usable
 * review never makes a commentable COMPLETE, and zero findings never hide
 * files that were not reviewed.
 */
export async function runQuickReview(ctx, run, request) {
  const { azure, progress, settings } = ctx;
  const { snapshot, warnings, modelSnapshot } = await prepareSnapshot(ctx, run, request);
  const shards = shardFiles(snapshot.files, settings.workflow.shardFiles);
  const [role] = initialRoles('quick');
  const counter = { next: shards.length * ID_SPAN };
  const tasks = shards.map((files, index) => ({ role, files, index, count: shards.length, idBase: index * ID_SPAN }));
  progress(run, `Quick review: ${tasks.length} session(s) for ${shards.length} shard(s); no independent verification follows.`);
  const initialTask = initialRunner(ctx, run, request, { snapshot, modelSnapshot, counter, handlerFor: task => ({
    evaluate: (answer, _previous, session) => evaluateQuick(answer, { task, snapshot, azure, run, reads: session?.reads }),
  }) });
  const outcomes = (await runPool(tasks, settings.workflow.parallelSessions, initialTask)).flat();
  if (!run.active) throw new Error(run.reason || 'Review stopped.');
  if (!outcomes.some(outcome => outcome.result)) throw new Error(`Every quick review session failed: ${[...new Set(outcomes.map(outcome => outcome.error?.message).filter(Boolean))].slice(0, 3).join(' | ')}`);

  const findings = [], dispositions = [], reports = [], initialReports = [], unusableTexts = [], discovered = new Set(), covered = new Set(), used = new Set();
  const coverage = { [role]: { assigned: 0, covered: 0, failedFiles: [], gaps: [] } };
  let usable = 0, failedShards = 0, reviewerGaps = false;
  for (const { task, result, error } of outcomes) {
    const label = shardLabel(task);
    coverage[role].assigned += task.files.length;
    if (!result) {
      failedShards++;
      coverage[role].failedFiles.push(...task.files);
      warnings.push(`The quick review ${label || 'session'} failed (${error?.message ?? 'unknown error'}); its ${task.files.length || 'unknown'} file(s) were not reviewed.`);
      continue;
    }
    // Classify before IDs are made unique: the checks are keyed by the answer's IDs.
    const entries = result.findings.map(finding => ({ finding, problems: result.invalid?.[finding.id] ?? [], check: result.checks?.[finding.id] }));
    const isUsable = quickUsable(result, task.files);
    uniqueIds(result.findings, 'Q', used);
    const reviewed = result.envelope?.coverage ? result.coverage.files.filter(path => task.files.includes(path)) : [];
    if (!isUsable) {
      failedShards++;
      coverage[role].failedFiles.push(...task.files);
      warnings.push(`The quick review ${label || 'session'} returned no usable review (${result.structured ? 'no reviewed file or usable finding' : 'no structured answer'}); its ${task.files.length} file(s) count as not reviewed.`);
      if (text(result.report)) unusableTexts.push(label ? `### ${label}\n\n${result.report}` : result.report);
    } else {
      usable++;
      for (const path of reviewed) covered.add(path);
      coverage[role].covered += reviewed.length;
      coverage[role].gaps.push(...result.coverage.gaps);
      if (result.coverage.gaps.length) reviewerGaps = true;
      for (const path of result.additionalFiles) discovered.add(path);
      if (text(result.report)) reports.push(label ? `### ${label}\n\n${result.report}` : result.report);
    }
    // The session that reported a finding, recorded by the runtime (never derived from IDs):
    // comment planning may combine findings of different sessions that repeat one defect.
    const shard = `${task.index + 1}/${task.count}${task.part ?? ''}`;
    for (const { finding, problems, check } of entries) {
      findings.push({ ...finding, origin: role });
      const partial = findingOnly(finding);
      if (!isUsable) dispositions.push({ id: finding.id, status: 'NEEDS_INFO', reason: 'The finding comes from a quick review answer that was not usable. [Runtime: not eligible for comments.]', partialFinding: partial, shard });
      else if (problems.length) dispositions.push({ id: finding.id, status: 'NEEDS_INFO', reason: `The finding is ${problems.join('; ')} after the correction turns. [Runtime: not eligible for comments.]`, partialFinding: partial, shard });
      else if (!check?.ok) dispositions.push({ id: finding.id, status: 'NEEDS_INFO', reason: `The location check failed: ${check?.problem ?? 'it was not checked.'} [Runtime: not eligible for comments.]`, partialFinding: partial, shard });
      else dispositions.push({ id: finding.id, status: 'REPORTED', reason: QUICK_REPORTED_REASON, finding: partial, inline: check.inline, shard });
    }
    initialReports.push({ role, shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, files: task.files.length, status: result.status,
      structured: result.structured, usable: isUsable, report: result.report, gaps: result.coverage.gaps, warnings: result.warnings });
    warnings.push(...result.warnings.map(message => label ? `Quick review ${label}: ${message}` : `Quick review: ${message}`));
  }
  // Only records identical in every field are duplicates; findings on the same lines stay separate.
  const kept = new Map();
  let duplicates = 0;
  for (const status of ['REPORTED', 'NEEDS_INFO']) for (const entry of dispositions.filter(row => row.status === status)) {
    const key = findingKey(entry.finding ?? entry.partialFinding);
    if (!kept.has(key)) { kept.set(key, entry.id); continue; }
    Object.assign(entry, { status: 'MERGED', mergedInto: kept.get(key), reason: `Identical in every field to ${kept.get(key)}. [Runtime: exact duplicate.]` });
    delete entry.finding; delete entry.inline; delete entry.partialFinding;
    duplicates++;
  }
  if (duplicates) warnings.push(`Removed ${duplicates} exact duplicate finding(s); findings that differ in any field are kept.`);
  if (discovered.size) warnings.push(`The quick reviewer reported ${discovered.size} changed path(s) missing from Azure's list: ${[...discovered].slice(0, 20).join(', ')}${discovered.size > 20 ? ', ...' : ''}`);
  const unreviewedFiles = snapshot.files.filter(path => !covered.has(path)).length;
  const reasons = [...(failedShards ? ['shard-failed'] : []), ...(snapshot.filesComplete ? [] : ['partial-file-list']), ...(reviewerGaps ? ['reviewer-gaps'] : [])];
  const coverageSummary = { complete: !unreviewedFiles && !reasons.length, unreviewedFiles, filesComplete: snapshot.filesComplete, reasons };
  const reported = dispositions.filter(row => row.status === 'REPORTED').length;
  progress(run, `Quick review finished: ${reported} reported finding(s), ${dispositions.filter(row => row.status === 'NEEDS_INFO').length} need more information; coverage ${coverageSummary.complete ? 'complete' : 'incomplete'}.`);

  const { freshness, stale } = await finalRecheck(ctx, run, snapshot, warnings);
  const status = stale ? 'STALE' : usable ? 'COMPLETE' : 'PARTIAL';
  return {
    status, snapshot, freshness, dispositions, newFindings: [], findings,
    report: reports.join('\n\n'),
    reviewWarnings: [...new Set(warnings)],
    coverage, coverageSummary, discoveredFiles: [...discovered], initialReports, verification: 'none',
    initialObservations: status === 'COMPLETE' ? [] : findings,
    unstructuredInitials: unusableTexts,
    shards: { initial: shards.length, verification: 0, duplicateChecks: 0 },
  };
}
