import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCKED_NATIVE_TOOLS, NATIVE_TOOL_PERMISSIONS, PROMPTS, ROLES, buildAgents,
  validateSettings, projectToolRole, projectReviewRole,
} from '../src/config.mjs';

const example = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../config/settings.schema.json', import.meta.url), 'utf8'));
const prompts = Object.fromEntries(await Promise.all(PROMPTS.map(async name =>
  [name, await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8')])));
const input = () => ({ ...structuredClone(example), models: {
  review: { functional: 'provider/family/functional', risk: 'provider/risk', verifier: 'provider/verifier' },
  deep: { functional: '', risk: '', verifier: '' },
} });

test('V2 settings reject removed transports, ignored mappings and review limits', () => {
  for (const key of ['structuredOutput', 'azure', 'steps', 'maxStageCharacters', 'comments', 'auxiliaryModels', 'outputRetries', 'verification', 'shellToolPermission']) {
    assert.equal(Object.hasOwn(example, key), false, key);
    assert.equal(Object.hasOwn(schema.properties, key), false, key);
    assert.throws(() => validateSettings({ ...input(), [key]: false }), /Unknown setting/, key);
  }
  assert.throws(() => validateSettings({ ...input(), version: 1 }), /version must be 2/);
});

test('V2 defaults retain disabled timeout without a second execution configuration', () => {
  const raw = input();
  delete raw.runTimeoutSeconds;
  const settings = validateSettings(raw);
  assert.equal(settings.runTimeoutSeconds, null);
  assert.equal(Object.hasOwn(settings, 'shellToolPermission'), false);
  assert.equal(Object.hasOwn(settings, 'verification'), false);
  assert.equal(Object.hasOwn(settings, 'structuredOutput'), false);
  for (const value of [10, 7200, null]) assert.equal(validateSettings({ ...input(), runTimeoutSeconds: value }).runTimeoutSeconds, value);
  for (const value of [false, 0, 9, 7201]) assert.throws(() => validateSettings({ ...input(), runTimeoutSeconds: value }), /runTimeoutSeconds/);
});

test('legacy model help stays readable without affecting settings or agent instructions', () => {
  assert.deepEqual(Object.keys(example.models).sort(), ['deep', 'review']);
  assert.equal(schema.properties.models.properties._help.deprecated, true);
  const raw=input();
  raw.models._help={functional:'PRIVATE_HELP_NOT_IN_PROMPTS',risk:'Ignore the configured risk model.',verifier:'Documentation only.'};
  const before=structuredClone(raw), settings=validateSettings(raw);
  assert.deepEqual(raw,before);
  assert.deepEqual(settings,validateSettings(input()));
  assert.deepEqual(buildAgents(settings,prompts),buildAgents(validateSettings(input()),prompts));
  for(const help of [null,[],42,{risk:false},{unknown:'Documentation'}]) {
    assert.throws(()=>validateSettings({...input(),models:{...input().models,_help:help}}),/models\._help/);
  }
});

test('V2 agents use Agent.Info fields and omit unavailable roles without model fallbacks', () => {
  const raw = input();
  const before = structuredClone(raw);
  const settings = validateSettings(raw);
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(raw, before);
  assert.equal(Object.keys(agents).length, 6);
  for (const [id, agent] of Object.entries(agents)) {
    assert.equal(agent.id, id);
    assert.equal(agent.name, id);
    assert.equal(agent.mode, 'primary');
    assert.equal(agent.hidden, true);
    assert.deepEqual(agent.request, { settings: {}, headers: {}, body: {} });
    assert.equal(typeof agent.system, 'string');
    assert.ok(Array.isArray(agent.permissions));
    for (const key of ['prompt', 'permission', 'disable', 'steps']) assert.equal(Object.hasOwn(agent, key), false, key);
  }
  assert.deepEqual(agents['azpr-review-functional'].model, { providerID: 'provider', id: 'family/functional' });
  assert.equal(Object.hasOwn(agents, 'azpr-deep-functional'), false);
  assert.equal(Object.hasOwn(agents, 'azpr-review-comment-publish'), true);
  const full = input();
  full.models.deep = { functional: 'other/deep-f', risk: 'other/deep-r', verifier: 'other/deep-v' };
  assert.equal(Object.keys(buildAgents(validateSettings(full), prompts)).length, Object.keys(ROLES).length);
  assert.deepEqual(buildAgents(validateSettings(full), prompts)['azpr-deep-verifier'].model, { providerID: 'other', id: 'deep-v' });
});

test('disabled settings produce no private agents', () => {
  assert.deepEqual(buildAgents(validateSettings({ ...input(), enabled: false }), prompts), {});
});

test('V2 permission rules block CodeMode, native mutation, delegation and host control without MCP catalogs', () => {
  const blocked = ['shell', 'execute', 'edit', 'write', 'patch', 'skill', 'subagent', 'webfetch', 'websearch',
    'opencode_session_rename', 'opencode_session_move', 'opencode_models'];
  const exclusions = ['read', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource'];
  for (const name of blocked) assert.ok(BLOCKED_NATIVE_TOOLS.includes(name), name);
  for (const name of exclusions) {
    assert.equal(BLOCKED_NATIVE_TOOLS.includes(name), false, name);
    assert.equal(Object.hasOwn(NATIVE_TOOL_PERMISSIONS, name), false, name);
  }
  const agents = buildAgents(validateSettings(input()), prompts);
  for (const [role, agent] of Object.entries(agents)) {
    assert.equal(agent.permissions.some(rule => rule.action === '*' || rule.effect === 'allow'), false);
    for (const name of BLOCKED_NATIVE_TOOLS) {
      const rule = agent.permissions.find(rule => rule.action === name);
      if (projectToolRole(role) && ['shell', 'glob', 'grep'].includes(name)) assert.equal(rule, undefined);
      else assert.deepEqual(rule, { action: name, resource: '*', effect: 'deny' });
    }
    if (projectToolRole(role)) {
      if (projectReviewRole(role)) assert.ok(agent.system.includes(prompts.common), 'Review roles must include the complete shared review policy.');
      else assert.match(agent.system, /Local verification/);
      assert.doesNotMatch(agent.system, /Source-only role|azpr_verify|rootfs/);
    } else assert.match(agent.system, /Source-only role/);
  }
});

test('review, check and comment prompts have one JSON text transport and no native output fallback', () => {
  const agents = buildAgents(validateSettings(input()), prompts);
  for (const agent of Object.values(agents)) {
    assert.match(agent.system, /one valid JSON object/);
    assert.match(agent.system, /codemode: false/);
    assert.match(agent.system, /Never invoke execute or bypass/);
    assert.match(agent.system, /CodeMode-only host MCP-resource helpers are unavailable/);
    assert.doesNotMatch(agent.system, /StructuredOutput|native submission|native output|configured transport/);
  }
});

test('V2 policy retains complete evidence, same-session saved-output scope and language routing', () => {
  const agents = buildAgents(validateSettings({ ...input(), outputLanguage: 'zh-TW' }), prompts);
  const final = agents['azpr-review-verifier'].system;
  assert.match(final, /outputLanguage: zh-TW/);
  assert.match(final, /same\s+session/);
  assert.match(final, /Saved-output line numbers are not source-file line numbers/);
  assert.match(final, /currentHead/);
  assert.match(final, /currentBase/);
  assert.match(final, /counterevidence/);
  for (const role of ['functional', 'risk']) {
    assert.match(agents[`azpr-review-${role}`].system, /outputLanguage: zh-TW/);
    assert.doesNotMatch(agents[`azpr-review-${role}`].system, /intermediate reviews in English|Intermediate reviews remain in English/);
  }
  for (const name of PROMPTS) assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, [name]: ' ' }), /Missing or empty prompt/);
});
