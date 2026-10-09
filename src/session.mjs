/** OpenCode V2 session transport. No provider, Azure or HTTP client. */
import { isDeepStrictEqual } from 'node:util';
import { FOREIGN_MESSAGE_TYPES, isHostContinuation, requireMethods } from './host.mjs';

const pendingAdmissions = new WeakMap();
const textValue = value => typeof value === 'string' && value.length > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function sessionApi(context, methods) {
  requireMethods(context, methods.map(method => `session.${method}`), 'the review session transport');
  return context.session;
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('[AZPR] Session operation cancelled.');
}

// The host Promise adapter ignores request options, including signals. Race
// locally, but keep pending admissions so cleanup waits for a delayed prompt.
function cancellable(operation, signal) {
  aborted(signal);
  const promise = Promise.resolve().then(() => { aborted(signal); return operation(); });
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => settle(reject, signal.reason ?? new Error('[AZPR] Session operation cancelled.'));
    const settle = (finish, value) => {
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => settle(resolve, value), error => settle(reject, error));
    if (signal.aborted) onAbort();
  });
}

function admission(context, sessionID, operation) {
  let sessions = pendingAdmissions.get(context);
  if (!sessions) pendingAdmissions.set(context, sessions = new Map());
  let pending = sessions.get(sessionID);
  if (!pending) sessions.set(sessionID, pending = new Set());
  const promise = Promise.resolve().then(operation);
  pending.add(promise);
  const done = () => {
    pending.delete(promise);
    if (!pending.size && sessions.get(sessionID) === pending) sessions.delete(sessionID);
  };
  promise.then(done, done);
  return promise;
}

function modelRef(value) {
  if (record(value) && textValue(value.providerID) && textValue(value.id)) {
    return { providerID: value.providerID, id: value.id, ...(value.variant === undefined ? {} : { variant: value.variant }) };
  }
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash > 0 && slash < value.length - 1) return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
  }
  throw new Error('[AZPR] A V2 provider/model reference is required.');
}

function sameModel(actual, expected) {
  return actual?.providerID === expected.providerID && actual?.id === expected.id &&
    (actual?.variant ?? 'default') === (expected.variant ?? 'default');
}

/** Create a linked, independent session with its agent and model already bound. */
export async function createReviewSession(context, { origin, title, role, model, permissions, signal }) {
  const api = sessionApi(context, ['create']);
  if (!textValue(origin) || !textValue(role) || !textValue(title)) throw new Error('[AZPR] Incomplete review session identity.');
  const selectedModel = modelRef(model);
  const made = await cancellable(() => api.create({
    parentID: origin, title, agent: role, model: selectedModel,
    ...(permissions === undefined ? {} : { permissions }),
  }), signal);
  if (!record(made) || !textValue(made.id) || made.id === origin || made.parentID !== origin ||
      made.agent !== role || !sameModel(made.model, selectedModel)) {
    throw new Error('[AZPR] OpenCode V2 did not create the requested independent reviewer session.');
  }
  return made;
}

/** A model-less child session that only carries runtime MCP calls. */
export async function createRuntimeSession(context, { origin, title, agent, signal }) {
  const api = sessionApi(context, ['create']);
  const made = await cancellable(() => api.create({ parentID: origin, title, agent }), signal);
  if (!record(made) || !textValue(made.id) || made.id === origin || made.parentID !== origin || made.agent !== agent) {
    throw new Error('[AZPR] OpenCode V2 did not create the runtime session for Azure DevOps calls.');
  }
  return made;
}

function normalizeAnswer(message, sessionID) {
  return {
    info: {
      id: message.id, sessionID, role: 'assistant', agent: message.agent,
      model: message.model, finish: message.finish,
      ...(message.error === undefined ? {} : { error: message.error }),
      time: message.time,
    },
    // Provider reasoning and previous tool turns never become final output.
    parts: message.content.filter(part => part?.type === 'text')
      .map(part => ({ type: 'text', text: part.text })),
  };
}

function responseError(message, response, execution) {
  const error = new Error(message);
  if (response) error.response = response;
  if (execution) error.execution = execution;
  return error;
}

// Bounded host metadata only; provider bodies can contain private request data.
function providerFailure(final, assistants) {
  const error = final?.error;
  if (typeof error?.type !== 'string' || !error.type.startsWith('provider.') ||
      !Number.isInteger(error.status) || error.status < 400 || error.status > 599) return undefined;
  return { status: error.status,
    toolCallsObserved: assistants.reduce((count, message) => count +
      (Array.isArray(message.content) ? message.content.filter(part => part?.type === 'tool').length : 0), 0) };
}

/**
 * Text fragments of a stream the host interrupted and resumed. Accept only
 * errored text-only assistant messages that the host marked for retry, each
 * followed by the host continuation, and finally a successful text answer.
 */
