import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, readdir, cp, utimes } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMissingSettings, defaultPatFile, settingsFileFor, parseSetupArguments, saveSetup, setupPlugin } from '../src/setup.mjs';
import { AFTER_REVIEW, COMMANDS, SETTING_DEFAULTS, TERMINAL_PANEL, settingsText, validateSettings, withMissingSettings } from '../src/config.mjs';
import { AZURE_HEADERS, FAKE_PAT, azureError, fakeAzure, toolRegistry } from './fake-azure.mjs';
import { SETUP_RPC, createSetup } from '../src/tui-setup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'azpr-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'package'), path = join(root, 'private config', 'settings.json'), pat = join(root, 'pat file');
  await mkdir(source);
  await cp(new URL('../src/prompts', import.meta.url), join(source, 'prompts'), { recursive: true });
  await writeFile(pat, FAKE_PAT, { mode: 0o600 });
  const commands = new Map(), agents = new Map(), reports = [], notices = [], hooks = [];
  // The RPC the terminal UI's dialogs call: the handlers of the newest registration that was not disposed.
  const rpc = { definition: null, handlers: null, events: [] };
  const azure = fakeAzure({ org: 'fixture' });
  const tools = toolRegistry();
  const registration = () => ({ dispose() {} });
  const context = {
    options: { settingsFile: path },
    location: { directory: root },
    model: { list: async () => ({ data: [{ providerID: 'fixture', id: 'model', enabled: true, capabilities: { tools: true }, variants: [{ id: 'high' }] }] }) },
    command: {
      list: async () => ({ data: [...commands.values()] }),
      // Like the host: adding a command replaces the one that has its name, and a disposed transform takes
      // with it what it added, not what replaced that since.
      transform: async callback => {
        const added = [];
        callback({ add(command) { commands.set(command.name, command); added.push(command); } });
        return { dispose() { for (const command of added) if (commands.get(command.name) === command) commands.delete(command.name); } };
      },
    },
    agent: {
      get: async ({ agentID }) => ({ data: agents.get(agentID) }),
      // Like the host, a disposed transform takes what it added with it.
      transform: async callback => { const added = []; callback({ get: id => agents.get(id), update(id, mutate) {
        const agent = { id, permissions: [] }; mutate(agent); agents.set(id, agent); added.push(id);
      } }); return { dispose() { added.forEach(id => agents.delete(id)); } }; },
    },
    session: {
      get: async () => ({ data: { agent: 'build' } }),
      create: async () => { throw new Error('Setup must not create model sessions.'); },
      prompt: async () => { throw new Error('Setup must not prompt a model.'); },
      wait: async () => {}, context: async () => [], interrupt: async () => ({ interrupted: false }),
      hook: async (name, callback) => { hooks.push({ name, callback }); return registration(); },
      synthetic: async input => {
        reports.push(input.text);
        notices.push({ text: input.text, metadata: input.metadata });
        return { id: `notice-${reports.length}`, sessionID: input.sessionID, type: 'synthetic', delivery: input.delivery, payload: { text: input.text } };
      },
    },
    tool: { hook: async () => registration(), list: tools.list, transform: tools.transform },
    rpc: { register: async (definition, handlers) => { Object.assign(rpc, { definition, handlers });
      return { events: { emit: async (name, data) => { rpc.events.push([name, data]); } }, dispose() { if (rpc.handlers === handlers) rpc.handlers = null; } }; } },
  };
  const args = parseSetupArguments(`--organization fixture --model fixture/model --pat-file "${pat}"`);
  const options = { stateDirectory: join(root, 'state'), fetch: azure.fetch };
  return { root, source, path, pat, context, commands, agents, reports, notices, hooks, azure, args, rpc,
    setup: (extra = {}) => setupPlugin(context, source, { ...options, ...extra }),
    invoke: async (name, text = '') => {
      await commands.get(name).execute({ sessionID: 'origin', prompt: { text } });
      return reports.at(-1);
    },
  };
}

test('native settings stay outside packages; explicit and legacy settings take precedence', async t => {
  const f = await fixture(t), env = { HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'xdg') };
  assert.equal(await settingsFileFor({}, f.source, env), join(env.XDG_CONFIG_HOME, 'azpr/settings.json'));
  assert.equal(await settingsFileFor({}, f.source, { HOME: f.root }), join(f.root, '.config/azpr/settings.json'));
  await writeFile(join(f.source, 'settings.json'), '{}');
  assert.equal(await settingsFileFor({}, f.source, env), join(f.source, 'settings.json'));
  assert.equal(await settingsFileFor({ settingsFile: f.path }, f.source, env), f.path);
  for (const options of [{ settingsFile: 'relative.json' }, { settingsFile: null }, { unknown: true }, []]) {
    await assert.rejects(settingsFileFor(options, f.source, env), /options|absolute path/);
  }
});

test('setup parser accepts quoted paths, help and explicit replace but no token option', () => {
  assert.equal(parseSetupArguments(''), null);
  assert.equal(parseSetupArguments('--help'), null);
  assert.equal(parseSetupArguments('-h'), null);
  assert.deepEqual(parseSetupArguments('--organization example --model fixture/model#high --pat-file "/path with spaces/pat" --replace'), {
    '--organization': 'example', '--model': 'fixture/model#high', '--pat-file': '/path with spaces/pat', '--replace': true,
  });
  assert.deepEqual(parseSetupArguments('--organization https://dev.azure.com/org/project/_git/repo/pullrequest/1 --model fixture/model'), {
    '--organization': 'https://dev.azure.com/org/project/_git/repo/pullrequest/1', '--model': 'fixture/model',
  });
  for (const input of ['--pat do-not-display-secret', '--organization org', '--model fixture/model --pat-file /pat', '--model a/b --model c/d', '--pat-file "unfinished']) {
    assert.throws(() => parseSetupArguments(input), error => !error.message.includes('do-not-display-secret'));
  }
});

