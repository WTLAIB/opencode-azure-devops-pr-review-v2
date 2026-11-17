/**
 * Native package bootstrap and setup. Configuration lives outside the package cache.
 *
 * Setup has two ways in, and one writer. `/pr-setup` with options saves what they name, and in OpenCode's
 * terminal UI `/pr-setup` alone opens dialogs (src/tui-setup.mjs) that send their answers over the plugin's
 * RPC. Both end in the functions here, which check every value, are the only ones to write the settings
 * file and the token file, and are the only ones to ask Azure DevOps whether a token works.
 */
import { constants } from 'node:fs';
import { open, readFile, lstat, mkdir, link, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { COMMANDS, MODES, SETTING_CHECKS, modelRef, modelSlots, patProblem, privateAgent, settingsText, validateSettings, withMissingSettings } from './config.mjs';
import { parseUniqueJSON } from './output.mjs';
import { appendReport } from './session.mjs';
import { fetchTransportSupported, listOf, recordOf, requireMethods } from './host.mjs';
import { AzureError, createAzureClient, fetchTransport, organizationName, proxyLabel, restBaseUrl } from './azure.mjs';
import { createToolQueue } from './tool-queue.mjs';
import { readCaCertificates, readPatFile, setupAzurePrReview } from './runtime.mjs';
import { SETUP_RPC } from './tui-setup.mjs';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
// OpenCode's command list shows one line and cuts it: the first 50 characters say what this is for.
const SETUP_DESCRIPTION = 'Set up AZPR: organization, token, model; --help. In the terminal UI it asks in dialogs; elsewhere options name the values. No model call';
const USAGE = '/pr-setup --organization ORG --model PROVIDER/MODEL [--pat-file "/absolute/path/to/pat"]';
// How long setup waits for Azure DevOps when it checks a token: a person is waiting for the answer.
const CHECK_TIMEOUT_MS = 20000;
// How long a first setup waits for OpenCode to drop the commands that only said "setup required".
const RELEASE_WAIT_MS = 3000;
// The commands of a process without usable settings: each only says what is missing.
const PLACEHOLDER_DESCRIPTION = 'AZPR setup required; run /pr-setup';
const RESTART = 'restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process)';
const MAX_SETTINGS_BYTES = 1024 * 1024;
// A writer holds the setup lock for a few milliseconds. One this old was left behind by a process that
// ended while it held it: no one will release it, so nothing waits for it.
const LOCK_LEFT_BEHIND_MS = 30000;
const lockOf = path => `${path}.setup.lock`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** AZPR's directory for user files: $XDG_CONFIG_HOME/azpr, otherwise ~/.config/azpr. */
function userDirectory(environment) {
  const root = environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), '.config');
  if (!isAbsolute(root)) throw new Error('[AZPR] XDG_CONFIG_HOME must be an absolute path.');
  return join(root, 'azpr');
}

/** The PAT file setup uses without --pat-file, where the quickstart creates it. */
export const defaultPatFile = (environment = process.env) => join(userDirectory(environment), 'pat');

/** Explicit path wins; source installations retain their adjacent settings. */
export async function settingsFileFor(options = {}, sourceDirectory = SOURCE_DIRECTORY, environment = process.env) {
  if (!object(options) || Object.keys(options).some(key => key !== 'settingsFile')) {
    throw new Error('[AZPR] Plugin options accept only settingsFile (an absolute path).');
  }
  if (options.settingsFile !== undefined) {
    if (typeof options.settingsFile !== 'string' || !isAbsolute(options.settingsFile) || /[\0\r\n]/.test(options.settingsFile)) {
      throw new Error('[AZPR] options.settingsFile must be an absolute path.');
    }
    return resolve(options.settingsFile);
  }
  const legacy = join(sourceDirectory, 'settings.json');
  try { await lstat(legacy); return legacy; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return join(userDirectory(environment), 'settings.json');
}

/** Do not expose JSON parser excerpts: an existing profile can contain a PAT. */
function settingsJSON(raw) {
  try {
    const parsed = parseUniqueJSON(raw);
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error('[AZPR] settings.json must be a JSON object without duplicate keys; repair it manually before setup.'); }
}

export function parseSetupArguments(text) {
  // Literal arguments only: quoted paths support spaces, with no shell evaluation.
  const tokens = [];
  let token = '', quote = '', started = false;
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = '';
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += character; started = true; }
  }
  if (quote) throw new Error('[AZPR] Close the quoted setup argument.');
  if (started) tokens.push(token);
  if (!tokens.length || (tokens.length === 1 && ['--help', '-h'].includes(tokens[0]))) return null;
  const result = {};
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (!SETUP_FLAGS.includes(flag) || Object.hasOwn(result, flag)) {
      throw new Error('[AZPR] Unknown or repeated setup option. Use /pr-setup --help. Never put the PAT itself in a command.');
    }
    if (flag === '--replace') result[flag] = true;
    else {
      if (tokens[index + 1] === undefined || tokens[index + 1].startsWith('--')) throw new Error('[AZPR] A setup option needs a value. Use /pr-setup --help.');
      result[flag] = tokens[++index];
    }
  }
  // The options of a first setup come together; an option that changes one setting stands alone.
  if (FIRST_SETUP_FLAGS.some(flag => result[flag] !== undefined) && ['--organization', '--model'].some(flag => !result[flag])) {
    throw new Error('[AZPR] Supply --organization and --model (--pat-file is optional). Use /pr-setup --help.');
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ rows
const text = value => typeof value === 'string' ? value : '';
const OFF_WORD = /^(?:none|off)$/i;
const azureOf = raw => object(raw.azure) ? raw.azure : {};
const withAzure = (raw, values) => ({ ...raw, azure: { ...azureOf(raw), ...values } });
const modelsOf = (raw, mode) => modelSlots(mode).map(slot => text(raw.models?.[mode]?.[slot]));
const withModels = (raw, mode, value) => ({ ...raw, models: { ...(object(raw.models) ? raw.models : {}),
  [mode]: { ...(object(raw.models?.[mode]) ? raw.models[mode] : {}), ...Object.fromEntries(modelSlots(mode).map(slot => [slot, value])) } } });
/** The one value that all of them have, or null when they differ. */
const shared = values => values.every(value => value === values[0]) ? values[0] : null;
/**
 * Several values as one row of the list shows them: the value they share (`empty` where that is none), else
 * only that they differ, since the list has room for a few words; the settings file has each of them.
 */
const together = (values, empty, differ) => shared(values) === null ? differ : shared(values) || empty;
/** A path as a row of the list shows it: its last two parts where it is long. The dialog of the row has all of it. */
const shortPath = value => value.length <= 30 ? value : `…/${value.split('/').filter(Boolean).slice(-2).join('/')}`.slice(0, 34);
/** A proxy as it may be shown: scheme, host and port, and whether it carries a user name and password. */
function shownProxy(value) {
  if (!value) return 'none';
  try { const url = new URL(value); return `${proxyLabel(value)}${url.username || url.password ? ' (with credentials)' : ''}`; }
  catch { return 'not a proxy URL'; }
}
/** HTTPS_PROXY of the process that runs AZPR, as it may be shown; Bun's fetch uses it when azure.proxy is empty. */
function serviceProxy(environment) {
  const value = environment.HTTPS_PROXY || environment.https_proxy || '';
  try { return value ? proxyLabel(value) : ''; } catch { return ''; }
}
const valid = (check, ...args) => { try { return check(...args); } catch (error) { throw new Error(`[AZPR] ${error.message}`); } };

function organizationOf(answer) {
  const name = organizationName(text(answer).trim());
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(name)) {
    throw new Error('[AZPR] Use your Azure DevOps organization name (the <org> in https://dev.azure.com/<org>), or the URL of one of its pull requests.');
  }
  return name;
}
function proxyOf(answer, saved) {
  const value = text(answer).trim();
  if (value === '' || OFF_WORD.test(value)) return '';
  // A dialog starts with the saved proxy without its user name and password: left as it is, it keeps them.
  if (saved) { try { if (value === proxyLabel(saved)) return saved; } catch { /* A saved value that is no URL is replaced. */ } }
  return valid(SETTING_CHECKS.proxy, value);
}
async function caFileOf(answer) {
  const value = text(answer).trim();
  if (value === '' || OFF_WORD.test(value)) return '';
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('[AZPR] The CA certificate file must be an absolute path.');
  await readCaCertificates(value);
  return value;
}
async function modelOf(context, answer, optional) {
  const value = text(answer).trim();
  if (optional && (value === '' || OFF_WORD.test(value))) return '';
  valid(SETTING_CHECKS.model, value, 'The model');
  await checkModel(context, value);
  return value;
}
const choiceOf = (row, answer) => {
  const value = text(answer).trim();
  if (!row.choices.some(choice => choice.value === value)) throw new Error(`[AZPR] ${row.label} must be one of: ${row.choices.map(choice => choice.value).join(', ')}.`);
  return value;
};
const onOff = { choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], show: value => value ? 'on' : 'off', current: value => value ? 'on' : 'off' };
const LANGUAGES = [['en', 'English'], ['zh-TW', '繁體中文'], ['zh-CN', '简体中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español']];
const PUBLISH_CONFIRMATION = { title: 'Post comments without a preview?', keep: 'No, keep the current setting', accept: 'Yes, post them after every review',
  message: 'Each completed review then posts its comments on the pull request under your name' };

