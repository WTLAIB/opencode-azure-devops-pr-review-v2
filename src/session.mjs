/** Exact OpenCode 2.0.22 session transport. No provider, Azure, or HTTP client. */
import { isDeepStrictEqual } from 'node:util';
const pendingAdmissions = new WeakMap();
const textValue = value => typeof value === 'string' && value.length > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function sessionApi(context, methods) {
  for (const method of methods) {
    if (typeof context?.session?.[method] !== 'function') {
      throw new Error(`[AZPR] OpenCode V2 session.${method} is unavailable.`);
    }
  }
  return context.session;
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('[AZPR] Session operation cancelled.');
}

// The pinned Promise plugin adapter ignores request options, including signals.
// Race locally, but retain pending admissions so cleanup cannot certify an idle
// session before a delayed prompt is admitted. The workflow owns cleanup limits.
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

function responseError(message, response) {
  const error = new Error(message);
  if (response) error.response = response;
  return error;
}

/**
 * Admit exactly one literal prompt, await idle, then read authoritative context.
 * Context is not a full history API: if compaction removes the admitted input,
 * correlation fails closed. Events cannot substitute for that missing evidence.
 */
export async function requestReview(context, { sessionID, text, role, model, metadata, signal }) {
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
    throw new Error('[AZPR] The exact admitted review prompt is absent or ambiguous in active context; compaction may have removed it. No output was accepted.');
  }
  const prompt = messages[indexes[0]];
  if (prompt.type !== 'user' || prompt.text !== text || !isDeepStrictEqual(prompt.metadata, metadata) || ['files', 'agents', 'skills'].some(key => prompt[key]?.length)) {
    throw new Error('[AZPR] The projected review prompt differs from the admitted literal input.');
  }
  const turn = messages.slice(indexes[0] + 1);
  if (turn.some(message => ['user', 'synthetic', 'agent-switched', 'model-switched', 'location-switched', 'shell', 'skill'].includes(message?.type))) {
    throw new Error('[AZPR] Reviewer context changed after admission; output cannot be assigned to the authorized request.');
  }
  const terminal = turn.at(-1);
  const assistants = turn.filter(message => message?.type === 'assistant');
  const final = assistants.at(-1);
  const answer = final && Array.isArray(final.content) ? normalizeAnswer(final, sessionID) : undefined;
  if (session.outcome !== 'succeeded' || terminal?.type !== 'idle' || terminal.outcome !== 'succeeded') {
    throw responseError('[AZPR] Reviewer execution did not finish successfully; no partial response was accepted.', answer);
  }
  if (session.agent !== role || !sameModel(session.model, selectedModel) ||
      assistants.some(message => message.agent !== role || !sameModel(message.model, selectedModel))) {
    throw responseError('[AZPR] Reviewer agent or model binding changed; no output was accepted.', answer);
  }
  if (!final || turn.at(-2) !== final || !Array.isArray(final.content) || !Number.isFinite(final.time?.completed) ||
      assistants.some(message => message.error || !Number.isFinite(message.time?.completed) ||
        !['stop', 'tool-calls'].includes(message.finish))) {
    throw responseError('[AZPR] Reviewer context has no complete, successful final assistant response.', answer);
  }
  if (final.finish !== 'stop' || final.content.some(part => part?.type === 'tool')) {
    throw responseError('[AZPR] Reviewer output did not end with a final text response; no partial output was accepted.', answer);
  }
  if (answer.parts.some(part => typeof part.text !== 'string')) throw new Error('[AZPR] Invalid reviewer text content.');
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