test('without --pat-file setup uses the default PAT file, or keeps the one already set; --organization takes a URL', async t => {
  const f = await fixture(t);
  const environment = { HOME: join(f.root, 'home'), XDG_CONFIG_HOME: join(f.root, 'xdg') };
  const defaultPat = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat');
  assert.equal(defaultPatFile(environment), defaultPat);
  assert.equal(defaultPatFile({ HOME: environment.HOME }), join(environment.HOME, '.config', 'azpr', 'pat'));
  const minimal = { '--organization': 'fixture', '--model': 'fixture/model' };
  await assert.rejects(saveSetup(f.context, f.path, minimal, environment),
    error => error.message.startsWith(`[AZPR] No --pat-file was given, and the default PAT file ${defaultPat} could not be used (not found).`) && error.message.includes('quickstart'));
  await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  await mkdir(join(environment.XDG_CONFIG_HOME, 'azpr'), { recursive: true, mode: 0o700 });
  await writeFile(defaultPat, FAKE_PAT, { mode: 0o600 });
  t.after(await f.setup({ environment }));
  const receipt = await f.invoke('pr-setup', '--organization https://dev.azure.com/fixture/project/_git/repo/pullrequest/1 --model fixture/model');
  // A first setup is loaded at once: nothing was in use before it.
  assert.equal(receipt, `[AZPR] SETTINGS SAVED\nSettings: ${f.path}\nOrganization: fixture; PAT file: ${defaultPat}\n` +
    'AZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.');
  assert.match(await f.invoke('pr-setup', '--help'), new RegExp(`by default ${defaultPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  const saved = async () => { const { organization, pat, patFile } = JSON.parse(await readFile(f.path, 'utf8')).azure; return { organization, pat, patFile }; };
  assert.deepEqual(await saved(), { organization: 'fixture', pat: '', patFile: defaultPat });
  await saveSetup(f.context, f.path, { ...minimal, '--organization': 'https://Fixture-2.visualstudio.com/DefaultCollection/project', '--pat-file': f.pat, '--replace': true }, environment);
  assert.deepEqual(await saved(), { organization: 'fixture-2', pat: '', patFile: f.pat }, 'Host names are case-insensitive; URL parsing lowercases them.');
  await saveSetup(f.context, f.path, { ...minimal, '--organization': 'https://dev.azure.com/changed/', '--replace': true }, environment);
  assert.deepEqual(await saved(), { organization: 'changed', pat: '', patFile: f.pat }, 'A replacement keeps the PAT file already set.');
  await chmod(f.pat, 0o644);
  await assert.rejects(saveSetup(f.context, f.path, { ...minimal, '--replace': true }, environment),
    new RegExp(`the PAT file in the current settings ${f.pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be used \\(group or others may access it`));
  await chmod(f.pat, 0o600);
  const before = await readFile(f.path, 'utf8');
  for (const organization of ['http://dev.azure.com/fixture', 'https://user:secret@dev.azure.com/fixture', 'https://example.com/fixture', 'https://dev.azure.com/', 'dev.azure.com/fixture']) {
    await assert.rejects(saveSetup(f.context, f.path, { ...minimal, '--organization': organization, '--replace': true }, environment),
      error => !error.message.includes('secret'), organization);
  }
  assert.equal(await readFile(f.path, 'utf8'), before, 'A refused organization changes nothing.');
});

test('missing settings expose setup and blocked commands, without agents, tools or network calls', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  assert.deepEqual([...f.commands.keys()], ['pr-setup', ...Object.keys(COMMANDS)]);
  assert.equal(f.agents.size, 0);
  assert.equal(f.hooks.length, 0);
  assert.deepEqual(await f.context.tool.list(), []);
  assert.match(await f.invoke('pr-setup', '--help'), /fixture\/model[\s\S]*mode 600[\s\S]*--pat-file/);
  assert.match(await f.invoke('pr-check', 'https://example.invalid'), /SETUP REQUIRED/);
  assert.equal(f.azure.state.calls.length, 0);
  assert.deepEqual(await readdir(f.source), ['prompts']);
});

test('setup writes private external settings, uses one model and loads a first setup at once', async t => {
  const f = await fixture(t);
  const cleanup = await f.setup();
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model#high --pat-file "${f.pat}"`), /SETTINGS SAVED/);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved.models, { review: { functional: 'fixture/model#high', risk: 'fixture/model#high', verifier: 'fixture/model#high', rater: '' },
    quick: { reviewer: 'fixture/model#high' }, deep: { functional: '', risk: '', verifier: '', rater: '' } });
  // The file names every setting, so that each can be found and changed there.
  assert.deepEqual(withMissingSettings(saved).added, []);
  assert.equal(saved.terminalPanel, 'auto');
  assert.deepEqual(saved.afterReview, { quick: 'preview', review: 'preview', deep: 'preview' });
  assert.equal(saved.azure.pat, '');
  assert.equal(saved.azure.patFile, f.pat);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.root, 'private config'))).mode & 0o777, 0o700);
  // Nothing was loaded before, so the settings are read now, once: the commands are the real ones, without a restart.
  assert.ok(f.agents.has('azpr-review-functional'), 'The first setup loaded the runtime.');
  assert.deepEqual([...f.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());
  await assert.rejects(f.invoke('pr-review', 'a URL'), /absolute HTTPS Azure DevOps PR URL/, 'The review command itself answers.');
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  // A second setup changes settings that are in use: it waits for a restart, as before.
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`),
    /^\[AZPR\] SETTINGS SAVED\n[\s\S]*\nTo load them, restart the OpenCode service /);
  await cleanup();
  assert.equal(f.commands.size, 0, 'Unloading removes every command, also those the first setup brought.');
  t.after(await f.setup());
  assert.ok(f.agents.has('azpr-review-functional'));
  assert.ok(f.agents.has('azpr-quick-reviewer'));
  assert.ok(f.hooks.some(hook => hook.name === 'model.request'), 'The original private grant and compaction guards still load.');
  assert.deepEqual(await readdir(f.source), ['prompts']);
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});

test('replacement is explicit and preserves deep, proxy, workflow and disabled intent', async t => {
  const f = await fixture(t);
  await saveSetup(f.context, f.path, f.args);
  const raw = JSON.parse(await readFile(f.path, 'utf8'));
  Object.assign(raw, { enabled: false, outputLanguage: 'zh-TW', workflow: { parallelSessions: 2 }, debug: { enabled: true, directory: 'private-debug' } });
  raw.models.deep = { functional: 'fixture/deep', risk: 'fixture/deep', verifier: 'fixture/deep' };
  raw.azure.proxy = 'http://user:secret@example.invalid:8080';
  await writeFile(f.path, JSON.stringify(raw));
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(saveSetup(f.context, f.path, f.args), /--replace/);
  assert.equal(await readFile(f.path, 'utf8'), before);
  await saveSetup(f.context, f.path, { ...f.args, '--replace': true, '--organization': 'changed' });
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  // What the file left out is added at its default; nothing that was there changes.
  assert.deepEqual(saved, { ...raw, azure: { ...raw.azure, organization: 'changed' },
    models: { ...raw.models, deep: { ...raw.models.deep, rater: '' } },
    workflow: { parallelSessions: 2, shardFiles: 25, shardFindings: 15, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 },
    debug: { enabled: true, directory: 'private-debug', keepRuns: 20 } });
  t.after(await f.setup());
  assert.equal(f.commands.size, 0, 'enabled:false registers nothing.');
});

test('invalid JSON and unknown settings are never silently replaced or leaked', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'));
  for (const content of ['{"pat":"PRIVATE_TOKEN",}', '{"version":2,"version":2}', JSON.stringify({ version: 2, unknown: 'PRIVATE_TOKEN' })]) {
    await writeFile(f.path, content);
    await assert.rejects(saveSetup(f.context, f.path, { ...f.args, '--replace': true }), error => !error.message.includes('PRIVATE_TOKEN'));
    assert.equal(await readFile(f.path, 'utf8'), content);
  }
  t.after(await f.setup());
  assert.match(await f.invoke('pr-review'), /SETUP REQUIRED/);
  assert.equal(f.agents.size, 0);
});

test('model availability, tool capability and variant errors leave no settings file', async t => {
  for (const models of [[], [{ providerID: 'fixture', id: 'model', enabled: false, capabilities: { tools: true } }], [{ providerID: 'fixture', id: 'model', enabled: true, capabilities: { tools: false } }]]) {
    const f = await fixture(t);
    f.context.model.list = async () => models;
    await assert.rejects(saveSetup(f.context, f.path, f.args), /unavailable|support tools/);
    await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  }
  const f = await fixture(t);
  await assert.rejects(saveSetup(f.context, f.path, { ...f.args, '--model': 'fixture/model#missing' }), /variant/);
  await saveSetup(f.context, f.path, { ...f.args, '--model': 'fixture/model#default' });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).models.quick.reviewer, 'fixture/model#default');
});

test('setup refuses unsafe PAT, symlinked settings, writable directories and locks without touching targets', async t => {
  const f = await fixture(t);
  await chmod(f.pat, 0o644);
  await assert.rejects(saveSetup(f.context, f.path, f.args), /chmod 600/);
  await chmod(f.pat, 0o600);
  await mkdir(join(f.root, 'private config'));
  await symlink(f.pat, f.path);
  await assert.rejects(saveSetup(f.context, f.path, { ...f.args, '--replace': true }), /symbolic link/);
  assert.equal(await readFile(f.pat, 'utf8'), FAKE_PAT);
  await unlinkForTest(f.path);
  await chmod(join(f.root, 'private config'), 0o777);
  await assert.rejects(saveSetup(f.context, f.path, f.args), /writable by other users/);
  await chmod(join(f.root, 'private config'), 0o700);
  await writeFile(`${f.path}.setup.lock`, 'existing');
  await assert.rejects(saveSetup(f.context, f.path, f.args), /Another setup is active, or its lock was left behind \(if none is running, delete settings\.json\.setup\.lock beside the settings file\)\. No settings changed\./);
  assert.equal(await readFile(`${f.path}.setup.lock`, 'utf8'), 'existing');
});

async function unlinkForTest(path) { await rm(path); }

test('private reviewers and reserved command conflicts cannot use setup', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  f.context.session.get = async () => ({ data: { agent: 'azpr-review-functional' } });
  await assert.rejects(f.invoke('pr-setup', '--help'), /Private reviewers/);
  const g = await fixture(t), original = { name: 'pr-setup' };
  g.commands.set('pr-setup', original);
  await assert.rejects(g.setup(), /Reserved command name conflict/);
  assert.equal(g.commands.get('pr-setup'), original);
});

// What 0.4.1's /pr-setup wrote: the settings it asked for and nothing else.
const minimalSettings = f => ({ version: 2, models: { review: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/model' }, quick: { reviewer: 'fixture/model' } },
  azure: { organization: 'fixture', pat: '', patFile: f.pat } });
const checkReport = async f => {
  const before = f.reports.length;
  await f.invoke('pr-check', f.azure.prUrl());
  for (let count = 0; count < 400 && !f.reports.slice(before).some(report => /\] (READY|NOT_READY|INCOMPLETE)/.test(report)); count++) await new Promise(resolve => setTimeout(resolve, 5));
  return f.reports.slice(before).find(report => /\] (READY|NOT_READY|INCOMPLETE)/.test(report)) ?? f.reports.slice(before).join('\n');
};

test('loading AZPR writes the settings a file leaves out into it, at their defaults, and runs start as before', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const raw = { ...minimalSettings(f), outputLanguage: 'zh-TW', workflow: { parallelSessions: 2 }, afterReview: { review: 'none' } };
  // As a person keeps it: their own indentation, and a mode other users can read.
  await writeFile(f.path, JSON.stringify(raw, null, 4), { mode: 0o644 });
  t.after(await f.setup());
  const text = await readFile(f.path, 'utf8'), saved = JSON.parse(text);
  assert.deepEqual(saved, withMissingSettings(raw).settings);
  assert.deepEqual(withMissingSettings(saved).added, [], 'Nothing is left out any more.');
  assert.equal(saved.terminalPanel, 'auto');
  assert.deepEqual([saved.outputLanguage, saved.workflow.parallelSessions, saved.workflow.shardFiles, saved.afterReview], ['zh-TW', 2, 25, { review: 'none', quick: 'preview', deep: 'preview' }],
    'Values that were there stay; the rest of their group is added.');
  assert.deepEqual(Object.keys(saved).slice(0, 6), ['version', 'models', 'azure', 'outputLanguage', 'workflow', 'afterReview'], 'Existing names keep their place.');
  assert.deepEqual(validateSettings(saved), validateSettings(raw), 'The completed file behaves as the file did.');
  assert.equal(text, JSON.stringify(saved, null, 2) + '\n');
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600, 'The settings may hold a PAT: the new file is the owner\'s alone.');
  assert.deepEqual(await readdir(join(f.root, 'private config')), ['settings.json'], 'No lock or temporary file stays behind.');
  // The runtime read the completed file: a command is not refused over a file "changed since OpenCode loaded it".
  const report = await checkReport(f);
  assert.match(report, /\] READY/, report);
  assert.match(report, /\| Settings \| ok \| 23 setting\(s\) the settings file left out were added to it when AZPR loaded, at their defaults: models\.review\.rater, models\.deep, enabled, returnReport, debug, runTimeoutSeconds, shell, progressNotices and 15 more\. \|/);
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});

test('a completed settings file is left alone: the next load writes nothing and /pr-check has no row about it', async t => {
  const f = await fixture(t);
  await saveSetup(f.context, f.path, f.args);
  const before = await readFile(f.path, 'utf8'), stamp = (await lstat(f.path)).ino;
  t.after(await f.setup());
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await lstat(f.path)).ino, stamp, 'The file was not replaced.');
  assert.deepEqual(await addMissingSettings(f.path), { added: [] });
  assert.doesNotMatch(await checkReport(f), /\| Settings \|/);
});

test('a settings file that is off, unusable or not safely replaceable is never rewritten', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  // Disabled: AZPR does nothing, also not to the file.
  const disabled = JSON.stringify({ ...minimalSettings(f), enabled: false });
  await writeFile(f.path, disabled, { mode: 0o600 });
  await (await f.setup())();
  assert.equal(await readFile(f.path, 'utf8'), disabled);
  // Not usable: the person repairs it; nothing is added around the problem.
  for (const broken of [JSON.stringify({ ...minimalSettings(f), shel: 'ask' }), '{"version": 2, "version": 2}', 'not JSON']) {
    await writeFile(f.path, broken);
    await (await f.setup())();
    assert.equal(await readFile(f.path, 'utf8'), broken);
    assert.deepEqual(await addMissingSettings(f.path), { added: [] }, 'Called by itself it changes no such file either.');
  }
  assert.deepEqual(await addMissingSettings(join(f.root, 'private config', 'absent.json')), { added: [] }, 'A file that is not there is not created.');
  // A symbolic link is never replaced by a regular file; the runtime reads through it as before, and /pr-check says what is missing.
  const real = join(f.root, 'dotfiles.json'), minimal = JSON.stringify(minimalSettings(f));
  await writeFile(real, minimal, { mode: 0o600 });
  await rm(f.path);
  await symlink(real, f.path);
  t.after(await f.setup());
  assert.equal(await readFile(real, 'utf8'), minimal);
  assert.ok((await lstat(f.path)).isSymbolicLink());
  const report = await checkReport(f);
  assert.match(report, /\] READY/, report);
  assert.match(report, /\| Settings \| WARNING \| 19 setting\(s\) are not in the settings file and could not be added to it: Setup refuses a symbolic link for settings\.json\. Their defaults apply: models\.review\.rater, models\.deep, enabled, returnReport and 15 more\. \|/);
});

test('a settings file another writer holds: the load waits for it, then uses the file as it is', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const minimal = JSON.stringify(minimalSettings(f));
  await writeFile(f.path, minimal, { mode: 0o600 });
  // A lock that stays (a setup that was killed): nothing is written, and the reason names no value.
  await writeFile(`${f.path}.setup.lock`, '');
  const started = Date.now();
  const held = await addMissingSettings(f.path, { waitMs: 150, pauseMs: 20 });
  assert.ok(Date.now() - started >= 150, 'It waited for the other writer.');
  assert.equal(held.added.length, 0);
  assert.equal(held.missing.length, 19);
  assert.equal(held.problem, 'Another setup is active, or its lock was left behind (if none is running, delete settings.json.setup.lock beside the settings file). No settings changed.');
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  // A lock left behind long ago has no writer to wait for: the load goes on at once.
  const longAgo = new Date(Date.now() - 120000);
  await utimes(`${f.path}.setup.lock`, longAgo, longAgo);
  const startedOld = Date.now();
  const old = await addMissingSettings(f.path, { waitMs: 5000, pauseMs: 20 });
  assert.ok(Date.now() - startedOld < 2000, 'Nothing waits for a lock that no one will release.');
  assert.deepEqual([old.added.length, old.missing.length, old.problem], [0, 19, held.problem]);
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  await writeFile(`${f.path}.setup.lock`, '');
  // A lock that goes away: the file is completed after it.
  setTimeout(() => rm(`${f.path}.setup.lock`), 60);
  const after = await addMissingSettings(f.path, { waitMs: 3000, pauseMs: 20 });
  assert.equal(after.added.length, 19);
  assert.deepEqual(withMissingSettings(JSON.parse(await readFile(f.path, 'utf8'))).added, []);
  // A directory other users can write to is no place to replace a file in.
  await writeFile(f.path, minimal, { mode: 0o600 });
  await chmod(join(f.root, 'private config'), 0o777);
  const unsafe = await addMissingSettings(f.path);
  assert.equal(unsafe.problem, 'The settings directory must be a directory owned by you, not a symbolic link or writable by other users.');
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  await chmod(join(f.root, 'private config'), 0o700);
  // A file with a second name elsewhere is not replaced either.
  const { link } = await import('node:fs/promises');
  await link(f.path, join(f.root, 'second name'));
  assert.match((await addMissingSettings(f.path)).problem, /^Setup requires a regular settings file owned by you, without hard links\.$/);
  assert.equal(await readFile(f.path, 'utf8'), minimal);
});

test('what a person saves while the settings file is being completed is kept', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const minimal = minimalSettings(f);
  await writeFile(f.path, JSON.stringify(minimal), { mode: 0o600 });
  // The setup lock keeps AZPR's own writers apart, not an editor: this one saves after the completed text
  // was prepared and before it takes the file's place.
  let saves = 0;
  const edited = JSON.stringify({ ...minimal, terminalPanel: 'manual', outputLanguage: 'ja' });
  const result = await addMissingSettings(f.path, { pauseMs: 5, prepared: async () => { if (saves++ === 0) await writeFile(f.path, edited); } });
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual([saved.terminalPanel, saved.outputLanguage], ['manual', 'ja'], 'The person\'s values were not replaced by the defaults.');
  assert.deepEqual(saved, withMissingSettings(JSON.parse(edited)).settings, 'The saved file was then completed in its turn.');
  assert.equal(saves, 2, 'One attempt gave way to the save, the next one completed the saved file.');
  assert.ok(result.added.length > 0 && !result.added.includes('terminalPanel') && !result.added.includes('outputLanguage'));
  assert.deepEqual(await readdir(join(f.root, 'private config')), ['settings.json']);
  // A save on every attempt: the completion gives up after its wait and leaves the last save as it is.
  await writeFile(f.path, JSON.stringify(minimal), { mode: 0o600 });
  let count = 0;
  const busy = await addMissingSettings(f.path, { waitMs: 100, pauseMs: 10, prepared: () => writeFile(f.path, JSON.stringify({ ...minimal, outputLanguage: `x${count++ % 2 ? 'a' : 'b'}` })) });
  assert.equal(busy.added.length, 0);
  assert.equal(busy.problem, 'Settings changed during setup; retry after reviewing the file.');
  assert.match(JSON.parse(await readFile(f.path, 'utf8')).outputLanguage, /^x[ab]$/, 'The file is the editor\'s last save.');
  assert.deepEqual(await readdir(join(f.root, 'private config')), ['settings.json']);
});

test('a settings file switched off while AZPR loads is not rewritten', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const disabled = JSON.stringify({ ...minimalSettings(f), enabled: false });
  await writeFile(f.path, disabled, { mode: 0o600 });
  assert.deepEqual(await addMissingSettings(f.path), { added: [] }, 'Called for a disabled file, the completion writes nothing.');
  assert.equal(await readFile(f.path, 'utf8'), disabled);
  // Enabled when the load looked at it, switched off before the completion could write.
  await writeFile(f.path, JSON.stringify(minimalSettings(f)), { mode: 0o600 });
  let done = false;
  const result = await addMissingSettings(f.path, { pauseMs: 5, prepared: async () => { if (!done) { done = true; await writeFile(f.path, disabled); } } });
  assert.deepEqual(result, { added: [] });
  assert.equal(await readFile(f.path, 'utf8'), disabled, 'The file its user switched off stays as they saved it.');
});

test('a load that stopped waiting for another writer accepts the completed file later; a person\'s change still blocks', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const minimal = JSON.stringify(minimalSettings(f));
  await writeFile(f.path, minimal, { mode: 0o600 });
  // Another load holds the lock while this one loads: it reads the file as it is.
  await writeFile(`${f.path}.setup.lock`, '');
  t.after(await f.setup({ settingsWaitMs: 60 }));
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  const waiting = await checkReport(f);
  assert.match(waiting, /\] READY/, waiting);
  assert.match(waiting, /\| Settings \| WARNING \| 19 setting\(s\) are not in the settings file and could not be added to it: Another setup is active, or its lock was left behind \(if none is running, delete settings\.json\.setup\.lock beside the settings file\)\. No settings changed\. Their defaults apply: models\.review\.rater, models\.deep and 17 more\. \|/);
  // The other load finishes: the file now has the same settings with their defaults written in.
  await writeFile(f.path, settingsText(withMissingSettings(JSON.parse(minimal)).settings), { mode: 0o600 });
  await rm(`${f.path}.setup.lock`);
  assert.equal((await f.rpc.handlers.status({})).state, 'ready', 'Setup says what the preflight will: defaults another load wrote in are no change.');
  const completed = await checkReport(f);
  assert.match(completed, /\] READY/, 'The completed file is the loaded settings: commands are not refused over it.');
  assert.doesNotMatch(completed, /\| Settings \|/, 'Nothing is missing any more, so nothing is warned about.');
  assert.match(await checkReport(f), /\] READY/, 'And it stays accepted.');
  // A value someone changed is still a changed file.
  const edited = JSON.parse(await readFile(f.path, 'utf8'));
  edited.outputLanguage = 'ja';
  await writeFile(f.path, settingsText(edited));
  await f.invoke('pr-check', f.azure.prUrl());
  for (let count = 0; count < 200 && !f.reports.some(report => report.includes('changed since OpenCode')); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.reports.some(report => report.includes('settings.json changed since OpenCode loaded it')));
  assert.equal((await f.rpc.handlers.status({})).state, 'restart');
  // So is a completed file that also carries another value.
  const g = await fixture(t);
  await mkdir(join(g.root, 'private config'), { mode: 0o700 });
  await writeFile(g.path, minimal.replace(f.pat, g.pat), { mode: 0o600 });
  await writeFile(`${g.path}.setup.lock`, '');
  t.after(await g.setup({ settingsWaitMs: 60 }));
  await writeFile(g.path, settingsText({ ...withMissingSettings(minimalSettings(g)).settings, shell: 'ask' }), { mode: 0o600 });
  await g.invoke('pr-check', g.azure.prUrl());
  for (let count = 0; count < 200 && !g.reports.some(report => report.includes('changed since OpenCode')); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(g.reports.some(report => report.includes('settings.json changed since OpenCode loaded it')), 'Defaults written in are accepted, a changed value with them is not.');
});

test('loads that happen at the same time complete the settings file once and all read the same text', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const minimal = JSON.stringify(minimalSettings(f));
  // Many rounds: a load may open the file just before another one replaces it, and must then read the new file
  // instead of reporting that the settings file is not a regular one.
  for (let round = 0; round < 25; round++) {
    await writeFile(f.path, minimal, { mode: 0o600 });
    // Each reads the file right after its own attempt, as the runtime does.
    const loads = await Promise.all(Array.from({ length: 16 }, async () => {
      const result = await addMissingSettings(f.path, { pauseMs: 2 });
      return { result, text: await readFile(f.path, 'utf8') };
    }));
    const final = await readFile(f.path, 'utf8');
    assert.deepEqual(withMissingSettings(JSON.parse(final)).added, []);
    assert.equal(loads.filter(load => load.result.added.length).length, 1, 'One of them wrote the file.');
    assert.deepEqual(loads.map(load => load.result.problem).filter(Boolean), [], 'None reports a problem for a file another load completed.');
    assert.ok(loads.every(load => load.text === final), 'None read the file before it was complete, so none finds it changed later.');
    assert.deepEqual(await readdir(join(f.root, 'private config')), ['settings.json']);
    assert.equal(SETTING_DEFAULTS.terminalPanel, JSON.parse(final).terminalPanel);
  }
});

test('legacy installed configuration loads without migration and changes still block new runs', async t => {
  const f = await fixture(t);
  f.context.options = {};
  const legacy = join(f.source, 'settings.json');
  await saveSetup(f.context, legacy, f.args);
  const before = await readFile(legacy, 'utf8');
  t.after(await f.setup());
  assert.equal(await readFile(legacy, 'utf8'), before);
  await writeFile(legacy, before + '\n');
  await f.invoke('pr-check', f.azure.prUrl());
  for (let count = 0; count < 100 && !f.reports.some(report => report.includes('changed since OpenCode')); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.reports.some(report => report.includes('changed since OpenCode')));
  assert.equal(f.azure.state.calls.length, 0);
});

test('SETUP REQUIRED and /pr-setup --help name the problem, never a setting value or the PAT', async t => {
  const f = await fixture(t);
  const shown = async () => {
    const cleanup = await f.setup();
    try { return [await f.invoke('pr-review', f.azure.prUrl()), await f.invoke('pr-setup', '--help')]; } finally { await cleanup(); }
  };
  const [blocked, help] = await shown();
  assert.match(blocked, /^\[AZPR\] SETUP REQUIRED\nNo review or Azure request was started\. Settings at .+ could not be used when OpenCode loaded AZPR: there is no settings file yet\. Run \/pr-setup \(in the terminal UI it asks in dialogs; --help shows the options\)/);
  assert.match(help, /^\[AZPR\] SETUP REQUIRED\nSettings: .+\nProblem when OpenCode loaded AZPR: there is no settings file yet\.\n\nIn OpenCode's terminal UI, \/pr-setup alone asks [^\n]+\n\n1\. /);
  await saveSetup(f.context, f.path, f.args);
  const valid = JSON.parse(await readFile(f.path, 'utf8'));
  const cases = [
    ['{"azure":{"pat":"PRIVATE_TOKEN_0123456789abcdef",}', /settings\.json must be a JSON object without duplicate keys; repair it manually before setup\./],
    [JSON.stringify({ ...valid, afterReview: { review: 'PRIVATE_VALUE' } }), /afterReview\.review must be none, preview or publish\./],
    [JSON.stringify({ ...valid, models: { review: { functional: 'PRIVATE_VALUE', risk: 'fixture/model', verifier: 'fixture/model' } } }), /models\.review\.functional: select an actual provider\/model ID/],
    [JSON.stringify({ ...valid, azure: { ...valid.azure, pat: 'PRIVATE_TOKEN_0123456789abcdef' } }), /Set either azure\.pat or azure\.patFile, not both/],
    [JSON.stringify({ ...valid, azure: { ...valid.azure, PRIVATE_TOKEN_0123456789abcdefghijklmnopqrstuvwxyz: '' } }), /Unknown setting in azure \(its name is not shown/],
  ];
  for (const [content, problem] of cases) {
    await writeFile(f.path, content);
    for (const text of await shown()) {
      assert.match(text, problem, content);
      assert.doesNotMatch(text, /PRIVATE_|fixture-pat/, 'No setting value or PAT is shown.');
    }
  }
  await writeFile(f.path, JSON.stringify(valid));
  await chmod(f.pat, 0o644);
  for (const text of await shown()) assert.match(text, /azure\.patFile could not be used \(group or others may access it; run chmod 600 on it\)\./);
  await chmod(f.pat, 0o600);
  await chmod(f.path, 0o000);
  try { for (const text of await shown()) assert.match(text, /the settings file could not be read \(EACCES\)\./); }
  finally { await chmod(f.path, 0o600); }
  const cleanup = await f.setup();
  t.after(cleanup);
  assert.match(await f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP\nSettings: .+\n\nIn OpenCode's terminal UI, [^\n]+\n\n1\. /, 'Usable settings show no problem.');
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});

// ------------------------------------------------------------------ setup from the terminal UI's dialogs
const HOSTED = [{ id: 'fixture/model', name: 'Fixture Model', provider: 'Fixture AI', variants: ['high'] }];
// A certificate that belongs to no key anyone holds: made for these tests, its key was deleted.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBjTCCATOgAwIBAgIUODGvBy+MpkOsObO39fORDml1VdgwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRQVpQUiB1bml0IHRlc3QgQ0EwHhcNMjYxMTE3MTk1MjQ2WhcN
MzYxMTE0MTk1MjQ2WjAcMRowGAYDVQQDDBFBWlBSIHVuaXQgdGVzdCBDQTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABAbmktp+Rt3shLcM6VQnBFDSgjW3xYP2O0Vi
AzBLbuaBZB64TgE9rcyyqCAi+E2+Oqcx/YbT1DvFo+nROYCBWWijUzBRMB0GA1Ud
DgQWBBTauFprFSMPKqz2NKw/2FRTuadAyjAfBgNVHSMEGDAWgBTauFprFSMPKqz2
NKw/2FRTuadAyjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIFdB
lTeL05iydRA8gQYVf/8vUwzX82xWWS2B7vM7itkUAiEAkpqQTIAAqSaRUYRx7QzA
GsMfpygTU5EC3V1Enrw+Nes=
-----END CERTIFICATE-----
`;
const NEW_TOKEN = 'another-valid-token-0123456789abcdefghijklmnop';
/** The terminal part's setup against this fixture's server part: dialogs answer from a list, everything shown is kept. */
function dialogs(f, answers) {
  const shown = [], toasts = [];
  const queue = [...answers];
  const next = (kind, options) => {
    shown.push({ kind, ...options });
    if (!queue.length) throw new Error(`No answer was scripted for the ${kind} "${options.title}".`);
    return queue.shift();
  };
  const setup = createSetup({ call: (method, input) => f.rpc.handlers[method](input),
    dialog: { prompt: async options => next('prompt', options), select: async options => next('select', options), confirm: async options => next('confirm', options), alert: async options => { shown.push({ kind: 'alert', ...options }); } },
    secret: async options => next('secret', options), toast: options => toasts.push(options), models: async () => HOSTED });
  return { setup, shown, toasts, left: () => queue.length, said: () => JSON.stringify([shown, toasts]) };
}
const environmentOf = f => ({ HOME: join(f.root, 'home'), XDG_CONFIG_HOME: join(f.root, 'xdg') });
const mode = async path => (await lstat(path)).mode & 0o777;
const rowsOf = status => Object.fromEntries(status.rows.map(row => [row.id, row]));

test('the dialogs and the server part set AZPR up together: the token is checked, files are owner-only, and AZPR is loaded at once', async t => {
  // The token file is named for its organization: the default PAT file is the same for every settings file a person has.
  const f = await fixture(t), environment = environmentOf(f), tokenFile = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture');
  t.after(await f.setup({ environment }));
  assert.equal(f.rpc.definition, SETUP_RPC);
  const before = await f.rpc.handlers.status({});
  assert.deepEqual([before.version, before.state, before.problem, before.editable, before.settingsFile, before.organization], [1, 'required', 'there is no settings file yet.', true, f.path, '']);
  assert.deepEqual(before.rows.map(row => `${row.group}/${row.id}/${row.kind}`), ['Azure DevOps/organization/text', 'Azure DevOps/token/secret', 'Azure DevOps/proxy/text', 'Azure DevOps/caFile/text',
    'Models/reviewModel/model', 'Models/quickModel/model', 'Models/deepModel/model', 'Reviews/language/choice', 'Reviews/afterReview/choice', 'Reviews/report/choice', 'Reviews/progress/choice',
    'Terminal UI/panel/choice', 'Diagnostics/debug/choice']);
  assert.deepEqual([rowsOf(before).token.saved, rowsOf(before).token.value, rowsOf(before).reviewModel.value, rowsOf(before).language.value, rowsOf(before).afterReview.value], [false, 'not set', 'not set', 'en', 'preview']);
  // A row offers exactly the values its setting accepts, and only posting without a preview is confirmed.
  const offered = id => rowsOf(before)[id].choices.map(choice => choice.value).sort();
  assert.deepEqual([offered('afterReview'), offered('panel'), offered('report'), offered('progress'), offered('debug')], [[...AFTER_REVIEW].sort(), [...TERMINAL_PANEL].sort(), ['full', 'receipt'], ['off', 'on'], ['off', 'on']]);
  assert.deepEqual(before.rows.flatMap(row => (row.choices ?? []).filter(choice => choice.confirm).map(choice => `${row.id}=${choice.value}`)), ['afterReview=publish']);
  assert.ok(!before.rows.some(row => /shell|verifyTls|tls/i.test(row.id)), 'What weakens a review\'s isolation is not offered.');

  const d = dialogs(f, ['https://dev.azure.com/fixture/project/_git/repo/pullrequest/1', '', FAKE_PAT, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  assert.deepEqual(d.shown.map(item => `${item.kind}: ${item.title}`), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token',
    'select: Model for /pr-review', 'select: Variant of fixture/model', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.match(d.shown[2].description, /^Create one at https:\/\/dev\.azure\.com\/fixture\/_usersSettings\/tokens with the scopes Code \(Read\) and Pull Request Threads \(Read & write\)\./);
  assert.match(d.shown.at(-1).message, /^Check access to a pull request, then review it:\n\n\/pr-check <PR URL>/, 'The first setup was loaded: no restart is asked for.');
  // One request asked Azure DevOps whether the token works, before anything was written.
  assert.deepEqual(f.azure.state.calls.map(call => [call.route, call.path, call.query]), [['access', '/fixture/_apis/git/pullrequests', { $top: '1', 'api-version': '7.1' }]]);

  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved.azure, { organization: 'fixture', pat: '', patFile: tokenFile, concurrency: 6, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true });
  assert.deepEqual(saved.models, { review: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/model', rater: '' }, quick: { reviewer: 'fixture/model' }, deep: { functional: '', risk: '', verifier: '', rater: '' } });
  assert.deepEqual(withMissingSettings(saved).added, [], 'The file names every setting.');
  assert.equal(await readFile(tokenFile, 'utf8'), FAKE_PAT, 'The token file holds the token alone.');
  assert.deepEqual([await mode(tokenFile), await mode(f.path), await mode(join(environment.XDG_CONFIG_HOME, 'azpr')), await mode(join(f.root, 'private config'))], [0o600, 0o600, 0o700, 0o700]);
  assert.deepEqual((await readdir(join(environment.XDG_CONFIG_HOME, 'azpr'))), ['pat-fixture'], 'No temporary file is left beside the token.');

  // Nothing was loaded before, so the settings are in use now: the review commands are the real ones, and the
  // server part said so once, for clients that would otherwise keep the commands they knew.
  assert.ok(f.agents.has('azpr-review-functional'));
  assert.deepEqual(f.rpc.events, [['loaded', {}]]);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  const after = await f.rpc.handlers.status({});
  assert.deepEqual([after.state, after.problem, after.organization, rowsOf(after).token.saved, rowsOf(after).token.value, rowsOf(after).reviewModel.value, rowsOf(after).quickModel.value, rowsOf(after).deepModel.value],
    ['ready', '', 'fixture', true, 'saved', 'fixture/model', 'fixture/model', 'off']);
  assert.ok(rowsOf(after).token.description.endsWith(` The saved token is in ${tokenFile}.`), 'The token\'s dialog says where the saved token is.');
  assert.match(after.settingsFileShown, /^…\/private config\/settings\.json$/);
  for (const text of [d.said(), JSON.stringify(f.notices), JSON.stringify(after), await readFile(f.path, 'utf8')]) assert.ok(!text.includes(FAKE_PAT), 'The token is in the token file and nowhere else.');
});

test('the default PAT file is no saved token unless settings name it: the dialogs ask for a token, which gets a file of its own', async t => {
  const f = await fixture(t), environment = environmentOf(f), handMade = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat'), tokenFile = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture');
  // Made by hand before any settings existed, as the quickstart for setup with options has it.
  await mkdir(join(environment.XDG_CONFIG_HOME, 'azpr'), { recursive: true, mode: 0o700 });
  await writeFile(handMade, NEW_TOKEN, { mode: 0o600 });
  t.after(await f.setup({ environment }));
  // No settings name it, so it is no saved token of theirs: every settings file a person has may use that file.
  const before = rowsOf(await f.rpc.handlers.status({})).token;
  assert.deepEqual([before.saved, before.value], [false, 'not set']);
  assert.ok(!before.description.includes(handMade));
  assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'No token is saved for an organization yet.' });
  assert.equal(f.azure.state.calls.length, 0, 'The token in the file was sent nowhere.');
  const d = dialogs(f, ['fixture', '', FAKE_PAT, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  const asked = d.shown.find(item => item.kind === 'secret');
  assert.ok(asked.optional === false && !/Leave it empty/.test(asked.description), 'Keeping a saved token is not offered.');
  assert.deepEqual([await readFile(tokenFile, 'utf8'), await mode(tokenFile), JSON.parse(await readFile(f.path, 'utf8')).azure.patFile], [FAKE_PAT, 0o600, tokenFile]);
  assert.equal(await readFile(handMade, 'utf8'), NEW_TOKEN, 'The file a person made is left as it is: another settings file may name it.');
  assert.deepEqual([rowsOf(await f.rpc.handlers.status({})).token.saved, rowsOf(await f.rpc.handlers.status({})).token.value], [true, 'saved']);
});

test('settings files that share the directory of the default PAT file get a token file each, named for their organization', async t => {
  // Two settings files of one person (plugin options name them), for two organizations; both first setups run.
  const f = await fixture(t), environment = environmentOf(f);
  const g = await fixture(t);
  t.after(await f.setup({ environment }));
  t.after(await g.setup({ environment }));
  const first = await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  const second = await g.rpc.handlers.save({ changes: { organization: 'elsewhere', model: 'fixture/model' }, token: NEW_TOKEN });
  assert.deepEqual([first.ok, second.ok], [true, true]);
  const named = async fixture => { const { organization, patFile } = JSON.parse(await readFile(fixture.path, 'utf8')).azure; return [organization, patFile, await readFile(patFile, 'utf8')]; };
  assert.deepEqual(await named(f), ['fixture', join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture'), FAKE_PAT], 'The second setup did not write the first one\'s token file.');
  assert.deepEqual(await named(g), ['elsewhere', join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-elsewhere'), NEW_TOKEN]);
  assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture' }), { ok: true, organization: 'fixture' }, 'Each still sends its own token to its own organization.');
  assert.deepEqual((await readdir(join(environment.XDG_CONFIG_HOME, 'azpr'))).sort(), ['pat-elsewhere', 'pat-fixture']);

  // A name is no proof of whose file it is. Settings for "fixture" that a person pointed at a file called pat-other:
  const theirs = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-other');
  await writeFile(theirs, FAKE_PAT, { mode: 0o600 });
  const k = await fixture(t);
  await saveSetup(k.context, k.path, parseSetupArguments(`--organization fixture --model fixture/model --pat-file "${theirs}"`), environment);
  // A first setup for the organization "other" makes a file that did not exist, and leaves that one alone.
  const m = await fixture(t);
  t.after(await m.setup({ environment }));
  assert.equal((await m.rpc.handlers.save({ changes: { organization: 'other', model: 'fixture/model' }, token: NEW_TOKEN })).ok, true);
  assert.deepEqual(await named(m), ['other', join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-other-2'), NEW_TOKEN]);
  assert.deepEqual(await named(k), ['fixture', theirs, FAKE_PAT], 'The file other settings name was not written.');
});

test('settings that were written stay written when the cleanup after them fails: the token they name is not taken away', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment }));
  // The temporary file of the settings cannot be removed any more once the settings are in place.
  const unlink = fsPromises.unlink;
  let failed = 0, result;
  fsPromises.unlink = async path => {
    if (/settings\.json\.[0-9a-f-]+\.tmp$/.test(String(path))) { failed++; throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' }); }
    return unlink(path);
  };
  syncBuiltinESMExports();
  try { result = await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT }); }
  finally { fsPromises.unlink = unlink; syncBuiltinESMExports(); }
  assert.equal(failed, 1, 'The cleanup failed after the settings were in place.');
  assert.deepEqual([result.ok, result.status.state], [true, 'ready'], 'What was written is reported as written.');
  const { organization, patFile } = JSON.parse(await readFile(f.path, 'utf8')).azure;
  assert.deepEqual([organization, await readFile(patFile, 'utf8')], ['fixture', FAKE_PAT], 'The token the settings name is where they say.');
  assert.ok(f.agents.has('azpr-review-functional'));
});

test('a token that was replaced stays reported as replaced when the cleanup after it fails', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  t.after(await f.setup({ environment }));
  // The temporary file of the token cannot be removed (or looked for) any more once the token is in place.
  const unlink = fsPromises.unlink;
  let failed = 0, result;
  fsPromises.unlink = async path => {
    if (String(path).startsWith(`${f.pat}.`) && String(path).endsWith('.tmp')) { failed++; throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' }); }
    return unlink(path);
  };
  syncBuiltinESMExports();
  try { result = await f.rpc.handlers.save({ token: NEW_TOKEN, organization: 'fixture', changes: { language: 'ja' } }); }
  finally { fsPromises.unlink = unlink; syncBuiltinESMExports(); }
  assert.equal(failed, 1);
  assert.deepEqual([result.ok, result.status.state], [true, 'restart'], 'The token was replaced and the settings were written: that is what is reported.');
  assert.deepEqual([await readFile(f.pat, 'utf8'), JSON.parse(await readFile(f.path, 'utf8')).outputLanguage], [NEW_TOKEN, 'ja']);
});

test('two first setups for one organization get a file each, and one that fails takes only its own away', async t => {
  const a = await fixture(t), environment = environmentOf(a), directory = join(environment.XDG_CONFIG_HOME, 'azpr');
  const b = await fixture(t);
  let other;
  // While the first has made its token file and is about to write its settings, the second saves (its settings
  // file is another one, and so is its lock); then the first one's settings file turns out to have changed.
  t.after(await a.setup({ environment, settingsPrepared: async () => {
    other = await b.rpc.handlers.save({ changes: { organization: 'shared', model: 'fixture/model' }, token: NEW_TOKEN });
    await writeFile(a.path, '{}', { mode: 0o600 });
  } }));
  t.after(await b.setup({ environment }));
  const mine = await a.rpc.handlers.save({ changes: { organization: 'shared', model: 'fixture/model' }, token: FAKE_PAT });
  assert.deepEqual(mine, { ok: false, fix: '', problem: 'Settings changed during setup; retry after reviewing the file.' });
  assert.equal(other.ok, true);
  const { organization, patFile } = JSON.parse(await readFile(b.path, 'utf8')).azure;
  assert.deepEqual([organization, patFile, await readFile(patFile, 'utf8')], ['shared', join(directory, 'pat-shared-2'), NEW_TOKEN], 'The second setup\'s token is where its settings say.');
  assert.deepEqual(await readdir(directory), ['pat-shared-2'], 'The first took away the file it had made, and nothing else.');
});

test('a token file that settings name for no organization, or the default PAT file, is never written: the token gets a file of its own', async t => {
  // Settings that name a token file but no organization, as a person may have left them.
  const f = await fixture(t), environment = environmentOf(f);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  await writeFile(f.path, JSON.stringify({ version: 2, azure: { patFile: f.pat } }), { mode: 0o600 });
  t.after(await f.setup({ environment }));
  const row = rowsOf(await f.rpc.handlers.status({})).token;
  assert.deepEqual([row.saved, row.value], [false, 'saved without an organization']);
  assert.ok(row.description.endsWith(` The token in ${f.pat} was saved without an organization and is not used; the token you enter gets a file of its own.`));
  // Naming an organization does not make that token the organization's: it needs one of its own, saved with it.
  assert.deepEqual([row.bound, await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' } })],
    [true, { ok: false, problem: 'The token these settings name was saved without an organization. An organization needs a token of its own: enter it together with the organization.' }]);
  assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'No token is saved for an organization yet.' });
  assert.equal(f.azure.state.calls.length, 0);
  assert.equal(await readFile(f.path, 'utf8'), JSON.stringify({ version: 2, azure: { patFile: f.pat } }), 'Nothing was saved.');
  f.azure.state.pat = NEW_TOKEN;
  const d = dialogs(f, ['fixture', '', NEW_TOKEN, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  assert.equal(await readFile(f.pat, 'utf8'), FAKE_PAT, 'What the dialog said is what happened: that file was not written.');
  const saved = JSON.parse(await readFile(f.path, 'utf8')).azure;
  assert.deepEqual([saved.patFile, await readFile(saved.patFile, 'utf8'), await mode(saved.patFile)], [join(f.root, 'pat-fixture'), NEW_TOKEN, 0o600]);
  assert.match(d.shown.at(-1).message, /\/pr-setup shows and changes these settings\.$/, 'No earlier token of these settings is left behind: nothing more is said.');

  // Settings as setup with options leaves them: they name the default PAT file, which every settings file may use.
  const g = await fixture(t), shared = environmentOf(g), common = join(shared.XDG_CONFIG_HOME, 'azpr', 'pat');
  await mkdir(join(shared.XDG_CONFIG_HOME, 'azpr'), { recursive: true, mode: 0o700 });
  await writeFile(common, FAKE_PAT, { mode: 0o600 });
  await saveSetup(g.context, g.path, parseSetupArguments('--organization fixture --model fixture/model'), shared);
  assert.equal(JSON.parse(await readFile(g.path, 'utf8')).azure.patFile, common);
  t.after(await g.setup({ environment: shared }));
  const rotated = await g.rpc.handlers.save({ token: NEW_TOKEN, organization: 'fixture' });
  assert.deepEqual([rotated.ok, rotated.note], [true, `The earlier token is still in ${common}. Delete that file if you no longer need it.`]);
  const now = JSON.parse(await readFile(g.path, 'utf8')).azure;
  assert.deepEqual([now.patFile, await readFile(now.patFile, 'utf8'), await readFile(common, 'utf8')], [join(shared.XDG_CONFIG_HOME, 'azpr', 'pat-fixture'), NEW_TOKEN, FAKE_PAT]);
  // From then on the file is these settings' own for this organization: the next token replaces it.
  const again = await g.rpc.handlers.save({ token: `${NEW_TOKEN}3`, organization: 'fixture' });
  assert.deepEqual([again.ok, again.note, await readFile(now.patFile, 'utf8'), JSON.parse(await readFile(g.path, 'utf8')).azure.patFile], [true, undefined, `${NEW_TOKEN}3`, now.patFile]);
});

test('a settings file removed while AZPR runs: setup starts again, and what it saves waits for a restart', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  t.after(await f.setup({ environment }));
  assert.equal((await f.rpc.handlers.status({})).state, 'ready');
  await rm(f.path);
  const gone = await f.rpc.handlers.status({});
  assert.deepEqual([gone.state, gone.problem, gone.editable, gone.organization], ['required', '', true, '']);
  const d = dialogs(f, ['fixture', '', FAKE_PAT, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  assert.equal(d.shown.at(-1).message, 'The settings are saved.\n\nRestart the OpenCode service (opencode service restart), then run /pr-check <PR URL>.');
  assert.equal((await f.rpc.handlers.status({})).state, 'restart', 'The runtime keeps the settings it read.');
  assert.deepEqual(f.rpc.events, [], 'Nothing was loaded a second time.');
});

test('a saved token is kept only with the saved way to Azure DevOps: a proxy typed in a first setup asks for the token', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  // Settings that name an organization and a token file but no model: setup is required, and a token is saved.
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  await writeFile(f.path, JSON.stringify({ version: 2, azure: { organization: 'fixture', pat: '', patFile: f.pat } }), { mode: 0o600 });
  t.after(await f.setup({ environment }));
  const before = await f.rpc.handlers.status({});
  assert.deepEqual([before.state, rowsOf(before).token.saved], ['required', true]);
  const d = dialogs(f, ['fixture', 'http://proxy.example:8080', '', '', FAKE_PAT, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  assert.deepEqual(d.shown.filter(item => item.kind === 'secret').map(item => [item.optional, item.problem]), [[true, ''],
    [true, 'The saved token is checked only through the saved proxy and with the saved CA certificate file. Enter the token to check it with the ones given here.']]);
  assert.equal(f.azure.state.calls.length, 1, 'Only the token that was entered was sent, through the proxy that was entered with it.');
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).azure.proxy, 'http://proxy.example:8080');
  assert.ok(f.agents.has('azpr-review-functional'), 'This save made the settings usable: they are loaded.');
});

test('the access check tells a refused token, an unknown organization and a network that needs a proxy or a CA file apart, and asks once', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  let network = 'direct';
  const seen = [];
  const fetch = (url, init) => {
    seen.push({ url: String(url), proxy: init.proxy, ca: init.tls?.ca?.length });
    const refuse = code => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
    if (network === 'refused') return refuse('ECONNREFUSED');
    if (network === 'certificate') return refuse('SELF_SIGNED_CERT_IN_CHAIN');
    if (network === 'proxy-login') return Promise.resolve(new Response('', { status: 407 }));
    if (network === 'gateway') return Promise.resolve(new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    if (network === 'busy') return Promise.resolve(new Response(azureError(503, 'ServiceUnavailableException', 'Busy.').body, { status: 503, headers: { 'content-type': 'application/json', ...AZURE_HEADERS } }));
    if (network === 'forbidden') return Promise.resolve(new Response(azureError(403, 'GitNeedsPermissionException', 'TF401019').body, { status: 403, headers: { 'content-type': 'application/json', ...AZURE_HEADERS } }));
    return f.azure.fetch(url, init);
  };
  t.after(await f.setup({ environment, fetch }));
  const check = input => f.rpc.handlers.check(input);
  assert.deepEqual(await check({ organization: 'fixture', token: FAKE_PAT }), { ok: true, organization: 'fixture' });
  assert.deepEqual(await check({ organization: 'https://dev.azure.com/fixture/project', token: `  ${FAKE_PAT}\n` }), { ok: true, organization: 'fixture' }, 'A URL names the organization, and blanks around a pasted token are not part of it.');
  assert.deepEqual(await check({ organization: 'fixture', token: NEW_TOKEN }),
    { ok: false, fix: 'token', problem: 'Azure DevOps did not accept this token for the organization "fixture" (HTTP 203). It may be mistyped or expired, or belong to another organization.' });
  assert.deepEqual(await check({ organization: 'elsewhere', token: FAKE_PAT }), { ok: false, fix: 'organization', problem: 'Azure DevOps knows no organization named "elsewhere" (HTTP 404).' });
  assert.deepEqual(await check({ organization: 'fixture', token: 'short' }), { ok: false, fix: 'token', problem: 'That is not one token of 20 to 1024 printable characters.' });
  // What setup takes as a token is what it can replace later: a token with quotes around it, or other signs in it, is refused.
  const sentBefore = f.azure.state.calls.length;
  for (const token of [`"${FAKE_PAT}"`, `'${FAKE_PAT}'`, `${FAKE_PAT}.signature`, `Bearer:${FAKE_PAT}`, `PAT=${FAKE_PAT}`]) {
    const refused = await check({ organization: 'fixture', token });
    assert.deepEqual(refused, { ok: false, fix: 'token', problem: 'That is not an Azure DevOps token: it has characters other than letters, digits, "-" and "_" (quotes around it, perhaps).' });
    assert.deepEqual(await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token }),
      { ok: false, problem: 'The token is not an Azure DevOps token: it has characters other than letters, digits, "-" and "_" (quotes around it, perhaps).' });
  }
  assert.equal(f.azure.state.calls.length, sentBefore, 'Nothing was sent for them, and nothing saved.');
  await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  assert.deepEqual(await check({ organization: 'not a name', token: FAKE_PAT }), { ok: false, fix: '', problem: 'Use your Azure DevOps organization name (the <org> in https://dev.azure.com/<org>), or the URL of one of its pull requests.' });
  assert.deepEqual(await check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'No token is saved for an organization yet.' });
  const asked = seen.length;
  for (const [situation, expected] of [
    ['refused', { fix: 'proxy', problem: 'Azure DevOps could not be reached (ECONNREFUSED). This network may need a proxy.' }],
    ['certificate', { fix: 'caFile', problem: 'The TLS certificate of the connection was not accepted (SELF_SIGNED_CERT_IN_CHAIN). A proxy that inspects HTTPS needs its root CA certificate.' }],
    ['proxy-login', { fix: 'proxy', problem: 'The proxy asks for a user name and password (HTTP 407).' }],
    ['gateway', { fix: 'proxy', problem: 'A proxy or gateway answered instead of Azure DevOps (HTTP 403).' }],
    ['busy', { fix: '', problem: 'Azure DevOps answered with an error (HTTP 503). Try again in a moment.' }],
    ['forbidden', { fix: 'token', problem: 'Azure DevOps accepted the token but did not let it list pull requests (HTTP 403). It needs the scopes Code (Read) and Pull Request Threads (Read & write).' }],
  ]) {
    network = situation;
    assert.deepEqual(await check({ organization: 'fixture', token: FAKE_PAT }), { ok: false, ...expected }, situation);
  }
  assert.equal(seen.length, asked + 6, 'A person is waiting: every check is one request, also where a read would be tried again.');
  // The proxy and the CA file that were just entered are the ones used, and a proxy's password is in no answer.
  network = 'refused';
  const through = await check({ organization: 'fixture', token: FAKE_PAT, proxy: 'http://user:pw-secret@proxy.example:8080' });
  assert.deepEqual(through, { ok: false, fix: 'proxy', problem: 'Azure DevOps could not be reached (ECONNREFUSED). Check the proxy http://proxy.example:8080 (with credentials).' });
  assert.equal(seen.at(-1).proxy, 'http://user:pw-secret@proxy.example:8080');
  assert.deepEqual(await check({ organization: 'fixture', token: FAKE_PAT, proxy: 'proxy.example:8080' }),
    { ok: false, fix: '', problem: 'azure.proxy must be empty or a proxy URL such as http://proxy.example.com:8080, optionally with percent-encoded credentials (http://user:password@host:port), without a path, query or fragment.' });
  assert.deepEqual(await check({ organization: 'fixture', token: FAKE_PAT, caFile: join(f.root, 'missing.pem') }), { ok: false, fix: '', problem: 'azure.caFile could not be read (ENOENT).' });
  // What is given is text. Anything else is refused before anything is asked, not read as an answer that is empty or absent.
  network = 'direct';
  const before = seen.length;
  for (const input of [{ organization: null, token: FAKE_PAT }, { organization: 'fixture', token: 7 }, { organization: 'fixture', token: [FAKE_PAT] },
    { organization: 'fixture', token: FAKE_PAT, proxy: false }, { organization: 'fixture', token: FAKE_PAT, caFile: { path: 'x' } }]) {
    assert.deepEqual(await check(input), { ok: false, fix: '', problem: 'Setup takes each answer as text.' }, JSON.stringify(input));
  }
  assert.equal(seen.length, before, 'Nothing was sent for them.');
  assert.ok(!JSON.stringify(f.notices).includes(FAKE_PAT) && f.notices.length === 0, 'A check tells the conversation nothing.');
});

test('answers are checked without being saved; a saved proxy\'s user name and password never leave the server part', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment }));
  const { validate, save, status } = f.rpc.handlers;
  assert.deepEqual(await validate({ changes: { organization: 'https://fixture.visualstudio.com/DefaultCollection/project' } }), { ok: true, values: { organization: 'fixture' }, shown: { organization: 'fixture' } });
  assert.deepEqual(await validate({ changes: { proxy: ' none ' } }), { ok: true, values: { proxy: '' }, shown: { proxy: 'none' } });
  // A proxy's user name and password are in no answer, also not those of a proxy that was just typed: nothing
  // comes back for it but how it may be shown, and the dialog keeps what was typed.
  assert.deepEqual(await validate({ changes: { proxy: 'http://user:pw-secret@proxy.example:8080' } }),
    { ok: true, values: {}, shown: { proxy: 'http://proxy.example:8080 (with credentials)' } });
  assert.deepEqual(await validate({ changes: { organization: 'fixture', proxy: ' http://user:pw-secret@proxy.example:8080 ' } }),
    { ok: true, values: { organization: 'fixture' }, shown: { organization: 'fixture', proxy: 'http://proxy.example:8080 (with credentials)' } });
  assert.deepEqual(await validate({ changes: { proxy: ' http://proxy.example:8080 ' } }), { ok: true, values: { proxy: 'http://proxy.example:8080' }, shown: { proxy: 'http://proxy.example:8080' } });
  for (const [changes, problem] of [
    [{ organization: 'https://example.com/fixture' }, /^Only dev\.azure\.com and <organization>\.visualstudio\.com URLs name an organization\.$/],
    [{ organization: '' }, /^Use your Azure DevOps organization name/],
    [{ proxy: 'socks5://proxy.example:1080' }, /^azure\.proxy must be empty or a proxy URL/],
    [{ caFile: 'relative.pem' }, /^The CA certificate file must be an absolute path\.$/],
    [{ caFile: f.pat }, /^azure\.caFile contains no PEM certificate/],
    [{ caFile: '/dev/zero' }, /^azure\.caFile could not be read \(not a regular file\)\.$/],
    [{ caFile: f.root }, /^azure\.caFile could not be read \(not a regular file\)\.$/],
    [{ model: 'Fixture Model' }, /^The model: select an actual provider\/model ID/],
    [{ model: 'fixture/absent' }, /^The selected model is unavailable in OpenCode\./],
    [{ language: 'Traditional Chinese' }, /^outputLanguage must be a language tag/],
    [{ afterReview: 'always' }, /^After a review must be one of: preview, none, publish\.$/],
    [{ shell: 'inherit' }, /^Setup does not know one of the settings it was given\.$/],
    [{ token: FAKE_PAT }, /^Setup does not know one of the settings it was given\.$/],
    [{ __proto__: null, constructor: 'x' }, /^Setup does not know one of the settings it was given\.$/],
  ]) {
    const result = await validate({ changes });
    assert.equal(result.ok, false, JSON.stringify(changes));
    assert.match(result.problem, problem, JSON.stringify(changes));
    assert.ok(!Object.values(changes).some(value => value && result.problem.includes(value)), 'A refused answer is not quoted.');
  }
  assert.deepEqual(await validate({}), { ok: false, fix: '', problem: 'Setup was given no settings to change.' });
  // An answer is text. Anything else is refused, not read as an empty answer (which would clear a proxy).
  for (const answer of [0, null, true, ['http://proxy.example:8080'], { url: 'x' }]) {
    assert.deepEqual(await validate({ changes: { proxy: answer } }), { ok: false, fix: '', problem: 'Setup takes each setting as text.' });
  }
  for (const input of [null, 'changes', 7, [], { changes: [] }, { changes: 'proxy' }]) assert.equal((await validate(input)).ok, false);
  await assert.rejects(lstat(f.path), { code: 'ENOENT' }, 'Checking answers writes nothing.');

  // With a proxy that has a password saved, the dialog starts with the proxy alone; left as it is, it stands for the saved one.
  await writeFile(f.pat, FAKE_PAT, { mode: 0o600 });
  assert.equal((await save({ changes: { organization: 'fixture', model: 'fixture/model', proxy: 'http://user:pw-secret@proxy.example:8080' }, token: FAKE_PAT })).ok, true);
  const row = rowsOf(await status({})).proxy;
  assert.deepEqual([row.value, row.current], ['http://proxy.example:8080 (with credentials)', 'http://proxy.example:8080']);
  assert.match(row.description, /The saved proxy has a user name and password, which are not shown: leave the URL as it is to keep them\.$/);
  assert.deepEqual(await validate({ changes: { proxy: 'http://proxy.example:8080' } }), { ok: true, values: { proxy: 'http://proxy.example:8080' }, shown: { proxy: 'http://proxy.example:8080 (with credentials)' } });
  assert.equal((await save({ changes: { proxy: 'http://proxy.example:8080' } })).ok, true);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).azure.proxy, 'http://user:pw-secret@proxy.example:8080', 'Unchanged in the dialog: the saved proxy with its password stays.');
  assert.equal((await save({ changes: { proxy: 'http://other.example:3128' } })).ok, true);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).azure.proxy, 'http://other.example:3128');
  assert.ok(!JSON.stringify([await status({}), await validate({ changes: { proxy: 'http://other.example:3128' } })]).includes('pw-secret'));
});

