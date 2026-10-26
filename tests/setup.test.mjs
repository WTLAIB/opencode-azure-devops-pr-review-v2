import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPatFile, settingsFileFor, parseSetupArguments, saveSetup, setupPlugin } from '../src/setup.mjs';
import { COMMANDS } from '../src/config.mjs';
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
  const saved = async () => JSON.parse(await readFile(f.path, 'utf8')).azure;
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
  assert.deepEqual(saved.models, { review: { functional: 'fixture/model#high', risk: 'fixture/model#high', verifier: 'fixture/model#high' }, quick: { reviewer: 'fixture/model#high' } });
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
  assert.deepEqual(saved, { ...raw, azure: { ...raw.azure, organization: 'changed' } });
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
  await assert.rejects(saveSetup(f.context, f.path, f.args), /setup lock/);
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
