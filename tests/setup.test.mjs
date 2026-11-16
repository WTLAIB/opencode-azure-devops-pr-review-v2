import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, readdir, cp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMissingSettings, defaultPatFile, settingsFileFor, parseSetupArguments, saveSetup, setupPlugin } from '../src/setup.mjs';
import { COMMANDS, SETTING_DEFAULTS, settingsText, validateSettings, withMissingSettings } from '../src/config.mjs';
import { FAKE_PAT, fakeAzure, toolRegistry } from './fake-azure.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'azpr-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'package'), path = join(root, 'private config', 'settings.json'), pat = join(root, 'pat file');
  await mkdir(source);
  await cp(new URL('../src/prompts', import.meta.url), join(source, 'prompts'), { recursive: true });
  await writeFile(pat, FAKE_PAT, { mode: 0o600 });
  const commands = new Map(), agents = new Map(), reports = [], hooks = [];
  const azure = fakeAzure({ org: 'fixture' });
  const tools = toolRegistry();
  const registration = () => ({ dispose() {} });
  const context = {
    options: { settingsFile: path },
    location: { directory: root },
    model: { list: async () => ({ data: [{ providerID: 'fixture', id: 'model', enabled: true, capabilities: { tools: true }, variants: [{ id: 'high' }] }] }) },
    command: {
      list: async () => ({ data: [...commands.values()] }),
      transform: async callback => {
        const added = [];
        callback({ add(command) { commands.set(command.name, command); added.push(command.name); } });
        return { dispose() { added.forEach(name => commands.delete(name)); } };
      },
    },
    agent: {
      get: async ({ agentID }) => ({ data: agents.get(agentID) }),
      transform: async callback => { callback({ get: id => agents.get(id), update(id, mutate) {
        const agent = { id, permissions: [] }; mutate(agent); agents.set(id, agent);
      } }); return registration(); },
    },
    session: {
      get: async () => ({ data: { agent: 'build' } }),
      create: async () => { throw new Error('Setup must not create model sessions.'); },
      prompt: async () => { throw new Error('Setup must not prompt a model.'); },
      wait: async () => {}, context: async () => [], interrupt: async () => ({ interrupted: false }),
      hook: async (name, callback) => { hooks.push({ name, callback }); return registration(); },
      synthetic: async input => {
        reports.push(input.text);
        return { id: `notice-${reports.length}`, sessionID: input.sessionID, type: 'synthetic', delivery: 'queue', payload: { text: input.text } };
      },
    },
    tool: { hook: async () => registration(), list: tools.list, transform: tools.transform },
  };
  const args = parseSetupArguments(`--organization fixture --model fixture/model --pat-file "${pat}"`);
  const options = { stateDirectory: join(root, 'state'), fetch: azure.fetch };
  return { root, source, path, pat, context, commands, agents, reports, hooks, azure, args,
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
  assert.ok(receipt.startsWith(`[AZPR] SETTINGS SAVED\nSettings: ${f.path}\nOrganization: fixture; PAT file: ${defaultPat}\n` +
    'To load them, restart the OpenCode service (in a terminal: opencode service restart; if you run opencode serve yourself, restart that process), then run /pr-check <PR URL>.'), receipt);
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

test('setup writes private external settings, uses one model and requires restart before review', async t => {
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
  assert.match(await f.invoke('pr-review', 'a URL'), /SETUP REQUIRED/);
  assert.equal(f.agents.size, 0);
  await cleanup();
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
  assert.match(blocked, /^\[AZPR\] SETUP REQUIRED\nNo review or Azure request was started\. Settings at .+ could not be used when OpenCode loaded AZPR: there is no settings file yet\. Run \/pr-setup --help/);
  assert.match(help, /^\[AZPR\] SETUP REQUIRED\nSettings: .+\nProblem when OpenCode loaded AZPR: there is no settings file yet\.\n\n1\. /);
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
  assert.match(await f.invoke('pr-setup', '--help'), /^\[AZPR\] SETUP\nSettings: .+\n\n1\. /, 'Usable settings show no problem.');
  assert.ok(f.reports.every(report => !report.includes(FAKE_PAT)));
});