test('one setting is saved at a time from the list; settings in use wait for a restart, and say so', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  const initial = await readFile(f.path, 'utf8');
  t.after(await f.setup({ environment }));
  const { save, status } = f.rpc.handlers;
  assert.equal((await status({})).state, 'ready');
  assert.deepEqual(f.rpc.events, [], 'Settings that were there when OpenCode loaded AZPR are no first setup.');
  // Choosing the value a setting already has writes nothing, and nothing waits for a restart.
  const unchanged = await save({ changes: { language: 'en', afterReview: 'preview' } });
  assert.deepEqual([unchanged.ok, unchanged.status.state, await readFile(f.path, 'utf8')], [true, 'ready', initial]);
  const value = async id => rowsOf(await status({}))[id].value;
  for (const [changes, id, shown, read] of [
    [{ language: 'zh-TW' }, 'language', 'zh-TW', raw => raw.outputLanguage],
    [{ afterReview: 'none' }, 'afterReview', 'none', raw => raw.afterReview],
    [{ report: 'full' }, 'report', 'full', raw => raw.returnReport],
    [{ progress: 'off' }, 'progress', 'off', raw => raw.progressNotices],
    [{ panel: 'manual' }, 'panel', 'manual', raw => raw.terminalPanel],
    [{ debug: 'on' }, 'debug', 'on', raw => raw.debug],
    [{ deepModel: 'fixture/model#high' }, 'deepModel', 'fixture/model#high', raw => raw.models.deep],
    [{ quickModel: 'off' }, 'quickModel', 'off', raw => raw.models.quick],
    [{ reviewModel: 'fixture/model#high' }, 'reviewModel', 'fixture/model#high', raw => raw.models.review],
  ]) {
    const result = await save({ changes });
    assert.equal(result.ok, true, JSON.stringify(changes));
    assert.equal(result.status.state, 'restart', 'The runtime read the settings once; what is saved now waits for a restart.');
    assert.equal(await value(id), shown);
    assert.ok(read(JSON.parse(await readFile(f.path, 'utf8'))) !== undefined);
  }
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual([saved.outputLanguage, saved.afterReview, saved.returnReport, saved.progressNotices, saved.terminalPanel, saved.debug],
    ['zh-TW', { review: 'none', deep: 'none', quick: 'none' }, 'full', false, 'manual', { enabled: true, directory: '', keepRuns: 20 }]);
  assert.deepEqual(saved.models, { review: { functional: 'fixture/model#high', risk: 'fixture/model#high', verifier: 'fixture/model#high', rater: '' },
    deep: { functional: 'fixture/model#high', risk: 'fixture/model#high', verifier: 'fixture/model#high', rater: '' }, quick: { reviewer: '' } });
  // Everything setup does not ask for is as it was, and the file is still owner-only and complete.
  const untouched = ({ models, outputLanguage, afterReview, returnReport, progressNotices, terminalPanel, debug, ...rest }) => rest;
  assert.deepEqual(untouched(saved), untouched(JSON.parse(initial)));
  assert.equal(await mode(f.path), 0o600);
  // The runtime still has the settings it read: it refuses new runs until the restart, as for any changed file.
  await f.invoke('pr-check', f.azure.prUrl());
  for (let attempt = 0; attempt < 200 && !f.reports.some(report => /settings\.json changed since OpenCode loaded it/.test(report)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.reports.at(-1), /settings\.json changed since OpenCode loaded it\. Restart the OpenCode service/);
  // A value that differs between the roles or modes is shown as it is.
  await writeFile(f.path, JSON.stringify({ ...saved, afterReview: { quick: 'none', review: 'preview', deep: 'publish' }, models: { ...saved.models, review: { functional: 'fixture/model', risk: 'fixture/model#high', verifier: 'fixture/model' } } }));
  assert.deepEqual([await value('afterReview'), await value('reviewModel')], ['differs by mode', 'differs by role'], 'The list has room for a few words; the file has each value.');
  const refused = await save({ changes: { language: 'no such language' } });
  assert.deepEqual([refused.ok, refused.problem], [false, 'outputLanguage must be a language tag such as en, zh-TW, zh-CN, or ja (not a language name or instruction).']);
});

