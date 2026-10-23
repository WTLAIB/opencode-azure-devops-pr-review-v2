/** Native package bootstrap. Configuration lives outside the package cache. */
import { constants } from 'node:fs';
import { open, readFile, lstat, mkdir, link, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { COMMANDS, modelRef, privateAgent, validateSettings } from './config.mjs';
import { parseUniqueJSON } from './output.mjs';
import { appendReport } from './session.mjs';
import { listOf, recordOf, requireMethods } from './host.mjs';
import { readPatFile, setupAzurePrReview } from './runtime.mjs';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SETUP_DESCRIPTION = 'Configure AZPR with one model and an existing PAT file; no model or Azure calls';
const USAGE = '/pr-setup --organization ORG --model PROVIDER/MODEL --pat-file "/absolute/path/to/pat"';
const MAX_SETTINGS_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  const root = environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), '.config');
  if (!isAbsolute(root)) throw new Error('[AZPR] XDG_CONFIG_HOME must be an absolute path.');
  return join(root, 'azpr', 'settings.json');
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
    if (!['--organization', '--model', '--pat-file', '--replace'].includes(flag) || Object.hasOwn(result, flag)) {
      throw new Error('[AZPR] Unknown or repeated setup option. Use /pr-setup --help. Never put the PAT itself in a command.');
    }
    if (flag === '--replace') result[flag] = true;
    else {
      if (!tokens[index + 1] || tokens[index + 1].startsWith('--')) throw new Error('[AZPR] A setup option needs a value. Use /pr-setup --help.');
      result[flag] = tokens[++index];
    }
  }
  if (['--organization', '--model', '--pat-file'].some(flag => !result[flag])) {
    throw new Error('[AZPR] Supply --organization, --model and --pat-file together. Use /pr-setup --help.');
  }
  return result;
}

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
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
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

/** Atomic, owner-only save; serialize setup calls and preserve unrelated values. */
export async function saveSetup(context, path, arguments_) {
  const previous = await readExisting(path);
  if (previous !== null && !arguments_['--replace']) {
    throw new Error('[AZPR] Settings already exist. Add --replace to change organization, PAT file and all review/quick model slots while keeping other settings.');
  }
  const raw = previous === null ? { version: 2 } : settingsJSON(previous);
  if (raw.version !== 2) throw new Error('[AZPR] Setup supports only version-2 settings; existing data was preserved.');
  if (raw.models !== undefined && !object(raw.models) || raw.azure !== undefined && !object(raw.azure)) {
    throw new Error('[AZPR] Repair models and azure objects in settings.json before setup; existing data was preserved.');
  }
  const model = arguments_['--model'];
  const patFile = arguments_['--pat-file'];
  if (typeof patFile !== 'string' || !isAbsolute(patFile) || resolve(patFile) === resolve(path)) {
    throw new Error('[AZPR] --pat-file must name an absolute path separate from settings.json.');
  }
  const next = { ...raw, models: { ...raw.models,
    review: { functional: model, risk: model, verifier: model }, quick: { reviewer: model } },
    azure: { ...raw.azure, organization: arguments_['--organization'], pat: '', patFile } };
  validateSettings(next);
  await checkModel(context, model);
  await readPatFile(patFile);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o022) || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) {
    throw new Error('[AZPR] The settings directory must be a directory owned by you, not a symbolic link or writable by other users.');
  }
  const lock = `${path}.setup.lock`, temporary = `${path}.${randomUUID()}.tmp`;
  let handle, acquired = false;
  try {
    try { handle = await open(lock, 'wx', 0o600); acquired = true; }
    catch (error) { if (error.code === 'EEXIST') throw new Error('[AZPR] Another setup is active, or a previous setup lock remains. No settings changed.'); throw error; }
    if (await readExisting(path) !== previous) throw new Error('[AZPR] Settings changed during setup; retry after reviewing the file.');
    await writeTemporary(temporary, JSON.stringify(next, null, 2) + '\n');
    if (previous === null) await link(temporary, path); // Refuse a concurrent creator rather than overwriting it.
    else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await handle?.close();
    if (acquired) await unlink(lock);
  }
}

