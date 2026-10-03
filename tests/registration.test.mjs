import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupAzurePrReview } from '../src/runtime.mjs';
import { PROMPTS } from '../src/config.mjs';

const copy = value => structuredClone(value);
const pr = 'https://dev.azure.com/example/project/_git/repository/pullrequest/1';
async function fixture(t, existingCommands = []) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-v2-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
  raw.models.review = { functional: 'fixture/functional', risk: 'fixture/risk', verifier: 'fixture/verifier' };
  await writeFile(join(directory, 'settings.json'), JSON.stringify(raw));
  await mkdir(join(directory, 'prompts'));
  await Promise.all(PROMPTS.map(async name => writeFile(join(directory, 'prompts', name + '.md'),
    await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8'))));
  const agents = new Map([['build', { id: 'build', name: 'Build', permissions: [{ action: 'only-build', resource: '*', effect: 'allow' }] }]]);
  const commands = new Map(existingCommands.map(command => [command.name, command]));
  const calls = { transforms: 0, created: 0, agents: [], reports: [] };
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  const context = {
    location: { directory },
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
      hook: async (name, fn) => { hooks[name] = fn; return registration(); },
      create: async () => { calls.created++; throw new Error('No model session expected in registration tests.'); },
      prompt: async () => { throw new Error('No model prompt expected.'); },
      wait: async () => {}, context: async () => [], get: async () => ({}),
      interrupt: async () => ({ interrupted: false }),
      synthetic: async input => {
        calls.reports.push(input.text);
        return { id: 'queued', sessionID: input.sessionID, type: 'synthetic', payload: { text: input.text }, delivery: 'queue' };
      },
    },
    tool: { hook: async () => registration() },
  };
  return { context, directory, raw, agents, commands, calls,
    setup: () => setupAzurePrReview(context, directory),
    invoke: name => commands.get(name).execute({ sessionID: 'origin', prompt: { text: pr }, delivery: 'queue' }),
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

test('V2 post-config global permissions are preserved and all complete private definitions are pinned at first use', async t => {
  const f = await fixture(t);
  const build = copy(f.agents.get('build'));
  const dispose = await f.setup();
  t.after(dispose);
  const global = { action: 'fixture_mcp_*', resource: '*', effect: 'deny' };
  for (const [role, agent] of f.agents) if (role.startsWith('azpr-')) agent.permissions.push(copy(global));
  await assert.rejects(f.invoke('pr-deep'), /All three models.deep roles/);
  assert.ok(f.calls.agents.includes('azpr-review-verifier'));
  assert.equal(f.calls.created, 0);
  for (const [role, agent] of f.agents) if (role.startsWith('azpr-')) {
    assert.deepEqual(agent.permissions.at(-1), global);
    assert.equal(agent.permissions.some(rule => rule.action === 'only-build'), false);
  }
  assert.deepEqual(f.agents.get('build'), build);
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
    await assert.rejects(f.invoke('pr-deep'), /protected private reviewer field or native permission rule/);
    assert.equal(f.calls.created, 0);
  }
});

test('later host permission changes fail existing role fingerprints before creating a reviewer', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  await assert.rejects(f.invoke('pr-deep'), /All three models.deep roles/);
  for (const role of ['azpr-review-functional', 'azpr-review-risk']) f.agents.get(role).permissions.push({ action: 'fixture_mcp_read', resource: '*', effect: 'deny' });
  await f.invoke('pr-review');
  assert.equal(f.calls.created, 0);
  assert.ok(f.calls.reports.some(report => report.includes('Private reviewer configuration changed')));
});

test('a later reserved-command shadow and changed settings both fail before session creation', async t => {
  const f = await fixture(t);
  t.after(await f.setup());
  f.commands.set('pr-review', { name: 'pr-review', description: 'Late user command', execute: async () => {} });
  await assert.rejects(f.invoke('pr-deep'), /missing or shadowed/);
  assert.equal(f.calls.created, 0);
  const g = await fixture(t);
  t.after(await g.setup());
  await writeFile(join(g.directory, 'settings.json'), JSON.stringify(g.raw) + '\n');
  await assert.rejects(g.invoke('pr-deep'), /settings.json changed/);
  assert.equal(g.calls.created, 0);
});
