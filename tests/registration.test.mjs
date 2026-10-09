import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupAzurePrReview } from '../src/runtime.mjs';
import { PROMPTS } from '../src/config.mjs';
import { fakeAzure, toolRegistry, FAKE_PAT } from './fake-azure.mjs';

const copy = value => structuredClone(value);
async function fixture(t, existingCommands = []) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-v2-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
  raw.models.review = { functional: 'fixture/functional', risk: 'fixture/risk', verifier: 'fixture/verifier' };
  raw.azure = { ...raw.azure, organization: 'example', pat: FAKE_PAT };
  await writeFile(join(directory, 'settings.json'), JSON.stringify(raw));
  await mkdir(join(directory, 'prompts'));
  await Promise.all(PROMPTS.map(async name => writeFile(join(directory, 'prompts', name + '.md'),
    await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8'))));
  const agents = new Map([['build', { id: 'build', name: 'Build', permissions: [{ action: 'only-build', resource: '*', effect: 'allow' }] }]]);
  const commands = new Map(existingCommands.map(command => [command.name, command]));
  const calls = { transforms: 0, reviewSessions: 0, agents: [], reports: [] };
  const azure = fakeAzure({ org: 'example', project: 'project', repo: 'repository', prId: 1 });
  const tools = toolRegistry();
  const registration = () => ({ dispose: async () => {} });
  const context = {
    location: { directory },
    model: { list: async () => ({ data: [] }) },
    agent: {
      get: async ({ agentID }) => { calls.agents.push(agentID); return { data: copy(agents.get(agentID)) }; },
      transform: async callback => {
        calls.transforms++;
        callback({
          get: id => agents.get(id),
          update: (id, update) => {
            if (!agents.has(id)) agents.set(id, { id, name: id, request: { settings: {}, headers: {}, body: {} }, mode: 'primary', hidden: false,
              permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: '*.env', effect: 'ask' }] });
            update(agents.get(id));
          },
        });
        return registration();
      },
    },
    command: {
      list: async () => ({ data: [...commands.values()].map(({ name, description }) => ({ name, description })) }),
      transform: async callback => { callback({ add: command => commands.set(command.name, command) }); return registration(); },
    },
    session: {
      hook: async () => registration(),
      create: async () => {
        calls.reviewSessions++;
        throw new Error('No model session expected in registration tests.');
      },
      prompt: async () => { throw new Error('No model prompt expected.'); },
      wait: async () => {}, context: async () => [], get: async () => ({}),
      interrupt: async () => ({ interrupted: false }),
      synthetic: async input => {
        calls.reports.push(input.text);
        return { id: 'queued', sessionID: input.sessionID, type: 'synthetic', payload: { text: input.text }, delivery: 'queue' };
      },
    },
    tool: { hook: async () => registration(), transform: tools.transform, list: tools.list },
  };
  return { context, directory, raw, agents, commands, calls, azure,
    setup: () => setupAzurePrReview(context, directory, { stateDirectory: join(directory, 'state'), fetch: azure.fetch }),
    invoke: async name => {
      const before = calls.reports.length;
      await commands.get(name).execute({ sessionID: 'origin', prompt: { text: azure.prUrl() }, delivery: 'queue' });
      while (!calls.reports.slice(before).some(text => /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/.test(text))) await new Promise(resolve => setImmediate(resolve));
      return calls.reports.slice(before).find(text => /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/.test(text));
    },
  };
}

test('registration preserves an existing reserved command before registering agents or hooks', async t => {
  const original = { name: 'pr-review', description: 'User-owned command', execute: async () => {} };
  const f = await fixture(t, [original]);
  await assert.rejects(f.setup(), /Reserved command name conflict/);
  assert.equal(f.calls.transforms, 0);
  assert.equal(f.commands.get('pr-review'), original);
  assert.deepEqual([...f.agents.keys()], ['build']);
});