/**
 * What setup can set, in the order the terminal UI lists it; everything else stays in the settings file.
 * A row reads its value from settings that have every default (`get`), shows it (`show`, and `current`:
 * what a dialog starts with), takes an answer as a person gives it (`accept`: the value to save, or an
 * Error that says what is wrong without quoting the answer) and writes it (`set`). `flag` is its
 * /pr-setup option. The token has no option and is never part of `changes`: it travels alone.
 */
const ROWS = Object.freeze([
  { id: 'organization', flag: '--organization', group: 'Azure DevOps', label: 'Organization', kind: 'text', title: 'Azure DevOps organization', placeholder: 'my-organization',
    description: () => 'The name in https://dev.azure.com/<organization>. You can also paste the URL of a pull request.',
    get: raw => text(azureOf(raw).organization), show: value => value || 'not set', current: value => value,
    accept: async (_context, answer) => organizationOf(answer), set: (raw, value) => withAzure(raw, { organization: value }) },
  { id: 'token', group: 'Azure DevOps', label: 'Access token', kind: 'secret', title: 'Personal access token',
    description: () => 'Create one at https://dev.azure.com/{organization}/_usersSettings/tokens with the scopes Code (Read) and Pull Request Threads (Read & write). Azure DevOps is asked once whether it works. It is then saved in a file only you can read (mode 600) and not shown again.' },
  { id: 'proxy', flag: '--proxy', group: 'Azure DevOps', label: 'Proxy', kind: 'text', title: 'Proxy for Azure DevOps (optional)', placeholder: 'http://proxy.example.com:8080',
    description: (raw, environment) => 'Only if this network reaches dev.azure.com through a proxy. Leave it empty and press Enter to skip. A user name and password go into the URL (http://user:password@host:port) and are visible while you type.' +
      (serviceProxy(environment) ? ` When it is empty, AZPR uses the HTTPS_PROXY of the OpenCode service: ${serviceProxy(environment)}.` : '') +
      (shownProxy(text(azureOf(raw).proxy)).endsWith(')') ? ' The saved proxy has a user name and password, which are not shown: leave the URL as it is to keep them.' : ''),
    get: raw => text(azureOf(raw).proxy), show: shownProxy, current: value => { try { return value ? proxyLabel(value) : ''; } catch { return ''; } },
    accept: async (_context, answer, raw) => proxyOf(answer, text(azureOf(raw).proxy)), set: (raw, value) => withAzure(raw, { proxy: value }) },
  { id: 'caFile', flag: '--ca-file', group: 'Azure DevOps', label: 'CA certificate file', kind: 'text', title: 'CA certificate file (optional)', placeholder: '/absolute/path/to/company-root-ca.pem',
    description: () => 'Only where a company proxy inspects HTTPS: the absolute path of its root CA certificate, a PEM file. Leave it empty and press Enter to skip.',
    get: raw => text(azureOf(raw).caFile), show: value => value ? shortPath(value) : 'none', current: value => value,
    accept: async (_context, answer) => caFileOf(answer), set: (raw, value) => withAzure(raw, { caFile: value }) },
  { id: 'reviewModel', flag: '--review-model', group: 'Models', label: 'Review model', kind: 'model', title: 'Model for /pr-review',
    get: raw => modelsOf(raw, 'review'), show: values => together(values, 'not set', 'differs by role'), current: values => shared(values) ?? '',
    accept: (context, answer) => modelOf(context, answer, false), set: (raw, value) => withModels(raw, 'review', value) },
  { id: 'quickModel', flag: '--quick-model', group: 'Models', label: 'Quick model', kind: 'model', title: 'Model for /pr-quick', optional: { label: 'Off', description: '/pr-quick stays off' },
    get: raw => modelsOf(raw, 'quick'), show: values => values[0] || 'off', current: values => values[0],
    accept: (context, answer) => modelOf(context, answer, true), set: (raw, value) => withModels(raw, 'quick', value) },
  { id: 'deepModel', flag: '--deep-model', group: 'Models', label: 'Deep model', kind: 'model', title: 'Stronger model for /pr-deep', optional: { label: 'Off', description: '/pr-deep stays off' },
    get: raw => modelsOf(raw, 'deep'), show: values => together(values, 'off', 'differs by role'), current: values => shared(values) ?? '',
    accept: (context, answer) => modelOf(context, answer, true), set: (raw, value) => withModels(raw, 'deep', value) },
  { id: 'language', flag: '--language', group: 'Reviews', label: 'Output language', kind: 'choice', title: 'Language of reports and comments',
    choices: LANGUAGES.map(([value, label]) => ({ value, label, description: value })),
    other: { label: 'Another language', title: 'Language of reports and comments', description: 'A language tag such as en, zh-TW, pt-BR or it.', placeholder: 'pt-BR' },
    get: raw => text(raw.outputLanguage), show: value => value, current: value => value,
    accept: async (_context, answer) => valid(SETTING_CHECKS.language, text(answer).trim()), set: (raw, value) => ({ ...raw, outputLanguage: value }) },
  { id: 'afterReview', flag: '--after-review', group: 'Reviews', label: 'After a review', kind: 'choice', title: 'After a completed review',
    choices: [{ value: 'preview', label: 'Show a comment preview', description: 'Nothing is posted' }, { value: 'none', label: 'Only the review', description: 'No preview' },
      { value: 'publish', label: 'Post the comments', description: 'Without a preview', confirm: PUBLISH_CONFIRMATION }],
    get: raw => MODES.map(mode => text(raw.afterReview?.[mode])), show: values => together(values, 'not set', 'differs by mode'), current: values => shared(values) ?? '',
    accept: async (_context, answer, _raw, row) => choiceOf(row, answer), set: (raw, value) => ({ ...raw, afterReview: { ...(object(raw.afterReview) ? raw.afterReview : {}), ...Object.fromEntries(MODES.map(mode => [mode, value])) } }) },
  { id: 'report', flag: '--report', group: 'Reviews', label: 'Report in the conversation', kind: 'choice', title: 'What a review returns to the conversation',
    choices: [{ value: 'receipt', label: 'A receipt', description: 'The report waits in the review session' }, { value: 'full', label: 'The receipt with the report', description: 'Also in the conversation' }],
    get: raw => text(raw.returnReport), show: value => value, current: value => value,
    accept: async (_context, answer, _raw, row) => choiceOf(row, answer), set: (raw, value) => ({ ...raw, returnReport: value }) },
  { id: 'progress', flag: '--progress', group: 'Reviews', label: 'Progress notices', kind: 'choice', title: 'Progress notices during long runs', ...onOff,
    get: raw => raw.progressNotices === true, accept: async (_context, answer, _raw, row) => choiceOf(row, answer) === 'on', set: (raw, value) => ({ ...raw, progressNotices: value }) },
  { id: 'panel', flag: '--panel', group: 'Terminal UI', label: 'Review panel', kind: 'choice', title: 'The review panel in the terminal UI',
    choices: [{ value: 'auto', label: 'Opens by itself', description: 'When a run starts or a report arrives' }, { value: 'manual', label: 'Only with /pr-panel' }],
    get: raw => text(raw.terminalPanel), show: value => value, current: value => value,
    accept: async (_context, answer, _raw, row) => choiceOf(row, answer), set: (raw, value) => ({ ...raw, terminalPanel: value }) },
  { id: 'debug', flag: '--debug', group: 'Diagnostics', label: 'Debug records', kind: 'choice', title: 'Debug records of every run', ...onOff,
    get: raw => raw.debug?.enabled === true, accept: async (_context, answer, _raw, row) => choiceOf(row, answer) === 'on',
    set: (raw, value) => ({ ...raw, debug: { ...(object(raw.debug) ? raw.debug : {}), enabled: value } }) },
]);
const rowOf = id => ROWS.find(row => row.id === id);
/** --model, --pat-file and --replace belong to a first setup, as does --organization; the other options change one setting each. */
const FIRST_SETUP_FLAGS = Object.freeze(['--organization', '--model', '--pat-file', '--replace']);
const SETUP_FLAGS = Object.freeze([...new Set([...FIRST_SETUP_FLAGS, ...ROWS.flatMap(row => row.flag ? [row.flag] : [])])]);

