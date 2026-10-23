/**
 * OpenCode host compatibility helpers.
 *
 * The plugin is validated against one OpenCode release, but it should detect
 * capabilities instead of assuming exact response shapes. Every host-specific
 * constant and response normalization lives here so an upgrade has one place
 * to adjust.
 */
export const TESTED_HOST_VERSION = '2.1.4';

// Text OpenCode (2.0.32 through 2.1.4) queues after resuming an interrupted text stream.
export const HOST_CONTINUATION_TEXT = 'The previous response was interrupted. Continue from where you left off without repeating completed content.';

// Context message types that mean someone other than the admitted prompt
// changed the conversation. Unknown future types are tolerated.
export const FOREIGN_MESSAGE_TYPES = Object.freeze(['user', 'synthetic', 'agent-switched', 'model-switched', 'location-switched', 'shell', 'skill']);

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Lists may arrive as `{ data: [...] }` or as a bare array. */
export function listOf(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return null;
}

/** Records may arrive as `{ data: {...} }` or directly. */
export function recordOf(value) {
  if (isRecord(value?.data)) return value.data;
  return isRecord(value) ? value : null;
}

export function hostVersion(context) {
  return typeof context?.app?.version === 'string' ? context.app.version : 'unknown';
}

export function hostCapabilities(context) {
  const fn = path => typeof path.split('.').reduce((value, key) => value?.[key], context) === 'function';
  const version = hostVersion(context);
  return {
    version,
    tested: version === TESTED_HOST_VERSION,
    permissionHook: fn('permission.hook'),
    toolTransform: fn('tool.transform'),
    sessionRemove: fn('session.remove'),
    eventSubscribe: fn('event.subscribe'),
  };
}

/**
 * Session events that show a turn progressing while no hook runs. OpenCode
 * 2.1.2 and 2.1.4 emit one delta event per streamed chunk of answer text,
 * reasoning or tool-call input; the projected session context shows the text
 * only once the step ends.
 */
const PROGRESS_EVENTS = new Map([
  ...['started', 'delta', 'ended'].map(phase => [`session.text.${phase}`, 'model output was streamed']),
  ...['started', 'delta', 'ended'].map(phase => [`session.reasoning.${phase}`, 'model reasoning was streamed']),
  ...['started', 'delta', 'ended'].map(phase => [`session.tool.input.${phase}`, 'a tool call was streamed']),
  ['session.tool.progress', 'a tool reported progress'],
  ['session.step.started', 'a model step started'],
  ['session.step.streamed', 'a model step finished streaming'],
  ['session.step.ended', 'a model step ended'],
]);

/** The session and activity a progress event stands for, or null. */
export function sessionProgress(event) {
  const activity = PROGRESS_EVENTS.get(event?.type);
  const sessionID = event?.data?.sessionID;
  return activity && typeof sessionID === 'string' ? { sessionID, activity } : null;
}

/**
 * OpenCode runs plugins on Bun (1.4.2 in 2.0.32 and 2.1.2, 1.4.4 in 2.1.4),
 * whose fetch accepts per-request `proxy` and `tls` options. Node's fetch
 * silently ignores both, so a configured proxy would be bypassed; callers
 * refuse instead.
 */
export const fetchTransportSupported = () => typeof process.versions?.bun === 'string';

/**
 * Model token usage per assistant message of a session context, oldest first.
 * OpenCode reports `tokens: { input, output, reasoning, cache: { read, write } }`
 * on each assistant message; `input` excludes cached input, so the prompt of a
 * request is input + cache.read + cache.write. Missing or invalid counts are 0.
 */
export function tokenUsage(messages) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.type === 'assistant' && isRecord(message.tokens))
    .map(({ tokens }) => ({ input: count(tokens.input), cacheRead: count(tokens.cache?.read), cacheWrite: count(tokens.cache?.write),
      output: count(tokens.output), reasoning: count(tokens.reasoning) }));
}

/** Sums of `tokenUsage` rows and the share of prompt tokens read from the provider's cache (null without prompt tokens). */
export function usageTotals(requests) {
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  for (const request of requests) for (const key of Object.keys(total)) total[key] += request[key];
  const prompt = total.input + total.cacheRead + total.cacheWrite;
  return { ...total, cachedInputShare: prompt ? Number((total.cacheRead / prompt).toFixed(4)) : null };
}

/** Throw one readable error naming every missing host method. */
export function requireMethods(context, paths, purpose) {
  const missing = paths.filter(path => typeof path.split('.').reduce((value, key) => value?.[key], context) !== 'function');
  if (missing.length) throw new Error(`[AZPR] OpenCode does not provide ${missing.join(', ')}; ${purpose} is unavailable.`);
}

/**
 * A synthetic host message that resumes an interrupted stream. The exact text
 * is preferred; a reworded continuation is accepted only directly after an
 * errored assistant message that the host marked for retry.
 */
export function isHostContinuation(message, previous) {
  if (message?.type !== 'synthetic' || typeof message.text !== 'string') return false;
  if (message.text === HOST_CONTINUATION_TEXT) return true;
  return previous?.type === 'assistant' && Boolean(previous.error) && Number.isInteger(previous.retry?.attempt) &&
    /interrupt/i.test(message.text) && /continue/i.test(message.text);
}
