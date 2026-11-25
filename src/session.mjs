/** OpenCode V2 session transport. No provider, Azure or HTTP client. */
import { isDeepStrictEqual } from 'node:util';
import { FOREIGN_MESSAGE_TYPES, USED_UP_LIMITS, isHostContinuation, isInstructionLoad, isInstructionUpdate, recordOf, requireMethods } from './host.mjs';

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
    const hash = value.indexOf('#'), base = hash < 0 ? value : value.slice(0, hash), slash = base.indexOf('/');
    if (slash > 0 && slash < base.length - 1 && hash !== value.length - 1) {
      return { providerID: base.slice(0, slash), id: base.slice(slash + 1), ...(hash < 0 ? {} : { variant: value.slice(hash + 1) }) };
    }
  }
  throw new Error('[AZPR] A V2 provider/model reference is required.');
}

function sameModel(actual, expected) {
  return actual?.providerID === expected.providerID && actual?.id === expected.id &&
    (actual?.variant ?? 'default') === (expected.variant ?? 'default');
}

/**
 * The conversation's location, which a child session would inherit. Undefined
 * when the host reports none; the host then uses the location this plugin
 * instance serves.
 */
async function conversationLocation(api, origin, signal) {
  const conversation = recordOf(await cancellable(() => api.get({ sessionID: origin }), signal).catch(() => null));
  const directory = conversation?.location?.directory;
  if (!textValue(directory)) return undefined;
  const workspaceID = conversation.location.workspaceID;
  return { directory, ...(workspaceID === undefined || workspaceID === null ? {} : { workspaceID }) };
}

/**
 * Create a session of its own with its agent and model already bound, at the
 * conversation's location. It is deliberately not a child of the conversation:
 * OpenCode 2.3.0 and later hand every answer of a child session to its parent
 * and wake the parent's own model with it. `metadata` marks the session as
 * AZPR's for tools that list sessions. A cancellation can overtake the host:
 * the session may still be created after this call gave up, and nothing else
 * would know it. `onLate` then receives it, when it is the session this call
 * asked for, so that the caller can delete it.
 */
export async function createReviewSession(context, { origin, title, role, model, permissions, metadata, signal, onLate }) {
  const api = sessionApi(context, ['create', 'get']);
  if (!textValue(origin) || !textValue(role) || !textValue(title)) throw new Error('[AZPR] Incomplete review session identity.');
  const selectedModel = modelRef(model);
  const location = await conversationLocation(api, origin, signal);
  const requested = made => record(made) && textValue(made.id) && made.id !== origin && (made.parentID ?? null) === null &&
    made.agent === role && sameModel(made.model, selectedModel) &&
    (location === undefined || !record(made.location) || made.location.directory === location.directory);
  let creating, made;
  try {
    made = await cancellable(() => (creating = Promise.resolve(api.create({
      title, agent: role, model: selectedModel,
      ...(location === undefined ? {} : { location }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(permissions === undefined ? {} : { permissions }),
    }))), signal);
  } catch (error) {
    if (onLate) creating?.then(late => { if (requested(late)) onLate(late); }).catch(() => {});
    throw error;
  }
  if (!requested(made)) throw new Error('[AZPR] OpenCode V2 did not create the requested independent reviewer session.');
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
  if (typeof error?.type !== 'string' || !error.type.startsWith('provider.')) return undefined;
  const exhausted = Object.hasOwn(USED_UP_LIMITS, error.type);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
  if (status === undefined && !exhausted) return undefined;
  return { ...(status === undefined ? {} : { status }), ...(exhausted ? { exhausted: error.type } : {}),
    toolCallsObserved: assistants.reduce((count, message) => count +
      (Array.isArray(message.content) ? message.content.filter(part => part?.type === 'tool').length : 0), 0) };
}

/**
 * Errored assistant messages of steps the host retried by itself after an
 * interrupted stream (OpenCode 2.3.0 and later): each is marked for retry and
 * directly followed by the assistant message of the retried step. The retry is
 * sent with what the step had finished (its tool calls that ran and what came
 * before them) and without the output the interruption cut off, so the answer
 * is the final message alone and nothing of these messages is joined to it.
 */
function retriedSteps(turn, enabled) {
  const retried = new Set();
  if (!enabled) return retried;
  turn.forEach((message, index) => {
    if (message?.type === 'assistant' && message.error && message.finish === 'error' && Number.isInteger(message.retry?.attempt) &&
        message.retry.attempt >= 1 && Number.isFinite(message.time?.completed) && turn[index + 1]?.type === 'assistant') retried.add(message);
  });
  return retried;
}

/**
 * Text fragments of a stream the host interrupted and resumed with a
 * continuation message (OpenCode through 2.2.x). Accept only errored text-only
 * assistant messages that the host marked for retry, each followed by the host
 * continuation, and finally a successful text answer.
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

// How the host says that a background command ended: completed (whatever its exit code), cancelled or in error.
const SHELL_ENDED = Object.freeze(['completed', 'cancelled', 'error']);

/**
 * The host's notices that a background command of this session has ended (shell under `shell: "ask"` or
 * `"inherit"`). A shell call that goes on in the background says so in its tool part (`state.metadata`: `status`
 * "running" and a `shellID`; a call that ended in the foreground names no shell), and when the command ends the
 * host writes one synthetic message whose metadata names that shell and how it ended (`source` "shell",
 * `shellID`, `state`), which it hands to the model like a late tool result (OpenCode 2.3.0 through 2.4.1). Each
 * such shell reports once. A second notice for it, a notice before its call, one for a shell this session did
 * not start (a command a person ran with `!`, another session's) and one without the host's marks are someone
 * else's messages.
 */
function ownShellNotices(messages) {
  const pending = new Set(), notices = new Set();
  for (const message of messages) {
    if (message?.type === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        const reported = part?.type === 'tool' && part.name === 'shell' ? part.state?.metadata : undefined;
        if (reported?.status === 'running' && textValue(reported.shellID)) pending.add(reported.shellID);
      }
    } else if (message?.type === 'synthetic' && message.metadata?.source === 'shell' && SHELL_ENDED.includes(message.metadata.state) &&
        pending.delete(message.metadata.shellID)) notices.add(message);
  }
  return notices;
}