async function checkModel(context, value) {
  if (typeof context.model?.list !== 'function') throw new Error('[AZPR] The model catalog is unavailable. Connect a model provider in OpenCode, then retry setup.');
  const catalog = listOf(await context.model.list());
  if (!catalog) throw new Error('[AZPR] The model catalog is unavailable; settings were not changed.');
  const { providerID, id, variant } = modelRef(value);
  const selected = catalog.find(item => item.providerID === providerID && item.id === id);
  if (!selected || selected.enabled === false) throw new Error('[AZPR] The selected model is unavailable in OpenCode. Choose an enabled ID from opencode models.');
  if (selected.capabilities?.tools !== true) throw new Error('[AZPR] The selected model must support tools.');
  if (variant && variant !== 'default' && (!Array.isArray(selected.variants) || !selected.variants.some(item => item.id === variant))) {
    throw new Error('[AZPR] The selected model does not offer that variant.');
  }
}

async function readExisting(path) {
  for (let attempt = 1; ; attempt++) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      // No name left: another writer replaced the file between the open and this check. Read the file that is there now.
      if (info.nlink === 0 && attempt < 5) continue;
      if (!info.isFile() || info.nlink !== 1 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new Error('[AZPR] Setup requires a regular settings file owned by you, without hard links.');
      }
      if (info.size > MAX_SETTINGS_BYTES) throw new Error('[AZPR] settings.json is larger than 1 MB.');
      return await handle.readFile('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') throw new Error('[AZPR] Setup refuses a symbolic link for settings.json.');
      throw error;
    } finally { await handle?.close(); }
  }
}

/**
 * Atomic, owner-only save; serialize setup calls and preserve unrelated values.
 * The options of a first setup (--organization, --model, --pat-file) create the file, or with --replace
 * set those values again: without --pat-file, a replacement keeps the PAT file already set and a first
 * setup uses the default PAT file. Every other option changes the one setting it names in an existing
 * file. The file names every setting, those setup does not ask for at their defaults. Returns the saved
 * organization and PAT file, and the labels of the single settings that were changed.
 */
export async function saveSetup(context, path, arguments_, environment = process.env) {
  const previous = await readExisting(path);
  const first = FIRST_SETUP_FLAGS.some(flag => arguments_[flag] !== undefined);
  if (previous === null && !first) {
    throw new Error('[AZPR] There are no settings yet. Supply --organization and --model, or run /pr-setup alone in OpenCode\'s terminal UI. Use /pr-setup --help.');
  }
  if (previous !== null && first && !arguments_['--replace']) {
    throw new Error('[AZPR] Settings already exist. Add --replace to change organization, PAT file and all review/quick model slots while keeping other settings.');
  }
  const raw = previous === null ? { version: 2 } : settingsJSON(previous);
  if (raw.version !== 2) throw new Error('[AZPR] Setup supports only version-2 settings; existing data was preserved.');
  if (raw.models !== undefined && !object(raw.models) || raw.azure !== undefined && !object(raw.azure)) {
    throw new Error('[AZPR] Repair models and azure objects in settings.json before setup; existing data was preserved.');
  }
  let next = raw, patFile = text(raw.azure?.patFile);
  if (first) {
    const model = arguments_['--model'];
    const organization = organizationName(arguments_['--organization']);
    const kept = typeof raw.azure?.patFile === 'string' && raw.azure.patFile ? raw.azure.patFile : '';
    patFile = arguments_['--pat-file'] ?? (kept || defaultPatFile(environment));
    if (typeof patFile !== 'string' || !isAbsolute(patFile) || resolve(patFile) === resolve(path)) {
      throw new Error('[AZPR] --pat-file must name an absolute path separate from settings.json.');
    }
    next = { ...raw, models: { ...raw.models, review: { functional: model, risk: model, verifier: model }, quick: { reviewer: model } },
      azure: { ...raw.azure, organization, pat: '', patFile } };
    validateSettings(withMissingSettings(next).settings);
    await checkModel(context, model);
    try { await readPatFile(patFile); }
    catch (error) {
      if (arguments_['--pat-file'] !== undefined) throw error;
      // Name the file setup chose, so the reader knows where to put the PAT.
      const problem = error.message.replace(/^\[AZPR\] azure\.patFile /, '');
      throw new Error(`[AZPR] No --pat-file was given, and the ${kept ? 'PAT file in the current settings' : 'default PAT file'} ${patFile} ${problem} Create it as the quickstart shows, or name another file with --pat-file.`);
    }
  }
  // Each of the other options changes one setting; an answer is checked as the terminal UI's is.
  const changed = [];
  for (const row of ROWS) {
    if (!row.flag || row.flag === '--organization' || arguments_[row.flag] === undefined) continue;
    next = row.set(next, await row.accept(context, arguments_[row.flag], next, row));
    changed.push(row.label);
  }
  const { settings } = withMissingSettings(next);
  validateSettings(settings);
  await writeSettings(path, previous, settings);
  return { organization: text(settings.azure?.organization), patFile, changed, first };
}

