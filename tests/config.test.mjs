import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCKED_NATIVE_TOOLS, NATIVE_TOOL_PERMISSIONS, PROMPTS, ROLES, allowedTools, buildAgents,
  nativeToolPermissions, validateSettings,
} from '../src/config.mjs';

const example = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../config/settings.schema.json', import.meta.url), 'utf8'));
const prompts = Object.fromEntries(await Promise.all(PROMPTS.map(async name =>
  [name, await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8')])));
const PAT = 'fixture-pat-0123456789abcdefghij';
const input = () => ({ ...structuredClone(example), models: {
  review: { functional: 'provider/family/functional', risk: 'provider/risk', verifier: 'provider/verifier' },
  deep: { functional: '', risk: '', verifier: '' },
}, azure: { ...example.azure, organization: 'org', pat: PAT } });

test('settings reject removed transports and unknown keys', () => {
  for (const key of ['structuredOutput', 'steps', 'maxStageCharacters', 'comments', 'auxiliaryModels', 'outputRetries', 'verification', 'shellToolPermission']) {
    assert.equal(Object.hasOwn(example, key), false, key);
    assert.equal(Object.hasOwn(schema.properties, key), false, key);
    assert.throws(() => validateSettings({ ...input(), [key]: false }), /Unknown setting/, key);
  }
  assert.throws(() => validateSettings({ ...input(), version: 1 }), /version must be 2/);
  assert.throws(() => validateSettings({ ...input(), mcp: { server: 'x' } }), /settings\.mcp is no longer used/);
  assert.throws(() => validateSettings({ ...input(), azure: { ...input().azure, server: 'x' } }), /Unknown setting azure\.server/);
  assert.throws(() => validateSettings({ ...input(), workflow: { shards: 2 } }), /Unknown setting workflow\.shards/);
});

test('defaults: no whole-run timeout, shell denied, bounded Azure DevOps calls and sharded workflow', () => {
  const raw = input();
  for (const key of ['runTimeoutSeconds', 'shell', 'progressNotices', 'workflow']) delete raw[key];
  raw.azure = { organization: 'org', pat: PAT };
  const settings = validateSettings(raw);
  assert.equal(settings.runTimeoutSeconds, null);
  assert.equal(settings.shell, 'deny');
  assert.equal(settings.progressNotices, true);
  assert.deepEqual(settings.azure, { organization: 'org', pat: PAT, concurrency: 3, callTimeoutSeconds: 120 });
  assert.deepEqual(settings.workflow, { shardFiles: 25, shardFindings: 15, parallelSessions: 4, repairAttempts: 2, stageRetries: 1 });
  assert.deepEqual(validateSettings(input()).azure, settings.azure, 'The example matches the defaults.');
  assert.deepEqual(validateSettings(input()).workflow, settings.workflow);
  for (const value of [10, 7200, null]) assert.equal(validateSettings({ ...input(), runTimeoutSeconds: value }).runTimeoutSeconds, value);
  for (const value of [false, 0, 9, 7201]) assert.throws(() => validateSettings({ ...input(), runTimeoutSeconds: value }), /runTimeoutSeconds/);
});

test('numeric and enum settings are range checked; partial objects take defaults', () => {
  assert.deepEqual(validateSettings({ ...input(), azure: { organization: 'org', pat: PAT, concurrency: 1 } }).azure, { organization: 'org', pat: PAT, concurrency: 1, callTimeoutSeconds: 120 });
  assert.equal(validateSettings({ ...input(), workflow: { repairAttempts: 0 } }).workflow.repairAttempts, 0);
  for (const [key, value] of [['azure', { organization: 'org', pat: PAT, concurrency: 0 }], ['azure', { organization: 'org', pat: PAT, concurrency: 9 }], ['azure', { organization: 'org', pat: PAT, callTimeoutSeconds: 5 }],
    ['workflow', { shardFiles: 0 }], ['workflow', { parallelSessions: 17 }], ['workflow', { repairAttempts: 4 }], ['workflow', { stageRetries: -1 }],
    ['shell', 'allow'], ['progressNotices', 'yes']]) {
    assert.throws(() => validateSettings({ ...input(), [key]: value }), undefined, `${key}=${JSON.stringify(value)}`);
  }
  for (const shell of ['deny', 'ask', 'inherit']) assert.equal(validateSettings({ ...input(), shell }).shell, shell);
});

test('azure needs an organization name and a token-shaped PAT; errors never echo the PAT', () => {
  for (const organization of ['', 'has space', '-lead', 'x'.repeat(51), 42]) {
    assert.throws(() => validateSettings({ ...input(), azure: { organization, pat: PAT } }), /azure\.organization must be/);
  }
  for (const pat of ['', 'short', 'has space in the middle 0123456789', 'REPLACE_WITH_YOUR_PAT_0123456789', 12345678901234567890]) {
    assert.throws(() => validateSettings({ ...input(), azure: { organization: 'org', pat } }), error => /azure\.pat must be/.test(error.message) && !error.message.includes(String(pat) || '\0'));
  }
  assert.equal(validateSettings(input()).azure.organization, 'org');
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

test('agents: one per configured role; deep needs all three models', () => {
  const settings = validateSettings(input());
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(Object.keys(agents).sort(), ['azpr-review-comment-plan', 'azpr-review-dedupe', 'azpr-review-functional', 'azpr-review-risk', 'azpr-review-verifier']);
  for (const [id, agent] of Object.entries(agents)) {
    assert.equal(agent.id, id);
    assert.equal(agent.mode, 'primary');
    assert.equal(agent.hidden, true);
    assert.deepEqual(agent.request, { settings: {}, headers: {}, body: {} });
    for (const key of ['prompt', 'permission', 'disable', 'steps']) assert.equal(Object.hasOwn(agent, key), false, key);
  }
  assert.deepEqual(agents['azpr-review-functional'].model, { providerID: 'provider', id: 'family/functional' });
  const partial = input();
  partial.models.deep = { functional: 'other/deep-f', risk: '', verifier: '' };
  const partialSettings = validateSettings(partial);
  assert.equal(partialSettings.deepReady, false);
  assert.equal(partialSettings.deepPartial, true);
  const full = input();
  full.models.deep = { functional: 'other/deep-f', risk: 'other/deep-r', verifier: 'other/deep-v' };
  assert.equal(Object.keys(buildAgents(validateSettings(full), prompts)).length, Object.keys(ROLES).length);
  assert.deepEqual(buildAgents(validateSettings({ ...input(), enabled: false }), prompts), {});
});

test('tools: an explicit allowlist of AZPR and read tools; denied natives and shell per setting', () => {
  for (const name of ['execute', 'edit', 'write', 'patch', 'skill', 'subagent', 'webfetch', 'websearch', 'question', 'opencode_session_rename', 'opencode_session_move', 'opencode_models']) {
    assert.ok(BLOCKED_NATIVE_TOOLS.includes(name), name);
  }
  for (const name of ['read', 'glob', 'grep', 'shell']) assert.equal(Object.hasOwn(NATIVE_TOOL_PERMISSIONS, name), false, name);
  assert.equal(nativeToolPermissions('azpr-review-risk', 'deny').shell, 'deny');
  assert.equal(nativeToolPermissions('azpr-review-risk', 'ask').shell, 'ask');
  assert.equal(Object.hasOwn(nativeToolPermissions('azpr-review-risk', 'inherit'), 'shell'), false);
  assert.deepEqual(allowedTools('azpr-review-risk', 'deny'), ['azpr_read_diff', 'azpr_read_file', 'azpr_search_code', 'azpr_find_files', 'azpr_list_files', 'azpr_pr_threads', 'read', 'glob', 'grep']);
  assert.ok(allowedTools('azpr-deep-comment-plan', 'ask').includes('shell'));
  assert.deepEqual(allowedTools('build', 'inherit'), [], 'Ordinary agents are not governed by AZPR.');
  for (const name of [...BLOCKED_NATIVE_TOOLS, 'ado_repo_file', 'repo_pull_request_thread_write']) assert.equal(allowedTools('azpr-review-risk', 'inherit').includes(name), false, name);
  const agents = buildAgents(validateSettings({ ...input(), shell: 'ask' }), prompts);
  for (const [role, agent] of Object.entries(agents)) {
    assert.equal(agent.permissions.some(rule => rule.action === '*' || rule.effect === 'allow'), false, role);
    assert.deepEqual(agent.permissions.find(rule => rule.action === 'shell'), { action: 'shell', resource: '*', effect: 'ask' });
  }
});

test('prompts: one JSON transport, shared tool policy, shell guidance and language routing', () => {
  const agents = buildAgents(validateSettings({ ...input(), outputLanguage: 'zh-TW' }), prompts);
  for (const [role, agent] of Object.entries(agents)) {
    assert.match(agent.system, /one valid JSON object/);
    assert.match(agent.system, /azpr_read_file[\s\S]*azpr_list_files[\s\S]*azpr_pr_threads/);
    assert.match(agent.system, /the runtime alone posts comments/);
    assert.match(agent.system, /never the PR repository/);
    assert.doesNotMatch(agent.system, /MCP|repo_file|repo_pull_request/);
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