test('what setup reports as waiting for a restart is what the runtime refuses new runs for, whoever changed it', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  const initial = await readFile(f.path, 'utf8');
  t.after(await f.setup({ environment }));
  const state = async () => (await f.rpc.handlers.status({})).state;
  assert.equal(await state(), 'ready');
  // Another instance of AZPR, another process or a person replaces the PAT file: this runtime has the token it read.
  await writeFile(f.pat, NEW_TOKEN, { mode: 0o600 });
  assert.equal(await state(), 'restart');
  await writeFile(f.pat, `${FAKE_PAT}\n`, { mode: 0o600 });
  assert.equal(await state(), 'ready', 'The token the runtime read, again: nothing waits.');
  // A PAT file that can no longer be used is no longer what was loaded either.
  await chmod(f.pat, 0o644);
  assert.equal(await state(), 'restart');
  await chmod(f.pat, 0o600);
  assert.equal(await state(), 'ready');
  // Any other text of the settings file is refused by the preflight, also one with the same values.
  await writeFile(f.path, `${initial}\n`, { mode: 0o600 });
  assert.equal(await state(), 'restart');
  await f.invoke('pr-check', f.azure.prUrl());
  for (let attempt = 0; attempt < 200 && !f.reports.some(report => /settings\.json changed since OpenCode loaded it/.test(report)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.reports.at(-1), /settings\.json changed since OpenCode loaded it\. Restart the OpenCode service/, 'The runtime says the same.');
  await writeFile(f.path, initial, { mode: 0o600 });
  assert.equal(await state(), 'ready');
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
});