/**
 * Replace the token file, or create it: one file that holds only the token, readable by its owner alone
 * (mode 600), in a directory no one else can write to. The new content takes the file's place in one step,
 * so a reader sees the old token or the new one. A path that is anything but a regular file of the user's
 * own is refused and left as it is.
 */
async function writeTokenFile(path, token) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const mine = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o022) || !mine(parentInfo)) {
    throw new Error('[AZPR] The directory of the token file must be a directory owned by you, not a symbolic link or writable by other users.');
  }
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.nlink !== 1 || !mine(existing))) {
    throw new Error('[AZPR] The token file must be a regular file owned by you, without hard links; it was left as it is.');
  }
  // Settings name this path, and settings can be wrong: a file that holds something other than one token is not
  // a token file, whatever the settings say, and is never replaced.
  if (existing && existing.size > 0) {
    let content = null;
    if (existing.size <= 4096) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { content = (await handle.readFile('utf8')).trim(); } finally { await handle.close(); }
    }
    if (content === null || (content !== '' && !/^[\x21-\x7e]{1,1024}$/.test(content))) {
      throw new Error('[AZPR] The file that azure.patFile names holds something other than one token; it was left as it is. Name another file there, or remove this one.');
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeTemporary(temporary, token);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/**
 * Run `work` while holding the setup lock of the settings file `path`. The lock keeps AZPR's writers apart,
 * in this process and in others: whoever finds it held gets an error marked `busy`.
 */
async function withSetupLock(path, work) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o022) || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) {
    throw new Error('[AZPR] The settings directory must be a directory owned by you, not a symbolic link or writable by other users.');
  }
  const lock = lockOf(path);
  let handle, acquired = false;
  try {
    try { handle = await open(lock, 'wx', 0o600); acquired = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw Object.assign(new Error(`[AZPR] Another setup is active, or its lock was left behind (if none is running, delete ${basename(lock)} beside the settings file). No settings changed.`), { busy: true });
    }
    return await work();
  } finally {
    await handle?.close();
    if (acquired) await unlink(lock);
  }
}
const settingsChanged = () => Object.assign(new Error('[AZPR] Settings changed during setup; retry after reviewing the file.'), { busy: true });

/**
 * Under the setup lock: replace the settings file (or create it, when `previous` is null) atomically and
 * owner-only, and only while the file still is what `previous` was. A file changed meanwhile is the
 * `busy` error: someone else wrote it.
 *
 * The lock keeps other AZPR writers out, not a person's editor. The file is therefore compared with
 * `previous` once more after the new text is ready, right before it takes the file's place: what
 * someone saved while that text was written is not overwritten.
 */
async function replaceSettings(path, previous, settings, prepared) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (await readExisting(path) !== previous) throw settingsChanged();
    await writeTemporary(temporary, settingsText(settings));
    await prepared?.();
    if (await readExisting(path) !== previous) throw settingsChanged();
    if (previous === null) await link(temporary, path); // Refuse a concurrent creator rather than overwriting it.
    else await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Replace the settings file under the setup lock; see `replaceSettings`. */
const writeSettings = (path, previous, settings, prepared) => withSetupLock(path, () => replaceSettings(path, previous, settings, prepared));

