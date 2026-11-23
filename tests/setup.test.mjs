import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, readdir, cp, utimes } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMissingSettings, defaultPatFile, settingsFileFor, parseSetupArguments, saveSetup, setupPlugin } from '../src/setup.mjs';
import { AFTER_REVIEW, COMMANDS, MAX_REVIEWERS, MIGRATION_NEEDED, SETTING_DEFAULTS, TERMINAL_PANEL, migrateSettings, settingsText, validateSettings, withMissingSettings } from '../src/config.mjs';
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
  // The update of settings of 0.4.x is confirmed by the word /pr-setup showed for it, and by nothing else: the option stands alone.
  assert.deepEqual(parseSetupArguments('--migrate 0123456789ab'), { '--migrate': '0123456789ab' });
  for (const input of ['--migrate 0123456789ab --language ja', '--language ja --migrate 0123456789ab', '--migrate 0123456789ab --deep-model off',
    '--organization org --model fixture/model --migrate 0123456789ab', '--organization org --model fixture/model --replace --migrate 0123456789ab']) {
    assert.throws(() => parseSetupArguments(input), { message: '[AZPR] --migrate stands alone: update the settings first, then change them. Use /pr-setup --help.' }, input);
  }
  for (const input of ['--migrate', '--migrate --language', '--migrate 0123456789ab --replace', '--migrate 0123456789ab --pat-file /pat', '--migrate 0123456789ab --migrate 0123456789ab']) {
    assert.throws(() => parseSetupArguments(input), /^Error: \[AZPR\] /, input);
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
  // One model named for a first setup: two passes of /pr-review and one of /pr-quick; /pr-deep stays off.
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.models, { review: { reviewers: ['fixture/model#high', 'fixture/model#high'], rater: '' },
    quick: { reviewers: ['fixture/model#high'], rater: '' }, deep: { reviewers: [], rater: '' } });
  // The file names every setting, so that each can be found and changed there.
  assert.deepEqual(withMissingSettings(saved).added, []);
  assert.equal(saved.terminalPanel, 'auto');
  assert.deepEqual(saved.afterReview, { quick: 'preview', review: 'preview', deep: 'preview' });
  assert.equal(saved.azure.pat, '');
  assert.equal(saved.azure.patFile, f.pat);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.root, 'private config'))).mode & 0o777, 0o700);
  // Nothing was loaded before, so the settings are read now, once: the commands are the real ones, without a restart.
  assert.ok(f.agents.has('azpr-review-reviewer'), 'The first setup loaded the runtime.');
  // A private role per pass: two for /pr-review, one for /pr-quick and none for /pr-deep, which is off.
  assert.deepEqual([...f.agents.keys()].filter(name => /-reviewer[b-d]?$/.test(name)).sort(), ['azpr-quick-reviewer', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  assert.deepEqual([...f.commands.keys()].sort(), ['pr-setup', ...Object.keys(COMMANDS)].sort());
  await assert.rejects(f.invoke('pr-review', 'a URL'), /absolute HTTPS Azure DevOps PR URL/, 'The review command itself answers.');
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  // A second setup changes settings that are in use: it waits for a restart, as before.
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`),
    /^\[AZPR\] SETTINGS SAVED\n[\s\S]*\nTo load them, restart the OpenCode service /);
  await cleanup();
  assert.equal(f.commands.size, 0, 'Unloading removes every command, also those the first setup brought.');
  t.after(await f.setup());
  assert.ok(f.agents.has('azpr-review-reviewer'));
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
  raw.models.deep = { reviewers: ['fixture/deep', 'fixture/deep#high', 'fixture/other'] };
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
    workflow: { parallelSessions: 2, shardFiles: 25, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 },
    debug: { enabled: true, directory: 'private-debug', keepRuns: 20 } });
  // A replacement names the review and quick models anew, as a first setup does: the usual passes of the one
  // model. Who rates is not asked, so it stays, also a rating that was switched off; and so does /pr-deep.
  Object.assign(saved.models, { review: { reviewers: ['fixture/model', 'fixture/other', 'fixture/model'], rater: false }, quick: { reviewers: ['fixture/other', 'fixture/other'], rater: 'fixture/rater' } });
  await writeFile(f.path, JSON.stringify(saved));
  await saveSetup(f.context, f.path, { ...f.args, '--replace': true, '--organization': 'changed', '--model': 'fixture/model#high' });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { ...saved, models: { review: { reviewers: ['fixture/model#high', 'fixture/model#high'], rater: false },
    quick: { reviewers: ['fixture/model#high'], rater: 'fixture/rater' }, deep: saved.models.deep } });
  t.after(await f.setup());
  assert.equal(f.commands.size, 0, 'enabled:false registers nothing.');
});

test('invalid JSON and unknown settings are never silently replaced or leaked', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'));
  // The same faults in a file of 0.4.x (settings version 2): one that is no JSON object with unique keys is
  // repaired by hand like any other, and one with an unknown setting takes its update and nothing else.
  for (const [content, problem] of [['{"pat":"PRIVATE_TOKEN",}', /^\[AZPR\] settings\.json must be a JSON object without duplicate keys; repair it manually before setup\.$/],
    ['{"version":2,"version":2}', /^\[AZPR\] settings\.json must be a JSON object without duplicate keys; repair it manually before setup\.$/],
    [JSON.stringify({ version: 2, unknown: 'PRIVATE_TOKEN' }), /^\[AZPR\] settings\.json is from AZPR 0\.4\.x \(settings version 2\)\. .* Other options work after that\.$/],
    ['{"version":3,"version":3}', /^\[AZPR\] settings\.json must be a JSON object without duplicate keys; repair it manually before setup\.$/],
    [JSON.stringify({ version: 3, unknown: 'PRIVATE_TOKEN' }), /^Unknown setting settings\.unknown; check for a typo\.$/]]) {
    await writeFile(f.path, content);
    await assert.rejects(saveSetup(f.context, f.path, { ...f.args, '--replace': true }), error => problem.test(error.message) && !error.message.includes('PRIVATE_TOKEN'), content);
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
  const { review, quick } = JSON.parse(await readFile(f.path, 'utf8')).models;
  assert.deepEqual([review.reviewers, quick.reviewers], [['fixture/model#default', 'fixture/model#default'], ['fixture/model#default']]);
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
  // A session of any private role, also of the roles of 0.4.x, which the sessions of saved reviews still name.
  for (const agent of ['azpr-review-reviewer', 'azpr-quick-reviewerd', 'azpr-deep-rating', 'azpr-review-comment-plan-verified', 'azpr-review-functional', 'azpr-deep-verifier']) {
    f.context.session.get = async () => ({ data: { agent } });
    await assert.rejects(f.invoke('pr-setup', '--help'), /Private reviewers/, agent);
    await assert.rejects(f.invoke('pr-setup', ''), /Private reviewers/, agent);
  }
  f.context.session.get = async () => ({ data: { agent: 'build' } });
  assert.match(await f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP REQUIRED\n/, 'Any other session is answered.');
  const g = await fixture(t), original = { name: 'pr-setup' };
  g.commands.set('pr-setup', original);
  await assert.rejects(g.setup(), /Reserved command name conflict/);
  assert.equal(g.commands.get('pr-setup'), original);
});

// A settings file that names what /pr-setup asks for and nothing else, as a person writes one by hand or an
// earlier version left it: every setting that came later is missing from it.
const minimalSettings = f => ({ version: 3, models: { review: { reviewers: ['fixture/model', 'fixture/model'] }, quick: { reviewers: ['fixture/model'] } },
  azure: { organization: 'fixture', pat: '', patFile: f.pat } });
// The same of AZPR 0.4.x (settings version 2), as 0.4.1's /pr-setup wrote it: three models for a review, one for a quick review.
const legacyMinimal = f => ({ version: 2, models: { review: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/model' }, quick: { reviewer: 'fixture/model' } },
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
  assert.match(report, /\| Settings \| ok \| 23 setting\(s\) the settings file left out were added to it when AZPR loaded, at their defaults: models\.review\.rater, models\.deep, models\.quick\.rater, enabled, returnReport, debug, runTimeoutSeconds, shell and 15 more\. \|/);
  // What was added says how the file behaved already: the first reviewer model rates, and /pr-deep is off.
  assert.deepEqual(saved.models, { review: { reviewers: ['fixture/model', 'fixture/model'], rater: '' }, quick: { reviewers: ['fixture/model'], rater: '' }, deep: { reviewers: [], rater: '' } });
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
  // Not usable: the person repairs it; nothing is added around the problem. Nor to settings of another
  // version, whatever they lack: those of 0.4.x (version 2) are changed only by the update a person confirms.
  for (const broken of [JSON.stringify({ ...minimalSettings(f), shel: 'ask' }), '{"version": 3, "version": 3}', 'not JSON',
    JSON.stringify({ ...minimalSettings(f), models: { review: { reviewers: 'fixture/model' } } }), JSON.stringify({ ...minimalSettings(f), version: 4 }),
    JSON.stringify(legacyMinimal(f)), JSON.stringify({ ...legacyMinimal(f), shel: 'ask' }), JSON.stringify({ ...legacyMinimal(f), enabled: false }), '{"version": 2, "version": 2}']) {
    await writeFile(f.path, broken);
    await (await f.setup())();
    assert.equal(await readFile(f.path, 'utf8'), broken);
    assert.deepEqual(await addMissingSettings(f.path), { added: [] }, 'Called by itself it changes no such file either.');
    assert.equal(await readFile(f.path, 'utf8'), broken);
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
  assert.match(report, /\| Settings \| WARNING \| 20 setting\(s\) are not in the settings file and could not be added to it: Setup refuses a symbolic link for settings\.json\. Their defaults apply: models\.review\.rater, models\.deep, models\.quick\.rater, enabled and 16 more\. \|/);
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
  // What it lacks, by name: who rates, the modes that are off, and every setting /pr-setup does not ask for.
  assert.deepEqual(held.missing, ['models.review.rater', 'models.deep', 'models.quick.rater', 'enabled', 'returnReport', 'debug', 'outputLanguage', 'runTimeoutSeconds', 'shell', 'progressNotices',
    'deletePrivateSessions', 'terminalPanel', 'afterReview', 'azure.concurrency', 'azure.callTimeoutSeconds', 'azure.archiveMegabytes', 'azure.proxy', 'azure.caFile', 'azure.verifyTls', 'workflow']);
  assert.equal(held.missing.length, 20);
  assert.equal(held.problem, 'Another setup is active, or its lock was left behind (if none is running, delete settings.json.setup.lock beside the settings file). No settings changed.');
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  // A lock left behind long ago has no writer to wait for: the load goes on at once.
  const longAgo = new Date(Date.now() - 120000);
  await utimes(`${f.path}.setup.lock`, longAgo, longAgo);
  const startedOld = Date.now();
  const old = await addMissingSettings(f.path, { waitMs: 5000, pauseMs: 20 });
  assert.ok(Date.now() - startedOld < 2000, 'Nothing waits for a lock that no one will release.');
  assert.deepEqual([old.added.length, old.missing.length, old.problem], [0, 20, held.problem]);
  assert.equal(await readFile(f.path, 'utf8'), minimal);
  await writeFile(`${f.path}.setup.lock`, '');
  // A lock that goes away: the file is completed after it.
  setTimeout(() => rm(`${f.path}.setup.lock`), 60);
  const after = await addMissingSettings(f.path, { waitMs: 3000, pauseMs: 20 });
  assert.equal(after.added.length, 20);
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
  assert.match(waiting, /\| Settings \| WARNING \| 20 setting\(s\) are not in the settings file and could not be added to it: Another setup is active, or its lock was left behind \(if none is running, delete settings\.json\.setup\.lock beside the settings file\)\. No settings changed\. Their defaults apply: models\.review\.rater, models\.deep and 18 more\. \|/);
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

test('legacy installed configuration loads where it is, without being moved or rewritten, and changes still block new runs', async t => {
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
    // A list of models: an entry is named by its place, never shown; so is a list that is none, too long or empty, and a rater.
    [JSON.stringify({ ...valid, models: { review: { reviewers: ['fixture/model', 'PRIVATE_VALUE'] } } }), /models\.review\.reviewers\[1\]: select an actual provider\/model ID/],
    [JSON.stringify({ ...valid, models: { review: { reviewers: 'PRIVATE_VALUE' } } }), /models\.review\.reviewers must be a list of models, one per review pass \(1 to 4\)\./],
    [JSON.stringify({ ...valid, models: { review: { reviewers: Array(5).fill('PRIVATE_VALUE') } } }), /models\.review\.reviewers takes at most 4 models, one per review pass\./],
    [JSON.stringify({ ...valid, models: { review: { reviewers: [] } } }), /models\.review\.reviewers needs at least one model: \/pr-review runs one pass per entry\./],
    [JSON.stringify({ ...valid, models: { ...valid.models, deep: { reviewers: {}, rater: 'PRIVATE_VALUE' } } }), /models\.deep\.reviewers must be a list of models, one per review pass \(1 to 4; an empty list leaves the mode off\)\./],
    [JSON.stringify({ ...valid, models: { ...valid.models, deep: { reviewers: ['fixture/model'], rater: 'PRIVATE_VALUE' } } }), /models\.deep\.rater: select an actual provider\/model ID/],
    [JSON.stringify({ ...valid, models: { ...valid.models, quick: { reviewers: [], rater: ['PRIVATE_VALUE'] } } }), /models\.quick\.rater must be "" \(the first reviewer model rates\), a provider\/model ID, or false \(no severity rating\)\./],
    // The model roles of 0.4.x under this version's number are settings it does not know.
    [JSON.stringify({ ...valid, models: { review: { functional: 'PRIVATE_VALUE', risk: 'fixture/model', verifier: 'fixture/model' } } }), /Unknown setting models\.review\.functional; check for a typo\./],
    [JSON.stringify({ ...valid, workflow: { shardFindings: 15 } }), /Unknown setting workflow\.shardFindings; check for a typo\./],
    [JSON.stringify({ ...valid, version: 4 }), /settings\.version must be 3\. Use the settings example of this version; older layouts are not supported\./],
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
  // Settings of 0.4.x: what their update changes is shown with the models it is about, but a value that is no
  // model ID is named, not shown: a model slot may hold something that was pasted into the wrong place.
  await writeFile(f.path, JSON.stringify({ ...legacyMinimal(f), models: { review: { functional: 'fixture/model', risk: 'fixture/model#high', verifier: 'PRIVATE_VALUE' }, quick: { reviewer: 'fixture/model' } } }));
  const [refused, update] = await shown();
  assert.equal(refused, `[AZPR] SETTINGS UPDATE REQUIRED\nNo review or Azure request was started. Settings: ${f.path}\n${MIGRATION_NEEDED}`);
  assert.match(update, /^\[AZPR\] SETTINGS UPDATE\nSettings: .+\n\n[^\n]+\n\n- [^\n]+\n- \/pr-review: functional fixture\/model, risk fixture\/model#high, verifier \(not a model ID\) -> 2 passes: fixture\/model, fixture\/model#high\. The verifier model is no longer used\.\n/);
  for (const text of [refused, update]) assert.doesNotMatch(text, /PRIVATE_|fixture-pat/, 'No setting value or PAT is shown.');
  // The same for a file of 0.4.x that has a fault as well: whatever the fault, the commands name the update, and
  // /pr-setup shows it with the fault the file will still have, by the setting's name.
  await writeFile(f.path, JSON.stringify({ ...legacyMinimal(f), afterReview: { review: 'PRIVATE_VALUE' }, azure: { ...legacyMinimal(f).azure, PRIVATE_TOKEN_0123456789abcdefghijklmnopqrstuvwxyz: '' } }));
  const [faulty, offer] = await shown();
  assert.equal(faulty, refused);
  assert.match(offer, /\n- After the update the settings still cannot be used: afterReview\.review must be none, preview or publish\. Nothing runs until that is set right, with \/pr-setup or in the settings file\.\n\n/);
  for (const text of [faulty, offer]) assert.doesNotMatch(text, /PRIVATE_|fixture-pat/, 'No setting value or PAT is shown.');
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
/**
 * The terminal part's setup against this fixture's server part: dialogs answer from a list, everything shown is kept.
 * An answer that is a function is called when its dialog opens, and what it returns is the answer.
 */
function dialogs(f, answers) {
  const shown = [], toasts = [];
  const queue = [...answers];
  const next = (kind, options) => {
    shown.push({ kind, ...options });
    if (!queue.length) throw new Error(`No answer was scripted for the ${kind} "${options.title}".`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(options) : answer;
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
  // A mode's models are a list: no entry yet, how many passes one model named alone becomes, and how many there may be.
  assert.deepEqual(['reviewModel', 'quickModel', 'deepModel'].map(id => { const { label, value, current, entries, usual, most } = rowsOf(before)[id]; return [label, value, current, entries, usual, most]; }),
    [['Review models', 'not set', '', [], 2, 4], ['Quick models', 'off', '', [], 1, 4], ['Deep models', 'off', '', [], 2, 4]]);
  assert.deepEqual(before.rows.filter(row => row.entries !== undefined || row.usual !== undefined || row.most !== undefined).map(row => row.id), ['reviewModel', 'quickModel', 'deepModel'], 'Only they are lists.');
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
  // One model was asked for, and what the dialog said it would become is what was written: two passes of
  // /pr-review and one of /pr-quick, in a new file of this version; /pr-deep is off.
  assert.match(d.shown.find(item => item.kind === 'confirm').message, /\nModel: fixture\/model \(two passes of \/pr-review, one of \/pr-quick\)\n/);
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.models, { review: { reviewers: ['fixture/model', 'fixture/model'], rater: '' }, quick: { reviewers: ['fixture/model'], rater: '' }, deep: { reviewers: [], rater: '' } });
  assert.deepEqual(withMissingSettings(saved).added, [], 'The file names every setting.');
  assert.equal(await readFile(tokenFile, 'utf8'), FAKE_PAT, 'The token file holds the token alone.');
  assert.deepEqual([await mode(tokenFile), await mode(f.path), await mode(join(environment.XDG_CONFIG_HOME, 'azpr')), await mode(join(f.root, 'private config'))], [0o600, 0o600, 0o700, 0o700]);
  assert.deepEqual((await readdir(join(environment.XDG_CONFIG_HOME, 'azpr'))), ['pat-fixture'], 'No temporary file is left beside the token.');

  // Nothing was loaded before, so the settings are in use now: the review commands are the real ones, and the
  // server part said so once, for clients that would otherwise keep the commands they knew.
  assert.ok(f.agents.has('azpr-review-reviewer'));
  assert.deepEqual(f.rpc.events, [['loaded', {}]]);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  const after = await f.rpc.handlers.status({});
  // A row has room for a few words: each model without its provider, with its number of passes. A dialog starts from the list as text.
  assert.deepEqual([after.state, after.problem, after.organization, rowsOf(after).token.saved, rowsOf(after).token.value, rowsOf(after).reviewModel.value, rowsOf(after).quickModel.value, rowsOf(after).deepModel.value],
    ['ready', '', 'fixture', true, 'saved', 'model ×2', 'model', 'off']);
  assert.deepEqual(['reviewModel', 'quickModel', 'deepModel'].map(id => [rowsOf(after)[id].current, rowsOf(after)[id].entries]),
    [['fixture/model*2', ['fixture/model', 'fixture/model']], ['fixture/model*1', ['fixture/model']], ['', []]]);
  assert.ok(rowsOf(after).token.description.endsWith(` The saved token is in ${tokenFile}.`), 'The token\'s dialog says where the saved token is.');
  assert.match(after.settingsFileShown, /^…\/private config\/settings\.json$/);
  // What the list says beside a row whose name does not: what each model is used for, and what makes a deep model one.
  assert.equal(after.settingsReference, 'the README\'s section "All settings and defaults" (https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2#all-settings-and-defaults)');
  assert.deepEqual([rowsOf(after).reviewModel.hint, rowsOf(after).quickModel.hint, rowsOf(after).deepModel.hint], ['for /pr-review', 'for /pr-quick', 'for /pr-deep'], 'Short: the list shows it between a name and a value.');
  assert.deepEqual([rowsOf(after).deepModel.title, rowsOf(after).deepModel.prompt, rowsOf(after).deepModel.variantPrompt], ['Model for /pr-deep', 'Stronger than the review model, or a higher variant', 'A higher variant reasons longer']);
  assert.deepEqual([rowsOf(after).organization.hint, rowsOf(after).reviewModel.prompt, rowsOf(after).reviewModel.variantPrompt, rowsOf(after).language.hint], [undefined, undefined, undefined, undefined]);
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
  assert.ok(f.agents.has('azpr-review-reviewer'));
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
  // Settings that name a token file but no organization, as a person may have left them: in this version's
  // layout, and in that of 0.4.x, which takes its update first; what the update leaves is held to the same rules.
  for (const version of [3, 2]) {
    const f = await fixture(t), environment = environmentOf(f);
    await mkdir(join(f.root, 'private config'), { mode: 0o700 });
    await writeFile(f.path, JSON.stringify({ version, azure: { patFile: f.pat } }), { mode: 0o600 });
    t.after(await f.setup({ environment }));
    if (version === 2) {
      // Until their update is confirmed, settings of 0.4.x take neither a token nor an organization, and no token is sent for them.
      const offered = await f.rpc.handlers.status({});
      assert.deepEqual([offered.state, offered.editable, rowsOf(offered).token.value, rowsOf(offered).token.saved], ['migrate', false, 'saved without an organization', false]);
      for (const input of [{ changes: { organization: 'fixture', model: 'fixture/model' }, token: NEW_TOKEN }, { changes: { organization: 'fixture', model: 'fixture/model' } }, { token: NEW_TOKEN, organization: 'fixture' }]) {
        assert.deepEqual(await f.rpc.handlers.save(input), { ok: false, problem: MIGRATION_NEEDED }, JSON.stringify(Object.keys(input)));
      }
      for (const input of [{ organization: 'fixture' }, { organization: 'fixture', token: NEW_TOKEN }]) assert.deepEqual(await f.rpc.handlers.check(input), { ok: false, fix: '', problem: MIGRATION_NEEDED });
      assert.deepEqual([await readFile(f.path, 'utf8'), await readFile(f.pat, 'utf8'), f.azure.state.calls.length], [JSON.stringify({ version, azure: { patFile: f.pat } }), FAKE_PAT, 0]);
      // The update changes the layout and nothing else: the file still names that token file and no organization,
      // and still has no models, which the answer says.
      const updated = await f.rpc.handlers.save({ migrate: offered.migration.word });
      assert.deepEqual([updated.ok, updated.remaining, updated.status.state], [true, 'models.review.reviewers needs at least one model: /pr-review runs one pass per entry.', 'required']);
      const left = JSON.parse(await readFile(f.path, 'utf8'));
      assert.deepEqual([left.version, left.azure.organization, left.azure.patFile, left.models.review.reviewers, f.azure.state.calls.length, f.agents.size], [3, undefined, f.pat, [], 0, 0]);
    }
    const start = await readFile(f.path, 'utf8');
    const first = await f.rpc.handlers.status({});
    assert.deepEqual([first.state, first.editable, first.migration], ['required', true, undefined], `version ${version}`);
    const row = rowsOf(first).token;
    assert.deepEqual([row.saved, row.value], [false, 'saved without an organization']);
    assert.ok(row.description.endsWith(` The token in ${f.pat} was saved without an organization and is not used; the token you enter gets a file of its own.`));
    // Naming an organization does not make that token the organization's: it needs one of its own, saved with it.
    assert.deepEqual([row.bound, await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' } })],
      [true, { ok: false, problem: 'The token these settings name was saved without an organization. An organization needs a token of its own: enter it together with the organization.' }]);
    assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture' }), { ok: false, fix: 'token', problem: 'No token is saved for an organization yet.' });
    assert.equal(f.azure.state.calls.length, 0);
    assert.equal(await readFile(f.path, 'utf8'), start, 'Nothing was saved.');
    await assert.rejects(lstat(join(f.root, 'pat-fixture')), { code: 'ENOENT' }, 'And no token file was made.');
    f.azure.state.pat = NEW_TOKEN;
    const d = dialogs(f, ['fixture', '', NEW_TOKEN, 'fixture/model', '', true]);
    await d.setup.open();
    assert.equal(d.left(), 0);
    assert.equal(await readFile(f.pat, 'utf8'), FAKE_PAT, 'What the dialog said is what happened: that file was not written.');
    const written = JSON.parse(await readFile(f.path, 'utf8')), saved = written.azure;
    assert.deepEqual([saved.patFile, await readFile(saved.patFile, 'utf8'), await mode(saved.patFile)], [join(f.root, 'pat-fixture'), NEW_TOKEN, 0o600]);
    assert.match(d.shown.at(-1).message, /\/pr-setup shows and changes these settings\.$/, 'No earlier token of these settings is left behind: nothing more is said.');
    // Whichever layout the file had at first, the first setup completed it, and it is in use.
    assert.deepEqual([written.version, written.models.review.reviewers, written.models.quick.reviewers, f.agents.has('azpr-review-reviewer')], [3, ['fixture/model', 'fixture/model'], ['fixture/model'], true], `version ${version}`);
  }

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
  await writeFile(f.path, JSON.stringify({ version: 3, azure: { organization: 'fixture', pat: '', patFile: f.pat } }), { mode: 0o600 });
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
  assert.ok(f.agents.has('azpr-review-reviewer'), 'This save made the settings usable: they are loaded.');
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
    // A mode's models: one model named alone is that mode's usual number of passes, and `off` leaves /pr-quick or /pr-deep off.
    [{ deepModel: 'fixture/model#high' }, 'deepModel', 'model#high ×2', raw => raw.models.deep],
    [{ quickModel: 'off' }, 'quickModel', 'off', raw => raw.models.quick],
    [{ reviewModel: 'fixture/model#high' }, 'reviewModel', 'model#high ×2', raw => raw.models.review],
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
  assert.deepEqual(saved.models, { review: { reviewers: ['fixture/model#high', 'fixture/model#high'], rater: '' },
    deep: { reviewers: ['fixture/model#high', 'fixture/model#high'], rater: '' }, quick: { reviewers: [], rater: '' } });
  // Everything setup does not ask for is as it was, and the file is still owner-only and complete.
  const untouched = ({ models, outputLanguage, afterReview, returnReport, progressNotices, terminalPanel, debug, ...rest }) => rest;
  assert.deepEqual(untouched(saved), untouched(JSON.parse(initial)));
  assert.equal(await mode(f.path), 0o600);
  // The runtime still has the settings it read: it refuses new runs until the restart, as for any changed file.
  await f.invoke('pr-check', f.azure.prUrl());
  for (let attempt = 0; attempt < 200 && !f.reports.some(report => /settings\.json changed since OpenCode loaded it/.test(report)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.reports.at(-1), /settings\.json changed since OpenCode loaded it\. Restart the OpenCode service/);
  // A value that differs between the modes is shown as that; a list of several models as its models in their order.
  await writeFile(f.path, JSON.stringify({ ...saved, afterReview: { quick: 'none', review: 'preview', deep: 'publish' }, models: { ...saved.models, review: { reviewers: ['fixture/model', 'fixture/model#high', 'fixture/model#high', 'fixture/model'] } } }));
  assert.deepEqual([await value('afterReview'), await value('reviewModel')], ['differs by mode', 'model + model#high ×2 + model'], 'The list has room for a few words; the file has each value.');
  assert.deepEqual([rowsOf(await status({})).afterReview.current, rowsOf(await status({})).reviewModel.current], ['', 'fixture/model*1,fixture/model#high*2,fixture/model*1'], 'A dialog starts from no choice, or from the list as it is.');
  // Passes are counted by the whole reference: two providers' models of one name are two models, shown with their providers.
  await writeFile(f.path, JSON.stringify({ ...saved, models: { ...saved.models, review: { reviewers: ['first/opus', 'second/opus', 'second/opus', 'fixture/model'] } } }));
  assert.equal(await value('reviewModel'), 'first/opus + second/opus ×2 + model');
  const refused = await save({ changes: { language: 'no such language' } });
  assert.deepEqual([refused.ok, refused.problem], [false, 'outputLanguage must be a language tag such as en, zh-TW, zh-CN, or ja (not a language name or instruction).']);
});

test('a mode\'s models are given as text: a model alone is the mode\'s usual passes, MODEL*N that many, and commas a list of at most four passes', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  // Two models that can review, one of them with a variant, and two that cannot.
  f.context.model.list = async () => ({ data: [{ providerID: 'fixture', id: 'model', enabled: true, capabilities: { tools: true }, variants: [{ id: 'high' }] },
    { providerID: 'fixture', id: 'other', enabled: true, capabilities: { tools: true } },
    { providerID: 'fixture', id: 'chat', enabled: true, capabilities: { tools: false } }, { providerID: 'fixture', id: 'retired', enabled: false, capabilities: { tools: true } }] });
  await saveSetup(f.context, f.path, f.args);
  // A rating that is switched off, and one that another model does: a list of models says nothing about who rates.
  const start = JSON.parse(await readFile(f.path, 'utf8'));
  Object.assign(start.models, { review: { ...start.models.review, rater: false }, deep: { reviewers: [], rater: 'fixture/other' } });
  await writeFile(f.path, settingsText(start), { mode: 0o600 });
  const initial = await readFile(f.path, 'utf8');
  t.after(await f.setup({ environment }));
  const { validate, save, status } = f.rpc.handlers;
  const A = 'fixture/model', B = 'fixture/other';
  // What an answer becomes: the list as text again, with every model's number of passes, and the few words a row shows; or what is wrong with it.
  const read = async (id, answer) => { const result = await validate({ changes: { [id]: answer } }); return result.ok ? [result.values[id], result.shown[id]] : result.problem; };
  for (const [id, answer, list, shown] of [
    // One model named alone: the usual number of passes of its mode.
    ['reviewModel', A, `${A}*2`, 'model ×2'], ['deepModel', A, `${A}*2`, 'model ×2'], ['quickModel', A, `${A}*1`, 'model'],
    ['reviewModel', `${A}#high`, `${A}#high*2`, 'model#high ×2'], ['quickModel', ` ${B} `, `${B}*1`, 'other'], ['deepModel', `${A}#default`, `${A}#default*2`, 'model#default ×2'],
    // With a number: that many passes, also exactly one where two are usual.
    ['reviewModel', `${A}*1`, `${A}*1`, 'model'], ['reviewModel', `${A}*3`, `${A}*3`, 'model ×3'], ['reviewModel', `${A}*4`, `${A}*4`, 'model ×4'], ['reviewModel', ` ${A} * 2 `, `${A}*2`, 'model ×2'],
    ['quickModel', `${A}*2`, `${A}*2`, 'model ×2'], ['deepModel', `${A}#high*1`, `${A}#high*1`, 'model#high'],
    // Several entries: one pass each unless a number says more, in the order of the passes; a model may come back later.
    ['reviewModel', `${A},${B}`, `${A}*1,${B}*1`, 'model + other'], ['reviewModel', `${A}*2,${B}`, `${A}*2,${B}*1`, 'model ×2 + other'],
    ['reviewModel', `${B}, ${A}*2 ,${B}`, `${B}*1,${A}*2,${B}*1`, 'other + model ×2 + other'], ['reviewModel', `${A},${A}`, `${A}*2`, 'model ×2'],
    ['quickModel', `${A},${A}#high,${A}`, `${A}*1,${A}#high*1,${A}*1`, 'model + model#high + model'], ['deepModel', `${A}*2,${B}*2`, `${A}*2,${B}*2`, 'model ×2 + other ×2'],
    ['deepModel', `${B},${A},${B},${A}`, `${B}*1,${A}*1,${B}*1,${A}*1`, 'other + model + other + model'],
    // /pr-quick and /pr-deep may be off: by either word, in any letters, or by an empty answer.
    ...['off', 'none', ' OFF ', 'None', '', '  '].flatMap(answer => [['quickModel', answer, '', 'off'], ['deepModel', answer, '', 'off']]),
  ]) assert.deepEqual(await read(id, answer), [list, shown], `${id}: ${JSON.stringify(answer)}`);
  const NO_MODEL = ': select an actual provider/model ID from opencode models, optionally with a variant as provider/model#variant; do not use a display name or placeholder.';
  const NO_COUNT = ': after the star comes the number of passes, 1 to 4.';
  for (const [id, answer, problem] of [
    // /pr-review cannot be off: it needs a model.
    ['reviewModel', 'off', `The model${NO_MODEL}`], ['reviewModel', 'none', `The model${NO_MODEL}`], ['reviewModel', '', `The model${NO_MODEL}`],
    // At most four passes in all, however they are written.
    ['reviewModel', `${A}*5`, 'Review models take at most 4 passes in all.'], ['reviewModel', `${A}*10`, 'Review models take at most 4 passes in all.'],
    ['quickModel', `${A}*3,${B}*2`, 'Quick models take at most 4 passes in all.'], ['deepModel', `${A},${B},${A},${B},${A}`, 'Deep models take at most 4 passes in all.'],
    // A number of passes is a number from 1; what is wrong in a list is said by the entry's place.
    ...['*0', '*', '*two', '*1.5', '*-1', '*100', '*1 2'].map(count => ['reviewModel', `${A}${count}`, `The model${NO_COUNT}`]),
    ['deepModel', `${A},${B}*0`, `Entry 2${NO_COUNT}`], ['quickModel', `${A}*x,${B}`, `Entry 1${NO_COUNT}`],
    // What is no model ID: a display name, a placeholder, an entry left empty, a list separated by blanks, a second star.
    ['reviewModel', 'Fixture Model', `The model${NO_MODEL}`], ['reviewModel', 'REPLACE_PROVIDER/REPLACE_MODEL', `The model${NO_MODEL}`], ['reviewModel', `${A} ${B}`, `The model${NO_MODEL}`],
    ['reviewModel', `${A}**2`, `The model${NO_MODEL}`], ['reviewModel', '*2', `The model${NO_MODEL}`], ['quickModel', `off,${A}`, `Entry 1${NO_MODEL}`],
    ['reviewModel', `${A},Fixture Model`, `Entry 2${NO_MODEL}`], ['reviewModel', `${A},`, `Entry 2${NO_MODEL}`], ['reviewModel', `,${A}`, `Entry 1${NO_MODEL}`], ['deepModel', `${A},,${B}`, `Entry 2${NO_MODEL}`],
    // A model OpenCode does not offer, offers without tools, or without that variant; in a list, which model it is.
    ['reviewModel', 'fixture/absent', 'The selected model is unavailable in OpenCode. Choose an enabled ID from opencode models.'],
    ['quickModel', 'fixture/retired*2', 'The selected model is unavailable in OpenCode. Choose an enabled ID from opencode models.'],
    ['deepModel', 'fixture/chat', 'The selected model must support tools.'], ['reviewModel', `${A}#missing`, 'The selected model does not offer that variant.'], ['reviewModel', `${B}#high*2`, 'The selected model does not offer that variant.'],
    // The place is that of the model's first entry, counted over the passes: a repeated model takes a place of its own.
    ['reviewModel', `${A},fixture/absent`, 'The selected model is unavailable in OpenCode (entry 2 of the list). Choose an enabled ID from opencode models.'],
    ['reviewModel', `fixture/absent,${A}`, 'The selected model is unavailable in OpenCode (entry 1 of the list). Choose an enabled ID from opencode models.'],
    ['reviewModel', `${A},${A},fixture/absent`, 'The selected model is unavailable in OpenCode (entry 3 of the list). Choose an enabled ID from opencode models.'],
    ['quickModel', `${A}*2,fixture/chat`, 'The selected model must support tools (entry 3 of the list).'], ['deepModel', `${B},${A}#missing`, 'The selected model does not offer that variant (entry 2 of the list).'],
  ]) {
    assert.equal(await read(id, answer), problem, `${id}: ${JSON.stringify(answer)}`);
    assert.doesNotMatch(problem, /fixture|Fixture|REPLACE/, 'What was answered is not quoted.');
  }
  assert.equal(await readFile(f.path, 'utf8'), initial, 'Checking answers writes nothing.');

  // Saved, a list is one entry per pass in the settings; who rates in that mode stays as it was.
  const first = await save({ changes: { reviewModel: `${A}*2,${B}`, quickModel: B, deepModel: `${B},${A}#high` } });
  assert.deepEqual([first.ok, first.status.state], [true, 'restart']);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved.models, { review: { reviewers: [A, A, B], rater: false }, quick: { reviewers: [B], rater: '' }, deep: { reviewers: [B, `${A}#high`], rater: 'fixture/other' } });
  assert.deepEqual({ ...saved, models: start.models }, start, 'Nothing else changed.');
  // A row shows the list in a few words, and gives it as the text a dialog or an option starts from, with its
  // entries, how many passes one model named alone becomes, and how many there may be.
  const rows = rowsOf(await status({}));
  assert.deepEqual(['reviewModel', 'quickModel', 'deepModel'].map(id => [rows[id].value, rows[id].current, rows[id].entries, rows[id].usual, rows[id].most]), [
    ['model ×2 + other', `${A}*2,${B}*1`, [A, A, B], 2, MAX_REVIEWERS], ['other', `${B}*1`, [B], 1, MAX_REVIEWERS], ['other + model#high', `${B}*1,${A}#high*1`, [B, `${A}#high`], 2, MAX_REVIEWERS]]);
  assert.equal(MAX_REVIEWERS, 4);
  // That text is an answer that leaves the list as it is: also a single pass where two are usual stays one.
  assert.equal((await save({ changes: { reviewModel: `${A}*1` } })).ok, true);
  const single = rowsOf(await status({})).reviewModel;
  assert.deepEqual([single.value, single.current, single.entries], ['model', `${A}*1`, [A]]);
  const before = await readFile(f.path, 'utf8');
  for (const id of ['reviewModel', 'quickModel', 'deepModel']) {
    const row = rowsOf(await status({}))[id];
    assert.deepEqual(await read(id, row.current), [row.current, row.value], id);
    assert.equal((await save({ changes: { [id]: row.current } })).ok, true, id);
  }
  assert.equal(await readFile(f.path, 'utf8'), before, 'Given back as it was shown, every list is the list it was.');
  // Off is an empty list; /pr-review refuses it and keeps its models.
  assert.equal((await save({ changes: { quickModel: 'off', deepModel: 'none' } })).ok, true);
  assert.deepEqual(await save({ changes: { reviewModel: 'off' } }), { ok: false, fix: '', problem: `The model${NO_MODEL}` });
  const off = JSON.parse(await readFile(f.path, 'utf8')).models;
  assert.deepEqual(off, { review: { reviewers: [A], rater: false }, quick: { reviewers: [], rater: '' }, deep: { reviewers: [], rater: 'fixture/other' } });
  assert.deepEqual(['quickModel', 'deepModel'].map(id => rowsOf(first.status)[id].optional), [{ label: 'Off', description: '/pr-quick stays off' }, { label: 'Off', description: '/pr-deep stays off' }]);
  assert.equal(rowsOf(first.status).reviewModel.optional, undefined, 'A dialog offers "Off" only where the mode may be off.');
  const rowsOff = rowsOf(await status({}));
  assert.deepEqual(['quickModel', 'deepModel'].map(id => [rowsOff[id].value, rowsOff[id].current, rowsOff[id].entries]), [['off', '', []], ['off', '', []]]);
  // The options of /pr-setup take the same text, since an option and a dialog are the same row.
  await saveSetup(f.context, f.path, { '--review-model': `${B},${A}*3`, '--quick-model': A, '--deep-model': `${A}*1` }, environment);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).models, { review: { reviewers: [B, A, A, A], rater: false }, quick: { reviewers: [A], rater: '' }, deep: { reviewers: [A], rater: 'fixture/other' } });
  await assert.rejects(saveSetup(f.context, f.path, { '--review-model': `${B},${A}*4` }, environment), { message: '[AZPR] Review models take at most 4 passes in all.' });
  await assert.rejects(saveSetup(f.context, f.path, { '--review-model': 'off' }, environment), { message: `[AZPR] The model${NO_MODEL}` });
});

