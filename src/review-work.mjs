/**
 * Review orchestration: runtime-owned snapshot, sharded initial reviews,
 * sharded verification and a deterministic final version recheck.
 */
import { ROLES, initialRoles, roleFor } from './config.mjs';
import { evaluateInitial, evaluateFinal, initialRepairPrompt, finalRepairPrompt, syntaxProblem } from './output.mjs';

const ID_SPAN = 1000;
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Sorted paths keep a directory's files in the same shard. */
export function shardFiles(files, size) {
  if (!files.length) return [[]];
  const sorted = [...files].sort();
  const shards = [];
  for (let index = 0; index < sorted.length; index += size) shards.push(sorted.slice(index, index + size));
  return shards;
}

/** Path part of a location such as "head:/src/a.ts:12-14". */
export function locationPath(location) {
  const match = /^(?:head|base)?:?(\/[^:]+)(?::\d+(?:-\d+)?)?$/.exec(String(location ?? '').trim());
  return match ? match[1] : '';
}

/** Group findings for verification by file so related claims share a session. */
export function shardFindings(findings, size) {
  if (!findings.length) return [[]];
  const sorted = [...findings].sort((a, b) => locationPath(a.location).localeCompare(locationPath(b.location)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
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
  const { files, changes, description, ...rest } = snapshot;
  return { ...rest, fileCount: files.length, files: await store.pack(files), description: await store.pack(description ?? '', 4000) };
}

/** Make finding IDs unique across shards; keep the model's ID when it is free. */
function uniqueIds(findings, prefix, used) {
  let next = 1;
  for (const finding of findings) {
    if (!used.has(finding.id)) { used.add(finding.id); continue; }
    while (used.has(`${prefix}-${next}`)) next++;
    finding.shardId = finding.id;
    finding.id = `${prefix}-${next}`;
    used.add(finding.id);
  }
}

/**
 * @param {object} ctx { azure, runStage, progress, settings, dataFor }
 * @param {object} run
 * @param {object} request parsed /pr-review arguments
 */
export async function runReview(ctx, run, request) {
  const { azure, runStage, progress, settings } = ctx;
  const store = await ctx.dataFor(run);
  const snapshot = await azure.snapshot(run, request.target);
  run.snapshot = snapshot;
  const warnings = [];
  if (snapshot.status !== 'active') warnings.push(`The PR status is ${snapshot.status}.`);
  if (!snapshot.filesComplete) warnings.push('Azure DevOps returned an incomplete changed-file list; reviewers were asked to find the remaining paths, which are not verified as complete.');
  progress(run, `PR #${snapshot.prId} at ${snapshot.head.slice(0, 10)}: ${snapshot.files.length} changed file(s)${snapshot.filesComplete ? '' : ' (partial list)'}.`);

  const modelSnapshot = await snapshotForModel(snapshot, store);
  const shards = shardFiles(snapshot.files, settings.workflow.shardFiles);
  const roles = initialRoles(run.profile);
  let nextBase = shards.length * ID_SPAN;
  const tasks = roles.flatMap(role => shards.map((files, index) => ({ role, files, index, count: shards.length, idBase: index * ID_SPAN })));
  progress(run, `Initial review: ${tasks.length} session(s) for ${roles.length} roles and ${shards.length} shard(s).`);

  async function initialTask(task) {
    const prefix = ROLES[task.role].prefix;
    const changes = new Map(snapshot.changes.map(change => [change.path, change]));
    const payload = {
      prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
      assignment: { shard: `${task.index + 1}/${task.count}${task.part ?? ''}`, files: task.files, changes: task.files.map(path => changes.get(path)).filter(Boolean),
        firstFindingId: `${prefix}-${task.idBase + 1}`, discoverFiles: !snapshot.filesComplete },
    };
    try {
      const result = await runStage(run, task.role, payload, {
        evaluate(answer) {
          const { result, issues } = evaluateInitial(answer, { prefix, assigned: task.files, inventory: snapshot.files, filesComplete: snapshot.filesComplete });
          return { result, issues, repairPrompt: issues.length ? initialRepairPrompt(issues, { parseOnly: !result.structured && syntaxProblem(issues) }) : undefined };
        },
      }, { label: task.count > 1 || task.part ? `shard ${task.index + 1}/${task.count}${task.part ?? ''}` : '' });
      return [{ task, result }];
    } catch (error) {
      if (!run.active) throw error;
      if (error?.failureClass === 'overflow' && task.files.length > 1) {
        const middle = Math.ceil(task.files.length / 2);
        progress(run, `${task.role} reached its context limit on ${task.files.length} files; splitting the shard in two.`);
        const halves = [task.files.slice(0, middle), task.files.slice(middle)].map((files, half) => ({ ...task, files, idBase: (nextBase += ID_SPAN), part: `${task.part ?? ''}${half ? 'b' : 'a'}` }));
        return [...await initialTask(halves[0]), ...await initialTask(halves[1])];
      }
      return [{ task, error }];
    }
  }

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

  // Verification, sharded by finding.
  const verifier = roleFor(run.profile, 'verifier');
  const groups = shardFindings(findings, settings.workflow.shardFindings);
  const allIds = findings.map(finding => finding.id);
  const packedReports = await store.pack(initialReports);
  const verifications = await runPool(groups.map((assigned, index) => ({ assigned, index, count: groups.length })), settings.workflow.parallelSessions, async task => {
    const payload = {
      prUrl: request.prUrl, userContext: request.userContext, outputLanguage: settings.outputLanguage, snapshot: modelSnapshot,
      assignment: { shard: `${task.index + 1}/${task.count}`, findingIds: task.assigned.map(f => f.id), findings: task.assigned,
        allFindingIds: await store.pack(allIds, 4000), firstNewFindingId: `V-${task.index * ID_SPAN + 1}` },
      initialReports: packedReports, discoveredFiles: [...discovered],
    };
    try {
      const result = await runStage(run, verifier, payload, {
        evaluate(answer, previous) {
          const { result, issues, repairIds } = evaluateFinal(answer, { originals: task.assigned, allIds, previous, supplement: Boolean(previous?.structured) });
          if (!issues.length) return { result, issues };
          return { result, issues, repairPrompt: finalRepairPrompt(issues, repairIds, { parseOnly: !result.structured && syntaxProblem(issues), full: !result.structured, includeNewFindings: issues.some(issue => issue.startsWith('newFindings')) }) };
        },
      }, { label: task.count > 1 ? `shard ${task.index + 1}/${task.count}` : '' });
      return { task, result };
    } catch (error) {
      if (!run.active) throw error;
      return { task, error };
    }
  });
  if (!run.active) throw new Error(run.reason || 'Review stopped.');

  const dispositions = [], newFindings = [], reports = [], usedNew = new Set();
  let verified = 0;
  for (const { task, result, error } of verifications) {
    const label = task.count > 1 ? `Verification shard ${task.index + 1}/${task.count}` : '';
    if (!result) {
      warnings.push(`${label || 'Verification'} failed (${error?.message ?? 'unknown error'}); its findings are UNREVIEWED.`);
      for (const finding of task.assigned) dispositions.push({ id: finding.id, status: 'UNREVIEWED', reason: 'The verification session failed; this finding is not confirmed.' });
      continue;
    }
    if (result.structured) verified++;
    dispositions.push(...result.dispositions);
    uniqueIds(result.newFindings, 'V', usedNew);
    newFindings.push(...result.newFindings);
    for (const row of result.incompleteNewFindings ?? []) reports.push(`Incomplete new finding (not eligible for comments): ${row.summary || row.id || 'unnamed'}`);
    if (text(result.report)) reports.push(label ? `### ${label}\n\n${result.report}` : result.report);
    if (result.modelStatus === 'INCOMPLETE') warnings.push(`${label || 'The verifier'} reported unfinished checks; see its report.`);
    warnings.push(...result.warnings.map(message => label ? `${label}: ${message}` : message));
  }

  // Deterministic final version recheck. Only a changed source commit is stale.
  let freshness;
  try {
    const now = await azure.versions(run, snapshot);
    freshness = { ...now, checkedAt: new Date().toISOString() };
    if (now.base && now.base !== snapshot.base) warnings.push(`The target branch moved during the review (${snapshot.base.slice(0, 10)} → ${now.base.slice(0, 10)}). Findings describe the PR source; target-only changes are not attributed to it.`);
    if (now.status !== 'active') warnings.push(`The PR is now ${now.status}.`);
  } catch (error) {
    if (!run.active) throw error;
    freshness = { error: String(error?.message ?? error) };
    warnings.push(`The final version recheck failed (${freshness.error}); publication re-checks the source commit before posting.`);
  }
  const stale = Boolean(freshness.head && freshness.head !== snapshot.head);
  const status = stale ? 'STALE' : verified ? 'COMPLETE' : 'PARTIAL';
  if (stale) warnings.unshift(`The PR source changed during the review (${snapshot.head.slice(0, 10)} → ${freshness.head.slice(0, 10)}). Run a new review before commenting.`);
  return {
    status, snapshot, freshness, dispositions, newFindings, findings,
    report: reports.join('\n\n'),
    reviewWarnings: [...new Set(warnings)],
    coverage, discoveredFiles: [...discovered], initialReports,
    initialObservations: status === 'COMPLETE' ? [] : findings,
    unstructuredInitials: status === 'COMPLETE' ? [] : initialReports.filter(item => !item.structured).map(item => item.report),
    shards: { initial: shards.length, verification: groups.length },
  };
}
