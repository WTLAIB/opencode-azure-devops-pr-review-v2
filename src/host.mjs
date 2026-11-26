/**
 * OpenCode host compatibility helpers.
 *
 * The plugin is validated against one OpenCode release, but it should detect
 * capabilities instead of assuming exact response shapes. Every host-specific
 * constant and response normalization lives here so an upgrade has one place
 * to adjust.
 */
export const TESTED_HOST_VERSION = '2.4.1';

// Text OpenCode 2.0.32 through 2.2.7 queue after resuming an interrupted text stream. OpenCode 2.3.0 retries the
// interrupted step instead and queues nothing (see `retriedSteps` in session.mjs).
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
    sessionUpdate: fn('session.update'),
    eventSubscribe: fn('event.subscribe'),
    pluginList: fn('plugin.list'),
  };
}

/** Whether a package specification names the npm package, or the Git repository (github:, git URLs, owner/repo). */
export function packageNamed(target, name, repository) {
  const spec = typeof target === 'string' ? target.trim() : '';
  if (spec === name || spec.startsWith(`${name}@`)) return true;
  const repo = repository.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[:/])${repo}(?:\\.git)?(?:[?#]|$)`).test(spec.toLowerCase());
}

/**
 * This plugin's entries in the host's plugin list. OpenCode 2.1.4 through 2.4.1 list
 * { id?, source: { type: package|local|builtin|sdk, target?, version? },
 * state: { status: active|failed, error? } } and keeps only the first entry
 * of a plugin ID: a second one is listed as failed with "Duplicate plugin ID".
 * `running` is the active entry with the plugin's ID; `others` are the other
 * entries with that ID or naming one of its packages. null without a list.
 */
export function pluginEntries(value, { id, ownPackage }) {
  const entries = listOf(value);
  if (!entries) return null;
  const ours = entries.filter(entry => isRecord(entry) && (entry.id === id || (entry.source?.type === 'package' && ownPackage(entry.source.target))));
  const running = ours.find(entry => entry.id === id && entry.state?.status === 'active') ?? null;
  return { running, others: ours.filter(entry => entry !== running) };
}

/**
 * Text with each URL's user name, password and query string masked: a Git or
 * tarball package specification, and host messages that quote one, can carry
 * a token there.
 */
export function withoutCredentials(text) {
  return String(text ?? '').replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*@)?([^\s?#]*)(\?[^\s#]*)?/gi,
    (match, scheme, userinfo, rest, query) => `${scheme}${userinfo ? '***@' : ''}${rest}${query ? '?***' : ''}`);
}

/** A path- and credential-free label for a plugin list entry's source: its package specification and installed version or commit. */
export function pluginSourceLabel(source) {
  if (source?.type === 'local') return 'a local source installation';
  if (source?.type !== 'package' || typeof source.target !== 'string') return 'an entry of unknown origin';
  const version = typeof source.version === 'string' && source.version && !source.target.endsWith(`@${source.version}`) && !source.target.endsWith(`#${source.version}`)
    ? /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(source.version) ? `commit ${source.version.slice(0, 7)}` : `version ${source.version}` : '';
  return `${withoutCredentials(source.target)}${version ? ` (${version})` : ''}`;
}

/**
 * Session events that show a turn progressing while no hook runs. OpenCode
 * 2.1.2 through 2.4.1 emit one delta event per streamed chunk of answer text,
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

/**
 * The event types to subscribe to. OpenCode 2.2.0 and later deliver only
 * these (`event.subscribe({ types })`); earlier releases ignore the option and
 * `sessionProgress` skips the rest.
 */
export const PROGRESS_EVENT_TYPES = Object.freeze([...PROGRESS_EVENTS.keys()]);

/** The session and activity a progress event stands for, or null. */
export function sessionProgress(event) {
  const activity = PROGRESS_EVENTS.get(event?.type);
  const sessionID = event?.data?.sessionID;
  return activity && typeof sessionID === 'string' ? { sessionID, activity } : null;
}

/**
 * OpenCode runs plugins on Bun (1.4.2 in 2.0.32 and 2.1.2, 1.4.4 in 2.1.4 through 2.4.1),
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

/**
 * Provider error types that mean a usage or spend limit is used up. Another
 * attempt fails the same way, so AZPR refuses OpenCode's retries of them and
 * starts no new session. OpenCode 2.2.0 added the spend limits, 2.2.3 the
 * ChatGPT and OpenCode Go usage limits and 2.4.0 the limit a ChatGPT
 * workspace's admin sets for a member; before, a ChatGPT limit arrived as a
 * rate limit (the workspace limit as a rate limit or, where its text speaks
 * of a usage limit, as a used-up quota).
 */
export const USED_UP_LIMITS = Object.freeze({
  'provider.quota': 'The provider reports the usage quota as used up',
  'provider.free-limit': "OpenCode reports the free model's usage limit as reached",
  'provider.chatgpt-limit': 'ChatGPT reports the subscription usage limit as reached',
  'provider.chatgpt-workspace-limit': "ChatGPT reports the usage limit set by the workspace's admin as reached",
  'provider.go-limit': 'OpenCode Go reports its usage limit as reached',
  'provider.budget-limit': 'OpenCode reports the workspace usage limit as reached',
  'provider.model-budget-limit': "OpenCode reports this model's spend limit as reached",
});

/**
 * The longest line OpenCode's native `read` returns whole: it cuts a longer one there and appends
 * "... (line truncated to 2000 chars)" (OpenCode 2.3.0 through 2.4.1). A model reads AZPR's private data pages
 * with that tool, one row per line, so a row must not be longer.
 */
export const HOST_READ_LINE_CHARACTERS = 2000;

/**
 * Whether a rejected session call says the session does not exist. OpenCode
 * 2.2.4 through 2.4.1 reject `session.get` and `session.remove` of such a session
 * with an error whose `_tag` and `name` are `Session.NotFoundError`.
 */
export const isSessionNotFound = error => (error?._tag ?? error?.name) === 'Session.NotFoundError';

/**
 * Whether a session still has the name OpenCode shows for one that nobody named. OpenCode 2.3.0 through 2.4.1
 * create a conversation without a title and list it as "New session"; earlier releases stored the same words with the
 * time it was created. OpenCode's own model names such a conversation when it first runs there.
 */
export function isUntitledSession(session) {
  const title = session?.title;
  return title === undefined || title === null || title === '' ||
    (typeof title === 'string' && /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title));
}

