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
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { COMMANDS, MODES, REPOSITORY, SETTING_CHECKS, MAX_REVIEWERS, MIGRATION_NEEDED, isModelReference, migrateSettings, modelRef, patProblem, privateAgent, settingsText, validateSettings, withMissingSettings } from './config.mjs';
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
// How long a first setup waits for OpenCode to drop the commands that only said that AZPR is not ready.
const RELEASE_WAIT_MS = 3000;
// The commands of a process without usable settings: each only says that AZPR cannot run here yet. The words are
// true of every reason: no settings, settings that cannot be used, settings of 0.4.x that wait for their update,
// and settings that were saved elsewhere since (by a setup in another project directory, say) and wait for a
// restart. /pr-setup tells which it is.
const PLACEHOLDER_DESCRIPTION = 'AZPR is not ready here; run /pr-setup to see what it needs';
// Where every setting is described: the README is long, so its section is named, and linked for a terminal that opens links.
const SETTINGS_REFERENCE = `the README's section "All settings and defaults" (https://github.com/${REPOSITORY}#all-settings-and-defaults)`;
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
  // The update of settings of 0.4.x is one confirmed change of the whole file: nothing else travels with it.
  if (result['--migrate'] !== undefined && Object.keys(result).length > 1) throw new Error('[AZPR] --migrate stands alone: update the settings first, then change them. Use /pr-setup --help.');
  return result;
}

// ------------------------------------------------------------------------------------------------ rows
const text = value => typeof value === 'string' ? value : '';
const OFF_WORD = /^(?:none|off)$/i;
const azureOf = raw => object(raw.azure) ? raw.azure : {};
const withAzure = (raw, values) => ({ ...raw, azure: { ...azureOf(raw), ...values } });
/** The one value that all of them have, or null when they differ. */
const shared = values => values.every(value => value === values[0]) ? values[0] : null;
/**
 * Several values as one row of the list shows them: the value they share (`empty` where that is none), else
 * only that they differ, since the list has room for a few words; the settings file has each of them.
 */
const together = (values, empty, differ) => shared(values) === null ? differ : shared(values) || empty;
// How many passes one model named for a mode becomes: a person can then add entries or take them away.
const USUAL_PASSES = Object.freeze({ review: 2, deep: 2, quick: 1 });
const NOT_A_MODEL = '(not a model ID)';
/** A mode's reviewer models as the settings have them: one entry per pass. */
const reviewersOf = (raw, mode) => Array.isArray(raw.models?.[mode]?.reviewers) ? raw.models[mode].reviewers.filter(item => typeof item === 'string') : [];
/** `raw` with that list for the mode; the mode's other settings (its rater) stay. */
const withReviewers = (raw, mode, list) => ({ ...raw, models: { ...(object(raw.models) ? raw.models : {}),
  [mode]: { ...(object(raw.models?.[mode]) ? raw.models[mode] : {}), reviewers: list } } });
/** A list as runs of one model: [[model, count], …]. */
const runs = list => list.reduce((all, model) => { if (all.at(-1)?.[0] === model) all.at(-1)[1]++; else all.push([model, 1]); return all; }, []);
/**
 * A list as text, the form an option and a dialog give it in: entries separated by commas, a model that
 * runs several passes in a row as MODEL*N. A model always carries its count here, also a single one
 * (MODEL*1): a model named alone, without a count, means the mode's usual number of passes.
 */
const reviewersText = list => runs(list).map(([model, count]) => `${model}*${count}`).join(',');
/** A list as a row of the settings list shows it, in a few words: each model without its provider, with its count. */
function reviewersShown(list, empty) {
  if (!list.length) return empty;
  const shown = list.map(model => isModelReference(model) ? model : NOT_A_MODEL);
  const short = model => model === NOT_A_MODEL ? model : model.slice(model.indexOf('/') + 1);
  // Passes are counted by the whole reference; a model keeps its provider where another provider has one of that name.
  const providers = new Map();
  for (const model of new Set(shown)) providers.set(short(model), (providers.get(short(model)) ?? 0) + 1);
  return runs(shown).map(([model, count]) => `${providers.get(short(model)) > 1 ? model : short(model)}${count > 1 ? ` ×${count}` : ''}`).join(' + ');
}
/**
 * The entries of a list that are model IDs. What a settings file holds in a model's place may be anything, a
 * pasted token included: a row names such an entry (`NOT_A_MODEL`) and never returns it.
 */
const modelsOnly = list => list.filter(isModelReference);
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
async function modelOf(context, answer) {
  const value = text(answer).trim();
  valid(SETTING_CHECKS.model, value, 'The model');
  await checkModels(context, [value]);
  return value;
}
/**
 * A mode's reviewer models from an answer: MODEL (the mode's usual number of passes of that model), or
 * entries separated by commas, each MODEL or MODEL*N, in the order of the passes (at most four in all);
 * `off` or `none` where the mode may be off. A model reference holds neither a comma nor a star. What is
 * wrong is said by the entry's position, never by quoting it.
 */