test('a first setup names one model: two review passes and one quick pass of it; /pr-deep and who rates stay as they are', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  // Settings a person began by hand: /pr-deep and the ratings are decided, the organization and the review models are not.
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const begun = { version: 3, models: { review: { rater: false }, deep: { reviewers: ['fixture/model#high', 'fixture/other', 'fixture/model#high'], rater: 'fixture/other' }, quick: { reviewers: ['fixture/other', 'fixture/other'], rater: false } } };
  await writeFile(f.path, JSON.stringify(begun), { mode: 0o600 });
  t.after(await f.setup({ environment }));
  const before = await f.rpc.handlers.status({});
  assert.deepEqual([before.state, before.editable, rowsOf(before).reviewModel.value, rowsOf(before).quickModel.value, rowsOf(before).deepModel.value], ['required', true, 'not set', 'other ×2', 'model#high + other + model#high']);
  // What the dialogs save: the one model, which stands for the review and the quick models.
  const saved = await f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  assert.deepEqual([saved.ok, saved.status.state], [true, 'ready']);
  const written = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(written.version, 3);
  assert.deepEqual(written.models, { review: { rater: false, reviewers: ['fixture/model', 'fixture/model'] }, deep: begun.models.deep, quick: { reviewers: ['fixture/model'], rater: false } });
  assert.deepEqual([rowsOf(saved.status).reviewModel.value, rowsOf(saved.status).quickModel.value, rowsOf(saved.status).deepModel.value], ['model ×2', 'model', 'model#high + other + model#high']);
  // The runtime that was loaded reads the lists the same way: a role per pass, and no rating where it is switched off.
  assert.deepEqual([...f.agents.keys()].filter(name => /-(?:reviewer[b-d]?|rating)$/.test(name)).sort(),
    ['azpr-deep-rating', 'azpr-deep-reviewer', 'azpr-deep-reviewerb', 'azpr-deep-reviewerc', 'azpr-quick-reviewer', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  // The one model is a model, checked like every other answer: neither mode is switched off with it.
  for (const answer of ['off', 'none', '', 'fixture/model*5', 'fixture/absent', 'Fixture Model']) {
    assert.equal((await f.rpc.handlers.validate({ changes: { model: answer } })).ok, false, JSON.stringify(answer));
  }
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
  await writeFile(f.path, JSON.stringify({ version: 3, azure: { organization: 'fixture' } }), { mode: 0o600 });
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
  assert.ok(f.agents.has('azpr-review-reviewer'));
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
  await writeFile(f.path, '{"version":3,"azure":{"pat":"PRIVATE_TOKEN_0123456789abcdef",}', { mode: 0o600 });
  const broken = await readFile(f.path, 'utf8');
  t.after(await f.setup({ environment }));
  const { status, validate, check, save } = f.rpc.handlers;
  const view = await status({});
  assert.deepEqual([view.state, view.editable, view.fileProblem], ['required', false, 'settings.json must be a JSON object without duplicate keys; repair it manually before setup.']);
  for (const answer of [await validate({ changes: { language: 'ja' } }), await check({ organization: 'fixture', token: FAKE_PAT }), await save({ changes: { language: 'ja' } })]) {
    assert.equal(answer.ok, false);
    assert.equal(answer.problem, 'settings.json must be a JSON object without duplicate keys; repair it manually before setup.');
  }
  // Nor is it a file whose update could be confirmed.
  assert.equal((await save({ migrate: '0123456789ab' })).ok, false);
  assert.equal(await readFile(f.path, 'utf8'), broken);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_TOKEN'));
  // The dialogs only say so.
  const d = dialogs(f, []);
  await d.setup.open();
  assert.deepEqual(d.shown.map(item => item.title), ['AZPR\'s settings file needs repair']);
  // A file whose groups are not objects, whose list of models is none, or of a version setup does not know, is the
  // same case; a symbolic link is not followed.
  for (const [content, problem] of [['{"version":3,"models":[]}', '"models" in the settings file is not a JSON object.'],
    ['{"version":3,"azure":"fixture"}', '"azure" in the settings file is not a JSON object.'], ['{"version":3,"debug":true}', '"debug" in the settings file is not a JSON object.'],
    ['{"version":3,"afterReview":"preview"}', '"afterReview" in the settings file is not a JSON object.'],
    ['{"version":3,"models":{"review":"fixture/model"}}', '"models.review" in the settings file is not a JSON object.'],
    ['{"version":3,"models":{"review":{"reviewers":"fixture/model"}}}', '"models.review.reviewers" in the settings file is not a list.'],
    ['{"version":3,"models":{"deep":{"reviewers":{"0":"fixture/model"}}}}', '"models.deep.reviewers" in the settings file is not a list.'],
    ['{"version":4}', 'Setup supports only version-3 settings.'], ['{"version":1}', 'Setup supports only version-3 settings.'], ['{"version":"3"}', 'Setup supports only version-3 settings.'],
    ['{}', 'Setup supports only version-3 settings.']]) {
    await writeFile(f.path, content);
    const now = await status({});
    assert.deepEqual([now.state, now.editable, now.fileProblem, now.migration], ['required', false, problem, undefined], content);
    for (const answer of [await validate({ changes: { language: 'ja' } }), await check({ organization: 'fixture', token: FAKE_PAT }), await save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT })]) {
      assert.deepEqual([answer.ok, answer.problem], [false, problem], content);
    }
    assert.equal(await readFile(f.path, 'utf8'), content);
  }
  assert.equal(f.azure.state.calls.length, 0, 'No token was sent for a file that cannot be changed.');
  await assert.rejects(lstat(join(environment.XDG_CONFIG_HOME, 'azpr')), { code: 'ENOENT' }, 'And none was saved.');
  // Settings of this version that only lack their values can be changed: a first setup fills them in.
  await writeFile(f.path, '{"version":3}');
  const empty = await status({});
  assert.deepEqual([empty.state, empty.editable, empty.fileProblem], ['required', true, '']);
  // And settings of 0.4.x are no case for repair, also not with such a group in them: setup offers their update,
  // and the dialogs ask. What is wrong with the file is repaired after it, in this version's layout.
  for (const content of [JSON.stringify(legacyMinimal(f)), '{"version":2}', '{"version":2,"azure":"fixture"}', '{"version":2,"models":[],"afterReview":"preview","debug":true}', '{"version":2,"models":{"review":"fixture/model"}}']) {
    await writeFile(f.path, content);
    const offered = await status({});
    assert.deepEqual([offered.state, offered.editable, offered.fileProblem, typeof offered.migration.word], ['migrate', false, MIGRATION_NEEDED, 'string'], content);
    const offer = dialogs(f, [undefined]);
    await offer.setup.open();
    assert.deepEqual(offer.shown.map(item => item.title), ['AZPR\'s settings are from an earlier version', 'Update AZPR\'s settings file?'], content);
    assert.equal(await readFile(f.path, 'utf8'), content);
  }
  // Updated, a file with a group that is no object is a file of this version that setup cannot change: it says which group.
  await writeFile(f.path, '{"version":2,"azure":"fixture"}');
  const converted = await save({ migrate: (await status({})).migration.word });
  assert.deepEqual([converted.ok, converted.remaining, converted.status.state, converted.status.editable, converted.status.fileProblem],
    [true, 'models.review.reviewers needs at least one model: /pr-review runs one pass per entry.', 'required', false, '"azure" in the settings file is not a JSON object.']);
  assert.deepEqual([JSON.parse(await readFile(f.path, 'utf8')).version, JSON.parse(await readFile(f.path, 'utf8')).azure], [3, 'fixture']);
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
  assert.match(f.notices.at(-1).text, /One setting of existing settings is changed without --replace: --proxy URL\|none, --ca-file PATH\|none, --review-model MODELS, --quick-model MODELS\|off, --deep-model MODELS\|off, --language [^,]+, --after-review preview\|none\|publish, --report receipt\|full, --progress on\|off, --panel auto\|manual, --debug on\|off\./);
  // What one model named for a first setup becomes, how a mode's passes and a variant are written, what a deep
  // model is for, and where every setting is described: the README is long.
  assert.match(f.notices.at(-1).text, /\. The selected model reviews twice in \/pr-review and once in \/pr-quick\. Deep remains unchanged \(off for a new profile\)\. /);
  assert.match(f.notices.at(-1).text, /A model takes a variant as PROVIDER\/MODEL#VARIANT\. MODELS is a mode's review passes in order: PROVIDER\/MODEL alone means that mode's usual number of passes of one model \(review 2, deep 2, quick 1\); MODEL\*N sets the number \(MODEL\*1 is one pass\), and entries separated by commas run different models, one pass each, at most 4 passes in all \(A,B or A\*2,B\)\. The first entry also merges repeated findings, plans the comments and rates the severities\. --deep-model sets the models of \/pr-deep, which runs the same review: choose a stronger model than the review model, the same model with a higher variant, or more passes\. Every setting is described in the README's section "All settings and defaults" \(https:\/\/github\.com\/WTLAIB\/opencode-azure-devops-pr-review-v2#all-settings-and-defaults\)\.\n/);
  assert.match(await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}" --language ja --deep-model fixture/model#high`),
    /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nOrganization: fixture; PAT file: .+\nChanged: Deep models, Output language\nAZPR has loaded them: run \/pr-check <PR URL>\./);
  assert.equal(f.notices.at(-1).metadata, undefined);
  const read = async () => JSON.parse(await readFile(f.path, 'utf8'));
  // What the guide says is what is written: two review passes and one quick pass of the model, and two deep passes of the one named for /pr-deep.
  assert.deepEqual([(await read()).outputLanguage, (await read()).models], ['ja', { review: { reviewers: ['fixture/model', 'fixture/model'], rater: '' },
    quick: { reviewers: ['fixture/model'], rater: '' }, deep: { reviewers: ['fixture/model#high', 'fixture/model#high'], rater: '' } }]);
  assert.equal(await f.invoke('pr-setup', '--language zh-TW --after-review none --proxy http://user:pw-secret@proxy.example:8080'),
    `[AZPR] SETTINGS SAVED\nSettings: ${f.path}\nChanged: Proxy, Output language, After a review\nTo load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process), then run /pr-check <PR URL>. No model or Azure request was made. Existing reviews keep their original settings.`);
  assert.deepEqual([(await read()).outputLanguage, (await read()).afterReview, (await read()).azure.proxy], ['zh-TW', { review: 'none', deep: 'none', quick: 'none' }, 'http://user:pw-secret@proxy.example:8080']);
  assert.match(await f.invoke('pr-setup', '--proxy none --deep-model off --quick-model off --debug on --progress off --panel manual --report full'), /\nChanged: Proxy, Quick models, Deep models, Report in the conversation, Progress notices, Review panel, Debug records\n/);
  const now = await read();
  assert.deepEqual([now.azure.proxy, now.models.deep.reviewers, now.models.quick.reviewers, now.debug.enabled, now.progressNotices, now.terminalPanel, now.returnReport], ['', [], [], true, false, 'manual', 'full']);
  // A mode's passes as an option: a number of them, and a list in quotes where it has blanks.
  assert.match(await f.invoke('pr-setup', '--review-model fixture/model*3 --quick-model "fixture/model#high, fixture/model" --deep-model fixture/model*1'), /\nChanged: Review models, Quick models, Deep models\n/);
  assert.deepEqual([(await read()).models.review.reviewers, (await read()).models.quick.reviewers, (await read()).models.deep.reviewers],
    [['fixture/model', 'fixture/model', 'fixture/model'], ['fixture/model#high', 'fixture/model'], ['fixture/model']]);
  const unchanged = await readFile(f.path, 'utf8');
  for (const [options, problem] of [
    ['--language "Traditional Chinese"', /^\[AZPR\] outputLanguage must be a language tag/], ['--after-review always', /^\[AZPR\] After a review must be one of: preview, none, publish\.$/],
    ['--review-model fixture/absent', /^\[AZPR\] The selected model is unavailable/], ['--ca-file relative.pem', /^\[AZPR\] The CA certificate file must be an absolute path\.$/],
    ['--review-model off', /^\[AZPR\] The model: select an actual provider\/model ID/], ['--review-model fixture/model*5', /^\[AZPR\] Review models take at most 4 passes in all\.$/],
    ['--quick-model fixture/model,fixture/absent', /^\[AZPR\] The selected model is unavailable in OpenCode \(entry 2 of the list\)\./], ['--deep-model fixture/model*0', /^\[AZPR\] The model: after the star comes the number of passes, 1 to 4\.$/],
    // Settings of this version have no update to confirm.
    ['--migrate 0123456789ab', /^\[AZPR\] These settings need no update: --migrate is only for settings of AZPR 0\.4\.x that \/pr-setup offers to update\.$/],
    ['--migrate 0123456789ab --language ja', /^\[AZPR\] --migrate stands alone: update the settings first, then change them\. Use \/pr-setup --help\.$/],
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
  await writeFile(f.path, '{"version":3,"models":{"review":{"reviewers":["fixture/model","fixture/model"]}},"azure":{"organization":"fixture","pat":"","patFile":""}}', { mode: 0o600 });
  assert.match(await f.invoke('pr-review', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n.*could not be used when OpenCode loaded AZPR: azure\.pat must be an Azure DevOps personal access token/);
  // So are settings of 0.4.x that someone puts there meanwhile: they are not what was found at load either, and need their update first.
  await writeFile(f.path, JSON.stringify(legacyMinimal(f)), { mode: 0o600 });
  assert.equal(await f.invoke('pr-review', f.azure.prUrl()), `[AZPR] SETTINGS UPDATE REQUIRED\nNo review or Azure request was started. Settings: ${f.path}\n${MIGRATION_NEEDED}`);
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
  assert.ok(f.agents.has('azpr-review-reviewer'), 'After the restart the settings are in use.');
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
  assert.ok(f.agents.has('azpr-review-reviewer'));
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
  assert.equal(starting.commands.get('pr-review').description, 'AZPR is not ready here; run /pr-setup to see what it needs');
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
  assert.equal(late.commands.get('pr-review').description, 'AZPR is not ready here; run /pr-setup to see what it needs');

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
  await writeFile(k.path, settingsText(withMissingSettings({ version: 3, models: { review: { reviewers: ['fixture/model', 'fixture/model'] } }, azure: { organization: 'fixture', pat: '', patFile: missing } }).settings), { mode: 0o600 });
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
  await writeFile(once.path, settingsText(withMissingSettings({ version: 3, models: { review: { reviewers: ['fixture/model', 'fixture/model'] } }, azure: { organization: 'fixture', pat: '', patFile: awaited } }).settings), { mode: 0o600 });
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

test('one setup saves at a time, whichever way it comes in, until the load that follows it has ended', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  const list = f.context.command.list;
  let held, release;
  // The load of the first setup waits on the host; meanwhile other saves arrive.
  f.context.command.list = async () => { if (!held) { held = new Promise(resolve => { release = resolve; }); await held; } return list(); };
  const first = f.rpc.handlers.save({ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT });
  for (let turn = 0; turn < 200 && !release; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function', 'The first save is loading what it saved.');
  const text = await readFile(f.path, 'utf8');
  assert.equal(await f.invoke('pr-setup', '--language ja'), '[AZPR] Another setup is active.');
  assert.deepEqual(await f.rpc.handlers.save({ changes: { language: 'ja' } }), { ok: false, problem: 'Another setup is being saved.' });
  assert.equal(await readFile(f.path, 'utf8'), text, 'Neither changed what is being loaded.');
  release();
  const saved = await first;
  f.context.command.list = list;
  assert.deepEqual([saved.ok, saved.status.state, f.agents.has('azpr-review-reviewer')], [true, 'ready', true], 'The first setup is loaded as it was saved.');
  // Afterwards the next save has its turn; the settings are in use by then, so it waits for the restart.
  assert.match(await f.invoke('pr-setup', '--language ja'), /\nChanged: Output language\nTo load them, restart the OpenCode service /);
  assert.equal((await f.rpc.handlers.status({})).state, 'restart');
});

test('a token that arrives while /pr-setup --replace checks the model is not that setup\'s own', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  // Settings that are complete but name a token file that is not there: no usable settings when AZPR is loaded.
  await saveSetup(f.context, f.path, f.args);
  await rm(f.pat);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  assert.equal((await f.rpc.handlers.status({})).state, 'required');
  const models = f.context.model.list;
  // Another writer supplies the token after this save looked at the file and before it checks it once more.
  f.context.model.list = async () => { await writeFile(f.pat, NEW_TOKEN, { mode: 0o600 }); return models(); };
  const receipt = await f.invoke('pr-setup', '--organization fixture --model fixture/model --replace');
  f.context.model.list = models;
  assert.match(receipt, /^\[AZPR\] SETTINGS SAVED\n[\s\S]*\nTo load them, restart the OpenCode service /);
  assert.deepEqual([f.agents.size, f.rpc.events.length, (await f.rpc.handlers.status({})).state], [0, 0, 'restart'], 'The token is someone else\'s: it waits for the restart.');
});

test('putting the commands that say "setup required" back never comes after a load it did not see', async t => {
  const f = await fixture(t), environment = environmentOf(f);
  t.after(await f.setup({ environment, releaseWaitMs: 50 }));
  const list = f.context.command.list;
  // A first setup is saved, but the host does not answer while it is loaded: no command is left but /pr-setup.
  f.context.command.list = async () => { throw new Error('host away'); };
  await f.invoke('pr-setup', `--organization fixture --model fixture/model --pat-file "${f.pat}"`);
  assert.deepEqual([...f.commands.keys()], ['pr-setup']);
  // The host answers again, slowly. /pr-setup --help asks it which names are taken, to put the commands back;
  let answer, asked = 0;
  f.context.command.list = async () => { if (++asked === 1) await new Promise(resolve => { answer = resolve; }); return list(); };
  const help = f.commands.get('pr-setup').execute({ sessionID: 'origin', prompt: { text: '--help' } });
  for (let turn = 0; turn < 200 && !answer; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof answer, 'function');
  // meanwhile a save of the same setup tries the load again.
  const saving = f.rpc.handlers.save({ changes: { language: 'ja' } });
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  answer();
  const [saved] = await Promise.all([saving, help]);
  f.context.command.list = list;
  assert.deepEqual([saved.ok, saved.status.state, f.agents.has('azpr-review-reviewer')], [true, 'ready', true]);
  assert.match(await f.invoke('pr-review', '--help'), /^\[AZPR\] \/pr-review <Azure DevOps PR URL>/, 'The review command is the runtime\'s, not one that says "setup required".');
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
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
  assert.ok(f.agents.has('azpr-review-reviewer'));
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
  assert.ok(f.agents.has('azpr-review-reviewer'));
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

// ------------------------------------------------------------------ settings of AZPR 0.4.x (settings version 2)
// Settings as AZPR 0.4.6 left them: three models for /pr-review, /pr-deep off, one quick reviewer, and every
// other setting of that version, several of them not at their defaults.
const legacySettings = (f, change = {}) => ({
  $schema: './settings.schema.json', version: 2,
  models: { _help: { functional: 'Finds defects in what the change does.', risk: 'Finds risks around the change.', verifier: 'Checks every finding.' },
    review: { functional: 'fixture/model', risk: 'fixture/model#high', verifier: 'fixture/verifier', rater: '' },
    deep: { functional: '', risk: '', verifier: '', rater: '' }, quick: { reviewer: 'fixture/model#high' } },
  enabled: true, returnReport: 'full', debug: { enabled: false, directory: '', keepRuns: 5 }, outputLanguage: 'zh-TW', runTimeoutSeconds: null, shell: 'deny',
  progressNotices: false, deletePrivateSessions: true, terminalPanel: 'manual', afterReview: { quick: 'none', review: 'preview', deep: 'preview' },
  azure: { organization: 'fixture', pat: '', patFile: f.pat, concurrency: 4, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true },
  workflow: { shardFiles: 30, shardFindings: 15, parallelSessions: 8, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 },
  ...change });
/** What their update makes of them, written out: the two reviewer models in their order, no verifier, and every other value as it was. */
function updatedSettings(f) {
  const { models, workflow: { shardFindings, ...workflow }, ...rest } = legacySettings(f);
  return { ...rest, version: 3, workflow,
    models: { review: { reviewers: ['fixture/model', 'fixture/model#high'], rater: '' }, deep: { reviewers: [], rater: '' }, quick: { reviewers: ['fixture/model#high'], rater: '' } } };
}
/** The text of an update as src/config.mjs defines it: what migrateSettings makes of the file, with every setting of this version. */
const updatedText = legacy => settingsText(withMissingSettings(migrateSettings(legacy).settings).settings);
// What /pr-setup and the dialogs say that update changes: one line per point.
const UPDATE_FIRST = 'This version reviews with a list of reviewer models per mode: each entry reviews the changed files on its own, one pass each. There is no verifier any more: the first entry also merges repeated findings and plans the comments, and a rating sets the severities.';
const UPDATE_LAST = 'Every other setting stays as it is, also one that is not a setting of this version: the settings check then names it.';
const UPDATE_REVIEW = '/pr-review: functional fixture/model, risk fixture/model#high, verifier fixture/verifier -> 2 passes: fixture/model, fixture/model#high. The verifier model is no longer used.';
const UPDATE_LINES = [UPDATE_FIRST, UPDATE_REVIEW, '/pr-deep: off, stays off.', '/pr-quick: reviewer fixture/model#high -> 1 pass: fixture/model#high.',
  'Severity rating of /pr-review, /pr-quick: none ran before (no rater was set). From now on the first reviewer model rates the findings from their text alone; "rater": false in the settings file switches that off.',
  'workflow.shardFindings is dropped: it sized the verifier\'s batches.', UPDATE_LAST];
const UPDATE_REQUIRED = f => `[AZPR] SETTINGS UPDATE REQUIRED\nNo review or Azure request was started. Settings: ${f.path}\n${MIGRATION_NEEDED}`;
/** What /pr-setup alone and --help say of such settings: what the update changes, and the command that confirms it. */
const UPDATE_GUIDE = (f, lines, word) => `[AZPR] SETTINGS UPDATE\nSettings: ${f.path}\n\nThese settings are from AZPR 0.4.x. Reviews run again once the file is updated to this version; nothing is changed until you confirm.\n\n` +
  `${lines.map(line => `- ${line}`).join('\n')}\n\n` +
  `In OpenCode's terminal UI, /pr-setup alone asks whether to update the file. In other clients, confirm with:\n\n/pr-setup --migrate ${word}\n\n` +
  'The word names this very change: when the settings file changes before you confirm, /pr-setup shows the update again. No model request or Azure request is made.';
const WRONG_WORD = '[AZPR] That word names no update of the settings file as it is now (the file changed, or OpenCode was restarted since). Run /pr-setup alone and use the word it shows.';
const CHANGED_SINCE = { ok: false, problem: 'The settings file changed since the update was shown, or OpenCode was restarted since, so nothing was saved. Run /pr-setup again to see the update as it is now.' };
const SETUP_BUSY = 'Another setup is active, or its lock was left behind (if none is running, delete settings.json.setup.lock beside the settings file). No settings changed.';
/** A fixture whose settings file holds these settings of 0.4.x, as text. */
async function outdated(t, make = legacySettings, write = settingsText) {
  const f = await fixture(t);
  await mkdir(join(f.root, 'private config'), { mode: 0o700 });
  const legacy = make(f), text = write(legacy);
  await writeFile(f.path, text, { mode: 0o600 });
  return { f, environment: environmentOf(f), legacy, text };
}

test('settings of AZPR 0.4.x are neither used nor touched: the commands say that an update is needed, and loading AZPR completes nothing', async t => {
  const f = await fixture(t), environment = environmentOf(f), directory = join(f.root, 'private config');
  await mkdir(directory, { mode: 0o700 });
  assert.match(MIGRATION_NEEDED, /^settings\.json is from AZPR 0\.4\.x \(settings version 2\)\. .* run \/pr-setup to see what changes and to update the file\. Nothing is changed until you confirm\.$/);
  // As 0.4.6 left them, and as 0.4.1's /pr-setup wrote them (what it asked for and nothing else): 0.4.x could use both.
  for (const legacy of [legacySettings(f), legacyMinimal(f)]) {
    // As a person keeps the file: their own indentation, and a mode other users can read.
    const text = JSON.stringify(legacy, null, 4);
    await writeFile(f.path, text);
    await chmod(f.path, 0o644);
    const before = await lstat(f.path);
    const cleanup = await f.setup({ environment });
    try {
      // No usable settings: every review command only says so, and nothing of the runtime is there.
      assert.deepEqual([...f.commands.keys()], ['pr-setup', ...Object.keys(COMMANDS)]);
      assert.deepEqual([f.agents.size, f.hooks.length, await f.context.tool.list()], [0, 0, []]);
      for (const name of Object.keys(COMMANDS)) {
        assert.equal(f.commands.get(name).description, 'AZPR is not ready here; run /pr-setup to see what it needs');
        assert.equal(await f.invoke(name, f.azure.prUrl()), UPDATE_REQUIRED(f), name);
      }
      const status = await f.rpc.handlers.status({});
      assert.deepEqual([status.state, status.problem], ['migrate', MIGRATION_NEEDED]);
      // The file is the file it was: this version has settings it does not name, but they belong to another
      // layout, and the completion at load, also called by itself, adds none of them.
      const after = await lstat(f.path);
      assert.equal(await readFile(f.path, 'utf8'), text);
      assert.deepEqual([after.ino, after.mode & 0o777, after.mtimeMs, after.size], [before.ino, 0o644, before.mtimeMs, before.size], 'It was neither replaced nor written to.');
      assert.ok(withMissingSettings(legacy).added.length > 0);
      assert.deepEqual(await addMissingSettings(f.path), { added: [] });
      assert.deepEqual(await addMissingSettings(f.path, { waitMs: 0, prepared: () => assert.fail('Nothing is prepared for such a file.') }), { added: [] });
      assert.equal(await readFile(f.path, 'utf8'), text);
      assert.equal((await lstat(f.path)).ino, before.ino);
      assert.deepEqual(await readdir(directory), ['settings.json'], 'No lock or temporary file was made.');
      assert.equal(f.azure.state.calls.length, 0);
    } finally { await cleanup(); }
    assert.equal(f.commands.size, 0);
  }
  // Switched off, such settings are left alone like any others: nothing is registered, also not /pr-setup.
  const off = JSON.stringify({ ...legacySettings(f), enabled: false });
  await writeFile(f.path, off);
  t.after(await f.setup({ environment }));
  assert.deepEqual([f.commands.size, f.agents.size, f.rpc.handlers, await readFile(f.path, 'utf8')], [0, 0, null, off]);
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});

test('/pr-setup alone shows what the update of 0.4.x settings changes and the word that confirms it; no other option changes such settings', async t => {
  const { f, environment, legacy, text } = await outdated(t);
  t.after(await f.setup({ environment }));
  const shown = await f.invoke('pr-setup', '');
  assert.deepEqual(f.notices.at(-1).metadata, { azpr: { setup: true } }, 'In the terminal UI the dialogs open for this notice, as for every /pr-setup alone.');
  const word = /\n\/pr-setup --migrate (\S+)\n/.exec(shown)?.[1];
  assert.match(word, /^[0-9a-f]{12}$/, shown);
  assert.equal(shown, UPDATE_GUIDE(f, UPDATE_LINES, word));
  // --help says the same and asks the terminal UI for nothing; shown again, the same change has the same word,
  // and it is the word the dialogs' server part gives with the same lines.
  assert.equal(await f.invoke('pr-setup', '--help'), shown);
  assert.equal(f.notices.at(-1).metadata, undefined);
  assert.equal(await f.invoke('pr-setup', '  '), shown);
  assert.deepEqual((await f.rpc.handlers.status({})).migration, { lines: UPDATE_LINES, word });
  // No other option changes these settings, also not those of a first setup: none of them says that the update was seen.
  for (const options of ['--language ja', '--review-model fixture/model', '--quick-model off', '--deep-model fixture/model', '--proxy none', '--ca-file none', '--after-review publish', '--report full',
    '--progress off', '--panel manual', '--debug on', '--language ja --debug on', `--organization fixture --model fixture/model --pat-file "${f.pat}"`,
    `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`, '--organization other --model fixture/model --replace --language ja']) {
    assert.equal(await f.invoke('pr-setup', options), `[AZPR] ${MIGRATION_NEEDED} Other options work after that.`, options);
  }
  // The word stands alone, and only the word of the file as it is names its update.
  for (const [options, problem] of [
    [`--migrate ${word} --language ja`, '[AZPR] --migrate stands alone: update the settings first, then change them. Use /pr-setup --help.'],
    [`--deep-model off --migrate ${word}`, '[AZPR] --migrate stands alone: update the settings first, then change them. Use /pr-setup --help.'],
    [`--organization fixture --model fixture/model --replace --migrate ${word}`, '[AZPR] --migrate stands alone: update the settings first, then change them. Use /pr-setup --help.'],
    [`--migrate ${word} --replace`, '[AZPR] Supply --organization and --model (--pat-file is optional). Use /pr-setup --help.'],
    ['--migrate', '[AZPR] A setup option needs a value. Use /pr-setup --help.'], [`--migrate ${word} --migrate ${word}`, '[AZPR] Unknown or repeated setup option. Use /pr-setup --help. Never put the PAT itself in a command.'],
    ['--migrate yes', WRONG_WORD], [`--migrate ${word}0`, WRONG_WORD], [`--migrate ${word.slice(1)}`, WRONG_WORD], ['--migrate 000000000000', WRONG_WORD], [`--migrate "${word} "`, WRONG_WORD],
  ]) assert.equal(await f.invoke('pr-setup', options), problem, options);
  assert.equal(await readFile(f.path, 'utf8'), text, 'Nothing was written for any of them.');
  assert.deepEqual([f.agents.size, f.rpc.events, f.azure.state.calls.length, await f.invoke('pr-review', f.azure.prUrl())], [0, [], 0, UPDATE_REQUIRED(f)]);

  // Confirmed with its word, the update is written, and since this process had no usable settings it loads them at once.
  const receipt = await f.invoke('pr-setup', `--migrate ${word}`);
  assert.equal(receipt, `[AZPR] SETTINGS UPDATED\nSettings: ${f.path}\nThe settings file now has the layout of this version; /pr-setup shows and changes the models of each mode.\n` +
    'AZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.');
  assert.equal(f.notices.at(-1).metadata, undefined);
  const written = await readFile(f.path, 'utf8');
  assert.equal(written, updatedText(legacy), 'What was written is what the update makes of that very file.');
  assert.deepEqual(JSON.parse(written), updatedSettings(f));
  assert.deepEqual([...f.agents.keys()].filter(name => /-reviewer[b-d]?$/.test(name)).sort(), ['azpr-quick-reviewer', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  assert.deepEqual(f.rpc.events, [['loaded', {}]]);
  assert.match(await f.invoke('pr-review', '--help'), /^\[AZPR\] \/pr-review <Azure DevOps PR URL>/, 'The review command is the runtime\'s.');
  // Nothing is left to update: the word names nothing any more, and /pr-setup is the setup of this version's settings again.
  assert.equal(await f.invoke('pr-setup', `--migrate ${word}`), '[AZPR] These settings need no update: --migrate is only for settings of AZPR 0.4.x that /pr-setup offers to update.');
  assert.equal(await readFile(f.path, 'utf8'), written);
  assert.match(await f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP\nSettings: .+\n\nIn OpenCode's terminal UI, /);
  const report = await checkReport(f);
  assert.match(report, /\] READY/, report);
  assert.match(report, /\| Review models \| ok \| 2 passes: fixture\/model, fixture\/model#high; severity rating by fixture\/model \(the first reviewer model\)\. \|/);
  assert.doesNotMatch(report, /\| Settings \|/, 'The file that was written names every setting: loading it added nothing.');
  assert.match(await f.invoke('pr-setup', '--language en'), /^\[AZPR\] SETTINGS SAVED\nSettings: .+\nChanged: Output language\nTo load them, restart the OpenCode service /, 'Other options work after that.');
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});

test('the dialogs\' server part offers the update of 0.4.x settings and nothing else, and saves it for the word it showed, alone', async t => {
  const { f, environment, legacy, text } = await outdated(t);
  t.after(await f.setup({ environment }));
  const { status, validate, check, save } = f.rpc.handlers;
  const offered = await status({});
  assert.deepEqual([offered.version, offered.state, offered.problem, offered.editable, offered.fileProblem, offered.settingsFile, offered.organization],
    [1, 'migrate', MIGRATION_NEEDED, false, MIGRATION_NEEDED, f.path, 'fixture']);
  assert.deepEqual(Object.keys(offered.migration), ['lines', 'word']);
  assert.deepEqual(offered.migration.lines, UPDATE_LINES);
  assert.match(offered.migration.word, /^[0-9a-f]{12}$/);
  const word = offered.migration.word;
  // Its rows show the settings as the update leaves them; an earlier terminal part reads "cannot be changed", with the reason.
  const rows = rowsOf(offered);
  assert.deepEqual([rows.reviewModel.value, rows.reviewModel.current, rows.quickModel.value, rows.deepModel.value, rows.language.value, rows.afterReview.value, rows.report.value, rows.token.saved, rows.token.value],
    ['model + model#high', 'fixture/model*1,fixture/model#high*1', 'model#high', 'off', 'zh-TW', 'differs by mode', 'full', true, 'saved']);
  // Nothing else is checked, sent or saved for such settings: not a setting, not a first setup, not a token.
  const UPDATE_FIRST_OF_ALL = { ok: false, problem: MIGRATION_NEEDED };
  for (const changes of [{ language: 'ja' }, { reviewModel: 'fixture/model' }, { deepModel: 'off' }, { organization: 'fixture', model: 'fixture/model' }, {}]) {
    assert.deepEqual(await validate({ changes }), UPDATE_FIRST_OF_ALL, JSON.stringify(changes));
    assert.deepEqual(await save({ changes }), UPDATE_FIRST_OF_ALL, JSON.stringify(changes));
  }
  for (const input of [{}, { token: NEW_TOKEN, organization: 'fixture' }, { changes: { organization: 'fixture', model: 'fixture/model' }, token: NEW_TOKEN }, { changes: { organization: 'other' }, token: NEW_TOKEN }]) {
    assert.deepEqual(await save(input), UPDATE_FIRST_OF_ALL, JSON.stringify(Object.keys(input)));
  }
  for (const input of [{}, { organization: 'fixture' }, { organization: 'fixture', token: FAKE_PAT }, { organization: 'fixture', token: FAKE_PAT, proxy: 'http://proxy.example:8080' }]) {
    assert.deepEqual(await check(input), { ok: false, fix: '', problem: MIGRATION_NEEDED }, JSON.stringify(Object.keys(input)));
  }
  // The update travels alone, as text, and under the word of the file as it is.
  const ALONE = { ok: false, problem: 'The update of the settings is saved by itself, before anything else is changed.' };
  for (const more of [{ changes: { language: 'ja' } }, { changes: {} }, { token: NEW_TOKEN }, { organization: 'fixture' }, { token: NEW_TOKEN, organization: 'fixture', changes: { language: 'ja' } }]) {
    assert.deepEqual(await save({ migrate: word, ...more }), ALONE, JSON.stringify(Object.keys(more)));
  }
  for (const migrate of [true, 1, null, [word], { word }]) assert.deepEqual(await save({ migrate }), { ok: false, fix: '', problem: 'Setup takes each answer as text.' }, JSON.stringify(migrate));
  for (const migrate of ['', 'yes', `${word}0`, word.slice(1), ` ${word}`, '000000000000']) assert.deepEqual(await save({ migrate }), CHANGED_SINCE, JSON.stringify(migrate));
  const tokenFile = await lstat(f.pat);
  assert.equal(await readFile(f.path, 'utf8'), text, 'Nothing was written for any of them');
  assert.deepEqual([await readFile(f.pat, 'utf8'), await readdir(join(f.root, 'private config'))], [FAKE_PAT, ['settings.json']], 'also not the token, a lock or a file beside the settings.');
  await assert.rejects(lstat(join(environment.XDG_CONFIG_HOME, 'azpr')), { code: 'ENOENT' });
  assert.deepEqual([f.azure.state.calls.length, f.agents.size, f.rpc.events, f.notices.length], [0, 0, [], 0]);

  // Saved for its word: exactly what the update makes of the file, and nothing in the answer but the settings as they are now.
  const updated = await save({ migrate: word });
  assert.deepEqual([updated.ok, Object.keys(updated)], [true, ['ok', 'status']]);
  const written = await readFile(f.path, 'utf8'), saved = JSON.parse(written);
  assert.equal(written, updatedText(legacy));
  // The reviewer models in their order (functional, then risk), no verifier, who rates as it was, and every other value where it was.
  assert.deepEqual(saved, updatedSettings(f));
  assert.deepEqual([saved.models.review.reviewers, saved.models.review.rater, saved.models.quick, saved.models.deep], [['fixture/model', 'fixture/model#high'], '', { reviewers: ['fixture/model#high'], rater: '' }, { reviewers: [], rater: '' }]);
  assert.deepEqual([saved.azure, saved.afterReview, saved.outputLanguage, saved.returnReport, saved.debug, saved.terminalPanel, saved.progressNotices, saved.$schema],
    [legacy.azure, legacy.afterReview, 'zh-TW', 'full', legacy.debug, 'manual', false, './settings.schema.json']);
  assert.deepEqual([Object.keys(saved), Object.keys(saved.models), Object.keys(saved.workflow)], [Object.keys(legacy), ['review', 'deep', 'quick'], ['shardFiles', 'parallelSessions', 'repairAttempts', 'stageRetries', 'stageIdleSeconds']]);
  assert.doesNotMatch(written, /fixture\/verifier|"(?:functional|risk|verifier|reviewer|_help|shardFindings)"/, 'Nothing of the verifier, the model roles, their documentation or the verifier\'s batch size is left.');
  assert.deepEqual(withMissingSettings(saved).added, [], 'The file names every setting of this version.');
  const tokenNow = await lstat(f.pat);
  assert.deepEqual([await readFile(f.pat, 'utf8'), tokenNow.ino, tokenNow.mtimeMs], [FAKE_PAT, tokenFile.ino, tokenFile.mtimeMs], 'The token file was not touched.');
  // This process had no usable settings and its own setup made these usable: they are loaded at once, and the
  // server part says so once, for clients that would otherwise keep the commands they knew.
  assert.deepEqual([updated.status.state, updated.status.problem, updated.status.editable, updated.status.fileProblem, updated.status.migration], ['ready', '', true, '', undefined]);
  assert.deepEqual([...f.agents.keys()].filter(name => /-reviewer[b-d]?$/.test(name)).sort(), ['azpr-quick-reviewer', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  assert.deepEqual(f.rpc.events, [['loaded', {}]]);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR [a-f0-9]{8}\] STARTED/);
  // The word names nothing any more, and from now on a row is changed like any other setting.
  assert.deepEqual(await save({ migrate: word }), { ok: false, problem: 'These settings need no update.' });
  const changed = await save({ changes: { quickModel: 'off' } });
  assert.deepEqual([changed.ok, changed.status.state, rowsOf(changed.status).quickModel.value], [true, 'restart', 'off']);
  for (const said of [JSON.stringify([offered, updated, changed]), JSON.stringify(f.notices), await readFile(f.path, 'utf8')]) assert.ok(!said.includes(FAKE_PAT), 'The token is in the token file and nowhere else.');
});

test('the update of 0.4.x settings is written like every other save: under the setup lock, in one step, owner-only, and only while the file is what was shown', async t => {
  // The file as a person keeps it: their own indentation, and a mode other users can read.
  const { f, environment, legacy, text } = await outdated(t, legacySettings, value => JSON.stringify(value, null, 4));
  const directory = join(f.root, 'private config');
  await chmod(f.path, 0o644);
  let prepared;
  t.after(await f.setup({ environment, settingsPrepared: () => prepared?.() }));
  const { status, save } = f.rpc.handlers;
  const word = (await status({})).migration.word;
  // An editor saves between the moment the update was shown and its confirmation: the word names the file that
  // was shown, so nothing is written, and the file as it is now has an update of its own.
  const edited = JSON.stringify({ ...legacy, outputLanguage: 'ja' }, null, 4);
  await writeFile(f.path, edited);
  assert.deepEqual(await save({ migrate: word }), CHANGED_SINCE);
  assert.equal(await f.invoke('pr-setup', `--migrate ${word}`), WRONG_WORD);
  assert.equal(await readFile(f.path, 'utf8'), edited, 'The file is as the editor saved it.');
  const other = await status({});
  assert.notEqual(other.migration.word, word);
  assert.match(await f.invoke('pr-setup', ''), new RegExp(`\\n/pr-setup --migrate ${other.migration.word}\\n`), '/pr-setup shows the update again, with the word of the file as it is now.');
  // The same text again has the word that was shown for it; a text that differs in a blank has not.
  await writeFile(f.path, `${text}\n`);
  assert.deepEqual(await save({ migrate: word }), CHANGED_SINCE);
  await writeFile(f.path, text);
  assert.equal((await status({})).migration.word, word);
  // While another setup holds the lock, nothing is written, whichever way the confirmation comes in.
  await writeFile(`${f.path}.setup.lock`, '');
  assert.deepEqual(await save({ migrate: word }), { ok: false, fix: '', problem: SETUP_BUSY });
  assert.equal(await f.invoke('pr-setup', `--migrate ${word}`), `[AZPR] ${SETUP_BUSY}`);
  await rm(`${f.path}.setup.lock`);
  assert.equal(await readFile(f.path, 'utf8'), text);
  // A directory other users can write to is no place to replace a file in, for the update as for any save.
  await chmod(directory, 0o777);
  try {
    assert.deepEqual(await save({ migrate: word }), { ok: false, fix: '', problem: 'The settings directory must be a directory owned by you, not a symbolic link or writable by other users.' });
    assert.equal(await f.invoke('pr-setup', `--migrate ${word}`), '[AZPR] The settings directory must be a directory owned by you, not a symbolic link or writable by other users.');
  } finally { await chmod(directory, 0o700); }
  assert.deepEqual([await readFile(f.path, 'utf8'), await readdir(directory)], [text, ['settings.json']]);
  // The lock keeps AZPR's writers apart, not an editor: what is saved in the moment before the new text takes
  // the file's place is kept, and neither the lock nor the new text is left behind.
  prepared = () => writeFile(f.path, edited);
  assert.deepEqual(await save({ migrate: word }), { ok: false, fix: '', problem: 'Settings changed during setup; retry after reviewing the file.' });
  prepared = undefined;
  assert.equal(await readFile(f.path, 'utf8'), edited);
  assert.deepEqual(await readdir(directory), ['settings.json']);
  assert.deepEqual([f.agents.size, f.rpc.events, (await status({})).state], [0, [], 'migrate'], 'Nothing was loaded, and the update is still offered.');
  // What a reader of the settings sees while the update is written: the old file, whole, until the new one takes
  // its place. The new text is ready beside it, readable by its owner alone, and the setup lock is held.
  await writeFile(f.path, text);
  await chmod(f.path, 0o644);
  const inode = (await lstat(f.path)).ino;
  let during;
  prepared = async () => {
    const names = (await readdir(directory)).sort(), temporary = join(directory, names.find(name => name.endsWith('.tmp')));
    during = { names: names.map(name => name.replace(/\.[0-9a-f-]{36}\.tmp$/, '.<id>.tmp')), settings: await readFile(f.path, 'utf8'), mode: await mode(temporary), next: await readFile(temporary, 'utf8') };
  };
  const updated = await save({ migrate: word });
  prepared = undefined;
  const written = await readFile(f.path, 'utf8');
  assert.deepEqual([updated.ok, updated.status.state], [true, 'ready']);
  assert.deepEqual(during, { names: ['settings.json', 'settings.json.<id>.tmp', 'settings.json.setup.lock'], settings: text, mode: 0o600, next: written });
  assert.equal(written, updatedText(legacy));
  assert.deepEqual([await mode(f.path), (await lstat(f.path)).ino !== inode, await readdir(directory), await mode(directory)], [0o600, true, ['settings.json'], 0o700],
    'The settings may hold a PAT: the new file is the owner\'s alone, it took the old one\'s place, and nothing is left beside it.');

  // With options the same holds: the file that other users could read is the owner's alone afterwards.
  const g = await outdated(t, legacySettings, value => JSON.stringify(value, null, 4));
  await chmod(g.f.path, 0o644);
  t.after(await g.f.setup({ environment: g.environment }));
  const first = (await lstat(g.f.path)).ino;
  assert.match(await g.f.invoke('pr-setup', `--migrate ${/--migrate (\S+)/.exec(await g.f.invoke('pr-setup', ''))[1]}`), /^\[AZPR\] SETTINGS UPDATED\n/);
  assert.deepEqual([await readFile(g.f.path, 'utf8'), await mode(g.f.path), (await lstat(g.f.path)).ino !== first, await readdir(join(g.f.root, 'private config'))], [updatedText(g.legacy), 0o600, true, ['settings.json']]);

  // A word is one process's: after a restart, or in another OpenCode process, /pr-setup shows the update again under another word.
  const h = await outdated(t), elsewhere = await fixture(t);
  elsewhere.context.options.settingsFile = h.f.path;
  t.after(await h.f.setup({ environment: h.environment }));
  const { setupPlugin: another } = await import('../src/setup.mjs?another-process');
  t.after(await another(elsewhere.context, elsewhere.source, { stateDirectory: join(elsewhere.root, 'state'), fetch: elsewhere.azure.fetch, environment: h.environment }));
  const here = /--migrate (\S+)/.exec(await h.f.invoke('pr-setup', ''))[1], there = /--migrate (\S+)/.exec(await elsewhere.invoke('pr-setup', ''))[1];
  assert.notEqual(here, there);
  assert.equal(await elsewhere.invoke('pr-setup', `--migrate ${here}`), WRONG_WORD);
  assert.deepEqual(await elsewhere.rpc.handlers.save({ migrate: here }), CHANGED_SINCE);
  assert.equal(await readFile(h.f.path, 'utf8'), h.text);
  assert.match(await elsewhere.invoke('pr-setup', `--migrate ${there}`), /^\[AZPR\] SETTINGS UPDATED\n[\s\S]*\nAZPR has loaded them: /);
  assert.equal(await readFile(h.f.path, 'utf8'), updatedText(h.legacy));
});

test('the update of 0.4.x settings is not written through a symbolic link or to a file with a second name, as no save is; nor while another save has the turn', async t => {
  // Settings that a link names (a dotfiles directory, say): the runtime would read through it, so the review
  // commands know the settings to be of 0.4.x. Setup refuses such a file as it is, and writes nothing to its target.
  const { f, environment, text } = await outdated(t), real = join(f.root, 'dotfiles.json');
  await writeFile(real, text, { mode: 0o600 });
  await rm(f.path);
  await symlink(real, f.path);
  t.after(await f.setup({ environment }));
  assert.equal(await f.invoke('pr-review', f.azure.prUrl()), UPDATE_REQUIRED(f));
  const linked = await f.rpc.handlers.status({});
  assert.deepEqual([linked.editable, linked.fileProblem, linked.migration], [false, 'Setup refuses a symbolic link for settings.json.', undefined]);
  assert.equal((await f.rpc.handlers.save({ migrate: '0123456789ab' })).ok, false);
  assert.equal(await f.invoke('pr-setup', '--migrate 0123456789ab'), '[AZPR] Setup refuses a symbolic link for settings.json.');
  assert.deepEqual(await addMissingSettings(f.path), { added: [] });
  assert.deepEqual([await readFile(real, 'utf8'), (await lstat(f.path)).isSymbolicLink(), (await readdir(join(f.root, 'private config'))).sort()], [text, true, ['settings.json']]);
  // The same for a file that has a second name elsewhere.
  await rm(f.path);
  await fsPromises.link(real, f.path);
  const named = await f.rpc.handlers.status({});
  assert.deepEqual([named.editable, named.fileProblem, named.migration], [false, 'Setup requires a regular settings file owned by you, without hard links.', undefined]);
  assert.equal((await f.rpc.handlers.save({ migrate: '0123456789ab' })).ok, false);
  assert.equal(await f.invoke('pr-setup', '--migrate 0123456789ab'), '[AZPR] Setup requires a regular settings file owned by you, without hard links.');
  assert.deepEqual([await readFile(real, 'utf8'), (await lstat(real)).nlink, f.agents.size], [text, 2, 0]);
  // As a regular file of its own, the same text is offered its update.
  await rm(f.path);
  await writeFile(f.path, text, { mode: 0o600 });
  assert.equal((await f.rpc.handlers.status({})).state, 'migrate');

  // The update has the turn like every other save, from its first read to the end of the load that follows it:
  // whichever way another save comes in meanwhile, it changes nothing.
  const g = await outdated(t);
  t.after(await g.f.setup({ environment: g.environment, releaseWaitMs: 50 }));
  const word = (await g.f.rpc.handlers.status({})).migration.word, list = g.f.context.command.list;
  let held, release;
  // The load of the updated settings waits on the host; meanwhile other saves arrive.
  g.f.context.command.list = async () => { if (!held) { held = new Promise(resolve => { release = resolve; }); await held; } return list(); };
  const first = g.f.rpc.handlers.save({ migrate: word });
  for (let turn = 0; turn < 200 && !release; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function', 'The update is saved and is being loaded.');
  assert.equal(await readFile(g.f.path, 'utf8'), updatedText(g.legacy));
  assert.equal(await g.f.invoke('pr-setup', '--language ja'), '[AZPR] Another setup is active.');
  assert.equal(await g.f.invoke('pr-setup', `--migrate ${word}`), '[AZPR] Another setup is active.');
  assert.deepEqual(await g.f.rpc.handlers.save({ changes: { language: 'ja' } }), { ok: false, problem: 'Another setup is being saved.' });
  assert.deepEqual(await g.f.rpc.handlers.save({ migrate: word }), { ok: false, problem: 'Another setup is being saved.' });
  assert.equal(await readFile(g.f.path, 'utf8'), updatedText(g.legacy), 'Neither changed what is being loaded.');
  release();
  const saved = await first;
  g.f.context.command.list = list;
  assert.deepEqual([saved.ok, saved.status.state, g.f.agents.has('azpr-review-reviewer'), g.f.rpc.events], [true, 'ready', true, [['loaded', {}]]], 'The update is loaded as it was saved.');
});

test('what the update of 0.4.x settings changes is said line by line, with model IDs and nothing else of the file: a /pr-deep that was partly set, who rates, automatic comments', async t => {
  const { f, environment, legacy } = await outdated(t);
  t.after(await f.setup({ environment }));
  const { status, save } = f.rpc.handlers;
  const offered = async settings => { await writeFile(f.path, settingsText(settings), { mode: 0o600 }); return status({}); };
  const RATED_BY_FIRST = modes => `Severity rating of ${modes}: none ran before (no rater was set). From now on the first reviewer model rates the findings from their text alone; "rater": false in the settings file switches that off.`;
  const POSTS = (modes, several) => `afterReview is "publish" for ${modes}: after the update ${several ? 'these commands post' : 'this command posts'} the comments of the new reviews automatically, as the PAT owner. ` +
    'Reports and comments then say that findings were checked by their reviewer and that no separate verification ran. ' +
    `To read the comments before they are posted, set afterReview to preview for ${several ? 'these modes' : 'this mode'}.`;
  // /pr-deep with all three models and every rating at its default: each verified mode becomes two passes, and a
  // rating runs where none ran. One mode posts by itself; the verifier's batch size has nothing left to size.
  const deep = { ...legacy, models: { ...legacy.models, deep: { functional: 'fixture/model#high', risk: 'fixture/model', verifier: 'fixture/verifier', rater: '' } }, afterReview: { quick: 'publish', review: 'none', deep: 'preview' } };
  assert.deepEqual((await offered(deep)).migration.lines, [UPDATE_FIRST, UPDATE_REVIEW,
    '/pr-deep: functional fixture/model#high, risk fixture/model, verifier fixture/verifier -> 2 passes: fixture/model#high, fixture/model. The verifier model is no longer used.',
    '/pr-quick: reviewer fixture/model#high -> 1 pass: fixture/model#high.', RATED_BY_FIRST('/pr-review, /pr-deep, /pr-quick'),
    'workflow.shardFindings is dropped: it sized the verifier\'s batches.', POSTS('/pr-quick', false), UPDATE_LAST]);
  // Raters that were named stay; /pr-quick, which never had one, gets the first reviewer model's rating.
  const rated = { ...deep, models: { ...deep.models, review: { ...deep.models.review, rater: 'fixture/rater' }, deep: { ...deep.models.deep, rater: 'fixture/model#high' } }, afterReview: legacy.afterReview };
  assert.deepEqual((await offered(rated)).migration.lines.slice(4, 7), ['Severity rating of /pr-review: fixture/rater, as before.', 'Severity rating of /pr-deep: fixture/model#high, as before.', RATED_BY_FIRST('/pr-quick')]);
  // What is no model ID is named, never shown: a model slot may hold something that was pasted into the wrong
  // place. Nor does anything else of the file appear: a token kept in it, a proxy's user name and password.
  const withSecrets = base => ({ ...base, models: { ...base.models, review: { ...base.models.review, verifier: 'PRIVATE_VALUE_0123456789' }, deep: { functional: 'fixture/model', risk: '', verifier: 'PRIVATE_VALUE_0123456789', rater: '' } },
    azure: { ...base.azure, pat: FAKE_PAT, patFile: '', proxy: 'http://user:pw-secret@proxy.example:8080' } });
  const hidden = await offered(withSecrets(legacy));
  assert.deepEqual(hidden.migration.lines.slice(1, 3), ['/pr-review: functional fixture/model, risk fixture/model#high, verifier (not a model ID) -> 2 passes: fixture/model, fixture/model#high. The verifier model is no longer used.',
    '/pr-deep: only some of its three models were set, so it was off and stays off (models.deep.reviewers is empty). Set it afterwards with /pr-setup.']);
  assert.deepEqual([rowsOf(hidden).token.value, rowsOf(hidden).token.saved, rowsOf(hidden).proxy.value], ['in the settings file', true, 'http://proxy.example:8080 (with credentials)']);
  const guide = await f.invoke('pr-setup', '');
  assert.match(guide, /\n- \/pr-review: functional fixture\/model, risk fixture\/model#high, verifier \(not a model ID\) -> 2 passes: /);
  for (const said of [JSON.stringify(hidden), guide, await f.invoke('pr-review', f.azure.prUrl())]) assert.doesNotMatch(said, /PRIVATE_VALUE|fixture-pat|pw-secret/, 'Neither a value that is no model ID, nor the token, nor the proxy\'s password.');

  // A group that names reviewers already, whatever they hold, is kept as it is and named: neither version could
  // use it, and its models are not mixed with the ones the update would map.
  const clashing = { ...legacy, models: { ...legacy.models, review: { ...legacy.models.review, reviewers: ['fixture/other'] }, deep: { functional: 'fixture/model', risk: 'fixture/model', verifier: 'fixture/verifier', reviewers: null } } };
  assert.deepEqual((await offered(clashing)).migration.lines.slice(1, 3), ['/pr-review: its settings name reviewers, which 0.4.x did not know, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.',
    '/pr-deep: its settings name reviewers, which 0.4.x did not know, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.']);

  // A group written wholly as this version writes one runs as it is after the update: the lines name its passes,
  // its rating and that it posts by itself, as for any mode that runs.
  const asWritten = { ...legacy, models: { ...legacy.models, quick: { reviewers: ['fixture/other'] } }, afterReview: { quick: 'publish', review: 'none', deep: 'none' } };
  const writtenLines = (await offered(asWritten)).migration.lines;
  assert.deepEqual(writtenLines.filter(line => /\/pr-quick/.test(line)), ['/pr-quick: the file already names its reviewers as this version does, so they stay -> 1 pass: fixture/other.',
    RATED_BY_FIRST('/pr-review, /pr-quick'), POSTS('/pr-quick', false)]);

  // /pr-deep with two of its three models was off in 0.4.x and stays off: its list is empty, whatever its rater
  // was. /pr-quick was off as well; two modes post by themselves; no batch size was set.
  const partial = { ...legacy, models: { ...legacy.models, review: { ...legacy.models.review, rater: 'fixture/rater' }, deep: { functional: 'fixture/model', risk: 'fixture/model#high', verifier: '', rater: 'fixture/model#high' }, quick: { reviewer: '' } },
    afterReview: { quick: 'preview', review: 'publish', deep: 'publish' }, workflow: { shardFiles: 30 } };
  const last = await offered(partial);
  assert.deepEqual(last.migration.lines, [UPDATE_FIRST, UPDATE_REVIEW,
    '/pr-deep: only some of its three models were set, so it was off and stays off (models.deep.reviewers is empty). Set it afterwards with /pr-setup.', '/pr-quick: off, stays off.',
    'Severity rating of /pr-review: fixture/rater, as before.', POSTS('/pr-review, /pr-deep', true), UPDATE_LAST]);
  assert.deepEqual([rowsOf(last).reviewModel.value, rowsOf(last).deepModel.value, rowsOf(last).quickModel.value, rowsOf(last).afterReview.value], ['model + model#high', 'off', 'off', 'differs by mode']);
  const updated = await save({ migrate: last.migration.word });
  assert.deepEqual([updated.ok, updated.status.state], [true, 'ready']);
  const written = await readFile(f.path, 'utf8'), saved = JSON.parse(written);
  assert.equal(written, updatedText(partial));
  assert.deepEqual(saved.models, { review: { reviewers: ['fixture/model', 'fixture/model#high'], rater: 'fixture/rater' }, deep: { reviewers: [], rater: 'fixture/model#high' }, quick: { reviewers: [], rater: '' } });
  assert.deepEqual([saved.afterReview, saved.workflow], [partial.afterReview, { shardFiles: 30, parallelSessions: 8, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 }],
    'What posts by itself still does, as the lines said; what the file left out of a group is added at its default.');
  // The runtime that was loaded has /pr-review with the named rater, and neither /pr-deep nor /pr-quick.
  assert.deepEqual([...f.agents.keys()].filter(name => /-(?:reviewer[b-d]?|rating)$/.test(name)).sort(), ['azpr-review-rating', 'azpr-review-reviewer', 'azpr-review-reviewerb']);
  assert.ok(f.notices.every(notice => !/PRIVATE_VALUE|fixture-pat|pw-secret/.test(notice.text)));

  // Updated, a file keeps what was its person's own, the token it holds and the proxy with its password, and
  // loses what went with the verifier; still no answer and no notice holds any of it, by either way.
  for (const way of ['rpc', 'option']) {
    const s = await outdated(t, g => withSecrets(legacySettings(g)));
    t.after(await s.f.setup({ environment: s.environment }));
    const shown = await s.f.rpc.handlers.status({});
    const answer = way === 'rpc' ? await s.f.rpc.handlers.save({ migrate: shown.migration.word }) : await s.f.invoke('pr-setup', `--migrate ${shown.migration.word}`);
    const kept = await readFile(s.f.path, 'utf8');
    assert.deepEqual([kept, JSON.parse(kept).azure.pat, JSON.parse(kept).azure.proxy, kept.includes('PRIVATE_VALUE')], [updatedText(s.legacy), FAKE_PAT, 'http://user:pw-secret@proxy.example:8080', false], way);
    assert.deepEqual([(await s.f.rpc.handlers.status({})).state, s.f.agents.has('azpr-review-reviewer')], ['ready', true], 'The token in the settings is the one in use.');
    for (const said of [JSON.stringify(shown), JSON.stringify(answer), JSON.stringify(await s.f.rpc.handlers.status({})), JSON.stringify(s.f.notices)]) {
      assert.doesNotMatch(said, /PRIVATE_VALUE|fixture-pat|pw-secret/, way);
    }
  }
});

// What stands in a model's place and is no model ID is named, never returned, as the lines of an update have it: a
// token that was pasted into the wrong place is in no answer of the server part, neither in a row's value, its
// current text nor its entries, for settings of 0.4.x (whose rows are made of what the update will write) and of
// this version alike.
test('a token pasted where a model goes is named, never returned: also not in a row of the dialogs\' server part', async t => {
  /** The rows of a status answer that hold the token, with the fields it is in. */
  const echoed = status => status.rows.filter(row => JSON.stringify(row).includes(FAKE_PAT)).map(row => [row.id, Object.keys(row).filter(key => JSON.stringify(row[key]).includes(FAKE_PAT))]);
  // Settings of 0.4.x: the token where the first reviewer's model goes, and the quick reviewer's.
  const old = await outdated(t, f => legacySettings(f, { models: { review: { functional: FAKE_PAT, risk: 'fixture/model#high', verifier: 'fixture/verifier', rater: '' }, quick: { reviewer: FAKE_PAT } } }));
  t.after(await old.f.setup({ environment: old.environment }));
  const offered = await old.f.rpc.handlers.status({});
  // What a person is shown names it without showing it, and so does every notice.
  assert.deepEqual(offered.migration.lines.slice(1, 4), ['/pr-review: its models are not all model IDs, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.',
    '/pr-deep: off, stays off.', '/pr-quick: its models are not all model IDs, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.']);
  for (const notice of [await old.f.invoke('pr-setup', ''), await old.f.invoke('pr-review', old.f.azure.prUrl())]) assert.ok(!notice.includes(FAKE_PAT));
  // Settings of this version: the token as an entry of the review models.
  const now = await fixture(t);
  await mkdir(join(now.root, 'private config'), { mode: 0o700 });
  await writeFile(now.path, JSON.stringify({ version: 3, models: { review: { reviewers: [FAKE_PAT, 'fixture/model'] } }, azure: { organization: 'fixture', pat: '', patFile: now.pat } }), { mode: 0o600 });
  t.after(await now.setup({ environment: environmentOf(now) }));
  for (const notice of [await now.invoke('pr-setup', '--help'), await now.invoke('pr-review', now.azure.prUrl())]) assert.ok(!notice.includes(FAKE_PAT));
  const listed = await now.rpc.handlers.status({});
  assert.deepEqual({ outdated: echoed(offered), current: echoed(listed) }, { outdated: [], current: [] }, 'Rows of the status answer hold the token.');
});

test('an update of 0.4.x settings that was saved elsewhere, or for settings in use, waits for the restart; one that leaves them unusable says why', async t => {
  // One settings file, loaded by OpenCode for two project directories: each has a server part of its own, and neither found usable settings.
  const { f, environment, legacy } = await outdated(t);
  const g = await fixture(t);
  g.context.options.settingsFile = f.path;
  t.after(await f.setup({ environment }));
  t.after(await g.setup({ environment }));
  const shown = await f.rpc.handlers.status({});
  assert.deepEqual([shown.state, (await g.rpc.handlers.status({})).state], ['migrate', 'migrate']);
  // The other one's setup saves the update: it made the settings usable, so they are its to load.
  const there = await g.rpc.handlers.save({ migrate: (await g.rpc.handlers.status({})).migration.word });
  assert.deepEqual([there.ok, there.status.state, g.agents.has('azpr-review-reviewer'), g.rpc.events], [true, 'ready', true, [['loaded', {}]]]);
  // Here they were saved elsewhere: this process read no settings and reads none now. Setup says that they wait
  // for the restart, and so does every review command; the word that was shown here names nothing any more.
  const here = await f.rpc.handlers.status({});
  assert.deepEqual([here.state, here.editable, here.fileProblem, here.migration, f.agents.size], ['restart', true, '', undefined, 0]);
  assert.equal(await f.invoke('pr-check', f.azure.prUrl()),
    `[AZPR] RESTART REQUIRED\nNo review or Azure request was started. The settings at ${f.path} can be used now, but AZPR found no usable settings when OpenCode loaded it for this project directory, and these were saved elsewhere: by a setup in another project directory or another OpenCode process, or by hand. To load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process).`);
  assert.deepEqual(await f.rpc.handlers.save({ migrate: shown.migration.word }), { ok: false, problem: 'These settings need no update.' });
  assert.equal(await f.invoke('pr-setup', `--migrate ${shown.migration.word}`), '[AZPR] These settings need no update: --migrate is only for settings of AZPR 0.4.x that /pr-setup offers to update.');
  assert.equal(await readFile(f.path, 'utf8'), updatedText(legacy));
  // What this process's own setup saves on top of them does not make them its to load.
  const changed = await f.rpc.handlers.save({ changes: { language: 'ja' } });
  assert.deepEqual([changed.ok, changed.status.state, f.agents.size, f.rpc.events], [true, 'restart', 0, []]);
  assert.match(await f.invoke('pr-check', f.azure.prUrl()), /^\[AZPR\] RESTART REQUIRED\n/);

  // A process whose settings are in use, and settings of 0.4.x that take their place (a backup put back, say):
  // the runtime keeps what it read. Setup offers the update, and what it saves waits for the restart, as every change does.
  const h = await fixture(t), own = environmentOf(h);
  await saveSetup(h.context, h.path, h.args);
  t.after(await h.setup({ environment: own }));
  assert.equal((await h.rpc.handlers.status({})).state, 'ready');
  await writeFile(h.path, settingsText(legacySettings(h)), { mode: 0o600 });
  const offered = await h.rpc.handlers.status({});
  assert.deepEqual([offered.state, offered.problem, offered.editable, offered.migration.lines], ['migrate', '', false, UPDATE_LINES]);
  const updated = await h.rpc.handlers.save({ migrate: offered.migration.word });
  assert.deepEqual([updated.ok, updated.status.state, updated.status.migration, h.rpc.events], [true, 'restart', undefined, []]);
  assert.equal(await readFile(h.path, 'utf8'), updatedText(legacySettings(h)));
  await h.invoke('pr-check', h.azure.prUrl());
  for (let attempt = 0; attempt < 200 && !h.reports.some(report => /settings\.json changed since OpenCode loaded it/.test(report)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(h.reports.at(-1), /settings\.json changed since OpenCode loaded it\. Restart the OpenCode service/, 'The runtime says the same.');
  // With the option, the receipt names the restart.
  await writeFile(h.path, settingsText(legacySettings(h)), { mode: 0o600 });
  assert.equal(await h.invoke('pr-setup', `--migrate ${(await h.rpc.handlers.status({})).migration.word}`),
    `[AZPR] SETTINGS UPDATED\nSettings: ${h.path}\nThe settings file now has the layout of this version; /pr-setup shows and changes the models of each mode.\n` +
    'To load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process), then run /pr-check <PR URL>. No model or Azure request was made. Existing reviews keep their original settings.');
  // Settings of 0.4.x with a fault, in the same place: updated, they are a file of this version that cannot be
  // used yet, which the answer says; the runtime keeps what it read, and setup lists the settings, so the fault can be set there.
  await writeFile(h.path, settingsText(legacySettings(h, { outputLanguage: 'Traditional Chinese' })), { mode: 0o600 });
  const faulty = await h.rpc.handlers.save({ migrate: (await h.rpc.handlers.status({})).migration.word });
  assert.deepEqual([faulty.ok, faulty.remaining, faulty.status.state, faulty.status.editable, faulty.status.problem, h.rpc.events],
    [true, 'outputLanguage must be a language tag such as en, zh-TW, zh-CN, or ja (not a language name or instruction).', 'restart', true, '', []]);
  const list = dialogs(h, ['language', 'zh-TW', undefined]);
  await list.setup.open();
  assert.deepEqual([list.shown.map(item => `${item.kind}: ${item.title}`), JSON.parse(await readFile(h.path, 'utf8')).outputLanguage],
    [['select: AZPR settings · restart needed', 'select: Language of reports and comments', 'select: AZPR settings · restart needed'], 'zh-TW']);

  // Settings of 0.4.x whose token file is not there: the update is offered and saved all the same, but what it
  // leaves cannot be used yet, and the answer says what stands in the way. Nothing is this setup's to load then.
  for (const way of ['dialogs', 'option']) {
    const k = await outdated(t);
    await rm(k.f.pat);
    t.after(await k.f.setup({ environment: k.environment }));
    const before = await k.f.rpc.handlers.status({});
    assert.deepEqual([before.state, rowsOf(before).token.saved, rowsOf(before).token.value], ['migrate', false, 'not set']);
    if (way === 'dialogs') {
      const d = dialogs(k.f, ['update']);
      await d.setup.open();
      assert.equal(d.shown.at(-1).message, 'The settings file is updated, but AZPR could not load it: azure.patFile could not be used (not found).\n\nSet that right, then restart the OpenCode service (opencode service restart) and run /pr-check <PR URL>.');
    } else {
      assert.equal(await k.f.invoke('pr-setup', `--migrate ${before.migration.word}`),
        `[AZPR] SETTINGS UPDATED\nSettings: ${k.f.path}\nThe settings file now has the layout of this version; /pr-setup shows and changes the models of each mode.\n` +
        'AZPR could not load them: azure.patFile could not be used (not found). Repair that, then restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process). No model or Azure request was made.');
    }
    assert.equal(await readFile(k.f.path, 'utf8'), updatedText(k.legacy));
    const after = await k.f.rpc.handlers.status({});
    assert.deepEqual([after.state, after.problem, after.editable, k.f.agents.size, k.f.rpc.events], ['required', 'azure.patFile could not be used (not found).', true, 0, []], way);
    assert.match(await k.f.invoke('pr-review', k.f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n.*could not be used when OpenCode loaded AZPR: azure\.patFile could not be used \(not found\)\./);
    // Someone then puts the token there: that makes them usable, and it was not this setup's doing.
    await writeFile(k.f.pat, FAKE_PAT, { mode: 0o600 });
    const later = await k.f.rpc.handlers.save({ changes: { language: 'ja' } });
    assert.deepEqual([later.ok, later.status.state, k.f.agents.size], [true, 'restart', 0], way);
  }
});

test('in the terminal UI the update of 0.4.x settings is shown, left alone unless it is asked for, and saved once', async t => {
  const { f, environment, legacy, text } = await outdated(t);
  t.after(await f.setup({ environment }));
  // Before anything is typed: a hint that says what /pr-setup is for here.
  const hinted = dialogs(f, []);
  await hinted.setup.hint();
  await hinted.setup.hint();
  assert.deepEqual(hinted.toasts, [{ message: 'AZPR\'s settings are from an earlier version. Type /pr-setup to see what changes and update them.', variant: 'info', duration: 8000 }]);
  // What changes is shown first, then asked in a list whose first row keeps the file: Escape and that row change nothing.
  for (const answer of [undefined, 'keep']) {
    const d = dialogs(f, [answer]);
    await d.setup.open();
    assert.deepEqual(d.shown.map(item => `${item.kind}: ${item.title}`), ['alert: AZPR\'s settings are from an earlier version', 'select: Update AZPR\'s settings file?']);
    assert.equal(d.shown[0].message, `${UPDATE_LINES.map(line => `- ${line}`).join('\n')}\n\nNothing is changed until you confirm in the next step.`);
    assert.deepEqual(d.shown[1].options, [{ title: 'Not now', value: 'keep', description: 'The file stays as it is; reviews do not run until it is updated' },
      { title: 'Update the settings file', value: 'update', description: '…/private config/settings.json' }]);
    assert.equal(d.shown[1].current, undefined, 'Nothing is preselected but the first row: the one that keeps the file.');
    assert.deepEqual(d.toasts, [{ message: 'AZPR setup: the settings file was left as it is.', variant: 'info' }]);
    assert.equal(await readFile(f.path, 'utf8'), text);
  }
  // The file changes while the question is open: the answer was given for what was shown, so nothing is saved, and that is said.
  const edited = settingsText({ ...legacy, outputLanguage: 'ja' });
  const stale = dialogs(f, [async () => { await writeFile(f.path, edited, { mode: 0o600 }); return 'update'; }]);
  await stale.setup.open();
  assert.deepEqual(stale.shown.map(item => item.title), ['AZPR\'s settings are from an earlier version', 'Update AZPR\'s settings file?']);
  assert.deepEqual(stale.toasts, [{ title: 'AZPR setup', message: CHANGED_SINCE.problem, variant: 'error', duration: 10000 }]);
  assert.equal(await readFile(f.path, 'utf8'), edited);
  assert.deepEqual([f.agents.size, f.rpc.events], [0, []]);
  await writeFile(f.path, text, { mode: 0o600 });
  // Asked for, the update is saved, loaded at once, and the commands are read again before the result is shown.
  const d = dialogs(f, ['update']);
  await d.setup.open();
  assert.deepEqual(d.shown.map(item => `${item.kind}: ${item.title}`), ['alert: AZPR\'s settings are from an earlier version', 'select: Update AZPR\'s settings file?', 'alert: AZPR\'s settings are updated']);
  assert.equal(d.shown.at(-1).message, 'Reviews run again:\n\n/pr-check <PR URL>\n/pr-review <PR URL>\n\n/pr-setup shows the models of each mode and changes them.');
  assert.deepEqual(d.toasts, []);
  assert.equal(await readFile(f.path, 'utf8'), updatedText(legacy));
  assert.deepEqual([f.agents.has('azpr-review-reviewer'), f.rpc.events], [true, [['loaded', {}]]]);
  // Opened again, setup is the list of this version's settings, with the models the update left; no hint is due.
  const list = dialogs(f, [undefined]);
  await list.setup.hint();
  await list.setup.open();
  assert.deepEqual([list.toasts, list.shown.map(item => `${item.kind}: ${item.title}`)], [[], ['select: AZPR settings']]);
  assert.deepEqual(list.shown[0].options.filter(option => option.category === 'Models').map(option => [option.title, option.description, option.footer]),
    [['Review models', 'for /pr-review', 'model + model#high'], ['Quick models', 'for /pr-quick', 'model#high'], ['Deep models', 'for /pr-deep', 'off']]);
  for (const said of [hinted.said(), stale.said(), d.said(), list.said(), JSON.stringify(f.notices)]) assert.ok(!said.includes(FAKE_PAT));
});

// The settings example of 0.4.6 as its installer copied it: placeholders where the review models go, and no organization.
const LEGACY_EXAMPLE = Object.freeze({ $schema: './settings.schema.json', version: 2,
  models: { review: { functional: 'REPLACE_PROVIDER/REPLACE_FUNCTIONAL', risk: 'REPLACE_PROVIDER/REPLACE_RISK', verifier: 'REPLACE_PROVIDER/REPLACE_VERIFIER', rater: '' },
    deep: { functional: '', risk: '', verifier: '', rater: '' }, quick: { reviewer: '' } },
  enabled: true, returnReport: 'receipt', debug: { enabled: false, directory: '', keepRuns: 20 }, outputLanguage: 'en', runTimeoutSeconds: null, shell: 'deny', progressNotices: true,
  deletePrivateSessions: true, terminalPanel: 'auto', afterReview: { quick: 'preview', review: 'preview', deep: 'preview' },
  azure: { organization: '', pat: '', patFile: '', concurrency: 6, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true },
  workflow: { shardFiles: 25, shardFindings: 15, parallelSessions: 8, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 } });
/** The last line of an update that leaves a fault: the file keeps it, and the repair follows the update. */
const STILL = problem => `After the update the settings still cannot be used: ${problem} Nothing runs until that is set right, with /pr-setup or in the settings file.`;
/** What /pr-setup --migrate answers for such an update. */
const UPDATED_NOT_USABLE = (f, problem) => `[AZPR] SETTINGS UPDATED\nSettings: ${f.path}\nThe settings file now has the layout of this version, and still cannot be used: ${problem} ` +
  'Set that right with /pr-setup (in the terminal UI it asks in dialogs; --help shows the options) or in the settings file. No model or Azure request was made.';

test('settings of 0.4.x that were never set up take their update like any others; the first setup then completes what the update leaves', async t => {
  /** What the update makes of the example: this version's layout around the placeholders it had, since an update chooses no model. */
  const updatedExample = () => {
    const { models, workflow: { shardFindings, ...workflow }, ...rest } = LEGACY_EXAMPLE;
    return { ...rest, version: 3, workflow,
      models: { review: { reviewers: ['REPLACE_PROVIDER/REPLACE_FUNCTIONAL', 'REPLACE_PROVIDER/REPLACE_RISK'], rater: '' }, deep: { reviewers: [], rater: '' }, quick: { reviewers: [], rater: '' } } };
  };
  /** And what a first setup with this model and these Azure values makes of that. */
  const setUp = (model, azure) => ({ ...updatedExample(), azure: { ...LEGACY_EXAMPLE.azure, ...azure },
    models: { review: { reviewers: [model, model], rater: '' }, deep: { reviewers: [], rater: '' }, quick: { reviewers: [model], rater: '' } } });
  const NO_MODEL = 'models.review.reviewers[0]: select an actual provider/model ID from opencode models, optionally with a variant as provider/model#variant; do not use a display name or placeholder.';
  // No model is named as if it were one, and what the file still lacks after the update is said before it is confirmed.
  // A mode whose models were never chosen ran no review, so there is nothing to say about who rated before.
  const EXAMPLE_LINES = [UPDATE_FIRST, '/pr-review: no model was chosen yet. Choose its models with /pr-setup after the update.', '/pr-deep: off, stays off.', '/pr-quick: off, stays off.',
    'workflow.shardFindings is dropped: it sized the verifier\'s batches.', UPDATE_LAST, STILL(NO_MODEL)];

  // In the terminal UI.
  const { f, environment, text } = await outdated(t, () => LEGACY_EXAMPLE);
  const tokenFile = join(environment.XDG_CONFIG_HOME, 'azpr', 'pat-fixture');
  t.after(await f.setup({ environment }));
  // The update is offered as for any settings of 0.4.x: by the commands, by /pr-setup and by the dialogs' server part.
  assert.equal(await f.invoke('pr-review', f.azure.prUrl()), UPDATE_REQUIRED(f));
  const before = await f.rpc.handlers.status({});
  assert.deepEqual([before.state, before.editable, before.fileProblem, before.migration.lines, before.organization, rowsOf(before).token.value], ['migrate', false, MIGRATION_NEEDED, EXAMPLE_LINES, '', 'not set']);
  assert.equal(await f.invoke('pr-setup', ''), UPDATE_GUIDE(f, EXAMPLE_LINES, before.migration.word));
  assert.deepEqual(f.notices.at(-1).metadata, { azpr: { setup: true } });
  // Nothing else changes the file, also not the first setup it needs next: no option and no answer says that the update was seen.
  for (const options of [`--organization fixture --model fixture/model --pat-file "${f.pat}"`, `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`, '--review-model fixture/model', '--language ja']) {
    assert.equal(await f.invoke('pr-setup', options), `[AZPR] ${MIGRATION_NEEDED} Other options work after that.`, options);
  }
  for (const input of [{ changes: { organization: 'fixture', model: 'fixture/model' }, token: FAKE_PAT }, { changes: { organization: 'fixture', model: 'fixture/model' } }, { changes: { reviewModel: 'fixture/model' } }]) {
    assert.deepEqual(await f.rpc.handlers.save(input), { ok: false, problem: MIGRATION_NEEDED }, JSON.stringify(input.changes));
  }
  assert.deepEqual(await f.rpc.handlers.validate({ changes: { organization: 'fixture', model: 'fixture/model' } }), { ok: false, problem: MIGRATION_NEEDED });
  assert.deepEqual(await f.rpc.handlers.check({ organization: 'fixture', token: FAKE_PAT }), { ok: false, fix: '', problem: MIGRATION_NEEDED });
  assert.equal(await readFile(f.path, 'utf8'), text, 'The file is as it was');
  await assert.rejects(lstat(join(environment.XDG_CONFIG_HOME, 'azpr')), { code: 'ENOENT' }, 'no token was saved');
  assert.equal(f.azure.state.calls.length, 0, 'and none was sent.');
  // The dialogs: the hint, what changes, the confirmation, and what is still missing afterwards, with where it is set.
  const d = dialogs(f, ['update']);
  await d.setup.hint();
  assert.deepEqual(d.toasts, [{ message: 'AZPR\'s settings are from an earlier version. Type /pr-setup to see what changes and update them.', variant: 'info', duration: 8000 }]);
  await d.setup.open();
  assert.deepEqual(d.shown.map(item => `${item.kind}: ${item.title}`), ['alert: AZPR\'s settings are from an earlier version', 'select: Update AZPR\'s settings file?', 'alert: AZPR\'s settings are updated']);
  assert.equal(d.shown[0].message, `${EXAMPLE_LINES.map(line => `- ${line}`).join('\n')}\n\nNothing is changed until you confirm in the next step.`);
  assert.equal(d.shown.at(-1).message, `The settings file has the layout of this version now. It still cannot be used:\n\n${NO_MODEL}\n\nSet that right with /pr-setup or in the settings file.`);
  // What was written is the update and nothing more: the placeholders are where the reviewer models go now, the
  // verifier's is gone, and every other value is where it was. Nothing is loaded: the settings are still not usable.
  const updated = await readFile(f.path, 'utf8');
  assert.equal(updated, updatedText(LEGACY_EXAMPLE));
  assert.deepEqual(JSON.parse(updated), updatedExample());
  assert.deepEqual([Object.keys(JSON.parse(updated)), withMissingSettings(JSON.parse(updated)).added, await mode(f.path)], [Object.keys(LEGACY_EXAMPLE), [], 0o600]);
  const after = await f.rpc.handlers.status({});
  assert.deepEqual([after.state, after.problem, after.editable, after.fileProblem, after.migration, f.agents.size, f.rpc.events], ['required', NO_MODEL, true, '', undefined, 0, []]);
  assert.match(await f.invoke('pr-review', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n.*could not be used when OpenCode loaded AZPR: models\.review\.reviewers\[0\]: select an actual provider\/model ID/);
  // Run again, /pr-setup is the first setup of a file of this version, and what it saves is loaded at once.
  const s = dialogs(f, ['fixture', '', FAKE_PAT, 'fixture/model', '', true]);
  await s.setup.hint();
  assert.deepEqual(s.toasts, [{ message: 'AZPR is not set up yet. Type /pr-setup to set it up.', variant: 'info', duration: 8000 }]);
  await s.setup.open();
  assert.equal(s.left(), 0);
  assert.deepEqual(s.shown.map(item => `${item.kind}: ${item.title}`), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token',
    'select: Model for /pr-review', 'select: Variant of fixture/model', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved, setUp('fixture/model', { organization: 'fixture', patFile: tokenFile }));
  assert.deepEqual([Object.keys(saved), withMissingSettings(saved).added], [Object.keys(LEGACY_EXAMPLE), []], 'Every setting kept its place, and the file names every setting of this version.');
  assert.deepEqual([await readFile(tokenFile, 'utf8'), await mode(tokenFile), await mode(f.path)], [FAKE_PAT, 0o600, 0o600]);
  assert.deepEqual([f.agents.has('azpr-review-reviewer'), f.agents.has('azpr-deep-reviewer'), f.rpc.events, (await f.rpc.handlers.status({})).state], [true, false, [['loaded', {}]], 'ready'], 'This setup made the settings usable: they are loaded at once.');

  // With options: the word, an answer that says what is still missing, then the options of a first setup.
  const g = await outdated(t, () => LEGACY_EXAMPLE);
  t.after(await g.f.setup({ environment: g.environment }));
  const shown = await g.f.invoke('pr-setup', '--help'), word = /--migrate (\S+)/.exec(shown)[1];
  assert.equal(shown, UPDATE_GUIDE(g.f, EXAMPLE_LINES, word));
  assert.equal(await g.f.invoke('pr-setup', `--migrate ${word}`), UPDATED_NOT_USABLE(g.f, NO_MODEL));
  assert.equal(await readFile(g.f.path, 'utf8'), updatedText(LEGACY_EXAMPLE));
  assert.deepEqual([g.f.agents.size, g.f.rpc.events, (await g.f.rpc.handlers.status({})).state], [0, [], 'required']);
  // From here on it is a file of this version that names no model yet: no update is left, and /pr-setup explains the first setup.
  assert.equal(await g.f.invoke('pr-setup', `--migrate ${word}`), '[AZPR] These settings need no update: --migrate is only for settings of AZPR 0.4.x that /pr-setup offers to update.');
  assert.match(await g.f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP REQUIRED\nSettings: .+\nProblem when OpenCode loaded AZPR: models\.review\.reviewers\[0\]: select an actual provider\/model ID [^\n]+\n\nIn OpenCode's terminal UI, \/pr-setup alone asks for the organization, /);
  // Like other existing settings they are replaced only when that is asked for.
  assert.match(await g.f.invoke('pr-setup', `--organization fixture --model fixture/model#high --pat-file "${g.f.pat}"`), /^\[AZPR\] Settings already exist\. Add --replace /);
  assert.equal(await readFile(g.f.path, 'utf8'), updatedText(LEGACY_EXAMPLE));
  assert.equal(await g.f.invoke('pr-setup', `--organization fixture --model fixture/model#high --pat-file "${g.f.pat}" --replace`),
    `[AZPR] SETTINGS SAVED\nSettings: ${g.f.path}\nOrganization: fixture; PAT file: ${g.f.pat}\nAZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.`);
  const written = JSON.parse(await readFile(g.f.path, 'utf8'));
  assert.deepEqual(written, setUp('fixture/model#high', { organization: 'fixture', patFile: g.f.pat }));
  assert.deepEqual([Object.keys(written), g.f.agents.has('azpr-review-reviewer'), g.f.agents.has('azpr-deep-reviewer'), g.f.rpc.events], [Object.keys(LEGACY_EXAMPLE), true, false, [['loaded', {}]]]);
});

test('settings of 0.4.x with a fault take their update before the fault is repaired: what would repair it changes nothing until then, and what is loaded afterwards is what the update showed', async t => {
  const NO_LANGUAGE = 'outputLanguage must be a language tag such as en, zh-TW, zh-CN, or ja (not a language name or instruction).';
  // A complete file of 0.4.6 with one value that no version accepts, and automatic publication in every mode.
  const PUBLISH = { quick: 'publish', review: 'publish', deep: 'publish' };
  const faulty = f => legacySettings(f, { outputLanguage: 'Traditional Chinese', afterReview: PUBLISH });
  // The update as it is shown: the two passes of each mode that was on, who rates, that these commands post by
  // themselves afterwards, and last what will still be wrong with the file.
  const FAULTY_LINES = [...UPDATE_LINES.slice(0, -1),
    'afterReview is "publish" for /pr-review, /pr-deep, /pr-quick: after the update these commands post the comments of the new reviews automatically, as the PAT owner. Reports and comments then say that findings were checked by their reviewer and that no separate verification ran. To read the comments before they are posted, set afterReview to preview for these modes.',
    UPDATE_LAST, STILL(NO_LANGUAGE)];
  for (const way of ['option', 'rpc']) {
    const { f, environment, legacy, text } = await outdated(t, faulty);
    t.after(await f.setup({ environment }));
    const { status, validate, save } = f.rpc.handlers;
    // An update is offered for this file as for any other of 0.4.x, with the fault it will still have.
    const offered = await status({});
    assert.deepEqual([offered.state, offered.editable, offered.fileProblem, offered.migration.lines], ['migrate', false, MIGRATION_NEEDED, FAULTY_LINES], way);
    assert.equal(await f.invoke('pr-setup', ''), UPDATE_GUIDE(f, FAULTY_LINES, offered.migration.word));
    assert.equal(await f.invoke('pr-review', f.azure.prUrl()), UPDATE_REQUIRED(f));
    // The change that would repair the fault is refused, and writes nothing: it would turn the file into this
    // version's layout without the update having been shown or confirmed.
    if (way === 'option') assert.equal(await f.invoke('pr-setup', '--language zh-TW'), `[AZPR] ${MIGRATION_NEEDED} Other options work after that.`);
    else {
      assert.deepEqual(await validate({ changes: { language: 'zh-TW' } }), { ok: false, problem: MIGRATION_NEEDED });
      assert.deepEqual(await save({ changes: { language: 'zh-TW' } }), { ok: false, problem: MIGRATION_NEEDED });
    }
    assert.deepEqual([await readFile(f.path, 'utf8'), f.agents.size, f.rpc.events], [text, 0, []], way);
    // Confirmed, the update is written as it was shown. The fault is still there, which the answer says, and nothing runs.
    if (way === 'option') assert.equal(await f.invoke('pr-setup', `--migrate ${offered.migration.word}`), UPDATED_NOT_USABLE(f, NO_LANGUAGE));
    else {
      const updated = await save({ migrate: offered.migration.word });
      assert.deepEqual([updated.ok, updated.remaining, Object.keys(updated), updated.status.state, updated.status.problem, updated.status.editable, updated.status.migration],
        [true, NO_LANGUAGE, ['ok', 'status', 'remaining'], 'required', NO_LANGUAGE, true, undefined]);
    }
    assert.equal(await readFile(f.path, 'utf8'), updatedText(legacy));
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { ...updatedSettings(f), outputLanguage: 'Traditional Chinese', afterReview: PUBLISH });
    assert.deepEqual([f.agents.size, f.rpc.events, f.azure.state.calls.length], [0, [], 0], way);
    assert.match(await f.invoke('pr-review', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\n.*could not be used when OpenCode loaded AZPR: outputLanguage must be a language tag/, 'A file of this version now: its fault is named.');
    // Now the repair is a change of one setting of this version's settings: it works, and makes them usable.
    if (way === 'option') {
      assert.equal(await f.invoke('pr-setup', '--language zh-TW'), `[AZPR] SETTINGS SAVED\nSettings: ${f.path}\nChanged: Output language\nAZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.`);
    } else {
      const repaired = await save({ changes: { language: 'zh-TW' } });
      assert.deepEqual([repaired.ok, repaired.status.state, repaired.remaining], [true, 'ready', undefined]);
    }
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { ...updatedSettings(f), outputLanguage: 'zh-TW', afterReview: PUBLISH }, 'Only the language differs from what the update wrote.');
    // What is loaded is what the update showed: two passes of /pr-review with the two reviewer models, one of
    // /pr-quick, the first reviewer model's rating in both, no /pr-deep, and comments posted by themselves.
    assert.deepEqual([...f.agents.keys()].filter(name => /-(?:reviewer[b-d]?|rating)$/.test(name)).sort(), ['azpr-quick-rating', 'azpr-quick-reviewer', 'azpr-review-rating', 'azpr-review-reviewer', 'azpr-review-reviewerb'], way);
    assert.deepEqual(f.rpc.events, [['loaded', {}]]);
    const report = await checkReport(f);
    assert.match(report, /\] READY/, report);
    assert.match(report, /\| Review models \| ok \| 2 passes: fixture\/model, fixture\/model#high; severity rating by fixture\/model \(the first reviewer model\)\. \|/);
    assert.match(report, /\| Quick models \| ok \| 1 pass: fixture\/model#high; severity rating by fixture\/model#high \(the first reviewer model\)\. \|/);
    assert.match(report, /\| Deep models \| ok \| Not set: \/pr-deep stays off /);
    assert.match(report, /\| Automatic comments \| ok \| afterReview: review publish, deep publish, quick publish\. After a COMPLETE \/pr-review, \/pr-deep or \/pr-quick, AZPR posts its comments as the PAT owner; /);
    assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
  }
});

test('every settings file of 0.4.x, whatever else is wrong with it, is offered its update and changed by nothing else; what is wrong is repaired after it', async t => {
  const { f, environment } = await outdated(t);
  t.after(await f.setup({ environment }));
  const { status, validate, check, save } = f.rpc.handlers;
  const complete = legacySettings(f), SECRET_NAME = 'PRIVATE_TOKEN_0123456789abcdefghijklmnopqrstuvwxyz';
  const NO_MODEL = at => `${at}: select an actual provider/model ID from opencode models, optionally with a variant as provider/model#variant; do not use a display name or placeholder.`;
  // The file, what it will still lack after its update, and a line of the update where one is worth a look.
  for (const [legacy, remaining, line] of [
    [{ version: 2 }, 'models.review.reviewers needs at least one model: /pr-review runs one pass per entry.', '/pr-review: off, stays off.'],
    [{ ...complete, shel: 'ask' }, 'Unknown setting settings.shel; check for a typo.'],
    [{ ...complete, [SECRET_NAME]: '' }, 'Unknown setting in settings (its name is not shown because it does not look like a setting name); check for a typo.'],
    [{ ...complete, mcp: { concurrency: 2 } }, 'settings.mcp is no longer used: AZPR calls the Azure DevOps REST API itself. Move concurrency and callTimeoutSeconds to azure, set azure.organization and azure.patFile (or azure.pat), and remove mcp.'],
    [{ ...complete, azure: { ...complete.azure, concurrency: 99 } }, 'azure.concurrency must be an integer from 1 to 8.'],
    [{ ...complete, azure: 'fixture' }, 'azure must be a JSON object.'],
    [{ ...complete, models: [] }, 'models must be a JSON object.', '/pr-review: its settings are not a group of models, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.'],
    // A value in a model's place that is none: named, not shown, also where it stays in the file.
    [{ ...complete, models: { ...complete.models, review: { ...complete.models.review, rater: 'Fixture Rater' } } }, NO_MODEL('models.review.rater'), 'Severity rating of /pr-review: the rater the file names is no model ID; it is kept as it is, and the settings check names it after the update.'],
    [{ ...complete, models: { ...complete.models, review: { ...complete.models.review, functional: 'PRIVATE_VALUE_0123456789' } } }, NO_MODEL('models.review.reviewers[0]'),
      '/pr-review: its models are not all model IDs, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.'],
    [{ ...complete, models: { ...complete.models, quick: { reviewer: 'Quick Model' } } }, NO_MODEL('models.quick.reviewers[0]'), '/pr-quick: its models are not all model IDs, so the file could not be used before either; they are kept as they are, and the settings check names them after the update.'],
    // A mode whose three models are all placeholders was never chosen: the update says so instead of naming models.
    [{ ...complete, models: { ...complete.models, deep: { functional: 'REPLACE_PROVIDER/REPLACE_FUNCTIONAL', risk: 'REPLACE_PROVIDER/REPLACE_RISK', verifier: 'REPLACE_PROVIDER/REPLACE_VERIFIER', rater: '' } } },
      NO_MODEL('models.deep.reviewers[0]'), '/pr-deep: no model was chosen yet. Choose its models with /pr-setup after the update.'],
  ]) {
    const text = JSON.stringify(legacy), name = text.slice(0, 60);
    await writeFile(f.path, text, { mode: 0o600 });
    // Not read at all: the review commands name the update, whatever else the file holds.
    assert.equal(await f.invoke('pr-review', f.azure.prUrl()), UPDATE_REQUIRED(f), name);
    const offered = await status({});
    assert.deepEqual([offered.state, offered.editable, offered.fileProblem, offered.migration.lines.at(-1)], ['migrate', false, MIGRATION_NEEDED, STILL(remaining)], name);
    if (line) assert.ok(offered.migration.lines.includes(line), `${name}: ${JSON.stringify(offered.migration.lines)}`);
    const shown = await f.invoke('pr-setup', '');
    assert.equal(shown, UPDATE_GUIDE(f, offered.migration.lines, offered.migration.word), name);
    for (const said of [JSON.stringify(offered.migration), shown]) assert.doesNotMatch(said, /PRIVATE_|Fixture Rater|Quick Model|fixture-pat/, 'What is shown holds no value that is no model ID, and no name that may be a secret.');
    // Changed by nothing but its update: no option, no answer of the dialogs, no completion at load.
    for (const options of ['--language ja', '--review-model fixture/model', `--organization fixture --model fixture/model --pat-file "${f.pat}" --replace`]) {
      assert.equal(await f.invoke('pr-setup', options), `[AZPR] ${MIGRATION_NEEDED} Other options work after that.`, `${name}: ${options}`);
    }
    for (const input of [{ changes: { language: 'ja' } }, { changes: { organization: 'fixture', model: 'fixture/model' }, token: NEW_TOKEN }, { token: NEW_TOKEN, organization: 'fixture' }]) {
      assert.deepEqual(await save(input), { ok: false, problem: MIGRATION_NEEDED }, name);
    }
    assert.deepEqual([await validate({ changes: { language: 'ja' } }), await check({ organization: 'fixture' })], [{ ok: false, problem: MIGRATION_NEEDED }, { ok: false, fix: '', problem: MIGRATION_NEEDED }], name);
    assert.deepEqual(await addMissingSettings(f.path), { added: [] }, name);
    assert.deepEqual([await readFile(f.path, 'utf8'), await readFile(f.pat, 'utf8'), f.azure.state.calls.length], [text, FAKE_PAT, 0], name);
    // Its update is the update of any file: what migrateSettings makes of it, complete, and the fault with it.
    const updated = await save({ migrate: offered.migration.word });
    assert.deepEqual([updated.ok, updated.remaining, updated.status.state, updated.status.migration], [true, remaining, 'required', undefined], name);
    const written = await readFile(f.path, 'utf8');
    assert.deepEqual([written, JSON.parse(written).version], [updatedText(legacy), 3], name);
    assert.match(await f.invoke('pr-review', f.azure.prUrl()), /^\[AZPR\] SETUP REQUIRED\nNo review or Azure request was started\. /, name);
    assert.ok((await f.invoke('pr-review', f.azure.prUrl())).includes(` could not be used when OpenCode loaded AZPR: ${remaining} `), name);
    assert.deepEqual([f.agents.size, f.rpc.events], [0, []], name);
  }
  // A text that is no JSON object with unique keys is no settings file of any version: it is repaired by hand, as always.
  for (const text of ['{"version":2,"version":2}', '[{"version":2}]', '{"version":2,']) {
    await writeFile(f.path, text, { mode: 0o600 });
    const answer = await status({});
    assert.deepEqual([answer.state, answer.editable, answer.fileProblem, answer.migration], ['required', false, 'settings.json must be a JSON object without duplicate keys; repair it manually before setup.', undefined], text);
    assert.match(await f.invoke('pr-setup', '--language ja'), /^\[AZPR\] settings\.json must be a JSON object without duplicate keys; repair it manually before setup\.$/, text);
    assert.equal(await readFile(f.path, 'utf8'), text);
  }
  assert.ok(f.reports.every(report => !report.includes(SECRET_NAME) && !report.includes(FAKE_PAT)));
});