/**
 * The sources of a request's instructions that are facts of the host itself: the date and the environment (the
 * working directory and the platform). Every other source tells of the place a conversation is in or of what is
 * configured there: instruction files (AGENTS.md, CLAUDE.md, the instructions a configuration lists), what MCP
 * servers, references and skills say of themselves, CodeMode guidance, instructions another plugin added.
 */
export const HOST_FACT_SOURCES = Object.freeze(['core/date', 'core/environment']);

/**
 * A request's system parts with the instructions part rebuilt from the sources named in `keep`. OpenCode 2.3.0
 * through 2.4.1 build that part from sources, join their texts with a blank line and keep each source as
 * `{ key, text }` in the part's `metadata.experimental.instructions`, a field the host marks as experimental.
 * Returns `{ system, removed }` (the sources that were left out, in their order), or null where no part has that
 * shape, more than one has it, or its text is not what its sources give: nothing can be told apart then, and
 * the caller leaves the request as it is.
 */
export function withoutPlaceInstructions(system, keep = HOST_FACT_SOURCES) {
  if (!Array.isArray(system)) return null;
  const found = system.flatMap((part, index) => Array.isArray(part?.metadata?.experimental?.instructions) ? [index] : []);
  if (found.length !== 1) return null;
  const [at] = found, part = system[at], sources = part.metadata.experimental.instructions;
  if (typeof part.text !== 'string' || !sources.every(source => isRecord(source) && typeof source.key === 'string' && typeof source.text === 'string') ||
      part.text !== sources.map(source => source.text).join('\n\n')) return null;
  const kept = sources.filter(source => keep.includes(source.key)), removed = sources.filter(source => !keep.includes(source.key));
  if (!removed.length) return { system, removed };
  const rebuilt = kept.length ? [{ ...part, text: kept.map(source => source.text).join('\n\n'),
    metadata: { ...part.metadata, experimental: { ...part.metadata.experimental, instructions: kept } } }] : [];
  return { system: [...system.slice(0, at), ...rebuilt, ...system.slice(at + 1)], removed };
}

/**
 * OpenCode's own provider for Claude Code, and the request option in which it keeps the instructions it hands the
 * model. That provider does not send a request's system parts. Its own `context` hook, which runs before any
 * plugin's and before the built-in hooks that add parts of their own, leaves there what it made of the
 * instructions part: the texts of its sources but the date and the environment, which Claude Code writes itself,
 * joined with a blank line (OpenCode 2.3.0 through 2.4.1, measured on 2.3.0 and 2.4.1).
 */
export const CLAUDE_PROVIDER = 'claude-agent';
export const CLAUDE_INSTRUCTIONS_OPTION = 'claudeCodeInstructions';

/**
 * What that option holds for a request whose instructions part has these sources besides the host's facts. A
 * caller that leaves those sources out of the system parts empties the option too, and only where the option
 * holds exactly this: anything else was made another way, and nothing can be told apart.
 */
export const claudeInstructions = sources => sources.map(source => source.text).join('\n\n');

/**
 * The instruction files OpenCode leaves in a session by itself after the session's native read tool read a file of
 * the project: the files between that file and the conversation's directory (AGENTS.md; from OpenCode 2.3.1 also
 * CLAUDE.md), as a synthetic message whose `metadata.instruction.paths` names the files it holds (OpenCode 2.3.0
 * through 2.4.1). Nothing else is one: not a message without an ID, and not a person's message or an assistant
 * message that carries such metadata. This is the form a session's own messages hold it in.
 */