/**
 * Classify a failed stage for the runtime's retry policy.
 * - overflow: the host attempted compaction in the failed turn (context full) or
 *   the provider rejected size. A refused background summary (OpenCode's
 *   `compaction.background`, on by default from 2.3.1 on; before that
 *   `experimental.background_compaction`) is not evidence: the turn went on, so
 *   its own failure decides.
 * - transient: interrupted streams, provider 408/409/425/429/5xx, missing idle,
 *   unexpected host messages.
 * - permanent: everything else (authentication, bad request, a used-up usage or
 *   spend limit, whatever its HTTP status, cancellation).
 */
export function classifyFailure(error) {
  const execution = error?.execution;
  if (execution?.compaction) return 'overflow';
  if (execution?.interrupted || execution?.provider?.exhausted) return 'permanent';
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
 *
 * A turn is the admitted prompt and what follows it up to the first idle marker. A prompt becomes a message of
 * the session only in the execution that takes it, and an execution leaves one marker when it ends, however it
 * ends (OpenCode 2.3.0 through 2.4.1), so that marker is the end of the execution that had the prompt, and says
 * how the turn ended. The turn's answer is the last assistant message before it.
 *
 * Two kinds of messages the host writes by itself are no one else's input and no step of the turn. What it
 * wrote of instructions (`isInstructionLoad`, `isInstructionUpdate`), anywhere in the session, since every
 * request is sent the whole session: the caller says of each by its ID that no request of this session showed
 * it (`unseen`), and where it does not say so of one, an answer is not accepted. And the notice that a
 * background command of this session ended (`ownShellNotices`). Anyone else's message fails the request, as
 * before, wherever the model of this turn was sent it: after the prompt, and between the turn before and the
 * prompt (`since` is that turn's prompt, and what stands before a session's first prompt counts too).
 *
 * What follows the turn's idle marker is no part of it: a command that ended later woke the session, and what
 * the host did then neither changes the answer nor how the turn ended. `settled` is called once the host reports
 * the session idle, before anything else is awaited, so that the caller can close what it opened for the turn.
 */
export async function requestReview(context, { sessionID, text, role, model, metadata, signal, allowHostContinuations = false, unseen, since, settled }) {
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
  settled?.();
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
  const changed = message => Object.assign(new Error(message), { contextChanged: true });
  const after = messages.slice(indexes[0] + 1);
  const notices = ownShellNotices(messages);
  // What the host wrote of instructions is answered for by the caller (below), and its notices of this
  // session's own commands are no input of anyone else's: neither is a step.
  const instructions = message => isInstructionLoad(message) || isInstructionUpdate(message);
  const own = message => instructions(message) || notices.has(message);
  const steps = after.filter(message => !own(message));
  const end = steps.findIndex(message => message?.type === 'idle');
  const turn = end < 0 ? steps : steps.slice(0, end + 1);
  // What reached the session since the turn before was sent to this turn's model with the rest: from that turn's
  // idle marker on, or from the session's beginning.
  let from = 0;
  if (since !== undefined) {
    const before = messages.findIndex(message => message?.id === since);
    const ended = before < 0 ? -1 : messages.findIndex((message, index) => index > before && message?.type === 'idle');
    if (ended < 0 || ended > indexes[0]) throw changed('[AZPR] The turn before this one is no longer where the session\'s messages had it; no output was accepted.');
    from = ended + 1;
  }
  const between = messages.slice(from, indexes[0]).filter(message => !own(message));
  // Either way the host recovers an interrupted stream; both need the caller's consent.
  const retried = retriedSteps(turn, allowHostContinuations);
  const continuation = continuedText(turn.filter(message => !retried.has(message)), allowHostContinuations);
  // Someone else's message ends it: before the prompt, in the turn or after it.
  if ([...between, ...steps].some(message => FOREIGN_MESSAGE_TYPES.includes(message?.type) && !continuation.synthetic.has(message))) {
    throw changed('[AZPR] The session received another message during this turn; its output cannot be assigned to the authorized request.');
  }
  const terminal = turn.at(-1);
  const assistants = turn.filter(message => message?.type === 'assistant');
  const final = assistants.at(-1);
  const answer = final && Array.isArray(final.content) ? normalizeAnswer(final, sessionID) : undefined;
  // The turn's own marker says how it ended. The session's outcome is that of its latest execution, which can be a
  // later one: it only describes a turn that has no marker.
  const marked = end >= 0;
  if (terminal?.type !== 'idle' || terminal.outcome !== 'succeeded') {
    const outcome = value => ['succeeded', 'failed', 'interrupted'].includes(value) ? value : 'unknown';
    const finish = ['stop', 'tool-calls', 'length', 'content-filter', 'error', 'cancelled'].includes(final?.finish) ? final.finish : 'unknown';
    const execution = { sessionOutcome: outcome(session.outcome),
      terminalOutcome: terminal?.type === 'idle' ? outcome(terminal.outcome) : 'missing-idle',
      assistantResponses: assistants.length, lastFinish: finish,
      interrupted: (!marked && session.outcome === 'interrupted') || terminal?.outcome === 'interrupted' || final?.error?.type === 'aborted' };
    // OpenCode opens a compaction's message before it asks for the summary, so a compaction it attempted in this
    // turn, which AZPR refuses, shows here. A background summary (OpenCode 2.1.4 and later) publishes nothing.
    const compaction = turn.filter(message => message?.type === 'compaction').at(-1);
    if (compaction) execution.compaction = ['running', 'completed', 'failed'].includes(compaction.status) ? compaction.status : 'unknown';
    const provider = !execution.interrupted && providerFailure(final, assistants);
    if (provider) execution.provider = provider;
    const hint = provider?.exhausted
      ? ` ${USED_UP_LIMITS[provider.exhausted]} (${provider.exhausted}), so a new session would fail the same way and is not started. Choose another model in the settings or wait until the limit resets.`
      : [401, 403].includes(provider?.status) ? ' Check provider access and the role\'s tool permissions.' : '';
    const detail = provider
      ? `Model provider request failed (${provider.status ? `HTTP ${provider.status}; ` : ''}${provider.toolCallsObserved} tool calls observed).${hint} `
      : '';
    throw responseError(`[AZPR] ${detail}Reviewer execution did not finish successfully (session=${execution.sessionOutcome}; terminal=${execution.terminalOutcome}; assistantResponses=${assistants.length}; finish=${finish}).`, answer, execution);
  }
  // Instructions that a request showed, in this turn or in an earlier one of the session, are instructions nobody
  // authorized for this answer. A turn that did not succeed has failed by its own outcome above, which decides
  // whether it is tried again.
  if (messages.some(message => instructions(message) && unseen?.(message.id) !== true)) {
    throw changed('[AZPR] Instructions that OpenCode wrote into this session by itself were not kept from its model; the output cannot be assigned to the authorized request.');
  }
  if (session.agent !== role || !sameModel(session.model, selectedModel) ||
      assistants.some(message => message.agent !== role || !sameModel(message.model, selectedModel))) {
    throw responseError('[AZPR] Reviewer agent or model binding changed; no output was accepted.', answer);
  }
  if (!final || turn.at(-2) !== final || !Array.isArray(final.content) || !Number.isFinite(final.time?.completed) ||
      assistants.some(message => !continuation.recovered.has(message) && !retried.has(message) && (message.error || !Number.isFinite(message.time?.completed) ||
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
  if (retried.size) answer.retriedSteps = retried.size;
  const loads = after.filter(isInstructionLoad).length;
  if (loads) answer.instructionLoads = loads;
  // The prompt of this turn, for the caller's next one in this session (`since`).
  answer.prompt = admitted.id;
  const noticed = after.filter(message => notices.has(message)).length;
  if (noticed) answer.shellNotices = noticed;
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

/**
 * Leave report data in the session's inbox without starting a formatting or ordinary-agent model call.
 * `steer` decides what happens when that session's own model runs next: the host hands every steered item
 * that waits to the model at once, together with the prompt that woke it, while it gives each queued item
 * a turn of its own (one model request per notice, each with the whole conversation).
 * `metadata` is stored with the notice for clients that read it (the terminal panel); no model sees it,
 * and a call without it carries none.
 */
export async function appendReport(context, { sessionID, text, signal, metadata }) {
  const api = sessionApi(context, ['synthetic']);
  if (!textValue(sessionID) || !textValue(text)) throw new Error('[AZPR] Report destination and text are required.');
  const result = await cancellable(() => api.synthetic({
    sessionID, text, description: text,
    ...(metadata ? { metadata } : {}),
    delivery: 'steer', resume: false,
  }), signal);
  if (!record(result) || !textValue(result.id) || result.sessionID !== sessionID || result.type !== 'synthetic' ||
      result.payload?.text !== text || result.delivery !== 'steer') {
    throw new Error('[AZPR] OpenCode V2 did not acknowledge the report.');
  }
  return { queued: true, id: result.id };
}