async function writeTemporary(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

async function guide(context, path, problem) {
  let catalog = [];
  try { catalog = (listOf(await context.model.list()) ?? []).filter(item => item.enabled !== false && item.capabilities?.tools === true); } catch { /* Help remains usable before provider setup. */ }
  const models = catalog.slice(0, 12).map(item => `${item.providerID}/${item.id}`);
  return `[AZPR] SETUP${problem ? ' REQUIRED' : ''}\nSettings: ${path}\n${problem ? `Problem when OpenCode loaded AZPR: ${problem}\n` : ''}\n` +
    `1. Connect your provider in OpenCode and choose one tool-capable model ID (${models.length ? models.join(', ') : 'run opencode models'}).\n` +
    '2. Create an Azure DevOps PAT for one organization with Code (Read) and Pull Request Threads (Read & write). Keep it alone in an existing regular file owned by you, with mode 600; never paste it into this conversation.\n' +
    `3. Run ${USAGE}\n\n` +
    'The selected model fills the three review roles and the quick reviewer. Deep remains unchanged (off for a new profile). Existing settings require --replace; other settings are kept. No model request or Azure request is made.\n' +
    'After saving, restart OpenCode and run /pr-check <PR URL>. Settings changes do not affect reviews already running.';
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

/** Missing/invalid settings expose only setup and blocked command explanations, with the reason. */
export async function setupPlugin(context, sourceDirectory = SOURCE_DIRECTORY, testOptions = {}) {
  const path = await settingsFileFor(context.options ?? {}, sourceDirectory);
  const { problem, disabled } = await settingsProblem(path);
  const blocked = Boolean(problem);
  if (disabled) return async () => {};
  requireMethods(context, ['command.list', 'command.transform'], 'AZPR setup');
  const catalog = listOf(await context.command.list());
  if (!catalog) throw new Error('[AZPR] Invalid OpenCode command catalog.');
  const reserved = ['pr-setup', ...(blocked ? Object.keys(COMMANDS) : [])];
  if (catalog.some(command => reserved.includes(command.name))) throw new Error('[AZPR] Reserved command name conflict; resolve it before loading AZPR.');
  let pending = false;
  const registration = await context.command.transform(editor => {
    editor.add({ name: 'pr-setup', description: SETUP_DESCRIPTION, async execute(event) {
      if (event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length) throw new Error('[AZPR] Setup accepts literal options only.');
      const session = typeof context.session?.get === 'function' ? recordOf(await context.session.get({ sessionID: event.sessionID })) : null;
      if (privateAgent(session?.agent)) throw new Error('[AZPR] Private reviewers cannot configure AZPR.');
      let text;
      try {
        const arguments_ = parseSetupArguments(event.prompt.text ?? '');
        if (arguments_ === null) text = await guide(context, path, problem);
        else {
          if (pending) throw new Error('[AZPR] Another setup is active.');
          pending = true;
          try { await saveSetup(context, path, arguments_); } finally { pending = false; }
          text = `[AZPR] SETTINGS SAVED\nSettings: ${path}\nRestart OpenCode, then run /pr-check <PR URL>. No model or Azure request was made. Existing reviews keep their original settings.`;
        }
      } catch (error) {
        // OS errors may include file contents only through custom providers; report codes, not arbitrary text.
        text = typeof error.message === 'string' && error.message.startsWith('[AZPR]') ? error.message : '[AZPR] Setup could not save settings. Check the model ID, organization, PAT file and local file permissions; existing settings were preserved.';
      }
      await appendReport(context, { sessionID: event.sessionID, text });
    } });
    if (blocked) for (const name of Object.keys(COMMANDS)) editor.add({ name, description: 'AZPR setup required; run /pr-setup', async execute(event) {
      await appendReport(context, { sessionID: event.sessionID,
        text: `[AZPR] SETUP REQUIRED\nNo review or Azure request was started. Settings at ${path} could not be used when OpenCode loaded AZPR: ${problem} Run /pr-setup --help; repair an existing settings file if necessary, then restart OpenCode.` });
    } });
  });
  let cleanup;
  try { if (!blocked) cleanup = await setupAzurePrReview(context, sourceDirectory, { ...testOptions, settingsPath: path }); }
  catch (error) { await registration.dispose(); throw error; }
  return async () => { await cleanup?.(); await registration.dispose(); };
}