test('post-config global permissions are preserved and all private definitions are pinned', async t => {
  const f = await fixture(t);
  const build = copy(f.agents.get('build'));
  t.after(await f.setup());
  const global = { action: 'fixture_mcp_*', resource: '*', effect: 'deny' };
  for (const [role, agent] of f.agents) if (role.startsWith('azpr-')) agent.permissions.push(copy(global));
  const receipt = await f.invoke('pr-review');
  assert.match(receipt, /unavailable in the host catalog/);
  assert.ok(f.calls.agents.includes('azpr-review-verifier'));
  assert.equal(f.calls.reviewSessions, 0);
  for (const [role, agent] of f.agents) if (role.startsWith('azpr-')) {
    assert.deepEqual(agent.permissions.at(-1), global);
    assert.equal(agent.permissions.some(rule => rule.action === 'only-build'), false);
  }
  assert.deepEqual(f.agents.get('build'), build);
});

test('the deterministic source check needs no model session', async t => {
  const f = await fixture(t);
  f.context.model.list = async () => ({ data: ['functional', 'risk', 'verifier'].map(id => ({ providerID: 'fixture', id, enabled: true, capabilities: { tools: true } })) });
  t.after(await f.setup());
  const receipt = await f.invoke('pr-check');
  assert.match(receipt, /\] READY/);
  assert.match(receipt, /HEAD source read \| ok/);
  assert.equal(f.calls.reviewSessions, 0);
  assert.deepEqual(new Set(f.azure.state.calls.map(call => call.route)), new Set(['pr', 'iterations', 'changes', 'items', 'threads']));
  assert.ok(f.azure.state.calls.every(call => call.method === 'GET'), '/pr-check never writes.');
});

test('post-config cannot replace protected role fields or native restrictions before first pin', async t => {
  const alterations = [
    agent => { agent.model.id = 'different'; },
    agent => { agent.system += '\nforeign instructions'; },
    agent => { agent.hidden = false; },
    agent => { agent.steps = 1; },
    agent => { agent.request.settings.timeout = 1; },
    agent => { agent.permissions.find(rule => rule.action === 'execute').effect = 'allow'; },
  ];
  for (const alter of alterations) {
    const f = await fixture(t);
    t.after(await f.setup());
    alter(f.agents.get('azpr-review-functional'));
    assert.match(await f.invoke('pr-check'), /Host configuration changed private agent azpr-review-functional/);
    assert.equal(f.calls.reviewSessions, 0);
  }
});

test('later host permission changes fail existing role fingerprints before creating a reviewer', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  await f.invoke('pr-check');
  f.context.model.list = async () => ({ data: ['functional', 'risk', 'verifier'].map(id => ({ providerID: 'fixture', id, enabled: true, capabilities: { tools: true } })) });
  for (const role of ['azpr-review-functional', 'azpr-review-risk']) f.agents.get(role).permissions.push({ action: 'fixture_mcp_read', resource: '*', effect: 'deny' });
  const receipt = await f.invoke('pr-review');
  assert.equal(f.calls.reviewSessions, 0);
  assert.match(receipt, /Private reviewer configuration changed/);
});

test('AZPR tools are registered once and a foreign tool with the same name is refused', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  const registered = await f.context.tool.list();
  assert.deepEqual(registered.map(tool => tool.name).sort(), ['azpr_list_files', 'azpr_pr_threads', 'azpr_read_file']);
  assert.ok(registered.every(tool => tool.options?.codemode === false), 'Direct tools, not CodeMode.');
  const g = await fixture(t);
  await g.context.tool.transform(editor => editor.add({ name: 'azpr_read_file', description: 'other plugin', input: {}, execute: async () => ({}) }));
  await assert.rejects(g.setup(), /Tool name conflict: azpr_read_file/);
});

test('a later reserved-command shadow and changed settings both fail before session creation', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  f.commands.set('pr-review', { name: 'pr-review', description: 'Late user command', execute: async () => {} });
  assert.match(await f.invoke('pr-check'), /missing or shadowed/);
  assert.equal(f.azure.state.calls.length, 0);
  const g = await fixture(t);
  t.after(await g.setup());
  await writeFile(join(g.directory, 'settings.json'), JSON.stringify(g.raw) + '\n');
  assert.match(await g.invoke('pr-check'), /settings\.json changed since OpenCode loaded it/);
  assert.equal(g.azure.state.calls.length, 0);
});