test('two setups that save at the same moment never leave the organization of one with the token of the other', async t => {
  const f = await fixture(t), environment = environmentOf(f), tokenFile = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture');
  // One settings file, loaded by OpenCode for two project directories: each has a server part of its own.
  const g = await fixture(t);
  g.context.options.settingsFile = f.path;
  let other;
  // The second setup saves while the first has written its token and is about to write its settings.
  t.after(await f.setup({ environment, settingsPrepared: async () => {
    other = await g.rpc.handlers.save({ changes: { organization: 'elsewhere', model: 'fixture/model' }, token: NEW_TOKEN });
  } }));
  t.after(await g.setup({ environment }));
  const mine = await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  assert.equal(mine.ok, true);
  assert.deepEqual(other, { ok: false, fix: '', problem: 'Another setup is active, or its lock was left behind (if none is running, delete settings.json.setup.lock beside the settings file). No settings changed.' });
  // The organization and the token in the file that the same settings name.
  const pair = async () => { const { organization, patFile } = JSON.parse(await readFile(f.path, 'utf8')).azure; return [organization, await readFile(patFile, 'utf8')]; };
  assert.deepEqual(await pair(), ['fixture', FAKE_PAT], 'The refused setup wrote neither file, so the token is the one of this organization.');
  // The first setup's settings are in use where it ran. The other project directory found none and did not make
  // these usable: there they wait for the restart, also after its own save, which replaces both files together.
  assert.deepEqual([(await f.rpc.handlers.status({})).state, (await g.rpc.handlers.status({})).state], ['ready', 'restart']);
  const again = await g.rpc.handlers.save({ changes: { organization: 'elsewhere', model: 'fixture/model' }, token: NEW_TOKEN });
  assert.deepEqual([again.ok, again.status.state], [true, 'restart']);
  assert.deepEqual(await pair(), ['elsewhere', NEW_TOKEN]);
  assert.equal(await readFile(tokenFile, 'utf8'), FAKE_PAT, 'The first organization\'s token is still in its file.');
  assert.equal((await f.rpc.handlers.status({})).state, 'restart', 'The runtime that was loaded has another organization than the settings now.');
  assert.equal(g.agents.size, 0);
});