async function reviewersFrom(context, answer, row) {
  const value = text(answer).trim();
  if (row.optional && (value === '' || OFF_WORD.test(value))) return [];
  const entries = value.split(',').map(entry => entry.trim());
  const list = [];
  for (const [index, entry] of entries.entries()) {
    const star = entry.lastIndexOf('*'), model = star < 0 ? entry : entry.slice(0, star).trim();
    const count = star < 0 ? (entries.length === 1 ? USUAL_PASSES[row.mode] : 1) : /^[1-9]\d?$/.test(entry.slice(star + 1).trim()) ? Number(entry.slice(star + 1)) : 0;
    const name = entries.length === 1 ? 'The model' : `Entry ${index + 1}`;
    valid(SETTING_CHECKS.model, model, name);
    if (!count) throw new Error(`[AZPR] ${name}: after the star comes the number of passes, 1 to ${MAX_REVIEWERS}.`);
    for (let pass = 0; pass < count; pass++) list.push(model);
  }
  if (list.length > MAX_REVIEWERS) throw new Error(`[AZPR] ${row.label} take at most ${MAX_REVIEWERS} passes in all.`);
  await checkModels(context, list);
  return list;
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
 * `hint` says what a row is for, where its name does not: the list shows it between the name and the value,
 * which leaves room for a few words only. `prompt` and `variantPrompt` say more where there is room for it:
 * in the search line of the dialog that lists the models, and of the one that lists a model's variants.
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
  { id: 'reviewModel', flag: '--review-model', group: 'Models', label: 'Review models', kind: 'model', mode: 'review', title: 'Model for /pr-review', hint: 'for /pr-review',
    get: raw => reviewersOf(raw, 'review'), show: list => reviewersShown(list, 'not set'), current: list => reviewersText(modelsOnly(list)),
    accept: (context, answer, _raw, row) => reviewersFrom(context, answer, row), set: (raw, list) => withReviewers(raw, 'review', list) },
  { id: 'quickModel', flag: '--quick-model', group: 'Models', label: 'Quick models', kind: 'model', mode: 'quick', title: 'Model for /pr-quick', hint: 'for /pr-quick', optional: { label: 'Off', description: '/pr-quick stays off' },
    get: raw => reviewersOf(raw, 'quick'), show: list => reviewersShown(list, 'off'), current: list => reviewersText(modelsOnly(list)),
    accept: (context, answer, _raw, row) => reviewersFrom(context, answer, row), set: (raw, list) => withReviewers(raw, 'quick', list) },
  { id: 'deepModel', flag: '--deep-model', group: 'Models', label: 'Deep models', kind: 'model', mode: 'deep', title: 'Model for /pr-deep', hint: 'for /pr-deep',
    // /pr-deep is the same review with stronger models: another model, the same one reasoning longer, or more passes.
    prompt: 'Stronger than the review model, or a higher variant', variantPrompt: 'A higher variant reasons longer', optional: { label: 'Off', description: '/pr-deep stays off' },
    get: raw => reviewersOf(raw, 'deep'), show: list => reviewersShown(list, 'off'), current: list => reviewersText(modelsOnly(list)),
    accept: (context, answer, _raw, row) => reviewersFrom(context, answer, row), set: (raw, list) => withReviewers(raw, 'deep', list) },
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
/** --migrate WORD confirms the update of settings of 0.4.x that /pr-setup alone showed: the word names that very change. */
const SETUP_FLAGS = Object.freeze([...new Set([...FIRST_SETUP_FLAGS, '--migrate', ...ROWS.flatMap(row => row.flag ? [row.flag] : [])])]);

/** Whether OpenCode offers each of these models, enabled, with tools and with the variant named; one listing for all of them. */
/** Each model of a list exists in OpenCode, can call tools and has its variant. A model is named by the place of its first entry, never quoted. */
async function checkModels(context, values) {
  if (typeof context.model?.list !== 'function') throw new Error('[AZPR] The model catalog is unavailable. Connect a model provider in OpenCode, then retry setup.');
  const catalog = listOf(await context.model.list());
  if (!catalog) throw new Error('[AZPR] The model catalog is unavailable; settings were not changed.');
  // A list of one model (also of several passes of it) needs no place; a list of different models names the entry.
  const several = new Set(values).size > 1;
  for (const [index, value] of values.entries()) {
    if (values.indexOf(value) !== index) continue;
    const which = several ? ` (entry ${index + 1} of the list)` : '';
    const { providerID, id, variant } = modelRef(value);
    const selected = catalog.find(item => item.providerID === providerID && item.id === id);
    if (!selected || selected.enabled === false) throw new Error(`[AZPR] The selected model is unavailable in OpenCode${which}. Choose an enabled ID from opencode models.`);
    if (selected.capabilities?.tools !== true) throw new Error(`[AZPR] The selected model must support tools${which}.`);
    if (variant && variant !== 'default' && (!Array.isArray(selected.variants) || !selected.variants.some(item => item.id === variant))) {
      throw new Error(`[AZPR] The selected model does not offer that variant${which}.`);
    }
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

// The word that names one update of settings of 0.4.x is a keyed digest, with a key of this process: it says
// nothing of a file that may hold a token, and a word of another process, or of before a restart, names nothing.
const MIGRATION_KEY = randomBytes(16);
const shownModel = value => isModelReference(value) ? value : NOT_A_MODEL;

/**
 * What a settings text of AZPR 0.4.x becomes; null for any other text. `settings` is the complete file of
 * this version (`written` its text), `problem` says why that file cannot be used yet ('' when it can: every
 * settings file that 0.4.x could use gives one that this version can use), `lines` say what changes, in the
 * words /pr-setup shows, and `word` names this very change: the text it replaces and the text it writes.
 * Every settings text of 0.4.x is changed by this update alone, also one with a fault: a repair that rewrote
 * the file in this version's layout would change its models, its rating and what automatic publication posts
 * without any of it being shown.
 */
function migrationOf(previous) {
  let raw;
  try { raw = settingsJSON(previous); } catch { return null; }
  if (raw.version !== 2) return null;
  let migrated, summary;
  try { ({ settings: migrated, summary } = migrateSettings(raw)); } catch { return null; }
  // The update repairs nothing: settings it leaves unusable are written as it leaves them, and the problem is
  // named; only usable ones get what they leave out at its defaults, as the loader completes a valid file only.
  let problem = '';
  try { validateSettings(migrated); } catch (error) { problem = typeof error?.message === 'string' ? error.message : 'the settings could not be used.'; }
  const settings = problem ? migrated : withMissingSettings(migrated).settings;
  const written = settingsText(settings);
  const word = createHmac('sha256', MIGRATION_KEY).update(previous).update('\0').update(written).digest('hex').slice(0, 12);
  return { migrated, settings, written, problem, word, lines: migrationLines(summary, problem) };
}

/** What an update of settings of 0.4.x changes, one line per point: values that are no model IDs are named, never shown. */
function migrationLines({ modes, shardFindings, publish }, problem = '') {
  const lines = ['This version reviews with a list of reviewer models per mode: each entry reviews the changed files on its own, one pass each. There is no verifier any more: the first entry also merges repeated findings and plans the comments, and a rating sets the severities.'];
  // Models that are no model IDs: none chosen yet (placeholders), or values that 0.4.x could not use either,
  // which the update keeps where they go now for the settings check to name.
  const unchosen = list => Array.isArray(list) && list.length > 0 && list.every(item => typeof item === 'string' && /REPLACE_|YOUR_PROVIDER|YOUR_MODEL/.test(item));
  const kept = mode => modes[mode].value ? `/pr-${mode}: its settings are not a group of models, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.`
    : modes[mode].clash ? `/pr-${mode}: its settings name reviewers, which 0.4.x did not know, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.`
    : unchosen(modes[mode].after.reviewers) ? `/pr-${mode}: no model was chosen yet. Choose its models with /pr-setup after the update.`
      : `/pr-${mode}: its models are not all model IDs, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.`;
  // A group the file already wrote as this version writes one runs as it is: what it runs is named.
  const current = mode => {
    const { reviewers } = modes[mode].after;
    return reviewers.length ? `/pr-${mode}: the file already names its reviewers as this version does, so they stay -> ${reviewers.length} pass${reviewers.length === 1 ? '' : 'es'}: ${reviewers.map(shownModel).join(', ')}.`
      : `/pr-${mode}: the file already names its reviewers as this version does, none, so it stays off.`;
  };
  for (const mode of ['review', 'deep']) {
    const { before, after, state } = modes[mode];
    if (modes[mode].current) lines.push(current(mode));
    else if (state === 'kept') lines.push(kept(mode));
    else if (state === 'on') lines.push(`/pr-${mode}: functional ${shownModel(before.functional)}, risk ${shownModel(before.risk)}, verifier ${shownModel(before.verifier)} -> ${after.reviewers.length} passes: ${after.reviewers.map(shownModel).join(', ')}. The verifier model is no longer used.`);
    else if (state === 'partial') lines.push(`/pr-${mode}: only some of its three models were set, so it was off and stays off (models.${mode}.reviewers is empty). Set it afterwards with /pr-setup.`);
    else lines.push(`/pr-${mode}: off, stays off.`);
  }
  lines.push(modes.quick.current ? current('quick') : modes.quick.state === 'kept' ? kept('quick') : modes.quick.state !== 'on' ? '/pr-quick: off, stays off.'
    : `/pr-quick: reviewer ${shownModel(modes.quick.before.reviewer)} -> 1 pass: ${shownModel(modes.quick.after.reviewers[0])}.`);
  // The rating of every mode that runs, and a rater the file names wherever it is no model ID or false.
  const rated = MODES.filter(mode => modes[mode].state === 'on'), raterOf = mode => modes[mode].after.rater;
  const off = rated.filter(mode => raterOf(mode) === false), inherited = rated.filter(mode => raterOf(mode) === '');
  if (off.length) lines.push(`Severity rating of ${off.map(mode => `/pr-${mode}`).join(', ')}: off ("rater": false), as the file says.`);
  for (const mode of rated.filter(mode => isModelReference(raterOf(mode)))) {
    lines.push(`Severity rating of /pr-${mode}: ${raterOf(mode)}, ${modes[mode].current ? 'as the file names it' : mode === 'quick' ? 'as the file names it (0.4.x had no rating for /pr-quick)' : 'as before'}.`);
  }
  for (const mode of MODES.filter(mode => modes[mode].state !== 'kept' && ![undefined, '', false].includes(raterOf(mode)) && !isModelReference(raterOf(mode)))) {
    lines.push(`Severity rating of /pr-${mode}: the rater the file names is no model ID; it is kept as it is, and the settings check names it after the update.`);
  }
  if (inherited.length) lines.push(`Severity rating of ${inherited.map(mode => `/pr-${mode}`).join(', ')}: none ran before (no rater was set). From now on the first reviewer model rates the findings from their text alone; "rater": false in the settings file switches that off.`);
  if (shardFindings !== undefined) lines.push('workflow.shardFindings is dropped: it sized the verifier\'s batches.');
  if (publish.length) lines.push(`afterReview is "publish" for ${publish.map(mode => `/pr-${mode}`).join(', ')}: after the update ${publish.length > 1 ? 'these commands post' : 'this command posts'} the comments of the new reviews automatically, as the PAT owner. Reports and comments then say that findings were checked by their reviewer and that no separate verification ran. To read the comments before they are posted, set afterReview to preview for ${publish.length > 1 ? 'these modes' : 'this mode'}.`);
  lines.push('Every other setting stays as it is, also one that is not a setting of this version: the settings check then names it.');
  // A file that had a fault keeps it: the update changes the layout, and the repair follows it.
  if (problem) lines.push(`After the update the settings still cannot be used: ${problem} Nothing runs until that is set right, with /pr-setup or in the settings file.`);
  return lines;
}

/**
 * Atomic, owner-only save; serialize setup calls and preserve unrelated values.
 * The options of a first setup (--organization, --model, --pat-file) create the file, or with --replace
 * set those values again: without --pat-file, a replacement keeps the PAT file already set and a first
 * setup uses the default PAT file. Every other option changes the one setting it names in an existing
 * file. The file names every setting, those setup does not ask for at their defaults. Returns the saved
 * organization and PAT file, the labels of the single settings that were changed, whether the settings it
 * replaced could not be used (`unusable`), and what the settings and the token file they name held when it
 * read them (`before`) and what it leaves (`after`: the text it wrote with the token it read; see `pairWith`).
 */
export async function saveSetup(context, path, arguments_, environment = process.env) {
  const previous = await readExisting(path);
  const first = FIRST_SETUP_FLAGS.some(flag => arguments_[flag] !== undefined);
  // Settings of 0.4.x take one change only: the update a person confirms with the word /pr-setup showed for
  // it. No other option implies that consent, also not those of a first setup or one that repairs a fault.
  const migration = previous === null ? null : migrationOf(previous);
  if (migration) {
    const word = arguments_['--migrate'];
    if (word === undefined) throw new Error(`[AZPR] ${MIGRATION_NEEDED} Other options work after that.`);
    if (word !== migration.word) throw new Error('[AZPR] That word names no update of the settings file as it is now (the file changed, or OpenCode was restarted since). Run /pr-setup alone and use the word it shows.');
    const held = await settingsTextProblem(previous);
    await writeSettings(path, previous, migration.settings);
    return { organization: text(migration.settings.azure?.organization), patFile: text(migration.settings.azure?.patFile), changed: [], first: false, migrated: true, remaining: migration.problem,
      unusable: Boolean(held.problem), before: pairWith(previous, held.digest), after: pairWith(migration.written, held.digest) };
  }
  if (arguments_['--migrate'] !== undefined) throw new Error('[AZPR] These settings need no update: --migrate is only for settings of AZPR 0.4.x that /pr-setup offers to update.');
  if (previous === null && !first) {
    throw new Error('[AZPR] There are no settings yet. Supply --organization and --model, or run /pr-setup alone in OpenCode\'s terminal UI. Use /pr-setup --help.');
  }
  if (previous !== null && first && !arguments_['--replace']) {
    throw new Error('[AZPR] Settings already exist. Add --replace to change organization, PAT file and the review and quick models while keeping other settings.');
  }
  const raw = previous === null ? { version: 3 } : settingsJSON(previous);
  if (raw.version !== 3) throw new Error('[AZPR] Setup supports only version-3 settings; existing data was preserved.');
  if (raw.models !== undefined && !object(raw.models) || raw.azure !== undefined && !object(raw.azure)) {
    throw new Error('[AZPR] Repair models and azure objects in settings.json before setup; existing data was preserved.');
  }
  // Whether the settings this save replaces could be used, and the token that goes with them, from one look at
  // them when they are read: what this save leaves is said from what it read and wrote, never from a later
  // look, which could be at another writer's work.
  const held = await settingsTextProblem(previous);
  const heldDigest = held.digest;
  let next = raw, patFile = text(raw.azure?.patFile), leftDigest = heldDigest;
  if (first) {
    const model = arguments_['--model'];
    const organization = organizationName(arguments_['--organization']);
    const kept = typeof raw.azure?.patFile === 'string' && raw.azure.patFile ? raw.azure.patFile : '';
    patFile = arguments_['--pat-file'] ?? (kept || defaultPatFile(environment));
    if (typeof patFile !== 'string' || !isAbsolute(patFile) || resolve(patFile) === resolve(path)) {
      throw new Error('[AZPR] --pat-file must name an absolute path separate from settings.json.');
    }
    // One model named for a first setup: the usual passes of /pr-review and of /pr-quick; /pr-deep stays as it is.
    valid(SETTING_CHECKS.model, model, 'The model');
    next = { ...withReviewers(withReviewers(raw, 'review', Array(USUAL_PASSES.review).fill(model)), 'quick', Array(USUAL_PASSES.quick).fill(model)),
      azure: { ...raw.azure, organization, pat: '', patFile } };
    validateSettings(withMissingSettings(next).settings);
    await checkModels(context, [model]);
    // The PAT file must be usable. Its token goes with what this save leaves when the settings name the file
    // anew; for a file they named already, the token is the one of the look above, whatever is there by now.
    try {
      const digest = digestOf(await readPatFile(patFile));
      if (resolve(patFile) !== resolve(text(raw.azure?.patFile) || '/')) leftDigest = digest;
    }
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
  // Judged on the text this save replaces, not on a second read: whether it is this save that makes the settings usable.
  const unusable = Boolean(held.problem);
  await writeSettings(path, previous, settings);
  return { organization: text(settings.azure?.organization), patFile, changed, first, unusable,
    before: previous === null ? undefined : pairWith(previous, heldDigest), after: pairWith(settingsText(settings), leftDigest) };
}

const mine = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
/**
 * One token as setup writes it and as it finds it in a file it may replace: one word of letters, digits, "-"
 * and "_" that is as long as a token (an Azure DevOps PAT, also an expired one, or a placeholder). The two
 * are the same test, so that what setup wrote it can replace: a line of JSON, a KEY=VALUE pair, a path, an
 * address, a short word or a token with quotes around it is something else.
 */
const TOKEN_WORD = /^[A-Za-z0-9_-]{20,1024}$/;
/** Why setup does not take a value as the token ('' when it does); it never contains the value. */
const tokenProblem = value => patProblem(value) || (TOKEN_WORD.test(value) ? ''
  : 'not an Azure DevOps token: it has characters other than letters, digits, "-" and "_" (quotes around it, perhaps)');
/** The directory of a token file, made where it is missing: the user's own, and no one else may write to it. */
async function tokenDirectory(parent) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o022) || !mine(parentInfo)) {
    throw new Error('[AZPR] The directory of the token file must be a directory owned by you, not a symbolic link or writable by other users.');
  }
}

/**
 * Replace the token file the settings name for this organization: one file that holds only the token,
 * readable by its owner alone (mode 600), in a directory no one else can write to. The new content takes
 * the file's place in one step, so a reader sees the old token or the new one. A path that is anything but
 * a regular file of the user's own is refused and left as it is.
 */
async function writeTokenFile(path, token) {
  await tokenDirectory(dirname(path));
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.nlink !== 1 || !mine(existing))) {
    throw new Error('[AZPR] The token file must be a regular file owned by you, without hard links; it was left as it is.');
  }
  // Settings name this path, and settings can be wrong: a file that holds something other than one token
  // (TOKEN_WORD) is not a token file, whatever the settings say, and is never replaced.
  if (existing && existing.size > 0) {
    let content = null;
    if (existing.size <= 4096) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { content = (await handle.readFile('utf8')).trim(); } finally { await handle.close(); }
    }
    if (content === null || (content !== '' && !TOKEN_WORD.test(content))) {
      throw new Error('[AZPR] The file that azure.patFile names holds something other than one token; it was left as it is. Name another file there, or remove this one.');
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    await writeTemporary(temporary, token);
    await rename(temporary, path);
    replaced = true;
  } finally {
    // The token is in place: what cannot be cleaned up after that is no reason to report it as not replaced.
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT' && !replaced) throw error; });
  }
}

