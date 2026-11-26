import { types } from 'node:util';

/**
 * OpenCode host compatibility helpers.
 *
 * The plugin is validated against one OpenCode release, but it should detect
 * capabilities instead of assuming exact response shapes. Every host-specific
 * constant and response normalization lives here so an upgrade has one place
 * to adjust.
 *
 * How the comments here date what a host does: "OpenCode 2.3.0 to the tested version" is a behaviour AZPR relies
 * on, seen from 2.3.0 on and still there in `TESTED_HOST_VERSION`. Every move of the tested version checks each
 * such fact again on the new release (the study of that release lists them with the source read or probe that
 * checked them); a behaviour that ends then gets a closed range. "Measured on …" names the releases a
 * measurement ran on, and a change from one release to the next names both.
 */
// The one OpenCode release AZPR is tested with. CI, the installer and CONTRIBUTING read it from here, and the
// README shows it (tests/release.test.mjs holds the two together).
export const TESTED_HOST_VERSION = '2.4.2';

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

// A release of 2.0.x to 2.2.x, as a whole version (Semantic Versioning 2.0.0): numbers without a leading zero,
// then perhaps a pre-release and build metadata, each of identifiers between dots, none of them empty.
const NUMBER = '(?:0|[1-9]\\d*)', NAME = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)', BUILD = '[0-9A-Za-z-]+';
const EARLIER_PROTOCOL = new RegExp(`^2\\.[0-2]\\.${NUMBER}(?:-${NAME}(?:\\.${NAME})*)?(?:\\+${BUILD}(?:\\.${BUILD})*)?$`);

/**
 * Whether a host of this version recovers an interrupted stream by retrying the step (OpenCode 2.3.0 and later)
 * and never by a continuation message that it queues (2.0.32 through 2.2.7). Only a version that names a host of
 * the earlier protocol, 2.0.x to 2.2.x, says otherwise: a host that does not say its version, or says one that
 * is no release (a development build, a text that is no version), is taken for a current one. The message of
 * the earlier protocol is known by its text alone, which anyone can post, so it is accepted only where the host
 * is known to write it.
 */
export function retriesSteps(version) {
  return !(typeof version === 'string' && EARLIER_PROTOCOL.test(version));
}