async function writeTemporary(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Write the settings a valid settings file leaves out into it, at their defaults, so that a version
 * which brings a new setting shows it where its user edits the others. The defaults are what
 * validation assumes for a missing setting anyway: the completed file behaves as the file did.
 * Values, their order and unrelated names stay; the file is replaced like a setup's (atomic,
 * owner-only, a regular file of the user's own, never through a symbolic link).
 *
 * This runs when OpenCode loads AZPR, before the settings are read for good, and never fails a load:
 * a file that cannot be rewritten is used as it is. Several processes and project instances load
 * AZPR at once; they would write the same text, and one that finds another writing waits for it
 * and reads the result, so that each ends up with the file as it then stays. A load that stops
 * waiting reads the file as it is; the runtime accepts the completed text when it appears later
 * (see its preflight), so a slow writer never leaves commands refused.
 *
 * Returns `added` (the names written, possibly none) or, when the file could not be completed,
 * `missing` (the names it lacks) with `problem`, which never holds a setting's value.
 * `prepared` (offline tests only) runs once the new text is ready, before it replaces the file.
 */
export async function addMissingSettings(path, { waitMs = 3000, pauseMs = 100, prepared } = {}) {
  const deadline = Date.now() + waitMs;
  let missing = [];
  try {
    for (;;) {
      const previous = await readExisting(path);
      if (previous === null) return { added: [] };
      const raw = settingsJSON(previous);
      // Switched off, also since this load began: AZPR does nothing, also not to the file.
      if (raw.enabled === false) return { added: [] };
      const { settings, added } = withMissingSettings(raw);
      if (!added.length) return { added: [] };
      // A file that cannot be used is its user's to repair: nothing is added around the problem.
      try { validateSettings(raw); validateSettings(settings); } catch { return { added: [] }; }
      missing = added;
      try {
        await writeSettings(path, previous, settings, prepared);
        return { added };
      } catch (error) {
        if (!error.busy || Date.now() >= deadline) throw error;
        // A lock no live writer holds will not go away: do not wait for it.
        const held = await stat(lockOf(path)).catch(() => null);
        if (held && Date.now() - held.mtimeMs > LOCK_LEFT_BEHIND_MS) throw error;
        await new Promise(done => setTimeout(done, pauseMs));
      }
    }
  } catch (error) {
    // What the file lacks now, read as the runtime reads it: a file this refuses to replace (a symbolic link, a
    // hard link) is still used, and another load may have completed the file since this one last looked.
    try {
      const raw = settingsJSON(await readFile(path, 'utf8'));
      validateSettings(raw);
      missing = raw.enabled === false ? [] : withMissingSettings(raw).added;
    } catch { /* The runtime reports a file it cannot use; what was known of it stays. */ }
    if (!missing.length) return { added: [] };
    // Names and error codes only: an OS or parser message may quote the file.
    const own = typeof error?.message === 'string' && error.message.startsWith('[AZPR] ');
    return { added: [], missing, problem: own ? error.message.slice(7) : `the file could not be rewritten (${error?.code ?? 'unknown error'}).` };
  }
}

async function guide(context, path, problem, environment) {
  let catalog = [], patFile;
  try { catalog = (listOf(await context.model.list()) ?? []).filter(item => item.enabled !== false && item.capabilities?.tools === true); } catch { /* Help remains usable before provider setup. */ }
  try { patFile = defaultPatFile(environment); } catch { patFile = '$XDG_CONFIG_HOME/azpr/pat'; }
  const models = catalog.slice(0, 12).map(item => `${item.providerID}/${item.id}`);
  const options = ROWS.filter(row => row.flag && row.flag !== '--organization').map(row => `${row.flag} ${row.other ? 'TAG' : row.kind === 'choice' ? row.choices.map(choice => choice.value).join('|')
    : row.kind === 'model' ? `PROVIDER/MODEL${row.optional ? '|off' : ''}` : row.id === 'proxy' ? 'URL|none' : 'PATH|none'}`);
  return `[AZPR] SETUP${problem ? ' REQUIRED' : ''}\nSettings: ${path}\n${problem ? `Problem when OpenCode loaded AZPR: ${problem}\n` : ''}\n` +
    'In OpenCode\'s terminal UI, /pr-setup alone asks for the organization, an optional proxy, the token and a model in dialogs, checks the token with Azure DevOps and saves it for you; afterwards it lists the settings to change. In other clients, or to script it:\n\n' +
    `1. Connect your provider in OpenCode and choose one tool-capable model ID (${models.length ? models.join(', ') : 'run opencode models'}).\n` +
    `2. Create an Azure DevOps PAT for one organization with Code (Read) and Pull Request Threads (Read & write). Keep it alone in a regular file owned by you, with mode 600 (by default ${patFile}); never paste it into this conversation.\n` +
    `3. Run ${USAGE}\n\n` +
    '--organization also takes a PR or organization URL. Without --pat-file, setup uses the default PAT file, or with --replace the PAT file already set. ' +
    'The selected model fills the three review roles and the quick reviewer. Deep remains unchanged (off for a new profile). Existing settings require --replace for these three options; other settings are kept. No model request or Azure request is made.\n\n' +
    `One setting of existing settings is changed without --replace: ${options.join(', ')}.\n\n` +
    `A first setup is loaded at once. After a later change, ${RESTART}. Then run /pr-check <PR URL>. Settings changes do not affect reviews already running.`;
}

/**
 * Why settings cannot be used (problem '' when they can, or when AZPR is
 * disabled), without their values: a missing or unreadable file (its error
 * code), JSON (the generic message, as a parser excerpt may hold the PAT),
 * validation or the PAT file, whose messages name settings and problems only.
 */
async function settingsProblem(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { return { problem: error.code === 'ENOENT' ? 'there is no settings file yet.' : `the settings file could not be read (${error.code ?? 'unknown error'}).` }; }
  try {
    const raw = settingsJSON(text);
    if (raw.enabled === false) return { disabled: true, problem: '' };
    const settings = validateSettings(raw);
    if (settings.azure.patFile) await readPatFile(settings.azure.patFile);
    return { problem: '' };
  } catch (error) {
    return { problem: error instanceof Error && error.message ? error.message.replace(/^\[AZPR\] /, '') : 'the settings could not be loaded.' };
  }
}

/** What an error may say to the person who is setting AZPR up: AZPR's own words, and never an OS or parser message. */
const said = (error, fallback) => typeof error?.message === 'string' && error.message.startsWith('[AZPR] ') ? error.message.slice(7) : fallback;

/** What Azure DevOps or the way to it refused, in setup's words, and which answer to ask for again (`fix`). */
function accessProblem(error, organization, proxy) {
  if (!(error instanceof AzureError)) return { fix: '', problem: 'The check could not be run.' };
  const status = error.status ? ` (HTTP ${error.status})` : '';
  const code = [error.code, error.cause?.cause?.code, error.cause?.code].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{2,40}$/.test(value));
  switch (error.kind) {
    case 'auth': return { fix: 'token', problem: `Azure DevOps did not accept this token for the organization "${organization}"${status}. It may be mistyped or expired, or belong to another organization.` };
    case 'permission': return { fix: 'token', problem: `Azure DevOps accepted the token but did not let it list pull requests${status}. It needs the scopes Code (Read) and Pull Request Threads (Read & write).` };
    case 'not-found': return { fix: 'organization', problem: `Azure DevOps knows no organization named "${organization}"${status}.` };
    case 'tls': return { fix: 'caFile', problem: `The TLS certificate of the connection was not accepted${code ? ` (${code})` : ''}. A proxy that inspects HTTPS needs its root CA certificate.` };
    case 'proxy': return { fix: 'proxy', problem: error.status === 407 ? 'The proxy asks for a user name and password (HTTP 407).' : `A proxy or gateway answered instead of Azure DevOps${status}.` };
    case 'timeout': return { fix: 'proxy', problem: `Azure DevOps did not answer within ${Math.round(CHECK_TIMEOUT_MS / 1000)} seconds.${proxy ? '' : ' This network may need a proxy.'}` };
    case 'network': return { fix: 'proxy', problem: `Azure DevOps could not be reached${code ? ` (${code})` : ''}.${proxy ? ` Check the proxy ${shownProxy(proxy)}.` : ' This network may need a proxy.'}` };
    case 'throttled': case 'server': return { fix: '', problem: `Azure DevOps answered with an error${status}. Try again in a moment.` };
    default: return { fix: '', problem: `Azure DevOps answered in a way setup does not know${status}.` };
  }
}

/**
 * Setup for one settings file: what the RPC of the terminal UI's dialogs calls. `loaded()` says what this
 * process has in use: `blocked` (no usable settings were found), `problem` (why) and `drift()` (the loaded
 * runtime's own answer to whether the settings file and the PAT file are still what it read).
 * `saved(unusable)` is told after every save that succeeded, with whether the settings could not be used
 * before it.
 * `options` are the runtime's test options (fetch, azureBaseUrl), `checkTimeoutMs` and, for offline tests,
 * `settingsPrepared` (runs when a save's new settings text is ready, before it replaces the file).
 */
