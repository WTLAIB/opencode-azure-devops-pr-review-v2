// Opt-in local evidence, NOT a transcript of private reasoning or tool traffic.
import { appendFile, mkdir, mkdtemp, lstat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, parse, relative, isAbsolute } from 'node:path';
import { visibleText } from './output.mjs';

/**
 * Value-free observations; counts can overlap and never establish source truth.
 * @typedef {object} ToolObservations
 * @property {number} registered Authorized ordinary before-hook calls.
 * @property {number} afterHook Legacy name: terminal outcomes from V2 after hooks or namespaced executor exceptions.
 * @property {number} hostCompleted
 * @property {number} hostErrors
 * @property {number} reportedErrors
 * @property {number} truncated
 * @property {number} observedErrors Deduplicated execution/result errors.
 * @property {number} unverifiedResults Observed outcomes without error/truncation flags.
 * @property {number} withoutOutcome Registered calls without a returned/terminal outcome.
 * @property {'not-assessed'} evidenceValidity
 * @property {null} recoveredReads
 */

/** Summarize an attempt grant after revocation; retain no IDs, names or bodies.
 * @param {import('./runtime.mjs').Grant} grant
 * @returns {ToolObservations}
 */
export function collectToolObservations(grant) {
  const observedErrors = new Set([...grant.failedTools, ...grant.reportedToolErrors]);
  const observed = new Set([...grant.returnedTools, ...grant.terminalTools.keys()]);
  return {
    registered: grant.toolCalls.size,
    afterHook: observed.size,
    hostCompleted: [...grant.terminalTools.values()].filter(status => status === 'completed').length,
    hostErrors: grant.failedTools.size,
    reportedErrors: grant.reportedToolErrors.size,
    truncated: grant.truncatedTools.size,
    observedErrors: observedErrors.size,
    unverifiedResults: [...observed].filter(id => !observedErrors.has(id) && !grant.truncatedTools.has(id)).length,
    withoutOutcome: [...grant.toolCalls.keys()].filter(id => !observed.has(id)).length,
    evidenceValidity: 'not-assessed', recoveredReads: null,
  };
}

// Capture the public execution error before interruption can replace it with an
// aborted-tool outcome. Opt-in diagnostics only; never copy arguments, result
// bodies, nested provider data, headers or reasoning into this summary.
export function diagnosticToolError(event) {
  const error = Object.fromEntries(['name', 'type', 'message', 'status']
    .flatMap(key => ['string', 'number'].includes(typeof event.error?.[key]) ? [[key, event.error[key]]] : []));
  return { tool: event.tool, source: event.status === 'error' ? 'execution' : 'result-flag',
    ...(Object.keys(error).length ? { error } : {}) };
}

// Local execution observations, not provider inference/queue time or Azure server time.
// Keep only tool names and offsets: no call IDs, arguments, output or reasoning.
export function createStageTiming(clock = () => performance.now()) {
  const start = clock(), requests = [], tools = new Map();
  let promptStart = null, response = null, responseOutcome = null, saved;
  const now = () => Math.max(0, clock() - start);
  const ms = value => Math.round(value * 1000) / 1000;
  const open = () => saved === undefined && response === null;
  function activeBetween(from, to) {
    const intervals = [];
    for (const tool of tools.values()) {
      if (tool.startMs >= to) continue;
      if (tool.endMs === null) return null; // Missing after-hook is unknown, not zero.
      const a = Math.max(from, tool.startMs), b = Math.min(to, tool.endMs);
      if (b > a) intervals.push([a, b]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let total = 0, end = from;
    for (const [a, b] of intervals) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    return total;
  }
  return {
    promptStarted() { if (open() && promptStart === null) promptStart = now(); },
    modelRequest() { if (open()) requests.push(now()); },
    toolStarted(id, tool) {
      if (open() && !tools.has(id)) tools.set(id, { tool, startMs: now(), endMs: null, outcome: null });
    },
    toolEnded(id, outcome = 'completed') {
      const tool = tools.get(id);
      if (open() && tool && tool.endMs === null && ['completed', 'error'].includes(outcome)) {
        tool.endMs = now(); tool.outcome = outcome;
      }
    },
    promptSettled(outcome) { if (open()) { response = now(); responseOutcome = outcome; } },
    finish() {
      if (saved) return saved;
      const end = now(), requestEnd = response ?? end, rows = [...tools.values()];
      const active = activeBetween(0, requestEnd), unfinishedTools = rows.filter(t => t.endMs === null).length;
      saved = {
        elapsedMs: ms(end), responseOutcome,
        promptMs: promptStart === null || response === null ? null : ms(response - promptStart),
        responseProcessingMs: response === null ? null : ms(end - response),
        toolActiveMs: unfinishedTools || active === null ? null : ms(active), unfinishedTools,
        lastToolToResponseMs: responseOutcome !== 'returned' || !rows.length || unfinishedTools ? null
          : ms(Math.max(0, response - rows.reduce((last, t) => Math.max(last, t.endMs), 0))),
        toolCalls: rows.map(t => ({ tool: t.tool, outcome: t.outcome, startMs: ms(t.startMs), endMs: t.endMs === null ? null : ms(t.endMs),
          durationMs: t.endMs === null ? null : ms(t.endMs - t.startMs) })),
        modelRounds: requests.map((startMs, index) => {
          const endMs = requests[index + 1] ?? requestEnd, active = activeBetween(startMs, endMs);
          return { startMs: ms(startMs), endMs: ms(endMs), durationMs: ms(endMs - startMs),
            toolActiveMs: active === null ? null : ms(active),
            outsideToolMs: active === null ? null : ms(Math.max(0, endMs - startMs - active)),
            endReason: index + 1 < requests.length ? 'next-request' : responseOutcome ?? 'stage-stop' };
        }),
      };
      return saved;
    },
  };
}

async function ensureDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const segment of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe debug directory.');
  }
}