export function hostCapabilities(context) {
  const fn = path => typeof path.split('.').reduce((value, key) => value?.[key], context) === 'function';
  const version = hostVersion(context);
  return {
    version,
    tested: version === TESTED_HOST_VERSION,
    stepRetries: retriesSteps(version),
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
 * This plugin's entries in the host's plugin list. OpenCode 2.1.4 to the tested version list
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
 * 2.1.2 to the tested version emit one delta event per streamed chunk of answer text,
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
 * OpenCode runs plugins on Bun (1.4.2 in 2.0.32 and 2.1.2, 1.4.4 from 2.1.4 to the tested version),
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
 * "... (line truncated to 2000 chars)" (OpenCode 2.3.0 to the tested version). A model reads AZPR's private data pages
 * with that tool, one row per line, so a row must not be longer.
 */
export const HOST_READ_LINE_CHARACTERS = 2000;

/**
 * Whether a rejected session call says the session does not exist. OpenCode
 * 2.2.4 to the tested version reject `session.get` and `session.remove` of such a session
 * with an error whose `_tag` and `name` are `Session.NotFoundError`.
 */
export const isSessionNotFound = error => (error?._tag ?? error?.name) === 'Session.NotFoundError';

/**
 * Whether a session still has the name OpenCode shows for one that nobody named. OpenCode 2.3.0 to the tested version
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
 * to the tested version build that part from sources, join their texts with a blank line and keep each source as
 * `{ key, text }` in the part's `metadata.experimental.instructions`, a field the host marks as experimental.
 * Returns `{ system, removed }` (the sources that were left out, in their order), or null where no part has that
 * shape, more than one has it, or its text is not what its sources give: nothing can be told apart then, and
 * the caller leaves the request as it is.
 */
export function withoutPlaceInstructions(system, keep = HOST_FACT_SOURCES) {
  // The parts are plain data as the host builds them, and are looked at as such (see `ownFields`): the list, a
  // part, its metadata and what that holds, and each source. The part is made anew from what these hold of
  // their own, so nothing a hook added to one of them in plain sight is lost with it; a part that is no plain
  // data is not looked into, and where the instructions part is such a one nothing can be told apart.
  const parts = listItems(system);
  if (!parts) return null;
  const read = part => {
    const fields = recordFields(part), metadata = recordFields(fields?.get('metadata')), experimental = recordFields(metadata?.get('experimental'));
    const listed = listItems(experimental?.get('instructions'));
    return listed ? { fields, sources: listed.map(source => { const held = recordFields(source); return { source, fields: held, bare: Boolean(held) && only(held, ['key', 'text']) }; }),
      bare: only(fields, ['type', 'text', 'metadata']) && only(metadata, ['experimental']) && only(experimental, ['instructions']) } : undefined;
  };
  const found = parts.flatMap((part, index) => { const held = read(part); return held ? [{ index, part, ...held }] : []; });
  if (found.length !== 1) return null;
  const [{ index: at, part, fields, sources, bare }] = found;
  const text = held => held.fields.get('text');
  if (fields.get('type') !== 'text' || typeof fields.get('text') !== 'string' || !sources.every(held => held.fields && typeof held.fields.get('key') === 'string' && typeof text(held) === 'string') ||
      fields.get('text') !== sources.map(text).join('\n\n')) return null;
  const kept = sources.filter(held => keep.includes(held.fields.get('key'))), gone = sources.filter(held => !keep.includes(held.fields.get('key'))), removed = gone.map(held => held.source);
  if (!removed.length) return { system, removed };
  // A source that goes takes with it whatever it holds, so only one that holds nothing but the host's key and
  // text; and where no source is kept the part goes too, so only a part that holds nothing but what the host
  // gave it. What a hook marked would lose that mark, and is not told apart instead.
  if (gone.some(held => !held.bare) || (!kept.length && !bare)) return null;
  const rebuilt = kept.length ? [{ ...part, text: kept.map(text).join('\n\n'),
    metadata: { ...part.metadata, experimental: { ...part.metadata.experimental, instructions: kept.map(held => held.source) } } }] : [];
  return { system: [...parts.slice(0, at), ...rebuilt, ...parts.slice(at + 1)], removed };
}

/**
 * Takes out of a request's list of tools those that `unwanted` names, where the list is an ordinary object and
 * lets a tool be taken out. `unwanted` is a rule, which is asked of every name the list lists, or a list of
 * names, of which only those are looked up: an ordinary conversation's request loses a few names of a list that
 * can be long. A list that answers for another object is not asked what it holds, and a tool that cannot be
 * taken out stays listed: whether a tool may run is decided where it is called, not by what a request lists, so
 * nothing is refused or thrown for either. Says whether no such tool is left listed, as far as that can be
 * known (not of a list that answers for another object).
 */
export function withoutTools(tools, unwanted) {
  if (tools === undefined || tools === null) return true;
  if (!ordinary(tools)) return false;
  const named = Array.isArray(unwanted);
  let gone = true;
  // A tool is what the list lists under a name: a property that is not listed (something a hook keeps there for
  // itself) or stands under a symbol is no tool, and is left where it is.
  for (const name of named ? unwanted : Reflect.ownKeys(tools)) {
    if (typeof name !== 'string' || !Reflect.getOwnPropertyDescriptor(tools, name)?.enumerable || !(named || unwanted(name))) continue;
    if (!Reflect.deleteProperty(tools, name)) gone = false;
  }
  return gone;
}

/**
 * A request's system parts with one more part after them: a new list, where they are an ordinary list (also one
 * that cannot be changed), and nothing where they are not, so that nothing of the list's own is called and
 * nothing it carries is lost. The caller leaves the parts as they are then.
 */
export function withPart(system, part) {
  const parts = listItems(system);
  return parts ? [...parts, part] : undefined;
}

/**
 * OpenCode's own provider for Claude Code, and the request option in which it keeps the instructions it hands the
 * model. That provider does not send a request's system parts. Its own `context` hook, which runs before any
 * plugin's and before the built-in hooks that add parts of their own, leaves there what it made of the
 * instructions part: the texts of its sources but the date and the environment, which Claude Code writes itself,
 * joined with a blank line (OpenCode 2.3.0 to the tested version, measured on 2.3.0, 2.4.1 and 2.4.2).
 */
export const CLAUDE_PROVIDER = 'claude-agent';
export const CLAUDE_INSTRUCTIONS_OPTION = 'claudeCodeInstructions';

/**
 * The text of that option as a request's options hold it, where the options are plain data that holds one of
 * its own. Nothing where the options are no plain data (they answer for another object, are of a class of their
 * own, or hold something that is not listed data), or where the option holds no text. It is taken from its
 * descriptor, so nothing of the options' own is called. Whether the option can be emptied is what writing it
 * answers (it cannot in frozen options): a caller looks at that, and leaves parts and option as they are where
 * it was not.
 */
export function claudeOption(options) {
  // Options are a plain object as the host builds them. In anything else a property that says it can be written
  // need not take a value (an object of a module's exports says so and refuses), so nothing is taken from it.
  if (!recordFields(options)) return undefined;
  const property = Reflect.getOwnPropertyDescriptor(options, CLAUDE_INSTRUCTIONS_OPTION);
  return property && typeof property.value === 'string' ? property.value : undefined;
}

/**
 * What a request's event holds in the places a `context` hook looks at and may replace (`system`, `messages`,
 * `options`, `tools`), each taken once from the event's own descriptor: its value, and whether the place can be
 * given another one. OpenCode hands a hook a plain object with these as listed data it can write (read from the
 * events of OpenCode 2.3.0 and 2.4.1). A place behind an accessor is not asked, and one that is not listed is
 * not looked at: it holds nothing here and is not written, and neither is a place of an event that answers for
 * another object. Whose request it is (its
 * session, agent and model) is not among them: that is read from the event as the host reads it, since a
 * request is authorized for what the host will send it as.
 */
export function requestSlots(event) {
  const slot = name => {
    const property = ordinary(event) ? Reflect.getOwnPropertyDescriptor(event, name) : undefined;
    // A place is listed data, like everything the host builds: one behind an accessor, or one that a hook made
    // unlisted, is not the host's. `unread`: something is there that was not looked at, so nothing is known of
    // what it holds, and it is not given another value.
    const data = Boolean(property) && Object.hasOwn(property, 'value') && property.enumerable === true;
    return { value: data ? property.value : undefined, writable: data && property.writable === true, unread: Boolean(property) && !data };
  };
  return { system: slot('system'), messages: slot('messages'), options: slot('options'), tools: slot('tools') };
}

/** A text that an ordinary object holds of its own under `name`, taken from its descriptor; nothing otherwise. */
export function ownText(value, name) {
  if (!ordinary(value)) return undefined;
  const property = Reflect.getOwnPropertyDescriptor(value, name);
  return property && Object.hasOwn(property, 'value') && typeof property.value === 'string' ? property.value : undefined;
}

/**
 * What that option holds for a request whose instructions part has these sources besides the host's facts. A
 * caller that leaves those sources out of the system parts empties the option too, and only where the option
 * holds exactly this: anything else was made another way, and nothing can be told apart.
 */
export const claudeInstructions = sources => sources.map(source => source.text).join('\n\n');

/**
 * The form of the message in which OpenCode leaves instruction files in a session by itself, after the session's
 * native read tool read a file of the project: the files between that file and the conversation's directory
 * (AGENTS.md; from OpenCode 2.3.1 also CLAUDE.md), as a synthetic message whose `metadata.instruction.paths`
 * names the files it holds (OpenCode 2.3.0 to the tested version). That metadata is what the host itself goes by: it is
 * its only record of which files a session was given. Nothing else has this form: not a message without an ID,
 * and not a person's message or an assistant message that carries such metadata. The text is not looked at:
 * whoever writes the metadata writes the text too, so it would prove nothing more.
 */
export function isInstructionLoad(message) {
  const paths = message?.metadata?.instruction?.paths;
  return message?.type === 'synthetic' && typeof message.id === 'string' && message.id.length > 0 && Array.isArray(paths) && paths.length > 0 &&
    paths.every(path => typeof path === 'string' && path.length > 0);
}

/**
 * An update of the instructions as a session's own messages hold it: OpenCode writes a `system` message when a
 * source changed while the session ran (an instruction file that was edited, an MCP server that says something
 * else, the date at midnight), and nothing else writes one (OpenCode 2.3.0 to the tested version, from
 * `session.instructions.updated`; the host marks it `notice: "instructions"`, which is not asked for here: a
 * message of this type is the host's own, whatever a later version marks it with).
 */
export const isInstructionUpdate = message => message?.type === 'system' && typeof message.id === 'string' && message.id.length > 0 && typeof message.text === 'string';

// The native tool whose reads make the host load instruction files (see READ_TOOLS in config.mjs).
const NATIVE_READ = 'read';

/**
 * What the host wrote of instructions into a session by itself, among the session's own messages: its updates,
 * and its loads of instruction files. A load is the late result of the session's own tool call, like the notice
 * of a background command: it counts only after an assistant message of this session called the native read
 * tool, since nothing else makes the host write one. A message of that form in a session that never read is
 * someone else's. Who wrote a message cannot be proved beyond that: a message of the form that someone posts
 * after such a call is taken for the host's. It is kept from the model like the host's own, so its text
 * reaches no answer.
 */
export function hostInstructions(messages) {
  const loads = [], updates = [];
  let read = false;
  for (const message of messages) {
    if (message?.type === 'assistant') read ||= Array.isArray(message.content) && message.content.some(part => part?.type === 'tool' && part.name === NATIVE_READ);
    else if (isInstructionUpdate(message)) updates.push(message);
    else if (read && isInstructionLoad(message)) loads.push(message);
  }
  return { loads, updates };
}

// What OpenCode builds for a request is plain data, and that is what "as the host builds it" asks of every level
// (read from the requests of OpenCode 2.3.0 and 2.4.1): a load is a plain object, a message's content an
// ordinary array of one plain text part, a load's metadata plain objects and arrays of strings, a system part and
// the sources of its instructions plain objects. Plain data is asked of an object's own properties, each taken
// once from its descriptor, so that nothing of the object's own is called: every one of them is listed, has a
// string for its name and holds its value itself. A property under a symbol, one that is not listed, one that is
// an accessor, an array of another class or with something more on it, an object of another class, and an
// object that answers for another (a proxy) are no plain data, whatever they would answer when asked. A
// property that is there without a value is none. What an object inherits is not looked at: a message is what it
// holds of its own.

// An object that can be looked at: one that does not answer for another. That is asked before anything else is
// asked of a value, since even whether a proxy is an array is its own to answer (one that was revoked throws).
const ordinary = value => value !== null && typeof value === 'object' && !types.isProxy(value);

// The fields of an ordinary object, by name: its own properties that have a value, where each of them is listed
// and holds its value under a string name (an array's length aside, which no array lists). Nothing where one is
// not, or where the object answers for another.
function ownFields(value, list = false) {
  if (!ordinary(value)) return undefined;
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const property = Reflect.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property || !Object.hasOwn(property, 'value') || (!property.enumerable && !(list && key === 'length'))) return undefined;
    if (property.value !== undefined) fields.set(key, property.value);
  }
  return fields;
}