function continuedText(turn, enabled) {
  const none = { recovered: new Set(), synthetic: new Set() };
  if (!enabled) return none;
  const start = turn.findIndex(message => message?.type === 'assistant' && message.error);
  if (start < 0) return none;
  const tail = turn.slice(start, -1);
  const recovered = new Set(), synthetic = new Set();
  for (let index = 0; index < tail.length; index += 2) {
    const message = tail[index];
    if (message?.type !== 'assistant' || !Array.isArray(message.content) ||
        !message.content.every(part => ['text', 'reasoning'].includes(part?.type)) ||
        !message.content.some(part => part?.type === 'text' && textValue(part.text)) ||
        !Number.isFinite(message.time?.completed)) return none;
    if (index === tail.length - 1 && message.finish === 'stop' && !message.error) break;
    const next = tail[index + 1];
    if (message.finish !== 'error' || !message.error || !Number.isInteger(message.retry?.attempt) ||
        message.retry.attempt < 1 || !isHostContinuation(next, message) || index + 2 >= tail.length) return none;
    recovered.add(message);
    synthetic.add(next);
  }
  return { recovered, synthetic };
}

/**
 * Asked to continue an interrupted answer, a model sometimes starts over
 * instead. A later fragment that opens exactly like the first one is such a
 * restart: only the text from that fragment on is the answer.
 */
export function restartIndex(texts) {
  const opening = (texts[0] ?? '').trimStart().slice(0, 16);
  if (opening.length < 8) return 0;
  for (let index = texts.length - 1; index > 0; index--) {
    if (texts[index].trimStart().startsWith(opening)) return index;
  }
  return 0;
}

/**
 * Classify a failed stage for the runtime's retry policy.
 * - overflow: the host tried to compact (context full) or the provider rejected size.
 * - transient: interrupted streams, provider 408/409/425/429/5xx, missing idle,
 *   unexpected host messages.
 * - permanent: everything else (authentication, bad request, cancellation).
 */
export function classifyFailure(error, { compactionRequested = false } = {}) {
  if (compactionRequested) return 'overflow';
  const execution = error?.execution;
  if (execution?.interrupted) return 'permanent';
  const status = execution?.provider?.status;
  if (status === 413) return 'overflow';
  if ([408, 409, 425, 429].includes(status) || (status >= 500 && status <= 599)) return 'transient';
  if (status >= 400 && status < 500) return 'permanent';
  if (execution && ['failed', 'unknown', 'missing-idle'].includes(execution.terminalOutcome)) return 'transient';
  if (error?.contextChanged || error?.transient) return 'transient';
  return 'permanent';
}

/**
 * Admit exactly one literal prompt, await idle, then read authoritative context.
 * Works for the first prompt and for follow-up repair prompts in the same
 * session: only the turn after this admitted prompt is examined.
 */