export async function createDiagnostics(settings, context, run) {
  const log = { directory: '', warnings: [], write: async () => {}, append: async () => {} };
  if (!settings.debug.enabled) return log;
  try {
    const stateHome = isAbsolute(process.env.XDG_STATE_HOME ?? '') ? process.env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
    const requested = settings.debug.directory;
    if (requested && !isAbsolute(requested) && !context.directory) throw new Error('Project directory unavailable.');
    const root = requested ? resolve(context.directory ?? '.', requested) : join(stateHome, 'opencode', 'azpr-v2-debug');
    await ensureDirectory(root);
    // Unique directory and exclusive files: never overwrite existing user data.
    const directory = await mkdtemp(join(root, `${run.id}-`));
    await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    log.directory = directory;
    // Line-oriented logs (for example every runtime Azure call) grow during a run.
    log.append = async (name, line) => {
      try {
        if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('Invalid diagnostic filename.');
        await appendFile(join(directory, name), line.endsWith('\n') ? line : line + '\n', { mode: 0o600 });
      } catch { if (!log.warnings.includes(`Could not append ${name}.`)) log.warnings.push(`Could not append ${name}.`); }
    };
    log.write = async (name, value) => {
      try {
        if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('Invalid diagnostic filename.');
        await writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch { log.warnings.push(`Could not save ${name}; inspect the OpenCode session instead.`); }
    };
    await log.write('run.json', { id: run.id, origin: run.origin, mode: run.mode, profile: run.profile, sourceReview: run.review?.id,
      startedAt: new Date().toISOString(), project: context.directory, outputLanguage: settings.outputLanguage,
      returnReport: settings.returnReport, outputTransport: 'json-text',
      runTimeoutSeconds: settings.runTimeoutSeconds, shell: settings.shell, mcp: settings.mcp, workflow: settings.workflow,
      privacy: 'Private review data. May contain source, PR details, model IDs, or secrets echoed by the model. Do not upload or commit. No automatic retention cleanup.' });
  } catch { log.warnings.push('Debug logging could not start; no diagnostic data was intentionally written. Inspect the OpenCode session instead.'); }
  return log;
}

export function diagnosticResponse(response) {
  const raw = visibleText(response);
  // Only select public answer/error fields; omit reasoning, tool inputs/outputs,
  // HTTP headers, provider options, and environment/configuration contents.
  const error = response?.info?.error;
  return {
    messageID: response?.info?.id, model: response?.info?.model?.id, provider: response?.info?.model?.providerID,
    finish: response?.info?.finish,
    error: error ? { type: error.type, message: String(error.message ?? ''), status: error.status } : undefined,
    text: raw, textCharacters: raw.length,
    ...(response?.continuation ? { continuation: { count: response.continuation.count,
      fragments: response.continuation.fragments.map(diagnosticResponse) } } : {}),
  };
}