/**
 * Make a token file that did not exist, and return its path: `pat-<organization>` in `directory`, or that
 * name with the first number that is free (`pat-<organization>-2`). The name is taken in one step that
 * refuses a name which exists, so no file is ever overwritten, and no two saves get the same file, whichever
 * settings file each is for: several settings files of one person share AZPR's directory, and their setup
 * locks are not the same lock. Owner-only (mode 600), in a directory no one else can write to.
 */
async function createTokenFile(directory, organization, token) {
  await tokenDirectory(directory);
  const temporary = join(directory, `pat.${randomUUID()}.tmp`);
  let made = '';
  try {
    await writeTemporary(temporary, token);
    for (let number = 1; number <= 999; number++) {
      const file = join(directory, `pat-${organization.toLowerCase()}${number === 1 ? '' : `-${number}`}`);
      try { await link(temporary, file); made = file; return file; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('[AZPR] The directory of the token file has no free name for a token file of this organization; remove the ones that are no longer needed.');
  } finally {
    // The file was made: a temporary name that cannot be removed then is no reason to lose track of it.
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT' && !made) throw error; });
  }
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
    // What the work wrote is written: a lock that cannot be removed is reported by the next writer that finds it.
    await handle?.close().catch(() => {});
    if (acquired) await unlink(lock).catch(() => {});
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
  let committed = false;
  try {
    if (await readExisting(path) !== previous) throw settingsChanged();
    await writeTemporary(temporary, settingsText(settings));
    await prepared?.();
    if (await readExisting(path) !== previous) throw settingsChanged();
    if (previous === null) await link(temporary, path); // Refuse a concurrent creator rather than overwriting it.
    else await rename(temporary, path);
    committed = true;
  } finally {
    // Once the new text is in place the write has happened: a temporary file that cannot be removed then is
    // left behind, and is no reason to report the write as failed (a caller would undo what belongs to it).
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT' && !committed) throw error; });
  }
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

/** What /pr-setup alone and --help say. For settings of 0.4.x that can be updated: what the update changes, and how to confirm it. */
async function guide(context, path, problem, environment, migration) {
  if (migration) {
    return `[AZPR] SETTINGS UPDATE\nSettings: ${path}\n\nThese settings are from AZPR 0.4.x. Reviews run again once the file is updated to this version; nothing is changed until you confirm.\n\n` +
      `${migration.lines.map(line => `- ${line}`).join('\n')}\n\n` +
      `In OpenCode's terminal UI, /pr-setup alone asks whether to update the file. In other clients, confirm with:\n\n/pr-setup --migrate ${migration.word}\n\n` +
      'The word names this very change: when the settings file changes before you confirm, /pr-setup shows the update again. No model request or Azure request is made.';
  }
  let catalog = [], patFile;
  try { catalog = (listOf(await context.model.list()) ?? []).filter(item => item.enabled !== false && item.capabilities?.tools === true); } catch { /* Help remains usable before provider setup. */ }
  try { patFile = defaultPatFile(environment); } catch { patFile = '$XDG_CONFIG_HOME/azpr/pat'; }
  const models = catalog.slice(0, 12).map(item => `${item.providerID}/${item.id}`);
  const options = ROWS.filter(row => row.flag && row.flag !== '--organization').map(row => `${row.flag} ${row.other ? 'TAG' : row.kind === 'choice' ? row.choices.map(choice => choice.value).join('|')
    : row.kind === 'model' ? `MODELS${row.optional ? '|off' : ''}` : row.id === 'proxy' ? 'URL|none' : 'PATH|none'}`);
  return `[AZPR] SETUP${problem ? ' REQUIRED' : ''}\nSettings: ${path}\n${problem ? `Problem when OpenCode loaded AZPR: ${problem}\n` : ''}\n` +
    'In OpenCode\'s terminal UI, /pr-setup alone asks for the organization, an optional proxy, the token and a model in dialogs, checks the token with Azure DevOps and saves it for you; afterwards it lists the settings to change. In other clients, or to script it:\n\n' +
    `1. Connect your provider in OpenCode and choose one tool-capable model ID (${models.length ? models.join(', ') : 'run opencode models'}).\n` +
    `2. Create an Azure DevOps PAT for one organization with Code (Read) and Pull Request Threads (Read & write). Keep it alone in a regular file owned by you, with mode 600 (by default ${patFile}); never paste it into this conversation.\n` +
    `3. Run ${USAGE}\n\n` +
    '--organization also takes a PR or organization URL. Without --pat-file, setup uses the default PAT file, or with --replace the PAT file already set. ' +
    'The selected model reviews twice in /pr-review and once in /pr-quick. Deep remains unchanged (off for a new profile). Existing settings require --replace for these three options; other settings are kept. No model request or Azure request is made.\n\n' +
    `One setting of existing settings is changed without --replace: ${options.join(', ')}. A model takes a variant as PROVIDER/MODEL#VARIANT. ` +
    `MODELS is a mode's review passes in order: PROVIDER/MODEL alone means that mode's usual number of passes of one model (review 2, deep 2, quick 1); MODEL*N sets the number (MODEL*1 is one pass), and entries separated by commas run different models, one pass each, at most ${MAX_REVIEWERS} passes in all (A,B or A*2,B). The first entry also merges repeated findings, plans the comments and rates the severities. ` +
    `--deep-model sets the models of /pr-deep, which runs the same review: choose a stronger model than the review model, the same model with a higher variant, or more passes. Every setting is described in ${SETTINGS_REFERENCE}.\n\n` +
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
  return settingsTextProblem(text);
}
/**
 * The same for a settings text that was read already (null: there is no file), so that a save judges the text
 * it replaces; with `digest`, the digest of the token in the file the text names ('' where it names none or
 * the file cannot be read). Both come from one read of that file: whether the settings can be used and which
 * token goes with them are then said of the same moment.
 */
async function settingsTextProblem(text) {
  if (text === null) return { problem: 'there is no settings file yet.', digest: '' };
  let settings;
  try {
    const raw = settingsJSON(text);
    if (raw.enabled === false) return { disabled: true, problem: '', digest: await tokenDigest(text) };
    settings = validateSettings(raw);
  } catch (error) {
    return { problem: error instanceof Error && error.message ? error.message.replace(/^\[AZPR\] /, '') : 'the settings could not be loaded.', digest: await tokenDigest(text),
      // Settings of 0.4.x: not a fault to repair, an update to confirm.
      ...(error?.needsMigration ? { migration: true } : {}) };
  }
  if (!settings.azure.patFile) return { problem: '', digest: '' };
  try { return { problem: '', digest: digestOf(await readPatFile(settings.azure.patFile)) }; }
  catch (error) { return { problem: error instanceof Error && error.message ? error.message.replace(/^\[AZPR\] /, '') : 'the settings could not be loaded.', digest: '' }; }
}

/** A token as it may be compared and remembered: a digest, never the token. */
const digestOf = token => createHash('sha256').update(token).digest('hex');
/** The digest of the token in the file a settings text names; '' where it names none or the file cannot be read. */
async function tokenDigest(text) {
  try {
    const file = settingsJSON(text).azure?.patFile;
    if (typeof file === 'string' && file) return digestOf(await readPatFile(file));
  } catch { /* A text that is no settings, or a token file that cannot be read: no token to tell apart. */ }
  return '';
}
/** A settings text and the token that goes with it (as its digest), as one value to compare. */
const pairWith = (text, digest) => `${digest}\n${text}`;
/** What a settings text and the token file it names hold at this moment; undefined for no settings file. */
const pairOf = async text => typeof text === 'string' ? pairWith(text, await tokenDigest(text)) : undefined;

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
 * `saved({ made, before, after })` is told after every save that succeeded: whether it made unusable
 * settings usable (the settings it replaced could not be used, and it wrote something), and what the
 * settings and the token file they name held when it read them and what it leaves (`pairWith`: the text
 * in the file after it with the token it wrote, or else the one it found).
 * `options` are the runtime's test options (fetch, azureBaseUrl), `checkTimeoutMs` and, for offline tests,
 * `settingsPrepared` (runs when a save's new settings text is ready, before it replaces the file).
 * `turn.busy` is the one turn of this server part's setup: a save takes it from its first read to the end
 * of what follows it (the load of a first setup), and so does /pr-setup with options.
 */
function createSetupService({ context, path, environment, options, loaded, saved, turn }) {
  // One request at a time, and none of them waits long: this queue is setup's own, since it must work before
  // there are settings, and so before the runtime and its queue exist.
  const queue = createToolQueue({ concurrency: 1, timeoutMs: options.checkTimeoutMs ?? CHECK_TIMEOUT_MS });
  const home = environment.HOME || homedir();
  const shownPath = value => home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;

  /** The settings file as setup may change it: its text (null: none yet), its content, and why it cannot be changed. */
  async function current() {
    let previous;
    try { previous = await readExisting(path); }
    catch (error) { return { previous: undefined, raw: null, fileProblem: said(error, `The settings file could not be read (${error?.code ?? 'unknown error'}).`) }; }
    if (previous === null) return { previous, raw: { version: 3 }, fileProblem: '' };
    try {
      // Settings of 0.4.x are changed in one way only, the update a person confirms: no row of theirs is edited,
      // also not to repair a fault.
      const migration = migrationOf(previous);
      if (migration) return { previous, raw: null, fileProblem: MIGRATION_NEEDED, migration };
      const raw = settingsJSON(previous);
      if (raw.version !== 3) throw new Error('[AZPR] Setup supports only version-3 settings.');
      for (const name of ['models', 'azure', 'debug', 'afterReview']) if (raw[name] !== undefined && !object(raw[name])) throw new Error(`[AZPR] "${name}" in the settings file is not a JSON object.`);
      if (object(raw.models)) for (const mode of MODES) {
        if (raw.models[mode] !== undefined && !object(raw.models[mode])) throw new Error(`[AZPR] "models.${mode}" in the settings file is not a JSON object.`);
        if (raw.models[mode]?.reviewers !== undefined && !Array.isArray(raw.models[mode].reviewers)) throw new Error(`[AZPR] "models.${mode}.reviewers" in the settings file is not a list.`);
      }
      return { previous, raw, fileProblem: '' };
    } catch (error) { return { previous, raw: null, fileProblem: said(error, 'The settings file could not be read as settings.') }; }
  }
  /**
   * Whether a token is saved and can be used, how the list shows that, and what its dialog adds; never the
   * token. A saved token is what the settings name, as the runtime reads it: `azure.patFile`, else
   * `azure.pat`. The default PAT file is none unless they name it: every settings file a person has may use it.
   */
  async function tokenState(raw) {
    // A token is saved for an organization. Where the settings name none, a token that is there belongs to none
    // yet: it is not offered, since a check would not send it.
    const owned = Boolean(text(azureOf(raw).organization));
    const file = text(azureOf(raw).patFile);
    if (!file) {
      return text(azureOf(raw).pat)
        ? { saved: owned && !patProblem(azureOf(raw).pat), shown: 'in the settings file', note: 'A new token is saved in a file of its own instead of in the settings file.' }
        : { saved: false, shown: 'not set', note: '' };
    }
    try {
      await readPatFile(file);
      return owned ? { saved: true, shown: 'saved', note: `The saved token is in ${shownPath(file)}.` }
        : { saved: false, shown: 'saved without an organization', note: `The token in ${shownPath(file)} was saved without an organization and is not used; the token you enter gets a file of its own.` };
    }
    catch (error) {
      if (/\(not found\)/.test(error.message)) return { saved: false, shown: 'not set', note: '' };
      return { saved: false, shown: 'cannot be used', note: `The token file ${shownPath(file)} ${said(error, 'could not be read.').replace(/^azure\.patFile /, '')}` };
    }
  }

  /** Whether the loaded runtime refuses new runs because the settings file or the PAT file changed since it read them. */
  const drifted = async use => {
    // No answer is no "nothing changed": a runtime that loaded nothing (settings switched off) has read none.
    if (typeof use.drift !== 'function') return true;
    try { return Boolean(await use.drift()); } catch { return true; }
  };

  async function status() {
    const { previous, raw, fileProblem, migration } = await current();
    const view = withMissingSettings(raw ?? migration?.settings ?? { version: 3 }).settings;
    const token = await tokenState(view);
    const use = loaded();
    // A process that found no usable settings: setup is required while there are none, and once there are some
    // that it has not loaded (another process's setup or an editor made them usable, or loading them failed),
    // they wait for the restart. Without a settings file there is nothing to list, also while a runtime still
    // works with the file that was there: setup starts again, and what it saves then waits for the restart.
    // For settings in use the runtime itself says whether it would refuse new runs, by the rule of its
    // preflight: any difference of the settings text but the defaults a load wrote into it, and any other
    // content of the PAT file, whoever wrote them.
    // Settings of 0.4.x that can be updated are neither missing nor faulty: `migrate`, with what the update
    // changes and the word that confirms it. Their rows are shown as they will be and cannot be edited before.
    const state = migration ? 'migrate'
      : use.blocked ? ((await settingsProblem(path)).problem ? 'required' : 'restart')
        : previous === null ? 'required'
          : (await drifted(use)) ? 'restart' : 'ready';
    return { version: 1, state, problem: use.blocked ? use.problem : '', editable: raw !== null, fileProblem,
      ...(migration ? { migration: { lines: migration.lines, word: migration.word } } : {}),
      settingsFile: path, settingsFileShown: shortPath(shownPath(path)), settingsReference: SETTINGS_REFERENCE, organization: text(azureOf(view).organization),
      rows: ROWS.map(row => row.kind === 'secret'
        ? { id: row.id, group: row.group, label: row.label, kind: row.kind, title: row.title, description: `${row.description(view, environment)}${token.note ? ` ${token.note}` : ''}`, value: token.shown, saved: token.saved,
          // Whether the settings name a token at all, usable or not: another organization then needs one of its own.
          bound: Boolean(text(azureOf(view).patFile) || text(azureOf(view).pat)) }
        : { id: row.id, group: row.group, label: row.label, kind: row.kind, title: row.title, value: row.show(row.get(view)), current: row.current(row.get(view)),
          ...(row.description ? { description: row.description(view, environment) } : {}), ...(row.placeholder ? { placeholder: row.placeholder } : {}),
          ...(row.hint ? { hint: row.hint } : {}), ...(row.prompt ? { prompt: row.prompt } : {}), ...(row.variantPrompt ? { variantPrompt: row.variantPrompt } : {}),
          ...(row.optional ? { optional: row.optional } : {}), ...(row.choices ? { choices: row.choices } : {}), ...(row.other ? { other: row.other } : {}),
          // A list of models: its entries, how many passes one model named alone becomes, and how many there may be.
          ...(row.mode ? { entries: modelsOnly(row.get(view)), usual: USUAL_PASSES[row.mode], most: MAX_REVIEWERS } : {}) }) };
  }

  /** An answer that is given is text, as a dialog gives it: anything else is no answer, not an empty one. */
  const textual = (input, names) => {
    for (const name of names) if (input[name] !== undefined && typeof input[name] !== 'string') throw new Error('[AZPR] Setup takes each answer as text.');
  };

  /**
   * The answers of `changes` in their saved form, applied to `raw`; `model` stands for the review and the quick
   * models: one model named for a first setup, the usual number of passes of each of the two modes.
   */
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
        // What goes back to the dialog is the answer in its saved form, but never a proxy's user name and
        // password: not the saved one's (a proxy left as the dialog showed it stands for the saved one), and
        // not those of a proxy that was just typed either. For such a proxy nothing goes back, and the dialog
        // keeps what was typed.
        if (row.id === 'proxy' && value && shownProxy(value).endsWith(')')) { if (text(answer).trim() !== value) values[id] = text(answer).trim(); }
        // A list goes back as the text an answer gives it in, so that a dialog can start from it again.
        else values[id] = row.kind === 'choice' && typeof value === 'boolean' ? (value ? 'on' : 'off') : Array.isArray(value) ? row.current(value) : value;
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
   * Ask Azure DevOps once whether a token works for an organization. A token that is given is checked
   * through the proxy and with the CA file given, else the saved ones. Without a token the saved one is
   * checked, and it goes only where the saved settings send it: to the organization it was saved for,
   * through the saved proxy and with the saved CA file. (A proxy and a CA file that the caller chooses
   * could otherwise read a token the caller does not have.)
   */
  async function check(input) {
    textual(input, ['organization', 'token', 'proxy', 'caFile']);
    const { raw, fileProblem } = await current();
    if (raw === null) return { ok: false, fix: '', problem: fileProblem };
    const view = withMissingSettings(raw).settings;
    const organization = organizationOf(input.organization ?? azureOf(view).organization);
    const savedProxy = text(azureOf(view).proxy), savedCaFile = text(azureOf(view).caFile);
    const proxy = input.proxy !== undefined ? proxyOf(input.proxy, savedProxy) : savedProxy;
    const caFile = input.caFile !== undefined ? await caFileOf(input.caFile) : savedCaFile;
    let token;
    if (input.token !== undefined) {
      token = text(input.token).trim();
      const problem = tokenProblem(token);
      if (problem) return { ok: false, fix: 'token', problem: `That is ${problem}.` };
    } else {
      const saved = text(azureOf(view).organization);
      if (organization.toLowerCase() !== saved.toLowerCase()) {
        return { ok: false, fix: 'token', problem: saved ? `The saved token was saved for the organization "${saved}". Enter a token of "${organization}".` : 'No token is saved for an organization yet.' };
      }
      if (proxy !== savedProxy || caFile !== savedCaFile) {
        return { ok: false, fix: 'token', problem: 'The saved token is checked only through the saved proxy and with the saved CA certificate file. Enter the token to check it with the ones given here.' };
      }
      const file = text(azureOf(view).patFile);
      if (!file && !text(azureOf(view).pat)) return { ok: false, fix: 'token', problem: 'No token is saved yet.' };
      try { token = file ? await readPatFile(file) : azureOf(view).pat; }
      catch (error) { return { ok: false, fix: 'token', problem: `The saved token cannot be used: ${said(error, 'its file is unreadable').replace(/^azure\.patFile /, 'its file ')}` }; }
    }
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
   * Save answers and, when one was given, the token.
   *
   * A token is saved for an organization: the one this save sets, or the one it was checked for, which must
   * still be the one in the settings. Organization and token change in one step, the write of the settings
   * file. A token of the organization the settings named already replaces the token file they name. Every
   * other token gets a file that did not exist (`createTokenFile`), which the settings name in the same
   * write: a first setup's, another organization's, and one for settings that name the default PAT file,
   * which every settings file a person has may use. So setup overwrites no file but the one these settings
   * name for this organization, and whoever reads the settings and then the file they name has a token of
   * that organization, also while a save is under way and after one that failed or was cut short.
   *
   * Both files are written under the setup lock, the token first, and only while the settings file still
   * is what the answers were checked against. A token file this save made is removed again when the
   * settings are not written: nothing names it.
   */
  async function save(input) {
    if (turn.busy) return { ok: false, problem: 'Another setup is being saved.' };
    turn.busy = true;
    try {
      textual(input, ['token', 'organization', 'migrate']);
      const { previous, raw, fileProblem, migration } = await current();
      if (input.migrate !== undefined) {
        // The update of settings of 0.4.x: confirmed by the word that names what was shown, and saved alone.
        if (input.changes !== undefined || input.token !== undefined || input.organization !== undefined) return { ok: false, problem: 'The update of the settings is saved by itself, before anything else is changed.' };
        if (!migration) return { ok: false, problem: 'These settings need no update.' };
        if (input.migrate !== migration.word) return { ok: false, problem: 'The settings file changed since the update was shown, or OpenCode was restarted since, so nothing was saved. Run /pr-setup again to see the update as it is now.' };
        const held = await settingsTextProblem(previous);
        await writeSettings(path, previous, migration.settings, options.settingsPrepared);
        await saved({ made: loaded().blocked && Boolean(held.problem), before: pairWith(previous, held.digest), after: pairWith(migration.written, held.digest) });
        // What the updated file still lacks, if anything: the dialogs go on to set it.
        return { ok: true, status: await status(), ...(migration.problem ? { remaining: migration.problem } : {}) };
      }
      if (raw === null) return { ok: false, problem: fileProblem };
      // Whether it is this save that makes the settings usable, judged on the text it replaces: only then are
      // they this setup's to load. And the token that goes with them, from the same look, to tell later
      // whether anything else wrote the settings or the token in between.
      const held = await settingsTextProblem(previous);
      const unusable = loaded().blocked && Boolean(held.problem), heldDigest = held.digest;
      let { next } = await apply(raw, input.changes ?? {});
      const before = withMissingSettings(raw).settings;
      const was = text(azureOf(before).organization), named = text(azureOf(next).organization);
      // The organization these settings name changes: from one to another, or from none to one.
      const changed = named.toLowerCase() !== was.toLowerCase(), another = changed && Boolean(was);
      // The file the token of these settings was in until now, where they named an organization and a token file.
      const source = was ? text(azureOf(before).patFile) : '';
      let token, directory = '';
      if (input.token !== undefined) {
        token = text(input.token).trim();
        const problem = tokenProblem(token);
        if (problem) return { ok: false, problem: `The token is ${problem}.` };
        const expected = input.organization !== undefined ? organizationOf(input.organization) : Object.hasOwn(input.changes ?? {}, 'organization') ? named : '';
        if (!expected) return { ok: false, problem: 'A token is saved for an organization: name the one it was checked for.' };
        if (expected.toLowerCase() !== named.toLowerCase()) {
          return { ok: false, problem: `The token was checked for the organization "${expected}", but the settings name ${named ? `"${named}"` : 'none'} now. Nothing was saved; run /pr-setup again.` };
        }
        const kept = text(azureOf(next).patFile);
        if (kept && (!isAbsolute(kept) || resolve(kept) === resolve(path))) return { ok: false, problem: 'The token file must be an absolute path other than the settings file.' };
        // Replaced where it is only when these settings name the file for this very organization, and it is not
        // the default PAT file. Otherwise a file is made beside it, or in AZPR's directory; until it is made,
        // the settings are checked with the name it will have if that name is free.
        if (!(kept && was && !another && resolve(kept) !== resolve(defaultPatFile(environment)))) directory = dirname(kept || defaultPatFile(environment));
        next = withAzure(next, { pat: '', patFile: directory ? join(directory, `pat-${named.toLowerCase()}`) : kept });
      } else if (changed && (text(azureOf(before).patFile) || text(azureOf(before).pat))) {
        // Without a new token, the one these settings name would pass to an organization it was not saved for:
        // also a token that cannot be read at the moment (its file may be readable again later), and also one
        // that was saved for no organization.
        return { ok: false, problem: `${was ? `The saved token was saved for the organization "${was}". Another organization` : 'The token these settings name was saved without an organization. An organization'} needs a token of its own: enter it together with the organization.` };
      }
      let { settings } = withMissingSettings(next);
      valid(validateSettings, settings);
      let written = settingsText(settings), wrote = false, made = '', onDisk = previous;
      if (token !== undefined || written !== previous) {
        await withSetupLock(path, async () => {
          // Once more, under the lock and before anything is written: the file still is what the answers were
          // checked against.
          if (await readExisting(path) !== previous) throw settingsChanged();
          let replaced = false;
          try {
            if (directory) {
              made = await createTokenFile(directory, named, token);
              ({ settings } = withMissingSettings(withAzure(next, { patFile: made })));
              valid(validateSettings, settings);
              written = settingsText(settings);
            } else if (token !== undefined) {
              // The token that is already there is left as it is: nothing changed, so nothing waits for a restart.
              const differs = !(await readPatFile(settings.azure.patFile).then(kept => kept === token, () => false));
              if (differs) { await writeTokenFile(settings.azure.patFile, token); replaced = true; }
            }
            if (written !== previous) { await replaceSettings(path, previous, settings, options.settingsPrepared); onDisk = written; }
            wrote = Boolean(made) || replaced || written !== previous;
          } catch (error) {
            // The file this save made is named by nothing: it is taken away again, and the organization and its
            // token are as they were.
            if (made) { await unlink(made).catch(() => {}); made = ''; throw error; }
            if (!replaced) throw error;
            // The token file the settings name has the new token by now: say so, since the answer otherwise
            // reads as if nothing had changed.
            throw new Error(`[AZPR] The token was saved, but the settings were not: ${said(error, 'the settings file could not be written.')}`);
          }
        });
      }
      // What this save leaves is said from what it wrote: the text that is in the file after it, and the token
      // it was given, or else the one that was there when it read the settings. Never from another look at the
      // files, which could be at what another writer put there since.
      await saved({ made: unusable && wrote, before: typeof previous === 'string' ? pairWith(previous, heldDigest) : undefined,
        after: pairWith(onDisk, token !== undefined ? digestOf(token) : heldDigest) });
      // The token these settings had before is still in its file: a person decides what becomes of it.
      const stays = made && source && resolve(source) !== resolve(made) && await readPatFile(source).then(() => true, () => false);
      return { ok: true, status: await status(),
        ...(stays ? { note: `The ${another ? `token of "${was}"` : 'earlier token'} is still in ${shownPath(source)}. Delete that file if you no longer need it.` } : {}) };
    } finally { turn.busy = false; }
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
  // settings file and the PAT file still are what it read. `own`: what the settings and the token file they
  // name hold (`pairOf`) while they are this process's to load, because a save of its own setup made the
  // settings usable and everything since was written by a save of that setup; undefined once anything else
  // wrote either file.
  const use = { blocked: Boolean(first.problem), problem: first.problem, loadProblem: '', drift: undefined, own: undefined };
  /** What the settings file and the token file it names hold at this moment. */
  const pairNow = async () => pairOf(await readFile(path, 'utf8').catch(() => null));
  const reserved = ['pr-setup', ...(use.blocked ? Object.keys(COMMANDS) : [])];
  if (catalog.some(command => reserved.includes(command.name))) throw new Error('[AZPR] Reserved command name conflict; resolve it before loading AZPR.');
  let cleanup, placeholders, activating, rpc, closed = false;
  // What changes this plugin's review commands runs one after another: the load of a first setup, which
  // takes the commands that say that AZPR is not ready away and registers the runtime's, and putting those commands
  // back. Neither sees the other half done, and what one read of the host is not older than the other's work.
  let lane = Promise.resolve();
  const inLane = job => {
    const run = lane.then(job, job);
    lane = run.catch(() => {});
    return run;
  };
  // One save at a time, whichever way it comes in (the dialogs' RPC or /pr-setup with options), until what
  // follows it has ended: a second save during the load of a first setup would change what is being loaded.
  const turn = { busy: false };
  /**
   * The review command names that another plugin has by now: what is listed under one of them and is not a
   * command that only says that AZPR is not ready. Asked right before those commands are registered, since a
   * plugin can take a name at any moment. Null where the host does not answer: nothing is known then, and
   * what was known earlier is not.
   */
  const taken = async () => {
    try {
      const listed = listOf(await context.command.list());
      return listed && new Set(listed.filter(command => Object.hasOwn(COMMANDS, command?.name) && command.description !== PLACEHOLDER_DESCRIPTION).map(command => command.name));
    } catch { return null; }
  };

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
      await appendReport(context, { sessionID: event.sessionID, text: now.migration
        // Settings of 0.4.x: nothing to repair, an update to confirm in /pr-setup, which this process then loads.
        ? `[AZPR] SETTINGS UPDATE REQUIRED\nNo review or Azure request was started. Settings: ${path}\n${now.problem}`
        : !usable
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
    activating ??= inLane(async () => {
      try {
        const now = await settingsProblem(path);
        if (now.problem || now.disabled) { use.problem = now.problem || 'AZPR is switched off in its settings (enabled: false).'; return false; }
        // Only what this setup saved is this process's to load. What took its place since (another process's
        // setup, an editor; the settings or the token) waits for the restart, like every change from elsewhere.
        if (use.own === undefined || await pairNow() !== use.own) {
          use.own = undefined;
          use.loadProblem = '';
          return false;
        }
        // The runtime refuses command names that exist: the commands that only said that AZPR is not ready go first.
        await placeholders?.dispose();
        placeholders = undefined;
        // The host may list them a moment longer. What is listed under a review command's name and is not one
        // of them is another plugin's command: the runtime will refuse to load beside it.
        for (const until = Date.now() + releaseWaitMs; ; ) {
          const listed = (listOf(await context.command.list()) ?? []).filter(command => Object.hasOwn(COMMANDS, command?.name));
          if (listed.every(command => command.description !== PLACEHOLDER_DESCRIPTION) || Date.now() >= until) break;
          await new Promise(done => setTimeout(done, 50));
        }
        let outcome; // 'loaded', 'failed' (use.loadProblem says why), 'replaced' or 'closed'
        try {
          cleanup = await load();
          // The runtime read the files a moment after they were compared above. What it read is what they hold
          // now (its own answer), and what they hold now must be what this setup saved.
          // A load that answers neither (settings switched off meanwhile load nothing) is no load of them.
          const same = typeof use.drift === 'function' && await use.drift().then(drift => !drift, () => false) && await pairNow() === use.own;
          outcome = !same ? 'replaced' : closed ? 'closed' : 'loaded';
        } catch (error) {
          use.problem = use.loadProblem = said(error, 'the settings could not be loaded.');
          outcome = 'failed';
        }
        // Someone else's settings by now, or unloaded meanwhile: what was just loaded goes again.
        if (outcome === 'replaced' || outcome === 'closed') {
          const loaded = cleanup;
          cleanup = undefined;
          use.drift = undefined;
          if (outcome === 'replaced') { use.own = undefined; use.loadProblem = ''; }
          await Promise.resolve(loaded?.()).catch(() => {});
        }
        if (outcome !== 'loaded') {
          // The commands that say so come back, except under a name that is another plugin's by now; without
          // them only /pr-setup is left until the restart.
          await restoreNow();
          return false;
        }
        use.blocked = false;
        use.problem = use.loadProblem = '';
        // OpenCode 2.3.0 through 2.4.1 announce commands that change after a plugin was loaded without their location,
        // and their clients then keep the list they have: the terminal part reads the commands again on this event.
        try { await rpc?.events?.emit?.('loaded', {}); } catch { /* The commands work either way. */ }
        return true;
      } catch (error) {
        // A host call failed on the way (removing the commands, listing them, unloading). What was saved stays
        // saved, and the commands that say what is missing stay too, or come back.
        use.problem = use.loadProblem = said(error, 'OpenCode did not answer while AZPR replaced its commands.');
        await restoreNow();
        return false;
      } finally { activating = undefined; }
    });
    return activating;
  }

  /**
   * Put the commands that say what is missing back where none are registered, except under a name another
   * plugin has by now. Only with a list of the commands read at this moment: where the host does not answer
   * they stay away (adding one would replace a command that may be someone's), and the next /pr-setup or save
   * tries again. `restoreNow` is the step itself, for what already runs in the lane (a load that failed);
   * everything else asks through `restorePlaceholders`, which waits for its turn there, so that the list it
   * reads is never older than a load, and a load never finds this half done.
   */
  const restoreNow = async () => {
    if (!use.blocked || placeholders || closed) return;
    const names = await taken();
    if (names && !closed) placeholders = await registerPlaceholders(names).catch(() => undefined);
  };
  const restorePlaceholders = () => inLane(restoreNow);

  /**
   * After a save of this process's own setup: `made` (the settings it replaced could not be used, and it wrote
   * something), and what the settings and their token file held when it read them (`before`) and hold after
   * it (`after`). A process that found no usable settings loads them when its own save is what made them
   * usable, and tries again with a later save when loading them failed, as long as the two files held
   * nothing but what this setup wrote in between. Settings that could be used before the save, or that
   * took the place of what this setup saved, were made by something else (another process's setup, an
   * editor, a tool): those wait for the restart, as every change does, whatever this save added. Returns
   * whether the runtime is loaded afterwards (`ready`), and otherwise what stands in the way now
   * (`problem`; '' when it is only the restart).
   */
  const afterSave = async ({ made, before, after }) => {
    if (!use.blocked) return { ready: true, problem: '' };
    const now = await settingsProblem(path);
    // Still not usable: nothing is this setup's to load yet (what makes them usable later may be someone
    // else's doing), and the problem of now takes the place of the one found at load.
    if (now.problem) {
      use.own = undefined;
      use.problem = now.problem;
      use.loadProblem = '';
      await restorePlaceholders();
      return { ready: false, problem: now.problem };
    }
    if (made) use.own = after;
    else if (use.own !== undefined && before === use.own) use.own = after;
    // Not this setup's any more, or never: what a load of its own settings failed on says nothing about these.
    else { use.own = undefined; use.loadProblem = ''; }
    if (use.own === undefined) { await restorePlaceholders(); return { ready: false, problem: '' }; }
    const ready = await activate();
    return { ready, problem: ready ? '' : use.loadProblem };
  };

  const service = createSetupService({ context, path, environment, options: { ...runtimeOptions, checkTimeoutMs, settingsPrepared }, loaded: () => use, turn,
    saved: async result => { await afterSave(result); } });
  const registrations = [];
  const registration = await context.command.transform(editor => {
    editor.add({ name: 'pr-setup', description: SETUP_DESCRIPTION, async execute(event) {
      if (event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length) throw new Error('[AZPR] Setup accepts literal options only.');
      const session = typeof context.session?.get === 'function' ? recordOf(await context.session.get({ sessionID: event.sessionID })) : null;
      if (privateAgent(session?.agent)) throw new Error('[AZPR] Private reviewers cannot configure AZPR.');
      // Where the commands that say what is missing could not be registered earlier, they are now. Not while a
      // load is under way: it sees to them itself when it ends, and this command does not wait for it.
      if (!activating) await restorePlaceholders();
      let text, metadata;
      try {
        const arguments_ = parseSetupArguments(event.prompt.text ?? '');
        if (arguments_ === null) {
          // Settings of 0.4.x that can be updated: what the update changes, and the word that confirms it.
          const offered = await readExisting(path).then(previous => typeof previous === 'string' ? migrationOf(previous) : null, () => null);
          text = await guide(context, path, use.blocked ? use.problem : '', environment, offered ?? undefined);
          // /pr-setup alone: the terminal UI opens its dialogs when it sees this notice. --help only explains.
          if (!(event.prompt.text ?? '').trim()) metadata = { azpr: { setup: true } };
        } else {
          if (turn.busy) throw new Error('[AZPR] Another setup is active.');
          turn.busy = true;
          let saved, after = { ready: false, problem: '' };
          const wasBlocked = use.blocked;
          try {
            saved = await saveSetup(context, path, arguments_, environment);
            if (wasBlocked) after = await afterSave({ made: saved.unusable, before: saved.before, after: saved.after });
          } finally { turn.busy = false; }
          // An updated file that had a fault before still has it: say what, and where it is set.
          text = saved.migrated && saved.remaining
            ? `[AZPR] SETTINGS UPDATED\nSettings: ${path}\nThe settings file now has the layout of this version, and still cannot be used: ${saved.remaining} Set that right with /pr-setup (in the terminal UI it asks in dialogs; --help shows the options) or in the settings file. No model or Azure request was made.`
            : `[AZPR] SETTINGS ${saved.migrated ? 'UPDATED' : 'SAVED'}\nSettings: ${path}\n` +
            (saved.migrated ? 'The settings file now has the layout of this version; /pr-setup shows and changes the models of each mode.\n' : '') +
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
    // A plugin may have taken a review command's name since the catalog was read above: that name stays its own.
    if (use.blocked) await restorePlaceholders();
    else cleanup = await load();
  }
  catch (error) { await Promise.allSettled(registrations.map(item => item.dispose())); throw error; }
  return async () => {
    closed = true;
    await activating?.catch(() => {});
    await lane;
    await cleanup?.();
    await placeholders?.dispose();
    await Promise.allSettled(registrations.reverse().map(item => item.dispose()));
  };
}