test('another organization\'s token gets a file of its own, and the settings switch organization and token in one write', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  let prepared;
  t.after(await f.setup({ environment, settingsPrepared: () => prepared?.() }));
  const { save, check, status } = f.rpc.handlers;
  const azure = async () => JSON.parse(await readFile(f.path, 'utf8')).azure;
  const other = join(f.root, 'pat-elsewhere');
  // Another organization does not inherit the saved token: it needs one of its own, saved with it.
  assert.deepEqual(await save({ changes: { organization: 'elsewhere' } }),
    { ok: false, problem: 'The saved token was saved for the organization "fixture". Another organization needs a token of its own: enter it together with the organization.' });
  // Also while the token file cannot be used: the settings still name it, and it may be usable again later.
  await chmod(f.pat, 0o644);
  const unusable = rowsOf(await status({})).token;
  assert.deepEqual([unusable.saved, unusable.value, unusable.bound], [false, 'cannot be used', true]);
  assert.deepEqual(await save({ changes: { organization: 'elsewhere' } }),
    { ok: false, problem: 'The saved token was saved for the organization "fixture". Another organization needs a token of its own: enter it together with the organization.' });
  await chmod(f.pat, 0o600);
  assert.deepEqual([(await azure()).organization, rowsOf(await status({})).token.bound], ['fixture', true]);
  assert.equal((await save({ changes: { organization: 'FIXTURE' } })).ok, true, 'The same organization in other letters keeps its token.');
  assert.equal((await save({ changes: { organization: 'fixture' } })).ok, true);
  // Should the settings not be written, the organization and its token are as they were: the other organization's
  // token never touched the file of this one, and the file made for it is taken away again.
  const current = await readFile(f.path, 'utf8');
  prepared = () => writeFile(f.path, `${current}\n`);
  assert.deepEqual(await save({ changes: { organization: 'elsewhere' }, token: NEW_TOKEN }), { ok: false, fix: '', problem: 'Settings changed during setup; retry after reviewing the file.' });
  prepared = undefined;
  assert.deepEqual([(await azure()).organization, (await azure()).patFile, await readFile(f.pat, 'utf8')], ['fixture', f.pat, FAKE_PAT]);
  await assert.rejects(lstat(other), { code: 'ENOENT' });
  assert.deepEqual(await check({ organization: 'fixture' }), { ok: true, organization: 'fixture' }, 'The saved token is still the one of its organization.');
  // Saved together: the token in a file beside the earlier one, named for the organization, and the settings name it.
  const both = await save({ changes: { organization: 'elsewhere' }, token: NEW_TOKEN });
  assert.deepEqual([both.ok, both.status.organization, both.note], [true, 'elsewhere', `The token of "fixture" is still in ${f.pat}. Delete that file if you no longer need it.`]);
  assert.deepEqual([(await azure()).organization, (await azure()).patFile, await readFile(other, 'utf8'), await mode(other)], ['elsewhere', other, NEW_TOKEN, 0o600]);
  assert.equal(await readFile(f.pat, 'utf8'), FAKE_PAT, 'The earlier organization\'s token file was not written.');
  assert.ok(rowsOf(await status({})).token.description.endsWith(` The saved token is in ${other}.`));
  // A check without a token reads the organization and the file the same settings name: the new pair.
  f.azure.state.org = 'elsewhere';
  f.azure.state.pat = NEW_TOKEN;
  const sent = f.azure.state.calls.length;
  assert.deepEqual(await check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'The saved token was saved for the organization "elsewhere". Enter a token of "fixture".' });
  assert.equal(f.azure.state.calls.length, sent);
  assert.deepEqual(await check({ organization: 'elsewhere' }), { ok: true, organization: 'elsewhere' });
  // A new token of the same organization replaces its file; going back to the first one gets a file of that name.
  const rotated = await save({ token: `${NEW_TOKEN}2`, organization: 'elsewhere' });
  assert.deepEqual([rotated.ok, rotated.note, await readFile(other, 'utf8'), (await azure()).patFile], [true, undefined, `${NEW_TOKEN}2`, other]);
  const back = await save({ changes: { organization: 'fixture' }, token: FAKE_PAT });
  assert.deepEqual([back.ok, back.note, (await azure()).patFile, await readFile(join(f.root, 'pat-fixture'), 'utf8'), await readFile(other, 'utf8')],
    [true, `The token of "elsewhere" is still in ${other}. Delete that file if you no longer need it.`, join(f.root, 'pat-fixture'), FAKE_PAT, `${NEW_TOKEN}2`]);
  for (const text of [JSON.stringify([both, rotated, back]), JSON.stringify(f.notices), await readFile(f.path, 'utf8')]) assert.ok(!text.includes(NEW_TOKEN) && !text.includes(FAKE_PAT));
});

test('settings that name an organization but no token have none, whatever the default PAT file holds', async t => {
  const f = await fixture(t), environment = environmentOf(f), common = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat');
  // The default PAT file may be the token of other settings, for another organization.
  await mkdir(join(environment.XDG_CONFIG_HOME, 'azpr'), { recursive: true, mode: 0o700 });
  await writeFile(common, NEW_TOKEN, { mode: 0o600 });
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  await writeFile(f.path, JSON.stringify({ version: 2, azure: { organization: 'fixture' } }), { mode: 0o600 });
  t.after(await f.setup({ environment }));
  const before = await f.rpc.handlers.status({});
  assert.deepEqual([before.state, rowsOf(before).token.saved, rowsOf(before).token.value], ['required', false, 'not set']);
  assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'No token is saved yet.' });
  assert.equal(f.azure.state.calls.length, 0, 'The token in the default file was sent nowhere.');
  const d = dialogs(f, ['fixture', '', FAKE_PAT, 'fixture/model', '', true]);
  await d.setup.open();
  assert.equal(d.left(), 0);
  assert.equal(d.shown.find(item => item.kind === 'secret').optional, false, 'There is no saved token to keep.');
  const saved = JSON.parse(await readFile(f.path, 'utf8')).azure;
  assert.deepEqual([saved.pat, saved.patFile, await readFile(saved.patFile, 'utf8')], ['', join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture'), FAKE_PAT]);
  assert.equal(await readFile(common, 'utf8'), NEW_TOKEN);
  assert.ok(f.agents.has('azpr-review-functional'));
});

test('a new token replaces the token file in one step and owner-only; a path that is not the user\'s own regular file is refused', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await saveSetup(f.context, f.path, f.args);
  let prepared;
  t.after(await f.setup({ environment, settingsPrepared: () => prepared?.() }));
  const { status, check } = f.rpc.handlers;
  // A token is saved for the organization it was checked for.
  const save = input => f.rpc.handlers.save(input.token === undefined || input.organization !== undefined ? input : { ...input, organization: 'fixture' });
  const before = await readFile(f.path, 'utf8');
  const result = await save({ token: ` ${NEW_TOKEN}\n` });
  assert.deepEqual([result.ok, result.status.state], [true, 'restart']);
  assert.equal(await readFile(f.pat, 'utf8'), NEW_TOKEN);
  assert.equal(await mode(f.pat), 0o600);
  assert.equal(await readFile(f.path, 'utf8'), before, 'The settings already name this token file: they are not rewritten.');
  // The same token again changes nothing: no file is written, and nothing new waits for a restart.
  const written = (await lstat(f.pat)).ino;
  assert.equal((await save({ token: NEW_TOKEN })).ok, true);
  assert.equal((await lstat(f.pat)).ino, written, 'The token file was not replaced by an identical one.');
  assert.deepEqual((await readdir(f.root)).filter(name => name.includes('.tmp')), []);
  // The saved token is the one a check without a token uses, and it goes only to the organization it was saved for.
  f.azure.state.pat = NEW_TOKEN;
  assert.deepEqual(await check({ organization: 'fixture' }), { ok: true, organization: 'fixture' });
  assert.deepEqual(await check({ organization: 'FIXTURE' }), { ok: true, organization: 'FIXTURE' }, 'Organization names differ by case only in writing.');
  const sent = f.azure.state.calls.length;
  assert.deepEqual(await check({ organization: 'elsewhere' }), { ok: false, fix: 'token', problem: 'The saved token was saved for the organization "fixture". Enter a token of "elsewhere".' });
  assert.equal(f.azure.state.calls.length, sent, 'Nothing was sent: the saved token never goes to another organization.');
  // Nor another way than the saved settings send it: a proxy and a CA file that the caller chooses could read it.
  const certificate = join(f.root, 'ca.pem');
  await writeFile(certificate, TEST_CA);
  for (const network of [{ proxy: 'http://proxy.example:8080' }, { caFile: certificate }, { proxy: 'http://proxy.example:8080', caFile: certificate }]) {
    assert.deepEqual(await check({ organization: 'fixture', ...network }), { ok: false, fix: 'token',
      problem: 'The saved token is checked only through the saved proxy and with the saved CA certificate file. Enter the token to check it with the ones given here.' }, JSON.stringify(Object.keys(network)));
  }
  assert.equal(f.azure.state.calls.length, sent, 'Nothing was sent for them either.');
  assert.deepEqual(await check({ organization: 'fixture', proxy: '', caFile: 'none' }), { ok: true, organization: 'fixture' }, 'The saved ones, named again, are the saved ones.');
  // A token file that is unusable is said to be so.
  await chmod(f.pat, 0o644);
  assert.deepEqual(await check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'The saved token cannot be used: its file could not be used (group or others may access it; run chmod 600 on it).' });
  await chmod(f.pat, 0o600);
  for (const [token, problem] of [['short', 'The token is not one token of 20 to 1024 printable characters.'], ['two words 0123456789abcdefghij', 'The token is not one token of 20 to 1024 printable characters.'],
    ['REPLACE_WITH_YOUR_TOKEN_0123456789', 'The token is still a placeholder.']]) {
    assert.deepEqual(await save({ token }), { ok: false, problem });
  }
  for (const token of [null, 7, [FAKE_PAT], { token: FAKE_PAT }]) assert.deepEqual(await save({ token }), { ok: false, fix: '', problem: 'Setup takes each answer as text.' });
  assert.equal(await readFile(f.pat, 'utf8'), NEW_TOKEN, 'A refused token changes nothing.');
  // The token and the settings are written under one lock: while another setup holds it, neither changes.
  await writeFile(`${f.path}.setup.lock`, '');
  assert.deepEqual(await save({ token: FAKE_PAT, changes: { language: 'ja' } }), { ok: false, fix: '',
    problem: 'Another setup is active, or its lock was left behind (if none is running, delete settings.json.setup.lock beside the settings file). No settings changed.' });
  await rm(`${f.path}.setup.lock`);
  assert.equal(await readFile(f.pat, 'utf8'), NEW_TOKEN, 'The token file was not touched without the lock.');
  // The lock keeps AZPR's writers apart, not an editor. Should the settings file change in the moment between
  // the token and the settings, the answer says that the token was saved.
  const current = await readFile(f.path, 'utf8');
  prepared = () => writeFile(f.path, `${current}\n`);
  assert.deepEqual(await save({ token: FAKE_PAT, changes: { language: 'ja' } }), { ok: false, fix: '',
    problem: 'The token was saved, but the settings were not: Settings changed during setup; retry after reviewing the file.' });
  prepared = undefined;
  assert.equal(await readFile(f.pat, 'utf8'), FAKE_PAT);
  assert.equal(await readFile(f.path, 'utf8'), `${current}\n`, 'What the editor saved is not overwritten.');
  assert.deepEqual((await readdir(join(f.root, 'private config'))).sort(), ['settings.json'], 'Neither a lock nor a temporary file is left.');
  assert.equal((await save({ token: NEW_TOKEN })).ok, true);
  // A token names its organization: without one, or for another than the settings name, it is not saved.
  assert.deepEqual(await f.rpc.handlers.save({ token: FAKE_PAT }), { ok: false, problem: 'A token is saved for an organization: name the one it was checked for.' });
  assert.deepEqual(await f.rpc.handlers.save({ token: FAKE_PAT, organization: 'elsewhere' }),
    { ok: false, problem: 'The token was checked for the organization "elsewhere", but the settings name "fixture" now. Nothing was saved; run /pr-setup again.' });
  assert.deepEqual(await f.rpc.handlers.save({ token: FAKE_PAT, organization: 7 }), { ok: false, fix: '', problem: 'Setup takes each answer as text.' });
  // The token file is replaced only where it is a regular file of the user's own, in a directory no one else can write to.
  const elsewhere = join(f.root, 'elsewhere');
  await writeFile(elsewhere, 'not a token', { mode: 0o600 });
  await rm(f.pat);
  await symlink(elsewhere, f.pat);
  assert.deepEqual(await save({ token: FAKE_PAT }), { ok: false, fix: '', problem: 'The token file must be a regular file owned by you, without hard links; it was left as it is.' });
  assert.equal(await readFile(elsewhere, 'utf8'), 'not a token', 'Nothing is written through a symbolic link.');
  await rm(f.pat);
  // Settings can name any path: a file that holds something other than one token is not replaced. One token is
  // one word of letters, digits, "-" and "_" that is as long as a token; one line of JSON, a KEY=VALUE pair, a
  // path, an address or a short word is something else.
  for (const content of ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n', 'two words', 'x'.repeat(5000),
    '{"name":"real-package","version":"1.0.0"}', 'AZURE_DEVOPS_PAT=0123456789abcdefghijklmnop', '/home/someone/.ssh/id_ed25519.backup', 'https://dev.azure.com/fixture/project',
    'someone@example.com:0123456789abcdef', 'production\n', '22.14.0']) {
    await writeFile(f.pat, content, { mode: 0o600 });
    assert.deepEqual(await save({ token: FAKE_PAT }), { ok: false, fix: '', problem: 'The file that azure.patFile names holds something other than one token; it was left as it is. Name another file there, or remove this one.' }, content.slice(0, 20));
    assert.equal(await readFile(f.pat, 'utf8'), content);
  }
  // An empty file, or one that holds a token that is of no use any more (an expired one, a placeholder), is one:
  // it is replaced, owner-only.
  for (const content of ['', 'expired0123456789abcdefghijklmnopqrstuvwxyz0123456789\n', 'REPLACE_WITH_YOUR_TOKEN_0123456789']) {
    await writeFile(f.pat, content, { mode: 0o644 });
    assert.equal((await save({ token: NEW_TOKEN })).ok, true);
    assert.deepEqual([await readFile(f.pat, 'utf8'), await mode(f.pat)], [NEW_TOKEN, 0o600]);
  }
  await rm(f.pat);
  await chmod(f.root, 0o777);
  try { assert.deepEqual(await save({ token: FAKE_PAT }), { ok: false, fix: '', problem: 'The directory of the token file must be a directory owned by you, not a symbolic link or writable by other users.' }); }
  finally { await chmod(f.root, 0o700); }
  await assert.rejects(lstat(f.pat), { code: 'ENOENT' });
  // A settings file that keeps the token in itself (azure.pat) gets a token file instead, and names it.
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(before), azure: { ...JSON.parse(before).azure, pat: FAKE_PAT, patFile: '' } }), { mode: 0o600 });
  assert.deepEqual([rowsOf(await status({})).token.value, rowsOf(await status({})).token.saved], ['in the settings file', true]);
  assert.equal((await save({ token: NEW_TOKEN })).ok, true);
  const moved = JSON.parse(await readFile(f.path, 'utf8')).azure;
  assert.deepEqual([moved.pat, moved.patFile], ['', join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture')]);
  assert.equal(await readFile(moved.patFile, 'utf8'), NEW_TOKEN);
  for (const text of [JSON.stringify(await status({})), JSON.stringify(f.notices), await readFile(f.path, 'utf8')]) assert.ok(!text.includes(NEW_TOKEN) && !text.includes(FAKE_PAT));
});

