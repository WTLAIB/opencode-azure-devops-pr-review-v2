import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFileFor, parseSetupArguments, saveSetup, setupPlugin } from '../src/setup.mjs';
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
    setup: () => setupPlugin(context, source, options),
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
  for (const input of ['--pat do-not-display-secret', '--organization org --model fixture/model', '--model a/b --model c/d', '--pat-file "unfinished']) {
    assert.throws(() => parseSetupArguments(input), error => !error.message.includes('do-not-display-secret'));
  }
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