// The items of an ordinary list: an array of the arrays' own class with a value at every place and nothing else
// on it. Nothing where the value is anything else.
function listItems(value) {
  if (!ordinary(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const fields = ownFields(value, true), length = fields?.get('length');
  if (!Number.isInteger(length) || fields.size !== length + 1) return undefined;
  const items = [];
  for (let index = 0; index < length; index++) {
    if (!fields.has(String(index))) return undefined;
    items.push(fields.get(String(index)));
  }
  return items;
}

// The fields of a plain object: one of the objects' own class, or of none. Nothing where it is anything else.
function recordFields(value) {
  if (!ordinary(value) || Array.isArray(value)) return undefined;
  const kind = Object.getPrototypeOf(value);
  return kind === Object.prototype || kind === null ? ownFields(value) : undefined;
}

// Whether two values are the same data, as JSON holds it: ordinary lists with the same length and the same data
// at each place, plain objects with the same fields (their order says nothing) and the same data under each.
// Anything else (a list or an object that is not plain, a function) is the same only as the very same value.
// The values are gone through without one call inside another, so that data of any depth is compared to its end.
function sameData(a, b) {
  const pairs = [[a, b]];
  while (pairs.length) {
    const [first, second] = pairs.pop();
    if (first === second) continue;
    if (!ordinary(first) || !ordinary(second)) return false;
    if (Array.isArray(first) || Array.isArray(second)) {
      const mine = listItems(first), theirs = listItems(second);
      if (!mine || !theirs || mine.length !== theirs.length) return false;
      mine.forEach((item, index) => pairs.push([item, theirs[index]]));
      continue;
    }
    const mine = recordFields(first), theirs = recordFields(second);
    if (!mine || !theirs || mine.size !== theirs.size) return false;
    for (const [name, value] of mine) {
      if (!theirs.has(name)) return false;
      pairs.push([value, theirs.get(name)]);
    }
  }
  return true;
}

// The fields of a request's message: those of an object of any class (an update is one of the host's own class,
// which a plugin cannot name) whose own properties are all listed data. Nothing for anything else.
const messageFields = message => ordinary(message) && !Array.isArray(message) ? ownFields(message) : undefined;
const only = (fields, names) => [...fields.keys()].every(name => names.includes(name));

// The text of a content that is one plain text part, `[{ type: 'text', text }]`, which is what OpenCode makes of
// a message's text in a request; nothing where the content is anything else: a string, several parts, a part of
// another kind, a list or a part that is not plain, or a text part that carries something more (the mark of
// another hook, say), which is no longer what the host built.
function oneText(content) {
  const parts = listItems(content), part = parts?.length === 1 ? recordFields(parts[0]) : undefined;
  return part && only(part, ['type', 'text']) && part.get('type') === 'text' && typeof part.get('text') === 'string' ? part.get('text') : undefined;
}

// What OpenCode makes of such an update in a request: `{ role: 'system', content: [{ type: 'text', text }] }`
// and nothing more. It has no ID and no metadata (the host gives those only to a message it builds from one
// stored message that keeps its ID), and no tools. The other system messages the host knows change a model's
// effort or its tools and hold no text. A message that carries anything else (a name, the mark of another hook)
// is no longer what the host built. `fields` are the message's own (`messageFields`).
const updateText = fields => only(fields, ['role', 'content']) && fields.get('role') === 'system' ? oneText(fields.get('content')) : undefined;

// What OpenCode makes of a load in a request: the user message with the load's ID and its text as one plain
// text part, to which the host adds the stored message's metadata for hooks to read:
// `{ id, role: 'user', content: [{ type: 'text', text }], metadata }`, a plain object, and nothing more. One
// without that metadata holds nothing that is not the host's; one whose metadata is other data, or that carries
// another field, holds what a hook added.
function isLoadAsBuilt(message, load) {
  const fields = recordFields(message);
  return Boolean(fields) && only(fields, ['id', 'role', 'content', 'metadata']) && fields.get('id') === load.id && fields.get('role') === 'user' &&
    (!fields.has('metadata') || sameData(fields.get('metadata'), load.metadata)) && oneText(fields.get('content')) === load.text;
}

// The ID a request's message holds of its own, where it is a text: read from its descriptor, so that a message
// that would work its ID out when asked is not asked.
const ownID = message => ownText(message, 'id');

/**
 * A request's messages without what OpenCode wrote into the session by itself: its loads of instruction files
 * and its updates of the instructions. Which messages those are is the session's own word (`stored`, its
 * messages as the host holds them; `hostInstructions`), not the request's. Only what is such a message as
 * OpenCode builds it is taken out, the whole message and each of its fields: a load is the user message with
 * the load's ID whose content is the load's text as one text part (`isLoadAsBuilt`), and an update, which has
 * no ID in a request, a system message of the host's form that holds exactly an update's text (`updateText`;
 * every copy of it). Another plugin's system message stays, also one of the host's form, unless it holds
 * exactly the text of an update that the session holds: nothing tells the two apart.
 *
 * Anything else stays as it is. A request is not searched for those texts, and a message that a hook before
 * this one changed (a content in another form, something joined to it, another role, a field or metadata of
 * its own) is not taken out for the ID it kept: it holds what is not the host's, which taking it out would
 * drop. The list of messages is asked the same: only an ordinary list is gone through. `changed` says that the
 * request's messages are no such list, or that it holds a message with a load's
 * ID that is not the load as the host builds it, for the stage's record. `loads` and `updates` are the IDs of
 * the session's messages that were taken out: of updates with one text, as many as the request held, in their
 * order. A session that holds no such message gets its request back as it is.
 */
export function withoutHostMessages(requested, stored) {
  const written = hostInstructions(stored);
  const loads = new Map(written.loads.map(message => [message.id, message])), updates = new Map();
  for (const message of written.updates) {
    if (!updates.has(message.text)) updates.set(message.text, []);
    updates.get(message.text).push(message.id);
  }
  if (!loads.size && !updates.size) return { messages: requested, loads: [], updates: [], changed: false };
  // The list is looked at like everything in it: an ordinary list is gone through as its own items say, and one
  // that is not (a list of a class of its own, one that carries something more, one that answers for another) is
  // left as it is, whole. What the host wrote may be in it then, so the request is counted.
  const items = listItems(requested);
  if (!items) return { messages: requested, loads: [], updates: [], changed: true };
  const found = { loads: new Set(), updates: [] }, taken = new Map();
  let changed = false;
  // A message is looked at through the descriptors of its own properties and nowhere else, so nothing of its own
  // is called and looking at it changes nothing: one that is no plain data is not known to be the host's, and
  // stays like anything else that is not.
  const messages = items.filter(message => {
    const id = ownID(message);
    if (id !== undefined && loads.has(id)) {
      if (isLoadAsBuilt(message, loads.get(id))) { found.loads.add(id); return false; }
      changed = true;
      return true;
    }
    const fields = messageFields(message), text = fields ? updateText(fields) : undefined, ids = text === undefined ? undefined : updates.get(text);
    if (!ids) return true;
    // The copies of one text cannot be told apart: each one that the request holds is one of the session's, in their order.
    const nth = taken.get(text) ?? 0;
    taken.set(text, nth + 1);
    if (nth < ids.length) found.updates.push(ids[nth]);
    return false;
  });
  // The list that was handed over comes back where nothing was taken out of it.
  return { messages: messages.length === items.length ? requested : messages, loads: [...found.loads], updates: found.updates, changed };
}

/**
 * The message a session's turn began with: the one user message that carries the nonce AZPR sent its prompt
 * with. A prompt that is admitted waits in the session's inbox, and becomes a message only in the execution
 * that takes it (OpenCode 2.3.0 to the tested version); until then, and where two messages carry the nonce, there is none.
 */
export function promptOf(messages, nonce) {
  const prompts = typeof nonce === 'string' && nonce.length > 0 ? messages.filter(message => message?.type === 'user' && message.metadata?.azprGrant === nonce) : [];
  return prompts.length === 1 && typeof prompts[0].id === 'string' && prompts[0].id.length > 0 ? prompts[0] : undefined;
}

/**
 * Where a turn stands, by the session's own messages: `before` while the turn's prompt is not among them,
 * `running` while no idle marker follows it, and `ended` once one does (an execution leaves one marker when it
 * ends, however it ends, before the host starts another one; OpenCode 2.3.0 to the tested version).
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