test('a settings file setup cannot change is reported, never rewritten', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  await writeFile(f.path, '{"version":2,"azure":{"pat":"PRIVATE_TOKEN_0123456789abcdef",}', { mode: 0o600 });
  const broken = await readFile(f.path, 'utf8');
  t.after(await f.setup({ environment }));
  const { status, validate, check, save } = f.rpc.handlers;
  const view = await status({});
  assert.deepEqual([view.state, view.editable, view.fileProblem], ['required', false, 'settings.json must be a JSON object without duplicate keys; repair it manually before setup.']);
  for (const answer of [await validate({ changes: { language: 'ja' } }), await check({ organization: 'fixture', token: FAKE_PAT }), await save({ changes: { language: 'ja' } })]) {
    assert.equal(answer.ok, false);
    assert.equal(answer.problem, 'settings.json must be a JSON object without duplicate keys; repair it manually before setup.');
  }
  assert.equal(await readFile(f.path, 'utf8'), broken);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_TOKEN'));
  // The dialogs only say so.
  const d = dialogs(f, []);
  await d.setup.open();
  assert.deepEqual(d.shown.map(item => item.title), ['AZPR\'s settings file needs repair']);
  // A file whose groups are not objects, or of another version, is the same case; a symbolic link is not followed.
  for (const [content, problem] of [['{"version":2,"models":[]}', '"models" in the settings file is not a JSON object.'], ['{"version":3}', 'Setup supports only version-2 settings.'],
    ['{"version":2,"models":{"review":"fixture/model"}}', '"models.review" in the settings file is not a JSON object.']]) {
    await writeFile(f.path, content);
    assert.equal((await status({})).fileProblem, problem);
  }
  await rm(f.path);
  await symlink(f.pat, f.path);
  assert.deepEqual([(await status({})).editable, (await status({})).fileProblem], [false, 'Setup refuses a symbolic link for settings.json.']);
});

test('/pr-setup alone tells the terminal UI to ask; options change one setting each without --replace', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment }));
  // Before any settings exist, a single setting has nothing to change.
  assert.equal(await f.invoke('pr-setup', '--language zh-TW'), '[AZPR] There are no settings yet. Supply --organization and --model, or run /pr-setup alone in OpenCode\'s terminal UI. Use /pr-setup --help.');
  await f.invoke('pr-setup', '');
  assert.deepEqual(f.notices.at(-1).metadata, { azpr: { setup: true } }, 'The notice of /pr-setup alone is marked: the terminal UI opens its dialogs.');
  await f.invoke('pr-setup', '   ');
  assert.deepEqual(f.notices.at(-1).metadata, { azpr: { setup: true } });
  await f.invoke('pr-setup', '--help');
  assert.equal(f.notices.at(-1).metadata, undefined, '--help only explains.');
  assert.match(f.notices.at(-1).text, /One setting of existing settings is changed without --replace: --proxy URL\|none, --ca-file PATH\|none, --review-model PROVIDER\/MODEL, --quick-model PROVIDER\/MODEL\|off, --deep-model PROVIDER\/MODEL\|off, --language [^,]+, --after-review preview\|none\|publish, --report receipt\|full, --progress on\|off, --panel auto\|manual, --debug on\|off\./);
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}" --language ja --deep-model fixture/model#high`),
    /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nOrganization: fixture; PAT file: .+\nChanged: Deep model, Output language\nAZPR has loaded them: run \/pr-check <PR URL>\./);
  assert.equal(f.notices.at(-1).metadata, undefined);
  const read = async () => JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual([(await read()).outputLanguage, (await read()).models.deep.verifier], ['ja', 'fixture/model#high']);
  assert.equal(await f.invoke('pr-setup', '--language zh-TW --after-review none --proxy http://user:pw-secret@proxy.example:8080'),
    `[AZPR] SETTINGS SAVED\nSettings: ${f.path}\nChanged: Proxy, Output language, After a review\nTo load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process), then run /pr-check <PR URL>. No model or Azure request was made. Existing reviews keep their original settings.`);
  assert.deepEqual([(await read()).outputLanguage, (await read()).afterReview, (await read()).azure.proxy], ['zh-TW', { review: 'none', deep: 'none', quick: 'none' }, 'http://user:pw-secret@proxy.example:8080']);
  assert.match(await f.invoke('pr-setup', '--proxy none --deep-model off --quick-model off --debug on --progress off --panel manual --report full'), /\nChanged: Proxy, Quick model, Deep model, Report in the conversation, Progress notices, Review panel, Debug records\n/);
  const now = await read();
  assert.deepEqual([now.azure.proxy, now.models.deep.functional, now.models.quick.reviewer, now.debug.enabled, now.progressNotices, now.terminalPanel, now.returnReport], ['', '', '', true, false, 'manual', 'full']);
  const unchanged = await readFile(f.path, 'utf8');
  for (const [options, problem] of [
    ['--language "Traditional Chinese"', /^\[AZPR\] outputLanguage must be a language tag/], ['--after-review always', /^\[AZPR\] After a review must be one of: preview, none, publish\.$/],
    ['--review-model fixture/absent', /^\[AZPR\] The selected model is unavailable/], ['--ca-file relative.pem', /^\[AZPR\] The CA certificate file must be an absolute path\.$/],
    ['--proxy ftp://proxy.example', /^\[AZPR\] azure\.proxy must be empty or a proxy URL/], ['--debug maybe', /^\[AZPR\] Debug records must be one of: on, off\.$/],
    ['--organization other', /^\[AZPR\] Supply --organization and --model/], ['--organization other --model fixture/model', /^\[AZPR\] Settings already exist\. Add --replace/],
    ['--token abc', /^\[AZPR\] Unknown or repeated setup option\./], ['--language', /^\[AZPR\] A setup option needs a value\./], ['--language en --language ja', /^\[AZPR\] Unknown or repeated setup option\./],
  ]) assert.match(await f.invoke('pr-setup', options), problem, options);
  assert.equal(await readFile(f.path, 'utf8'), unchanged, 'A refused option changes nothing.');
  assert.ok(!JSON.stringify(f.notices).includes('pw-secret'), 'A proxy\'s password is in no notice.');
});

test('a process that found no usable settings loads nothing by itself: settings another process saved wait for a restart', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  const cleanup = await f.setup({ environment });
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n/);
  // Settings that still cannot be used are named with their problem of now, not the one found at load.
  await mkdir(join(f.root, 'private config'), { recursive: true, mode: 0o700 });
  await writeFile(f.path, '{"version":2,"models":{"review":{"functional":"fixture/model","risk":"fixture/model","verifier":"fixture/model"}},"azure":{"organization":"fixture","pat":"","patFile":""}}', { mode: 0o600 });
  assert.match(await f.invoke('pr-review', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n.*could not be used when OpenCode loaded AZPR: azure\.pat must be an Azure DevOps personal access token/);
  await rm(f.path);
  // Another OpenCode process (or the same one, for another project directory) completes a first setup, or
  // someone writes the file: this process read no settings and reads none now. A restart loads them, as always.
  await saveSetup(f.context, f.path, f.args);
  assert.equal(await f.invoke('pr-check', f.azure.prUrl()),
    `[AZPR] RESTART REQUIRED\nNo review or Azure request was started. The settings at ${f.path} can be used now, but AZPR found no usable settings when OpenCode loaded it for this project directory, and these were saved elsewhere: by a setup in another project directory or another OpenCode process, or by hand. To load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process).`);
  assert.equal(f.agents.size, 0);
  assert.deepEqual(f.rpc.events, [], 'Nothing was loaded, so nothing is announced.');
  // Setup says the same: there are settings, and they wait for the restart. It gives no hint that AZPR is not set up.
  assert.equal((await f.rpc.handlers.status({})).state, 'restart');
  const d = dialogs(f, [undefined]);
  await d.setup.hint();
  await d.setup.open();
  assert.deepEqual([d.toasts.length, d.shown.map(item => `${item.kind}: ${item.title}`)], [0, ['select: AZPR settings · restart needed']]);
  // What this process's own setup saves now does not make them its to load: something else made them usable.
  const changed = await f.rpc.handlers.save({ changes: { language: 'ja' } });
  assert.deepEqual([changed.ok, changed.status.state], [true, 'restart']);
  assert.equal((await f.rpc.handlers.save({ changes: {} })).status.state, 'restart', 'A save that changes nothing loads nothing either.');
  assert.match(await f.invoke('pr-setup', '--language en'), /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nChanged: Output language\nTo load them, restart the OpenCode service \(in a terminal: opencode service restart; if you run opencode serve yourself, restart that process\), then run \/pr-check <PR URL>\. No model or Azure request was made\.$/);
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`), /\nTo load them, restart the OpenCode service /);
  assert.equal(f.agents.size, 0);
  assert.deepEqual(f.rpc.events, []);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n/);
  assert.equal(f.azure.state.calls.length, 0);
  await cleanup();
  t.after(await f.setup({ environment }));
  assert.ok(f.agents.has('azpr-review-functional'), 'After the restart the settings are in use.');
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
});

test('a host call that fails while a first setup is loaded leaves the settings saved and the commands that say so', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  const original = f.context.command.list;
  f.context.command.list = async () => { throw new Error('socket closed: host detail'); };
  const receipt = await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`);
  f.context.command.list = original;
  assert.match(receipt, /^\[AZPR\] SETTINGS SAVED\n[\s\S]*\nAZPR could not load them: OpenCode did not answer while AZPR replaced its commands\. Repair that, then restart the OpenCode service /);
  assert.ok(!receipt.includes('host detail'), 'The host\'s error text is not passed on.');
  assert.equal(f.agents.size, 0);
  // The commands that say so were taken away for the load, and the host could not tell which names are free:
  // none is registered on a guess (it would replace a command that may be another plugin's by now).
  assert.deepEqual([...f.commands.keys()], ['pr-setup']);
  // The next /pr-setup finds the host answering again and puts them back.
  assert.match(await f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP/);
  assert.deepEqual([...f.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n[\s\S]*are saved, but AZPR could not load them: OpenCode did not answer while AZPR replaced its commands\./);
  // The settings are this setup's own: its next save tries again.
  const saved = await f.rpc.handlers.save({ changes: { language: 'ja' } });
  assert.deepEqual([saved.ok, saved.status.state], [true, 'ready']);
  assert.ok(f.agents.has('azpr-review-functional'));
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
});