export async function requestReview(context, { sessionID, text, role, model, metadata, signal, allowHostContinuations = false }) {
  const api = sessionApi(context, ['prompt', 'wait', 'context', 'get']);
  if (!textValue(sessionID) || !textValue(text) || !textValue(role)) throw new Error('[AZPR] A session, role and literal prompt are required.');
  const selectedModel = modelRef(model);
  aborted(signal);
  const admitted = await cancellable(() => admission(context, sessionID,
    () => api.prompt({ sessionID, text, ...(metadata === undefined ? {} : { metadata }), delivery: 'steer', resume: true })), signal);
  if (!record(admitted) || !textValue(admitted.id) || admitted.sessionID !== sessionID || admitted.type !== 'user' ||
      admitted.payload?.text !== text || !isDeepStrictEqual(admitted.payload?.metadata, metadata) || admitted.delivery !== 'steer' ||
      ['files', 'agents', 'skills'].some(key => admitted.payload?.[key]?.length)) {
    throw new Error('[AZPR] OpenCode V2 did not admit the exact literal review prompt.');
  }
  await cancellable(() => api.wait({ sessionID }), signal);
  const messages = await cancellable(() => api.context({ sessionID }), signal);
  const session = await cancellable(() => api.get({ sessionID }), signal);
  if (!Array.isArray(messages) || session?.id !== sessionID) throw new Error('[AZPR] Invalid OpenCode V2 session context.');
  const indexes = messages.flatMap((message, index) => message?.id === admitted.id ? [index] : []);
  if (indexes.length !== 1) {
    throw new Error('[AZPR] The admitted prompt is absent or ambiguous in the session context; compaction may have removed it. No output was accepted.');
  }
  const prompt = messages[indexes[0]];
  if (prompt.type !== 'user' || prompt.text !== text || !isDeepStrictEqual(prompt.metadata, metadata) || ['files', 'agents', 'skills'].some(key => prompt[key]?.length)) {
    throw new Error('[AZPR] The projected prompt differs from the admitted literal input.');
  }
  const turn = messages.slice(indexes[0] + 1);
  const continuation = continuedText(turn, allowHostContinuations);
  if (turn.some(message => FOREIGN_MESSAGE_TYPES.includes(message?.type) && !continuation.synthetic.has(message))) {
    const error = new Error('[AZPR] The session received another message during this turn; its output cannot be assigned to the authorized request.');
    error.contextChanged = true;
    throw error;
  }
  const terminal = turn.at(-1);
  const assistants = turn.filter(message => message?.type === 'assistant');
  const final = assistants.at(-1);
  const answer = final && Array.isArray(final.content) ? normalizeAnswer(final, sessionID) : undefined;
  if (session.outcome !== 'succeeded' || terminal?.type !== 'idle' || terminal.outcome !== 'succeeded') {
    const outcome = value => ['succeeded', 'failed', 'interrupted'].includes(value) ? value : 'unknown';
    const finish = ['stop', 'tool-calls', 'length', 'content-filter', 'error', 'cancelled'].includes(final?.finish) ? final.finish : 'unknown';
    const execution = { sessionOutcome: outcome(session.outcome),
      terminalOutcome: terminal?.type === 'idle' ? outcome(terminal.outcome) : 'missing-idle',
      assistantResponses: assistants.length, lastFinish: finish,
      interrupted: session.outcome === 'interrupted' || terminal?.outcome === 'interrupted' || final?.error?.type === 'aborted' };
    const provider = !execution.interrupted && providerFailure(final, assistants);
    if (provider) execution.provider = provider;
    const detail = provider
      ? `Model provider request failed (HTTP ${provider.status}; ${provider.toolCallsObserved} tool calls observed).${[401, 403].includes(provider.status) ? ' Check provider access and the role\'s tool permissions.' : ''} `
      : '';
    throw responseError(`[AZPR] ${detail}Reviewer execution did not finish successfully (session=${execution.sessionOutcome}; terminal=${execution.terminalOutcome}; assistantResponses=${assistants.length}; finish=${finish}).`, answer, execution);
  }
  if (session.agent !== role || !sameModel(session.model, selectedModel) ||
      assistants.some(message => message.agent !== role || !sameModel(message.model, selectedModel))) {
    throw responseError('[AZPR] Reviewer agent or model binding changed; no output was accepted.', answer);
  }
  if (!final || turn.at(-2) !== final || !Array.isArray(final.content) || !Number.isFinite(final.time?.completed) ||
      assistants.some(message => !continuation.recovered.has(message) && (message.error || !Number.isFinite(message.time?.completed) ||
        !['stop', 'tool-calls'].includes(message.finish)))) {
    const error = responseError('[AZPR] The session has no complete, successful final assistant response.', answer);
    error.transient = true;
    throw error;
  }
  if (final.finish !== 'stop' || final.content.some(part => part?.type === 'tool')) {
    throw responseError('[AZPR] Reviewer output did not end with a final text response.', answer);
  }
  if (answer.parts.some(part => typeof part.text !== 'string')) throw new Error('[AZPR] Invalid reviewer text content.');
  if (continuation.recovered.size) {
    const fragments = [...continuation.recovered, final].map(message => normalizeAnswer(message, sessionID));
    if (fragments.some(fragment => fragment.parts.some(part => typeof part.text !== 'string'))) throw new Error('[AZPR] Invalid continued reviewer text.');
    const texts = fragments.map(fragment => fragment.parts.map(part => part.text).join(''));
    const restartedAt = restartIndex(texts);
    // Keep literal boundaries; the output parser decides whether this is usable.
    answer.parts = [{ type: 'text', text: texts.slice(restartedAt).join('') }];
    answer.continuation = { count: continuation.recovered.size, fragments, ...(restartedAt ? { restartedAt } : {}) };
  }
  aborted(signal);
  return answer;
}

/** Acceptance of interrupt alone is not settlement; wait also covers idle no-op. */
export async function interruptSession(context, { sessionID, signal }) {
  const api = sessionApi(context, ['interrupt', 'wait']);
  if (!textValue(sessionID)) throw new Error('[AZPR] A reviewer session is required for cancellation.');
  const pending = pendingAdmissions.get(context)?.get(sessionID);
  if (pending?.size) await cancellable(() => Promise.allSettled([...pending]), signal);
  const result = await cancellable(() => api.interrupt({ sessionID, resume: false }), signal);
  if (!record(result) || typeof result.interrupted !== 'boolean') throw new Error('[AZPR] OpenCode V2 interruption was not acknowledged.');
  await cancellable(() => api.wait({ sessionID }), signal);
  return { interrupted: result.interrupted, settled: true };
}

/** Queue report data without starting a formatting or ordinary-agent model call. */
export async function appendReport(context, { sessionID, text, signal }) {
  const api = sessionApi(context, ['synthetic']);
  if (!textValue(sessionID) || !textValue(text)) throw new Error('[AZPR] Report destination and text are required.');
  const result = await cancellable(() => api.synthetic({
    sessionID, text, description: text,
    delivery: 'queue', resume: false,
  }), signal);
  if (!record(result) || !textValue(result.id) || result.sessionID !== sessionID || result.type !== 'synthetic' ||
      result.payload?.text !== text || result.delivery !== 'queue') {
    throw new Error('[AZPR] OpenCode V2 did not acknowledge the queued report.');
  }
  return { queued: true, id: result.id };
}
