/**
 * OpenCode host compatibility helpers.
 *
 * The plugin was validated against one OpenCode release, but it should detect
 * capabilities instead of assuming exact response shapes. Every host-specific
 * constant and response normalization lives here so an upgrade has one place
 * to adjust.
 */
export const TESTED_HOST_VERSION = '2.0.22';

// Text OpenCode 2.0.22 queues after resuming an interrupted text stream.
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

/** MCP namespaces are sanitized the same way OpenCode names MCP tools. */
export const sanitizeNamespace = name => String(name).replace(/[^a-zA-Z0-9_-]/g, '_');

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
    toolList: fn('tool.list'),
    sessionRemove: fn('session.remove'),
  };
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