test('a review command name that another plugin took meanwhile stays its own when a first setup cannot be loaded', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  // Another plugin registers /pr-review after AZPR registered the commands that only say "setup required".
  let ran = 0;
  const theirs = { name: 'pr-review', description: 'Another plugin\'s review', async execute() { ran++; } };
  f.commands.set('pr-review', theirs);
  const receipt = await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`);
  assert.match(receipt, /\nAZPR could not load them: Reserved command name conflict: pr-review Repair that, then restart the OpenCode service /);
  assert.equal(f.commands.get('pr-review'), theirs, 'The command that stood in the way was not replaced.');
  await f.commands.get('pr-review').execute({ sessionID: 'origin', prompt: { text: '' } });
  assert.equal(ran, 1);
  // The other review commands say what is wrong, as before.
  assert.deepEqual([...f.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n[\s\S]*Reserved command name conflict: pr-review/);
  assert.equal(f.agents.size, 0);
  // Once that plugin is gone, setup's next save loads the settings, and the command is AZPR's.
  f.commands.delete('pr-review');
  assert.match(await f.invoke('pr-setup', '--language en'), /\nAZPR has loaded them: run \/pr-check <PR URL>\./);
  assert.match(await f.invoke('pr-review', '--help'), /^\[AZPR\] \/pr-review <Azure DevOps PR URL>/);

  // Also while AZPR starts without settings: between its look at the commands and its own registration.
  const starting = await fixture(t);
  const register = starting.context.rpc.register;
  starting.context.rpc.register = async (...inputs) => { starting.commands.set('pr-deep', { ...theirs, name: 'pr-deep' }); return register(...inputs); };
  t.after(await starting.setup({ environment: environmentOf(starting) }));
  assert.equal(starting.commands.get('pr-deep').description, 'Another plugin\'s review', 'The command registered meanwhile was not replaced.');
  assert.equal(starting.commands.get('pr-review').description, 'AZPR setup required; run /pr-setup');
  assert.deepEqual([...starting.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());

  // A plugin can take the name at any moment, also after AZPR looked and before the runtime does: what is
  // listed is read again before the commands that say so come back.
  const late = await fixture(t);
  t.after(await late.setup({ environment: environmentOf(late), releaseWaitMs: 50 }));
  const original = late.context.command.list;
  let lists = 0;
  late.context.command.list = async () => {
    // The first list is setup's, once its own commands are gone; the second is the runtime's.
    if (++lists === 2) late.commands.set('pr-comment', { ...theirs, name: 'pr-comment' });
    return original();
  };
  assert.match(await late.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${late.pat}"`), /\nAZPR could not load them: Reserved command name conflict: pr-comment /);
  assert.equal(late.commands.get('pr-comment').description, 'Another plugin\'s review', 'The command that arrived late was not replaced either.');
  assert.deepEqual([...late.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());
  assert.equal(late.commands.get('pr-review').description, 'AZPR setup required; run /pr-setup');

  // And where the host cannot say which names are taken after the load failed, none is registered on what was
  // known before: the next /pr-setup looks again.
  const silent = await fixture(t);
  t.after(await silent.setup({ environment: environmentOf(silent), releaseWaitMs: 50 }));
  silent.commands.set('pr-review', theirs);
  const listed = silent.context.command.list;
  let asked = 0;
  // Setup's look and the runtime's are answered; the look after the failure is not.
  silent.context.command.list = async () => { if (++asked > 2) throw new Error('host went away'); return listed(); };
  assert.match(await silent.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${silent.pat}"`), /\nAZPR could not load them: Reserved command name conflict: pr-review /);
  assert.deepEqual([...silent.commands.keys()].sort(), ['pr-review', 'pr-setup'], 'Nothing was registered on a guess.');
  assert.equal(silent.commands.get('pr-review'), theirs);
  silent.context.command.list = listed;
  assert.match(await silent.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP/);
  assert.deepEqual([...silent.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort(), 'The commands that say what is missing are back');
  assert.equal(silent.commands.get('pr-review'), theirs, 'except under the name that is another plugin\'s.');
});

test('settings that replaced the ones this setup saved are not loaded by its next save: they wait for the restart', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  // This setup's first save makes the settings usable, but loading them fails (another plugin has a command name).
  const original = f.context.command.list;
  f.context.command.list = async () => ({ data: [...(await original()).data, { name: 'pr-review', description: 'Another plugin\'s review' }] });
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`), /\nAZPR could not load them: Reserved command name conflict: pr-review /);
  f.context.command.list = original;
  // Another process then replaces the settings file, with settings this setup never saw.
  const theirs = { ...JSON.parse(await readFile(f.path, 'utf8')), shell: 'ask', afterReview: { review: 'publish', deep: 'publish', quick: 'publish' } };
  await writeFile(f.path, settingsText(theirs), { mode: 0o600 });
  // A save of this setup on top of them does not make them its own: they are not loaded.
  assert.match(await f.invoke('pr-setup', '--language ja'), /\nChanged: Output language\nTo load them, restart the OpenCode service /);
  const saved = await f.rpc.handlers.save({ changes: { report: 'full' } });
  assert.deepEqual([saved.ok, saved.status.state, f.agents.size], [true, 'restart', 0]);
  assert.deepEqual(f.rpc.events, []);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n.*can be used now, but AZPR found no usable settings when OpenCode loaded it for this project directory/);

  // The token is part of what a setup saved: another one in the file these settings name, written by something
  // else after a load that failed, is not loaded by this setup's next save either.
  const h = await fixture(t), own = environmentOf(h);
  t.after(await h.setup({ environment: own, releaseWaitMs: 50 }));
  const before = h.context.command.list;
  h.context.command.list = async () => ({ data: [...(await before()).data, { name: 'pr-review', description: 'Another plugin\'s review' }] });
  const first = await h.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  assert.deepEqual([first.ok, first.status.state], [true, 'restart']);
  h.context.command.list = before;
  await writeFile(JSON.parse(await readFile(h.path, 'utf8')).azure.patFile, NEW_TOKEN, { mode: 0o600 });
  const next = await h.rpc.handlers.save({ changes: { language: 'ja' } });
  assert.deepEqual([next.ok, next.status.state, h.agents.size], [true, 'restart', 0], 'The settings text is this setup\'s, the token is not.');

  // Nor is anything this setup's to load while its save leaves the settings unusable: here they name a token
  // file that is not there, and this setup changes one setting.
  const k = await fixture(t), bare = environmentOf(k);
  await mkdir(join(k.root, 'private config'), { mode: 0o700 });
  const missing = join(k.root, 'token to come');
  await writeFile(k.path, settingsText(withMissingSettings({ version: 2, models: { review: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/model' } }, azure: { organization: 'fixture', pat: '', patFile: missing } }).settings), { mode: 0o600 });
  t.after(await k.setup({ environment: bare, releaseWaitMs: 50 }));
  const changed = await k.rpc.handlers.save({ changes: { language: 'ja' } });
  assert.deepEqual([changed.ok, changed.status.state], [true, 'required']);
  // Someone else then puts the token there, which makes them usable; a save of this setup changes nothing about whose they are.
  await writeFile(missing, FAKE_PAT, { mode: 0o600 });
  const later = await k.rpc.handlers.save({ changes: { language: 'ja' } });
  const again = await k.rpc.handlers.save({ changes: { report: 'full' } });
  assert.deepEqual([later.status.state, again.status.state, k.agents.size, k.rpc.events.length], ['restart', 'restart', 0, 0]);

  // Whether the settings could be used and which token goes with them is said from one look at the token file:
  // a token that someone else puts there right after that look is not this setup's, whatever it saves.
  const once = await fixture(t), single = environmentOf(once);
  await mkdir(join(once.root, 'private config'), { mode: 0o700 });
  const awaited = join(once.root, 'token that arrives');
  await writeFile(once.path, settingsText(withMissingSettings({ version: 2, models: { review: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/model' } }, azure: { organization: 'fixture', pat: '', patFile: awaited } }).settings), { mode: 0o600 });
  t.after(await once.setup({ environment: single, releaseWaitMs: 50 }));
  const open = fsPromises.open;
  let looks = 0, arrived = false, outcome;
  fsPromises.open = async (file, ...rest) => {
    if (String(file) !== awaited || arrived) return open(file, ...rest);
    looks++;
    // The look finds no token; the other writer's token is there a moment later.
    try { return await open(file, ...rest); }
    finally { arrived = true; await writeFile(awaited, FAKE_PAT, { mode: 0o600 }); }
  };
  syncBuiltinESMExports();
  try { outcome = await once.rpc.handlers.save({ changes: { language: 'ja' } }); }
  finally { fsPromises.open = open; syncBuiltinESMExports(); }
  assert.deepEqual([looks, outcome.ok, outcome.status.state, once.agents.size, once.rpc.events.length], [1, true, 'restart', 0, 0]);

  // Settings that are switched off while this setup's save is being loaded load nothing, and that is no load.
  const off = await fixture(t), quiet = environmentOf(off);
  t.after(await off.setup({ environment: quiet, releaseWaitMs: 50 }));
  const asked = off.context.command.list;
  let switched = false;
  off.context.command.list = async () => {
    if (!switched && await readFile(off.path, 'utf8').then(() => true, () => false)) {
      switched = true;
      await writeFile(off.path, settingsText({ ...JSON.parse(await readFile(off.path, 'utf8')), enabled: false }), { mode: 0o600 });
    }
    return asked();
  };
  const answer = await off.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${off.pat}"`);
  off.context.command.list = asked;
  assert.equal(switched, true);
  assert.match(answer, /\nTo load them, restart the OpenCode service /);
  assert.deepEqual([off.agents.size, off.rpc.events.length, (await off.rpc.handlers.status({})).state], [0, 0, 'restart'], 'Nothing was loaded, and setup does not say that anything is ready.');
  assert.deepEqual([...off.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());

  // Or written in the moment this setup's own save ends: what a save leaves is what it wrote, not what a later
  // look at the token file finds.
  const r = await fixture(t), raced = environmentOf(r);
  t.after(await r.setup({ environment: raced, releaseWaitMs: 50, settingsPrepared: async () => {
    // This setup has made its token file and is writing its settings; another writer replaces the token.
    await writeFile(join(raced.XDG_CONFIG_HOME, 'azpr', 'pat-fixture'), NEW_TOKEN, { mode: 0o600 });
  } }));
  const mine = await r.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  assert.deepEqual([mine.ok, mine.status.state, r.agents.size, r.rpc.events.length], [true, 'restart', 0, 0], 'The token in the file is not the one this setup saved: nothing is loaded.');
  assert.match(await r.invoke('pr-check', r.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n/);

  // Also when they take the file's place in the moment between this setup's save and the load of what it saved.
  const g = await fixture(t), shared = environmentOf(g);
  t.after(await g.setup({ environment: shared, releaseWaitMs: 50 }));
  const list = g.context.command.list;
  let replaced = false;
  g.context.command.list = async () => {
    // Asked once the commands that say "setup required" are gone, right before the runtime reads the settings.
    if (!replaced && await readFile(g.path, 'utf8').then(() => true, () => false)) {
      replaced = true;
      await writeFile(g.path, settingsText({ ...JSON.parse(await readFile(g.path, 'utf8')), shell: 'ask' }), { mode: 0o600 });
    }
    return list();
  };
  const receipt = await g.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${g.pat}"`);
  g.context.command.list = list;
  assert.equal(replaced, true);
  assert.match(receipt, /\nTo load them, restart the OpenCode service /);
  assert.equal(g.agents.size, 0, 'What the runtime read was not this setup\'s text: it was unloaded again.');
  assert.deepEqual([...g.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort(), 'The commands that say so are back.');
  assert.match(await g.invoke('pr-check', g.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n/);
});

test('a /pr-setup that runs while a first setup is being loaded puts no command in the way of the load', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  const list = f.context.command.list;
  let help;
  f.context.command.list = async () => {
    // Asked while the commands that say "setup required" are away for the load: another /pr-setup runs right then.
    if (!help) {
      help = f.commands.get('pr-setup').execute({ sessionID: 'other', prompt: { text: '--help' } });
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
    }
    return list();
  };
  await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`);
  await help;
  f.context.command.list = list;
  assert.ok(f.reports.some(report => /\nAZPR has loaded them: run \/pr-check <PR URL>\./.test(report)), f.reports.join('\n---\n'));
  assert.ok(f.agents.has('azpr-review-functional'));
  assert.match(await f.invoke('pr-review', '--help'), /^\[AZPR\] \/pr-review <Azure DevOps PR URL>/, 'The review command is the runtime\'s.');
});

test('a first setup that cannot be loaded is saved and says why; a host without the RPC keeps the options', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  delete f.context.rpc;
  const cleanup = await f.setup({ environment, releaseWaitMs: 50 });
  assert.equal(f.rpc.handlers, null, 'No RPC is registered where the host has none.');
  // Another plugin took a review command's name after AZPR was loaded: the runtime refuses to load beside it.
  const original = f.context.command.list;
  f.context.command.list = async () => ({ data: [...(await original()).data, { name: 'pr-review' }] });
  const receipt = await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`);
  assert.match(receipt, /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nOrganization: fixture; PAT file: .+\nAZPR could not load them: Reserved command name conflict: pr-review Repair that, then restart the OpenCode service /);
  assert.equal(f.agents.size, 0);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n[\s\S]*Reserved command name conflict: pr-review/, 'The commands that say so are back.');
  f.context.command.list = original;
  // The settings are fine by now, and a review command says what stands in the way; setup itself tries again.
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n.*are saved, but AZPR could not load them: Reserved command name conflict: pr-review Repair that, then restart/);
  assert.equal(f.agents.size, 0);
  assert.match(await f.invoke('pr-setup', '--language en'), /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nChanged: Output language\nAZPR has loaded them: run \/pr-check <PR URL>\./);
  assert.ok(f.agents.has('azpr-review-functional'));
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  await cleanup();
  assert.equal(f.commands.size, 0);
  // After it was unloaded, a save that was still under way loads nothing.
  const late = await fixture(t);
  const unload = await late.setup({ environment: environmentOf(late) });
  const save = late.rpc.handlers.save;
  await unload();
  await writeFile(late.pat, FAKE_PAT, { mode: 0o600 });
  const result = await save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  assert.deepEqual([result.ok, result.status.state, late.agents.size, late.commands.size], [true, 'restart', 0, 0]);
});