export function isInstructionLoad(message) {
  const paths = message?.metadata?.instruction?.paths;
  return message?.type === 'synthetic' && typeof message.id === 'string' && message.id.length > 0 && Array.isArray(paths) && paths.length > 0 &&
    paths.every(path => typeof path === 'string' && path.length > 0);
}

/**
 * An update of the instructions as a session's own messages hold it: OpenCode writes a `system` message when a
 * source changed while the session ran (an instruction file that was edited, an MCP server that says something
 * else), and nothing else writes one (OpenCode 2.3.0 through 2.4.1, from `session.instructions.updated`).
 */
export const isInstructionUpdate = message => message?.type === 'system' && typeof message.id === 'string' && message.id.length > 0 && typeof message.text === 'string';

// What OpenCode makes of such an update in a request: a system message whose content is its text as one text
// part, without an ID, metadata or tools. The other system messages it knows change a model's effort or its
// tools and hold no text.
const updateText = message => {
  if (message?.role !== 'system' || message.id !== undefined || message.metadata !== undefined || message.tools !== undefined) return undefined;
  const content = message.content;
  return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string' ? content[0].text : undefined;
};

// Whether a value holds one of the texts whole in one of its strings, however deep: a message's content is a
// string, parts, or what a tool returned. Bytes are no text, and a value is looked at once.
const holdsText = (value, texts) => {
  const seen = new Set(), open = [value];
  while (open.length) {
    const item = open.pop();
    if (typeof item === 'string') { if (texts.some(text => item.includes(text))) return true; continue; }
    if (item === null || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer || seen.has(item)) continue;
    seen.add(item);
    for (const held of Array.isArray(item) ? item : Object.values(item)) open.push(held);
  }
  return false;
};

/**
 * A request's messages without what OpenCode wrote into the session by itself: its loads of instruction files
 * and its updates of the instructions. Which messages those are is the session's own word (`stored`, its
 * messages as the host holds them), not the request's: a hook that ran before this one may have changed what a
 * request message looks like. A load is taken out by its ID, whatever the request made of it; an update, which
 * has no ID in a request, wherever a system message of the host's form holds exactly its text, every copy of it.
 *
 * `left` says that a message that stays still holds the text of one of them, whole and word for word in one of
 * its strings, however deep: a hook before this one joined it to another message, gave its message another ID
 * or another form. Such a request cannot be sent without showing that text, and taking it out of another
 * message is not this function's to do. A text that such a hook cut into pieces or wrote in other words is not
 * found. `loads` and
 * `updates` are the IDs of the session's messages that were found and taken out. A session that holds no such
 * message gets its request back as it is.
 */
export function withoutHostMessages(requested, stored) {
  const loads = stored.filter(isInstructionLoad), updates = stored.filter(isInstructionUpdate);
  if (!loads.length && !updates.length) return { messages: requested, loads: [], updates: [], left: false };
  const loadIDs = new Set(loads.map(message => message.id)), found = { loads: new Set(), updates: new Set() };
  const messages = requested.filter(message => {
    if (typeof message?.id === 'string' && loadIDs.has(message.id)) { found.loads.add(message.id); return false; }
    const text = updateText(message);
    const same = text === undefined ? [] : updates.filter(update => update.text === text);
    for (const update of same) found.updates.add(update.id);
    return !same.length;
  });
  const texts = [...loads, ...updates].map(message => message.text).filter(text => typeof text === 'string' && text.length > 0);
  return { messages, loads: [...found.loads], updates: [...found.updates], left: messages.some(message => holdsText(message, texts)) };
}

/**
 * The message a session's turn began with: the one user message that carries the nonce AZPR sent its prompt
 * with. A prompt that is admitted waits in the session's inbox, and becomes a message only in the execution
 * that takes it (OpenCode 2.3.0 through 2.4.1); until then, and where two messages carry the nonce, there is none.
 */
export function promptOf(messages, nonce) {
  const prompts = typeof nonce === 'string' && nonce.length > 0 ? messages.filter(message => message?.type === 'user' && message.metadata?.azprGrant === nonce) : [];
  return prompts.length === 1 && typeof prompts[0].id === 'string' && prompts[0].id.length > 0 ? prompts[0] : undefined;
}

/**
 * Where a turn stands, by the session's own messages: `before` while the turn's prompt is not among them,
 * `running` while no idle marker follows it, and `ended` once one does (an execution leaves one marker when it
 * ends, however it ends, before the host starts another one; OpenCode 2.3.0 through 2.4.1).
 */
export function turnState(messages, prompt) {
  const at = prompt ? messages.indexOf(prompt) : -1;
  if (at < 0) return 'before';
  return messages.slice(at + 1).some(message => message?.type === 'idle') ? 'ended' : 'running';
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