function createSetupService({ context, path, environment, options, loaded, saved }) {
  // One request at a time, and none of them waits long: this queue is setup's own, since it must work before
  // there are settings, and so before the runtime and its queue exist.
  const queue = createToolQueue({ concurrency: 1, timeoutMs: options.checkTimeoutMs ?? CHECK_TIMEOUT_MS });
  let saving = false;
  const home = environment.HOME || homedir();
  const shownPath = value => home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;

  /** The settings file as setup may change it: its text (null: none yet), its content, and why it cannot be changed. */
  async function current() {
    let previous;
    try { previous = await readExisting(path); }
    catch (error) { return { previous: undefined, raw: null, fileProblem: said(error, `The settings file could not be read (${error?.code ?? 'unknown error'}).`) }; }
    if (previous === null) return { previous, raw: { version: 2 }, fileProblem: '' };
    try {
      const raw = settingsJSON(previous);
      if (raw.version !== 2) throw new Error('[AZPR] Setup supports only version-2 settings.');
      for (const name of ['models', 'azure', 'debug', 'afterReview']) if (raw[name] !== undefined && !object(raw[name])) throw new Error(`[AZPR] "${name}" in the settings file is not a JSON object.`);
      if (object(raw.models)) for (const mode of MODES) if (raw.models[mode] !== undefined && !object(raw.models[mode])) throw new Error(`[AZPR] "models.${mode}" in the settings file is not a JSON object.`);
      return { previous, raw, fileProblem: '' };
    } catch (error) { return { previous, raw: null, fileProblem: said(error, 'The settings file could not be read as settings.') }; }
  }
  const tokenFileOf = raw => text(azureOf(raw).patFile) || defaultPatFile(environment);
  /** Whether a token is saved and can be used, how the list shows that, and what its dialog adds; never the token. */
  async function tokenState(raw) {
    // A token is saved for an organization. Where the settings name none, a token that is there belongs to none
    // yet: it is not offered, since a check would not send it.
    const owned = Boolean(text(azureOf(raw).organization));
    if (!text(azureOf(raw).patFile) && text(azureOf(raw).pat)) {
      return { saved: owned && !patProblem(azureOf(raw).pat), shown: 'in the settings file', note: `A new token is saved in ${shownPath(tokenFileOf(raw))} instead of in the settings file.` };
    }
    const file = tokenFileOf(raw);
    try {
      await readPatFile(file);
      return owned ? { saved: true, shown: 'saved', note: `The saved token is in ${shownPath(file)}.` }
        : { saved: false, shown: 'saved without an organization', note: `The token you enter replaces the one in ${shownPath(file)}, which was saved without an organization.` };
    }
    catch (error) {
      if (/\(not found\)/.test(error.message)) return { saved: false, shown: 'not set', note: '' };
      return { saved: false, shown: 'cannot be used', note: `The token file ${shownPath(file)} ${said(error, 'could not be read.').replace(/^azure\.patFile /, '')}` };
    }
  }

  /** Whether the loaded runtime refuses new runs because the settings file or the PAT file changed since it read them. */
  const drifted = async use => { try { return Boolean(await use.drift?.()); } catch { return true; } };

  async function status() {
    const { previous, raw, fileProblem } = await current();
    const view = withMissingSettings(raw ?? { version: 2 }).settings;
    const token = await tokenState(view);
    const use = loaded();
    // A process that found no usable settings: setup is required while there are none, and once there are some
    // that it has not loaded (another process's setup or an editor made them usable, or loading them failed),
    // they wait for the restart. Without a settings file there is nothing to list, also while a runtime still
    // works with the file that was there: setup starts again, and what it saves then waits for the restart.
    // For settings in use the runtime itself says whether it would refuse new runs, by the rule of its
    // preflight: any difference of the settings text but the defaults a load wrote into it, and any other
    // content of the PAT file, whoever wrote them.
    const state = use.blocked ? ((await settingsProblem(path)).problem ? 'required' : 'restart')
      : previous === null ? 'required'
        : (await drifted(use)) ? 'restart' : 'ready';
    return { version: 1, state, problem: use.blocked ? use.problem : '', editable: raw !== null, fileProblem,
      settingsFile: path, settingsFileShown: shortPath(shownPath(path)), organization: text(azureOf(view).organization),
      rows: ROWS.map(row => row.kind === 'secret'
        ? { id: row.id, group: row.group, label: row.label, kind: row.kind, title: row.title, description: `${row.description(view, environment)}${token.note ? ` ${token.note}` : ''}`, value: token.shown, saved: token.saved }
        : { id: row.id, group: row.group, label: row.label, kind: row.kind, title: row.title, value: row.show(row.get(view)), current: row.current(row.get(view)),
          ...(row.description ? { description: row.description(view, environment) } : {}), ...(row.placeholder ? { placeholder: row.placeholder } : {}),
          ...(row.optional ? { optional: row.optional } : {}), ...(row.choices ? { choices: row.choices } : {}), ...(row.other ? { other: row.other } : {}) }) };
  }

  /** An answer that is given is text, as a dialog gives it: anything else is no answer, not an empty one. */
  const textual = (input, names) => {
    for (const name of names) if (input[name] !== undefined && typeof input[name] !== 'string') throw new Error('[AZPR] Setup takes each answer as text.');
  };

  /** The answers of `changes` in their saved form, applied to `raw`; `model` stands for the review and the quick model. */
  async function apply(raw, changes) {
    if (!object(changes)) throw new Error('[AZPR] Setup was given no settings to change.');
    let next = raw;
    const values = {}, shown = {};
    for (const [id, answer] of Object.entries(changes)) {
      const rows = id === 'model' ? [rowOf('reviewModel'), rowOf('quickModel')] : [rowOf(id)];
      if (rows.some(row => !row?.set)) throw new Error('[AZPR] Setup does not know one of the settings it was given.');
      // Every answer is text, as a dialog or an option gives it: anything else is no answer, not an empty one.
      if (typeof answer !== 'string') throw new Error('[AZPR] Setup takes each setting as text.');
      for (const row of rows) {
        const value = await row.accept(context, answer, next, row);
        next = row.set(next, value);
        // What goes back to the dialog is what the person gave, in its saved form. A proxy left as the dialog showed
        // it stands for the saved one, whose user name and password never leave this process.
        values[id] = row.kind === 'choice' && typeof value === 'boolean' ? (value ? 'on' : 'off')
          : row.id === 'proxy' && value && text(answer).trim() !== value ? text(answer).trim() : value;
        shown[id] = row.show(row.get(withMissingSettings(next).settings));
      }
    }
    return { next, values, shown };
  }

  /** Whether answers can be used, without saving them: their saved form and how they may be shown. */
  async function validate(input) {
    const { raw, fileProblem } = await current();
    if (raw === null) return { ok: false, problem: fileProblem };
    const { values, shown } = await apply(raw, input?.changes);
    return { ok: true, values, shown };
  }

  /**
   * Ask Azure DevOps once whether a token works for an organization: the token given, else the saved one;
   * through the proxy and with the CA file given, else the saved ones.
   */
  async function check(input) {
    textual(input, ['organization', 'token', 'proxy', 'caFile']);
    const { raw, fileProblem } = await current();
    if (raw === null) return { ok: false, fix: '', problem: fileProblem };
    const view = withMissingSettings(raw).settings;
    const organization = organizationOf(input.organization ?? azureOf(view).organization);
    let token;
    if (input?.token !== undefined) {
      token = text(input.token).trim();
      const problem = patProblem(token);
      if (problem) return { ok: false, fix: 'token', problem: `That is ${problem}.` };
    } else {
      // The saved token goes only to the organization it was saved for.
      const saved = text(azureOf(view).organization);
      if (organization.toLowerCase() !== saved.toLowerCase()) {
        return { ok: false, fix: 'token', problem: saved ? `The saved token was saved for the organization "${saved}". Enter a token of "${organization}".` : 'No token is saved for an organization yet.' };
      }
      try { token = text(azureOf(view).patFile) || !text(azureOf(view).pat) ? await readPatFile(tokenFileOf(view)) : azureOf(view).pat; }
      catch (error) { return { ok: false, fix: 'token', problem: `The saved token cannot be used: ${said(error, 'its file is unreadable').replace(/^azure\.patFile /, 'its file ')}` }; }
    }
    const proxy = input?.proxy !== undefined ? proxyOf(input.proxy, text(azureOf(view).proxy)) : text(azureOf(view).proxy);
    const caFile = input?.caFile !== undefined ? await caFileOf(input.caFile) : text(azureOf(view).caFile);
    const transport = fetchTransport({ proxy, caCertificates: await readCaCertificates(caFile), verifyTls: azureOf(view).verifyTls !== false });
    if (Object.keys(transport).length && !options.fetch && !fetchTransportSupported()) {
      return { ok: false, fix: '', problem: 'A proxy and a CA file need OpenCode\'s own runtime; this one would ignore them.' };
    }
    const client = createAzureClient({ organization, pat: token, baseUrl: restBaseUrl(options.azureBaseUrl ?? environment.AZPR_TEST_AZURE_BASE_URL),
      transport, queue, retryDelayMs: 0, fetch: options.fetch });
    try {
      await client.access({ controller: new AbortController() });
      return { ok: true, organization };
    } catch (error) { return { ok: false, ...accessProblem(error, organization, proxy) }; }
  }

  /**
   * Save answers and, when one was given, the token. A token is saved for an organization: the one this save
   * sets, or the one it was checked for, which must still be the one in the settings. The token file and the
   * settings that name it are written under the setup lock, the token first, and only while the settings
   * file still is what the answers were checked against: two setups that save at the same moment never
   * leave the organization of one with the token of the other.
   */
  async function save(input) {
    if (saving) return { ok: false, problem: 'Another setup is being saved.' };
    saving = true;
    try {
      textual(input, ['token', 'organization']);
      // Whether this save is the one that makes the settings usable: only then are they this setup's to load.
      const unusable = loaded().blocked && Boolean((await settingsProblem(path)).problem);
      const { previous, raw, fileProblem } = await current();
      if (raw === null) return { ok: false, problem: fileProblem };
      let { next } = await apply(raw, input.changes ?? {});
      const before = withMissingSettings(raw).settings;
      const was = text(azureOf(before).organization), named = text(azureOf(next).organization);
      let token;
      if (input.token !== undefined) {
        token = text(input.token).trim();
        const problem = patProblem(token);
        if (problem) return { ok: false, problem: `The token is ${problem}.` };
        const expected = input.organization !== undefined ? organizationOf(input.organization) : Object.hasOwn(input.changes ?? {}, 'organization') ? named : '';
        if (!expected) return { ok: false, problem: 'A token is saved for an organization: name the one it was checked for.' };
        if (expected.toLowerCase() !== named.toLowerCase()) {
          return { ok: false, problem: `The token was checked for the organization "${expected}", but the settings name ${named ? `"${named}"` : 'none'} now. Nothing was saved; run /pr-setup again.` };
        }
        const file = tokenFileOf(next);
        if (!isAbsolute(file) || resolve(file) === resolve(path)) return { ok: false, problem: 'The token file must be an absolute path other than the settings file.' };
        next = withAzure(next, { pat: '', patFile: file });
      } else if (was && named.toLowerCase() !== was.toLowerCase() && (await tokenState(before)).saved) {
        // Without a new token, the saved one would pass to an organization it was not saved for.
        return { ok: false, problem: `The saved token was saved for the organization "${was}". Another organization needs a token of its own: enter it together with the organization.` };
      }
      const { settings } = withMissingSettings(next);
      valid(validateSettings, settings);
      const written = settingsText(settings);
      if (token !== undefined || written !== previous) {
        await withSetupLock(path, async () => {
          // Once more, under the lock and before anything is written: the file still is what the answers were
          // checked against, so this token cannot end up beside an organization another setup saved meanwhile.
          if (await readExisting(path) !== previous) throw settingsChanged();
          // The token that is already there is left as it is: nothing changed, so nothing waits for a restart.
          const replaced = token !== undefined && !(await readPatFile(settings.azure.patFile).then(kept => kept === token, () => false));
          if (replaced) await writeTokenFile(settings.azure.patFile, token);
          try { if (written !== previous) await replaceSettings(path, previous, settings, options.settingsPrepared); }
          catch (error) {
            // The token file has the new token by now: say so, since the answer otherwise reads as if nothing had changed.
            if (!replaced) throw error;
            throw new Error(`[AZPR] The token was saved, but the settings were not: ${said(error, 'the settings file could not be written.')}`);
          }
        });
      }
      await saved(unusable);
      return { ok: true, status: await status() };
    } finally { saving = false; }
  }

  /** An RPC handler never throws: what went wrong is an answer, in AZPR's own words, and holds no value it was given. */
  const answer = (handler, fallback) => async input => {
    try { return await handler(object(input) ? input : {}); }
    catch (error) { return { ok: false, fix: '', problem: said(error, fallback) }; }
  };
  return {
    status: answer(status, 'AZPR\'s settings could not be read.'),
    validate: answer(validate, 'That value could not be checked.'),
    check: answer(check, 'The token could not be checked.'),
    save: answer(save, 'The settings could not be saved; nothing was changed. Check the file permissions of the settings directory.'),
  };
}

