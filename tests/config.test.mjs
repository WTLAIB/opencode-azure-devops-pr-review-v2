import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCKED_NATIVE_TOOLS, NATIVE_TOOL_PERMISSIONS, PROMPTS, ROLES, RUNTIME_AGENT, buildAgents, hiddenTools,
  nativeToolPermissions, validateSettings,
} from '../src/config.mjs';

const example = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../config/settings.schema.json', import.meta.url), 'utf8'));
const prompts = Object.fromEntries(await Promise.all(PROMPTS.map(async name =>
  [name, await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8')])));
const input = () => ({ ...structuredClone(example), models: {
  review: { functional: 'provider/family/functional', risk: 'provider/risk', verifier: 'provider/verifier' },
  deep: { functional: '', risk: '', verifier: '' },
} });

test('settings reject removed transports and unknown keys', () => {
  for (const key of ['structuredOutput', 'azure', 'steps', 'maxStageCharacters', 'comments', 'auxiliaryModels', 'outputRetries', 'verification', 'shellToolPermission']) {
    assert.equal(Object.hasOwn(example, key), false, key);
    assert.equal(Object.hasOwn(schema.properties, key), false, key);
    assert.throws(() => validateSettings({ ...input(), [key]: false }), /Unknown setting/, key);
  }
  assert.throws(() => validateSettings({ ...input(), version: 1 }), /version must be 2/);
  assert.throws(() => validateSettings({ ...input(), mcp: { servers: 'x' } }), /Unknown setting mcp\.servers/);
  assert.throws(() => validateSettings({ ...input(), workflow: { shards: 2 } }), /Unknown setting workflow\.shards/);
});

test('defaults: no whole-run timeout, shell denied, bounded MCP and sharded workflow', () => {
  const raw = input();
  for (const key of ['runTimeoutSeconds', 'shell', 'progressNotices', 'mcp', 'workflow']) delete raw[key];
  const settings = validateSettings(raw);
  assert.equal(settings.runTimeoutSeconds, null);
  assert.equal(settings.shell, 'deny');
  assert.equal(settings.progressNotices, true);
  assert.deepEqual(settings.mcp, { server: '', concurrency: 3, callTimeoutSeconds: 120 });
  assert.deepEqual(settings.workflow, { shardFiles: 25, shardFindings: 15, parallelSessions: 4, repairAttempts: 2, stageRetries: 1 });
  assert.deepEqual(validateSettings(input()).mcp, settings.mcp, 'The example matches the defaults.');
  assert.deepEqual(validateSettings(input()).workflow, settings.workflow);
  for (const value of [10, 7200, null]) assert.equal(validateSettings({ ...input(), runTimeoutSeconds: value }).runTimeoutSeconds, value);
  for (const value of [false, 0, 9, 7201]) assert.throws(() => validateSettings({ ...input(), runTimeoutSeconds: value }), /runTimeoutSeconds/);
});

test('numeric and enum settings are range checked; partial objects take defaults', () => {
  assert.deepEqual(validateSettings({ ...input(), mcp: { concurrency: 1 } }).mcp, { server: '', concurrency: 1, callTimeoutSeconds: 120 });
  assert.equal(validateSettings({ ...input(), workflow: { repairAttempts: 0 } }).workflow.repairAttempts, 0);
  for (const [key, value] of [['mcp', { concurrency: 0 }], ['mcp', { concurrency: 9 }], ['mcp', { callTimeoutSeconds: 5 }], ['mcp', { server: 1 }],
    ['workflow', { shardFiles: 0 }], ['workflow', { parallelSessions: 17 }], ['workflow', { repairAttempts: 4 }], ['workflow', { stageRetries: -1 }],
    ['shell', 'allow'], ['progressNotices', 'yes']]) {
    assert.throws(() => validateSettings({ ...input(), [key]: value }), undefined, `${key}=${JSON.stringify(value)}`);
  }
  for (const shell of ['deny', 'ask', 'inherit']) assert.equal(validateSettings({ ...input(), shell }).shell, shell);
});

test('legacy model help stays readable without affecting agent instructions', () => {
  const raw = input();
  raw.models._help = { functional: 'PRIVATE_HELP_NOT_IN_PROMPTS', risk: 'x', verifier: 'y' };
  const settings = validateSettings(raw);
  assert.deepEqual(settings, validateSettings(input()));
  assert.deepEqual(buildAgents(settings, prompts), buildAgents(validateSettings(input()), prompts));
  for (const help of [null, [], 42, { risk: false }, { unknown: 'Documentation' }]) {
    assert.throws(() => validateSettings({ ...input(), models: { ...input().models, _help: help } }), /models\._help/);
  }
});

test('agents: one per configured role plus the model-less runtime agent; deep needs all three models', () => {
  const settings = validateSettings(input());
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(Object.keys(agents).sort(), ['azpr-review-comment-plan', 'azpr-review-functional', 'azpr-review-risk', 'azpr-review-verifier', RUNTIME_AGENT].sort());
  for (const [id, agent] of Object.entries(agents)) {
    assert.equal(agent.id, id);
    assert.equal(agent.mode, 'primary');
    assert.equal(agent.hidden, true);
    assert.deepEqual(agent.request, { settings: {}, headers: {}, body: {} });
    for (const key of ['prompt', 'permission', 'disable', 'steps']) assert.equal(Object.hasOwn(agent, key), false, key);
  }
  assert.equal(Object.hasOwn(agents[RUNTIME_AGENT], 'model'), false);
  assert.equal(Object.hasOwn(agents[RUNTIME_AGENT], 'system'), false);
  assert.deepEqual(agents['azpr-review-functional'].model, { providerID: 'provider', id: 'family/functional' });
  const partial = input();
  partial.models.deep = { functional: 'other/deep-f', risk: '', verifier: '' };
  const partialSettings = validateSettings(partial);
  assert.equal(partialSettings.deepReady, false);
  assert.equal(partialSettings.deepPartial, true);
  const full = input();
  full.models.deep = { functional: 'other/deep-f', risk: 'other/deep-r', verifier: 'other/deep-v' };
  assert.equal(Object.keys(buildAgents(validateSettings(full), prompts)).length, Object.keys(ROLES).length + 1);
  assert.deepEqual(buildAgents(validateSettings({ ...input(), enabled: false }), prompts), {});
});

test('native tools: always denied set, shell per setting, runtime agent denies everything native', () => {
  for (const name of ['execute', 'edit', 'write', 'patch', 'skill', 'subagent', 'webfetch', 'websearch', 'question', 'opencode_session_rename', 'opencode_session_move', 'opencode_models']) {
    assert.ok(BLOCKED_NATIVE_TOOLS.includes(name), name);
  }
  for (const name of ['read', 'glob', 'grep', 'shell']) assert.equal(Object.hasOwn(NATIVE_TOOL_PERMISSIONS, name), false, name);
  assert.equal(nativeToolPermissions('azpr-review-risk', 'deny').shell, 'deny');
  assert.equal(nativeToolPermissions('azpr-review-risk', 'ask').shell, 'ask');
  assert.equal(Object.hasOwn(nativeToolPermissions('azpr-review-risk', 'inherit'), 'shell'), false);
  assert.ok(hiddenTools('azpr-review-risk', 'deny').includes('shell'));
  assert.equal(hiddenTools('azpr-review-risk', 'ask').includes('shell'), false);
  assert.equal(hiddenTools('azpr-review-risk', 'deny').includes('read'), false);
  for (const name of ['shell', 'read', 'glob', 'grep', 'execute']) assert.equal(nativeToolPermissions(RUNTIME_AGENT).hasOwnProperty(name), true);
  const agents = buildAgents(validateSettings({ ...input(), shell: 'ask' }), prompts);
  for (const [role, agent] of Object.entries(agents)) {
    assert.equal(agent.permissions.some(rule => rule.action === '*' || rule.effect === 'allow'), false, role);
    if (role !== RUNTIME_AGENT) assert.deepEqual(agent.permissions.find(rule => rule.action === 'shell'), { action: 'shell', resource: '*', effect: 'ask' });
  }
});

test('prompts: one JSON transport, shared tool policy, shell guidance and language routing', () => {
  const agents = buildAgents(validateSettings({ ...input(), outputLanguage: 'zh-TW' }), prompts);
  for (const [role, agent] of Object.entries(agents)) {
    if (role === RUNTIME_AGENT) continue;
    assert.match(agent.system, /one valid JSON object/);
    assert.match(agent.system, /Never use CodeMode execute/);
    assert.match(agent.system, /the runtime alone posts comments/);
    assert.match(agent.system, /list_directory does not accept commit SHAs/);
    assert.match(agent.system, /Shell is unavailable in this session/);
    assert.match(agent.system, /outputLanguage: zh-TW/);
    assert.doesNotMatch(agent.system, /currentHead|currentBase|StructuredOutput/);
  }
  assert.match(agents['azpr-review-verifier'].system, /counterevidence/);
  assert.match(agents['azpr-review-comment-plan'].system, /azprData/);
  const shellAllowed = buildAgents(validateSettings({ ...input(), shell: 'inherit' }), prompts);
  assert.match(shellAllowed['azpr-review-risk'].system, /Shell may be available under OpenCode permissions/);
  for (const name of PROMPTS) assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, [name]: ' ' }), /Missing or empty prompt/);
});

test('trimmed role instructions stay compact', () => {
  const agents = buildAgents(validateSettings(input()), prompts);
  for (const [role, agent] of Object.entries(agents)) if (agent.system) assert.ok(agent.system.length < 14000, `${role}: ${agent.system.length}`);
});