/** Missing/invalid settings expose only setup and blocked command explanations, with the reason. */
export async function setupPlugin(context, sourceDirectory = SOURCE_DIRECTORY, testOptions = {}) {
  const { environment = process.env, settingsWaitMs, checkTimeoutMs, releaseWaitMs = RELEASE_WAIT_MS, settingsPrepared, ...runtimeOptions } = testOptions;
  const path = await settingsFileFor(context.options ?? {}, sourceDirectory, environment);
  const first = await settingsProblem(path);
  if (first.disabled) return async () => {};
  requireMethods(context, ['command.list', 'command.transform'], 'AZPR setup');
  const catalog = listOf(await context.command.list());
  if (!catalog) throw new Error('[AZPR] Invalid OpenCode command catalog.');
  // What this process has in use: nothing while `blocked`, else a runtime, whose `drift()` says whether the
  // settings file and the PAT file still are what it read. `own`: a save of this process's own setup made the
  // settings usable, so they are its to load.
  const use = { blocked: Boolean(first.problem), problem: first.problem, loadProblem: '', drift: undefined, own: false };
  const reserved = ['pr-setup', ...(use.blocked ? Object.keys(COMMANDS) : [])];
  if (catalog.some(command => reserved.includes(command.name))) throw new Error('[AZPR] Reserved command name conflict; resolve it before loading AZPR.');
  let pending = false, cleanup, placeholders, activating, rpc, closed = false;
  let foreign = new Set(); // review command names that turned out to be another plugin's when a first setup was loaded

  /** Load the runtime with the settings as they are now. */
  const load = async () => {
    // Before the runtime reads the settings for good: it compares later reads with this one.
    const completion = await addMissingSettings(path, settingsWaitMs === undefined ? {} : { waitMs: settingsWaitMs, pauseMs: 10 });
    const loaded = await setupAzurePrReview(context, sourceDirectory, { ...runtimeOptions, settingsPath: path, settingsCompletion: completion });
    use.drift = typeof loaded?.settingsDrift === 'function' ? loaded.settingsDrift : undefined;
    return loaded;
  };
  /**
   * The commands of a process that found no usable settings: each says so. They load nothing, also when the
   * settings can be used by now: settings that this process's own setup did not save (another process's, or an
   * edit) are read after a restart, as always.
   */
  const registerPlaceholders = (taken = new Set()) => context.command.transform(editor => {
    // Adding a command replaces the one that has its name: a name another plugin took meanwhile stays its own.
    for (const name of Object.keys(COMMANDS)) if (!taken.has(name)) editor.add({ name, description: PLACEHOLDER_DESCRIPTION, async execute(event) {
      const now = await settingsProblem(path);
      const usable = !now.problem && !now.disabled;
      await appendReport(context, { sessionID: event.sessionID, text: !usable
        ? `[AZPR] SETUP REQUIRED\nNo review or Azure request was started. Settings at ${path} could not be used when OpenCode loaded AZPR: ${now.problem || use.problem} Run /pr-setup (in the terminal UI it asks in dialogs; --help shows the options); repair an existing settings file if necessary, then ${RESTART}.`
        : use.loadProblem
          ? `[AZPR] RESTART REQUIRED\nNo review or Azure request was started. The settings at ${path} are saved, but AZPR could not load them: ${use.loadProblem} Repair that, then ${RESTART}.`
          : `[AZPR] RESTART REQUIRED\nNo review or Azure request was started. The settings at ${path} can be used now, but AZPR found no usable settings when OpenCode loaded it for this project directory, and these were saved elsewhere: by a setup in another project directory or another OpenCode process, or by hand. To load them, ${RESTART}.` });
    } });
  });
  /**
   * A first setup takes effect without a restart: nothing was loaded before, so loading the settings now
   * is the one time they are read. Only `afterSave` calls it. Returns whether the runtime is loaded afterwards.
   */
  function activate() {
    if (!use.blocked) return Promise.resolve(true);
    if (closed) return Promise.resolve(false);
    activating ??= (async () => {
      try {
        const now = await settingsProblem(path);
        if (now.problem || now.disabled) { use.problem = now.problem || 'AZPR is switched off in its settings (enabled: false).'; return false; }
        // The runtime refuses command names that exist: the commands that only said "setup required" go first.
        await placeholders?.dispose();
        placeholders = undefined;
        // The host may list them a moment longer. What is listed under a review command's name and is not one
        // of them is another plugin's command: the runtime will refuse to load beside it.
        for (const until = Date.now() + releaseWaitMs; ; ) {
          const listed = (listOf(await context.command.list()) ?? []).filter(command => Object.hasOwn(COMMANDS, command?.name));
          foreign = new Set(listed.filter(command => command.description !== PLACEHOLDER_DESCRIPTION).map(command => command.name));
          if (listed.length === foreign.size || Date.now() >= until) break;
          await new Promise(done => setTimeout(done, 50));
        }
        try { cleanup = await load(); }
        catch (error) {
          use.problem = use.loadProblem = said(error, 'the settings could not be loaded.');
          // The commands that say so come back, except under a name that is another plugin's by now; without
          // them only /pr-setup is left until the restart.
          placeholders = closed ? undefined : await registerPlaceholders(foreign).catch(() => undefined);
          return false;
        }
        // Unloaded meanwhile: what was just loaded goes again.
        if (closed) { const loaded = cleanup; cleanup = undefined; await loaded?.(); return false; }
        use.blocked = false;
        use.problem = use.loadProblem = '';
        // OpenCode 2.3.0 announces commands that change after a plugin was loaded without their location, and
        // its clients then keep the list they have: the terminal part reads the commands again on this event.
        try { await rpc?.events?.emit?.('loaded', {}); } catch { /* The commands work either way. */ }
        return true;
      } catch (error) {
        // A host call failed on the way (removing the commands, listing them, unloading). What was saved stays
        // saved, and the commands that say what is missing stay too, or come back.
        use.problem = use.loadProblem = said(error, 'OpenCode did not answer while AZPR replaced its commands.');
        if (use.blocked && !placeholders && !closed) placeholders = await registerPlaceholders(foreign).catch(() => undefined);
        return false;
      } finally { activating = undefined; }
    })();
    return activating;
  }

  /**
   * After a save of this process's own setup; `unusable`: the settings could not be used before it. A process
   * that found no usable settings loads them when its own save is what made them usable, and tries again with
   * a later save when loading them failed. Settings that could be used before the save were made usable by
   * something else (another process's setup, an editor, a tool): those wait for the restart, as every change
   * does, whatever this save added. Returns whether the runtime is loaded afterwards (`ready`), and
   * otherwise what stands in the way now (`problem`; '' when it is only the restart).
   */
  const afterSave = async unusable => {
    if (!use.blocked) return { ready: true, problem: '' };
    const now = await settingsProblem(path);
    // Still not usable: the problem of now takes the place of the one found at load.
    if (now.problem) { use.problem = now.problem; return { ready: false, problem: now.problem }; }
    if (unusable) use.own = true;
    if (!use.own) return { ready: false, problem: '' };
    const ready = await activate();
    return { ready, problem: ready ? '' : use.problem };
  };

  const service = createSetupService({ context, path, environment, options: { ...runtimeOptions, checkTimeoutMs, settingsPrepared }, loaded: () => use,
    saved: async unusable => { await afterSave(unusable); } });
  const registrations = [];
  const registration = await context.command.transform(editor => {
    editor.add({ name: 'pr-setup', description: SETUP_DESCRIPTION, async execute(event) {
      if (event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length) throw new Error('[AZPR] Setup accepts literal options only.');
      const session = typeof context.session?.get === 'function' ? recordOf(await context.session.get({ sessionID: event.sessionID })) : null;
      if (privateAgent(session?.agent)) throw new Error('[AZPR] Private reviewers cannot configure AZPR.');
      let text, metadata;
      try {
        const arguments_ = parseSetupArguments(event.prompt.text ?? '');
        if (arguments_ === null) {
          text = await guide(context, path, use.blocked ? use.problem : '', environment);
          // /pr-setup alone: the terminal UI opens its dialogs when it sees this notice. --help only explains.
          if (!(event.prompt.text ?? '').trim()) metadata = { azpr: { setup: true } };
        } else {
          if (pending) throw new Error('[AZPR] Another setup is active.');
          pending = true;
          let saved, after = { ready: false, problem: '' };
          const wasBlocked = use.blocked;
          try {
            const unusable = wasBlocked && Boolean((await settingsProblem(path)).problem);
            saved = await saveSetup(context, path, arguments_, environment);
            if (wasBlocked) after = await afterSave(unusable);
          } finally { pending = false; }
          text = `[AZPR] SETTINGS SAVED\nSettings: ${path}\n` +
            (saved.first ? `Organization: ${saved.organization}; PAT file: ${saved.patFile}\n` : '') +
            (saved.changed.length ? `Changed: ${saved.changed.join(', ')}\n` : '') +
            (after.ready ? 'AZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.'
              : after.problem ? `AZPR could not load them: ${after.problem} Repair that, then ${RESTART}. No model or Azure request was made.`
                : `To load them, ${RESTART}, then run /pr-check <PR URL>. No model or Azure request was made.${wasBlocked ? '' : ' Existing reviews keep their original settings.'}`);
        }
      } catch (error) {
        // OS errors may include file contents only through custom providers; report codes, not arbitrary text.
        text = typeof error.message === 'string' && error.message.startsWith('[AZPR]') ? error.message : '[AZPR] Setup could not save settings. Check the model ID, organization, PAT file and local file permissions; existing settings were preserved.';
      }
      await appendReport(context, { sessionID: event.sessionID, text, ...(metadata ? { metadata } : {}) });
    } });
  });
  registrations.push(registration);
  try {
    // The terminal UI's dialogs reach setup through the plugin's RPC; a host without it keeps the options.
    if (typeof context.rpc?.register === 'function') registrations.push(rpc = await context.rpc.register(SETUP_RPC, service));
    if (use.blocked) placeholders = await registerPlaceholders();
    else cleanup = await load();
  }
  catch (error) { await Promise.allSettled(registrations.map(item => item.dispose())); throw error; }
  return async () => {
    closed = true;
    await activating?.catch(() => {});
    await cleanup?.();
    await placeholders?.dispose();
    await Promise.allSettled(registrations.reverse().map(item => item.dispose()));
  };
}
