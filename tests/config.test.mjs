import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCKED_NATIVE_TOOLS, NATIVE_TOOL_PERMISSIONS, PROMPTS, ROLES, allowedTools, buildAgents,
  nativeToolPermissions, patProblem, validateSettings, stageModel, configuredOptionalSlots,
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
// The severity rating exists only where a rater model is set.
const withRater = () => { const settings = input(); settings.models.review.rater = 'provider/rater'; return settings; };

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

test('afterReview: none for every mode by default, preview or publish per mode; errors name the setting, never its value', () => {
  assert.deepEqual(example.afterReview, { quick: 'none', review: 'none', deep: 'none' });
  assert.deepEqual(Object.keys(schema.properties.afterReview.properties).sort(), ['deep', 'quick', 'review']);
  for (const mode of ['quick', 'review', 'deep']) assert.deepEqual(schema.properties.afterReview.properties[mode].enum, ['none', 'preview', 'publish']);
  const raw = input();
  delete raw.afterReview;
  assert.deepEqual(validateSettings(raw).afterReview, { quick: 'none', review: 'none', deep: 'none' });
  assert.deepEqual(validateSettings(input()).afterReview, validateSettings(raw).afterReview, 'The example matches the defaults.');
  assert.deepEqual(validateSettings({ ...input(), afterReview: { review: 'publish' } }).afterReview, { quick: 'none', review: 'publish', deep: 'none' }, 'A missing mode is none.');
  assert.deepEqual(validateSettings({ ...input(), afterReview: { quick: 'preview', review: 'none', deep: 'publish' } }).afterReview, { quick: 'preview', review: 'none', deep: 'publish' });
  for (const value of ['Publish', 'post', '', true, null, 1, 'secret-value-123']) {
    assert.throws(() => validateSettings({ ...input(), afterReview: { review: value } }),
      error => error.message === 'afterReview.review must be none, preview or publish.' && !error.message.includes('secret-value'), String(value));
  }
  assert.throws(() => validateSettings({ ...input(), afterReview: { check: 'none' } }), /Unknown setting afterReview\.check/);
  for (const value of ['publish', ['publish'], null]) assert.throws(() => validateSettings({ ...input(), afterReview: value }), /afterReview must be a JSON object/);
});

test('an unknown key is named only when it looks like a setting name, so a pasted secret is not shown', () => {
  assert.throws(() => validateSettings({ ...input(), azure: { ...input().azure, patfile: '/x' } }), /Unknown setting azure\.patfile; check for a typo/);
  const pasted = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop';
  for (const container of ['settings', 'azure']) {
    const raw = container === 'settings' ? { ...input(), [pasted]: '' } : { ...input(), azure: { ...input().azure, [pasted]: '' } };
    assert.throws(() => validateSettings(raw), error => error.message.startsWith(`Unknown setting in ${container} (its name is not shown`) && !error.message.includes(pasted.slice(0, 20)));
  }
});

test('defaults: no whole-run timeout, shell denied, bounded Azure DevOps calls and sharded workflow', () => {
  const raw = input();
  for (const key of ['runTimeoutSeconds', 'shell', 'progressNotices', 'deletePrivateSessions', 'workflow']) delete raw[key];
  delete raw.debug;
  raw.azure = { organization: 'org', pat: PAT };
  const settings = validateSettings(raw);
  assert.equal(settings.runTimeoutSeconds, null);
  assert.equal(settings.shell, 'deny');
  assert.equal(settings.progressNotices, true);
  assert.equal(settings.deletePrivateSessions, true);
  assert.deepEqual(settings.debug, { enabled: false, directory: '', keepRuns: 20 });
  assert.deepEqual(settings.azure, { organization: 'org', pat: PAT, patFile: '', concurrency: 3, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true });
  assert.deepEqual(settings.workflow, { shardFiles: 25, shardFindings: 15, parallelSessions: 4, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 });
  assert.deepEqual(validateSettings(input()).azure, settings.azure, 'The example matches the defaults.');
  assert.deepEqual(validateSettings(input()).workflow, settings.workflow);
  for (const value of [10, 7200, null]) assert.equal(validateSettings({ ...input(), runTimeoutSeconds: value }).runTimeoutSeconds, value);
  for (const value of [false, 0, 9, 7201]) assert.throws(() => validateSettings({ ...input(), runTimeoutSeconds: value }), /runTimeoutSeconds/);
});

test('proxy and TLS settings: accepted forms; rejections never echo the proxy URL', () => {
  const azure = extra => ({ ...input(), azure: { organization: 'org', pat: PAT, ...extra } });
  for (const proxy of ['', 'http://10.1.2.3:80', 'http://proxy.example.com:8080/', 'https://proxy.example.com', 'http://user:p%40ss@10.1.2.3:3128', 'http://[::1]:3128']) {
    assert.equal(validateSettings(azure({ proxy })).azure.proxy, proxy);
  }
  for (const proxy of ['10.1.2.3:80', 'proxy.example.com:8080', 'socks5://10.1.2.3:1080', 'http://user:secret-word@10.1.2.3:80/path', 'http://10.1.2.3:80?x=1',
    'http://10.1.2.3:80#f', 'http://', 42, null, 'http://' + 'a'.repeat(2050)]) {
    assert.throws(() => validateSettings(azure({ proxy })), error => /azure\.proxy must be empty or a proxy URL/.test(error.message) && !error.message.includes('secret-word'), String(proxy));
  }
  assert.equal(validateSettings(azure({ caFile: '/etc/ssl/corp-root.pem' })).azure.caFile, '/etc/ssl/corp-root.pem');
  for (const caFile of ['corp.pem', '~/corp.pem', '/tmp/a\nb.pem', 7, null]) {
    assert.throws(() => validateSettings(azure({ caFile })), /azure\.caFile must be empty or the absolute path/, String(caFile));
  }
  assert.equal(validateSettings(azure({ verifyTls: false })).azure.verifyTls, false);
  for (const verifyTls of ['false', 0, null]) assert.throws(() => validateSettings(azure({ verifyTls })), /azure\.verifyTls must be boolean/);
});

test('numeric and enum settings are range checked; partial objects take defaults', () => {
  assert.deepEqual(validateSettings({ ...input(), azure: { organization: 'org', pat: PAT, concurrency: 1 } }).azure, { organization: 'org', pat: PAT, patFile: '', concurrency: 1, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true });
  assert.equal(validateSettings({ ...input(), azure: { organization: 'org', pat: PAT, archiveMegabytes: 1024 } }).azure.archiveMegabytes, 1024);
  assert.equal(validateSettings({ ...input(), workflow: { repairAttempts: 0 } }).workflow.repairAttempts, 0);
  for (const value of [0, 60, 7200]) assert.equal(validateSettings({ ...input(), workflow: { stageIdleSeconds: value } }).workflow.stageIdleSeconds, value);
  for (const value of [59, 7201, 1.5, -1, null, '600']) {
    assert.throws(() => validateSettings({ ...input(), workflow: { stageIdleSeconds: value } }), /workflow\.stageIdleSeconds must be 0 \(off\) or an integer from 60 to 7200/, String(value));
  }
  for (const [key, value] of [['azure', { organization: 'org', pat: PAT, concurrency: 0 }], ['azure', { organization: 'org', pat: PAT, concurrency: 9 }], ['azure', { organization: 'org', pat: PAT, callTimeoutSeconds: 5 }],
    ['azure', { organization: 'org', pat: PAT, archiveMegabytes: 0 }], ['azure', { organization: 'org', pat: PAT, archiveMegabytes: 1025 }], ['azure', { organization: 'org', pat: PAT, archiveMegabytes: 1.5 }],
    ['workflow', { shardFiles: 0 }], ['workflow', { parallelSessions: 17 }], ['workflow', { repairAttempts: 4 }], ['workflow', { stageRetries: -1 }],
    ['shell', 'allow'], ['progressNotices', 'yes'], ['deletePrivateSessions', 'no'],
    ['debug', { enabled: true, keepRuns: -1 }], ['debug', { enabled: true, keepRuns: 1001 }], ['debug', { enabled: true, keepRuns: '5' }]]) {
    assert.throws(() => validateSettings({ ...input(), [key]: value }), undefined, `${key}=${JSON.stringify(value)}`);
  }
  for (const shell of ['deny', 'ask', 'inherit']) assert.equal(validateSettings({ ...input(), shell }).shell, shell);
  assert.equal(validateSettings({ ...input(), debug: { enabled: true, keepRuns: 0 } }).debug.keepRuns, 0, '0 keeps every run directory.');
  assert.equal(validateSettings({ ...input(), deletePrivateSessions: false }).deletePrivateSessions, false);
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
  // The rating role is registered only where models.<mode>.rater names a model.
  assert.deepEqual(Object.keys(buildAgents(validateSettings(withRater()), prompts)).sort(), ['azpr-review-comment-plan', 'azpr-review-dedupe', 'azpr-review-functional', 'azpr-review-rating', 'azpr-review-risk', 'azpr-review-verifier']);
  for (const [id, agent] of Object.entries(agents)) {
    assert.equal(agent.id, id);
    assert.equal(agent.mode, 'primary');
    assert.equal(agent.hidden, true);
    assert.deepEqual(agent.request, { settings: {}, headers: {}, body: {} });
    for (const key of ['prompt', 'permission', 'disable', 'steps']) assert.equal(Object.hasOwn(agent, key), false, key);
  }
  assert.deepEqual(agents['azpr-review-functional'].model, { providerID: 'provider', id: 'family/functional' });
  // A variant (reasoning effort) uses OpenCode's own provider/model#variant notation.
  const withVariant = input();
  withVariant.models.review.risk = 'openai/gpt-6.1-sol#high';
  assert.deepEqual(buildAgents(validateSettings(withVariant), prompts)['azpr-review-risk'].model, { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' });
  for (const bad of ['openai/gpt-6.1-sol#', 'openai/gpt-6.1-sol#high#max', 'openai#high', '#high']) {
    const settings = input();
    settings.models.review.risk = bad;
    assert.throws(() => validateSettings(settings), /models\.review\.risk: select an actual provider\/model ID/, bad);
  }
  const partial = input();
  partial.models.deep = { functional: 'other/deep-f', risk: '', verifier: '' };
  const partialSettings = validateSettings(partial);
  assert.equal(partialSettings.deepReady, false);
  assert.equal(partialSettings.deepPartial, true);
  const full = input();
  full.models.deep = { functional: 'other/deep-f', risk: 'other/deep-r', verifier: 'other/deep-v' };
  assert.equal(Object.keys(buildAgents(validateSettings(full), prompts)).some(role => role.startsWith('azpr-quick-')), false, 'Quick roles need models.quick.reviewer.');
  full.models.quick = { reviewer: 'other/quick#high' };
  const fullAgents = buildAgents(validateSettings(full), prompts);
  assert.equal(Object.keys(fullAgents).length, Object.keys(ROLES).length - 2, 'Every role except the two ratings, which need a rater.');
  const rated = structuredClone(full);
  rated.models.review.rater = 'other/rater';
  rated.models.deep.rater = 'other/deep-rater';
  assert.equal(Object.keys(buildAgents(validateSettings(rated), prompts)).length, Object.keys(ROLES).length);
  // One quick reviewer per shard and a planner on the same model; no verifier or duplicate check.
  assert.deepEqual(Object.keys(fullAgents).filter(role => role.startsWith('azpr-quick-')).sort(), ['azpr-quick-comment-plan', 'azpr-quick-reviewer']);
  for (const role of ['azpr-quick-reviewer', 'azpr-quick-comment-plan']) assert.deepEqual(fullAgents[role].model, { providerID: 'other', id: 'quick', variant: 'high' }, role);
  assert.equal(validateSettings(input()).quickReady, false, 'A missing quick section disables /pr-quick.');
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, quick: { reviewer: 'YOUR_PROVIDER/YOUR_MODEL' } } }), /models\.quick\.reviewer: select an actual provider\/model ID/);
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, quick: { functional: 'p/m' } } }), /Unknown setting models\.quick\.functional/);
  assert.deepEqual(buildAgents(validateSettings({ ...input(), enabled: false }), prompts), {});
});

test('prompts: review stays byte-identical and deep shares it; quick never claims verification', async () => {
  const { createHash } = await import('node:crypto');
  const sha = value => createHash('sha256').update(value).digest('hex');
  // System prompts of the review roles after 0.3.4, whose shared finding rules
  // deliberately gained concrete gaps, one finding per place that needs its own
  // correction and identical copies in one reviewer's files as one place (0.3.4),
  // then a severity scale that weighs the harm a finding's evidence shows against
  // how often realistic use reaches it, taking the first level that fits, with the
  // verifier setting severity from its own checks, and stated each shared rule
  // once (0.3.5); then defects on lines a PR adds or moves count even when BASE
  // had the same code, and a possible intention neither keeps a defect out nor
  // refutes it: behavior that is wrong only if unintended is low and its
  // suggestion asks the author; then (0.3.7) a change that breaks what worked in
  // BASE is at least medium and an easy fix or an unconfirmed effect does not
  // lower a level, the verifier receives candidates without the reviewer's
  // severity, a finding states one defect, a merge keeps no text of the merged
  // finding, documented steps that worked in BASE and fail in HEAD are a
  // regression, a reviewer looks for stated intent before asking about it, and
  // NEEDS_INFO is for behavior that could not be established, not for intent.
  // The rating role (0.3.7) exists only where a rater model is set and has no
  // tools: its prompt is its own text and the Severity section, so the settings
  // below name a rater. The comment-plan prompts gained skip causes and
  // page-scoped lists after origin/main 5f9b917 and lost `priorPages` when pages
  // began to run side by side. Every role's tool guidance leaves what each tool
  // returns to the tool's own description.
  // Changing a review prompt is a deliberate change: update these together with
  // the validation notes. Deep roles run the same prompts with other models.
  const golden = {
    'deny/en/azpr-review-functional': '8098a60db7177ff416df8b752dffca1cd2e1d4bdb415bac84cdd35868fe9068c',
    'deny/en/azpr-review-risk': '4510845cb06ccca89871321e475fca93ecb71979e472eecea720d09b4a40e83f',
    'deny/en/azpr-review-verifier': '1e5886b0b7de5b0f8c056a5fb61bfcc6fc8f4356cc90c579b95b874595d53971',
    'deny/en/azpr-review-dedupe': '95bd1d48ff6fcc4802576854e591909d5bbf0101079a8ea11cacb45115069303',
    'deny/en/azpr-review-rating': 'ce9b0cc6de07e877f224bfb0c658c941e062145d0c6d60c9eeb0c8ab5f36d899',
    'deny/en/azpr-review-comment-plan': '4459cd370adb32ee1b2d54168f2ed20d315c1944550f3d29bd389e09283286a5',
    'ask/zh-TW/azpr-review-functional': 'c5e8f32697d3ebe9028926f55fe6ec60b5b389374721f3a472a7823345c1427a',
    'ask/zh-TW/azpr-review-risk': '1947a4209eacbfb628deec3aa07dac0d1d98412b13bab9b4027e664e83140cbf',
    'ask/zh-TW/azpr-review-verifier': 'c6ee1fba842a998d830502c3bab85e316307adc45e947c8ba1b71c5540a0f739',
    'ask/zh-TW/azpr-review-dedupe': 'f4ee9194952f7a6ffa752c5f54eac6012d5c380fe91d6223c64f4a3dd9632afc',
    'ask/zh-TW/azpr-review-rating': '520ba5dbabde44dab1d37f7936a03f7c1b9b00b87ff9c7f443e940b95e55a62e',
    'ask/zh-TW/azpr-review-comment-plan': '09fa9efd33f441743cb8fe0255f18cf02db3add68c532d4b129b64fa900d2ac1',
  };
  const models = { review: { functional: 'p/f', risk: 'p/r', verifier: 'p/v', rater: 'p/x' }, deep: { functional: 'p/df', risk: 'p/dr', verifier: 'p/dv', rater: 'p/dx' }, quick: { reviewer: 'p/q' } };
  for (const [shell, outputLanguage] of [['deny', 'en'], ['ask', 'zh-TW']]) {
    const agents = buildAgents(validateSettings({ version: 2, models, azure: { organization: 'org', pat: 'x'.repeat(52) }, shell, outputLanguage }), prompts);
    assert.deepEqual(Object.keys(agents).filter(role => role.startsWith('azpr-review-')).map(role => `${shell}/${outputLanguage}/${role}`).sort(),
      Object.keys(golden).filter(key => key.startsWith(`${shell}/${outputLanguage}/`)).sort(), 'Every review role is hash-locked, the rating included.');
    for (const [role, agent] of Object.entries(agents)) {
      if (role.startsWith('azpr-quick-')) {
        // The quick prompts say that nothing was verified; they never say that something was.
        assert.doesNotMatch(agent.system, /\bverified\b|\bconfirmed\b|already merged|corrected findings|verifier's|verifier will|disposition reasons/i, role);
        assert.doesNotMatch(agent.system, /<!-- azpr:/, `${role}: variant markers are removed`);
        continue;
      }
      if (role.startsWith('azpr-deep-')) {
        // Deep differs from review in its models only.
        const review = agents[role.replace('azpr-deep-', 'azpr-review-')];
        assert.equal(agent.system, review.system, role);
        assert.deepEqual(agent.permissions, review.permissions, role);
        assert.notDeepEqual(agent.model, review.model, role);
        continue;
      }
      assert.equal(sha(agent.system), golden[`${shell}/${outputLanguage}/${role}`], `${shell}/${outputLanguage}/${role}`);
    }
  }
  const quick = buildAgents(validateSettings({ version: 2, models, azure: { organization: 'org', pat: 'x'.repeat(52) } }), prompts);
  assert.match(quick['azpr-quick-reviewer'].system, /no verifier checks your findings afterwards/);
  assert.match(quick['azpr-quick-comment-plan'].system, /no independent verifier re-checked them/);
  assert.match(quick['azpr-quick-comment-plan'].system, /"inline": false/);
  // Only the quick planner may combine the duplicates that different sessions reported.
  assert.match(quick['azpr-quick-comment-plan'].system, /mergeCandidates[\s\S]*findingIds[\s\S]*mergeReason[\s\S]*when unsure, comment on each finding separately/);
  assert.doesNotMatch(quick['azpr-review-comment-plan'].system, /mergeCandidates/);
  // A quick reviewer files a defect it reaches in another changed file at that file's defective lines.
  assert.match(quick['azpr-quick-reviewer'].system, /file it at that file's defective lines, never at a line of your own files/);
  assert.doesNotMatch(quick['azpr-quick-reviewer'].system, /other changed files are context only/);
  assert.match(quick['azpr-review-functional'].system, /other changed files are context only/);
});

test('models.<mode>.rater: an optional model that turns the severity rating on; empty means no rating', () => {
  const base = validateSettings(input());
  assert.equal(base.models.review.rater, '');
  assert.deepEqual(configuredOptionalSlots(base, 'review'), []);
  assert.equal(stageModel(base, 'azpr-review-rating'), '', 'No rater: the stage is off, with no fallback to the verifier\'s model.');
  assert.equal(stageModel(base, 'azpr-review-verifier'), 'provider/verifier');
  assert.equal(stageModel(base, 'azpr-review-comment-plan'), 'provider/risk');
  assert.equal(Object.hasOwn(buildAgents(base, prompts), 'azpr-review-rating'), false, 'No rating role is registered without a rater.');
  const chosen = input();
  chosen.models.review.rater = 'strong/rater#high';
  const settings = validateSettings(chosen);
  assert.deepEqual(configuredOptionalSlots(settings, 'review'), ['rater']);
  assert.deepEqual(configuredOptionalSlots(settings, 'quick'), []);
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(agents['azpr-review-rating'].model, { providerID: 'strong', id: 'rater', variant: 'high' });
  assert.deepEqual(agents['azpr-review-verifier'].model, { providerID: 'provider', id: 'verifier' }, 'Only the rating uses the rater.');
  // The rater does not count toward the three roles that turn deep mode on, and deep works without one.
  const raterOnly = input();
  raterOnly.models.deep = { rater: 'strong/rater' };
  assert.deepEqual([validateSettings(raterOnly).deepReady, validateSettings(raterOnly).deepPartial], [false, false]);
  const deep = input();
  deep.models.deep = { functional: 'other/deep-f', risk: 'other/deep-r', verifier: 'other/deep-v' };
  const deepSettings = validateSettings(deep);
  assert.equal(deepSettings.deepReady, true);
  assert.equal(stageModel(deepSettings, 'azpr-deep-rating'), '', 'Deep rates only with its own rater, never a review model.');
  assert.equal(Object.hasOwn(buildAgents(deepSettings, prompts), 'azpr-deep-rating'), false);
  // A review rater does not turn the deep rating on, and the other way round.
  const reviewRated = structuredClone(deep);
  reviewRated.models.review.rater = 'strong/rater';
  const reviewRatedAgents = buildAgents(validateSettings(reviewRated), prompts);
  assert.deepEqual([Object.hasOwn(reviewRatedAgents, 'azpr-review-rating'), Object.hasOwn(reviewRatedAgents, 'azpr-deep-rating')], [true, false]);
  deep.models.deep.rater = 'strong/rater';
  assert.equal(stageModel(validateSettings(deep), 'azpr-deep-rating'), 'strong/rater');
  assert.deepEqual(buildAgents(validateSettings(deep), prompts)['azpr-deep-rating'].model, { providerID: 'strong', id: 'rater' });
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, review: { ...input().models.review, rater: 'YOUR_PROVIDER/YOUR_MODEL' } } }), /models\.review\.rater: select an actual provider\/model ID/);
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, review: { ...input().models.review, rater: 7 } } }), /models\.review\.rater/);
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, quick: { reviewer: 'p/q', rater: 'p/r' } } }), /Unknown setting models\.quick\.rater/);
  for (const mode of ['review', 'deep']) {
    assert.ok(Object.hasOwn(schema.properties.models.properties[mode].properties, 'rater'), mode);
    assert.equal(example.models[mode].rater, '', `${mode}: the example leaves the rating off`);
  }
  assert.equal(schema.properties.models.properties.review.required.includes('rater'), false);
  assert.equal(Object.hasOwn(schema.properties.models.properties.quick.properties, 'rater'), false);
});

test('prompt variants keep shared lines and refuse malformed blocks', async () => {
  const { selectVariant } = await import('../src/config.mjs');
  const text = 'a\n<!-- azpr:verified -->\nv1\n<!-- azpr:quick -->\nq1\n<!-- azpr:end -->\nb\n';
  assert.equal(selectVariant(text, 'verified'), 'a\nv1\nb\n');
  assert.equal(selectVariant(text, 'quick'), 'a\nq1\nb\n');
  assert.equal(selectVariant('<!-- azpr:quick -->\nonly quick\n<!-- azpr:end -->\nshared', 'verified'), 'shared');
  assert.throws(() => selectVariant('<!-- azpr:quick -->\nopen', 'quick', 'x'), /Unterminated variant block in x\.md/);
  assert.throws(() => selectVariant('<!-- azpr:end -->', 'quick', 'x'), /end without a start/);
  assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, common: prompts.common + '\n<!-- azpr:quick -->\n' }), /Unterminated variant block in common\.md/);
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
  // The rating role reads only the finding text in its input: no tool at all, whatever the shell setting.
  for (const shell of ['deny', 'ask', 'inherit']) {
    assert.deepEqual(allowedTools('azpr-review-rating', shell), [], shell);
    assert.equal(nativeToolPermissions('azpr-deep-rating', shell).shell, 'deny', shell);
  }
  const agents = buildAgents(validateSettings({ ...withRater(), shell: 'ask' }), prompts);
  assert.ok(Object.hasOwn(agents, 'azpr-review-rating'));
  for (const [role, agent] of Object.entries(agents)) {
    assert.equal(agent.permissions.some(rule => rule.action === '*' || rule.effect === 'allow'), false, role);
    assert.deepEqual(agent.permissions.find(rule => rule.action === 'shell'), { action: 'shell', resource: '*', effect: ROLES[role].tools === false ? 'deny' : 'ask' });
  }
});

test('prompts: one JSON transport, shared tool policy, shell guidance and language routing', () => {
  const agents = buildAgents(validateSettings({ ...withRater(), outputLanguage: 'zh-TW' }), prompts);
  assert.ok(Object.hasOwn(agents, 'azpr-review-rating'));
  for (const [role, agent] of Object.entries(agents)) {
    assert.match(agent.system, /one valid JSON object/);
    assert.doesNotMatch(agent.system, /MCP|repo_file|repo_pull_request/);
    assert.match(agent.system, /outputLanguage: zh-TW/);
    assert.doesNotMatch(agent.system, /currentHead|currentBase|StructuredOutput/);
    if (ROLES[role].tools === false) {
      // A role without tools gets its own text and the severity rules: nothing about tools, reading source or filing findings.
      assert.match(agent.system, /^# Role: severity rating\n/, role);
      assert.match(agent.system, /\n## Severity\n[\s\S]*Take the first level that fits:[\s\S]*\n# Configured output language\n/, role);
      assert.doesNotMatch(agent.system, /azpr_|# Tools|# Local commands|Reading source|File every concrete defect/, role);
      assert.doesNotMatch(agent.system, /\n## Output\n|Return the useful review/, `${role}: the Severity section alone, not the sections after it`);
      continue;
    }
    assert.match(agent.system, /Read the PR repository with AZPR's tools \(azpr_\*\)/);
    assert.match(agent.system, /the runtime alone posts comments/);
    assert.match(agent.system, /never the PR repository/);
    assert.match(agent.system, /Shell is unavailable in this session/);
  }
  assert.throws(() => buildAgents(validateSettings(withRater()), { ...prompts, common: prompts.common.replace('## Severity', '## Levels') }), /common\.md has no "## Severity" section/);
  assert.match(agents['azpr-review-verifier'].system, /counterevidence/);
  assert.match(agents['azpr-review-comment-plan'].system, /azprData/);
  const shellAllowed = buildAgents(validateSettings({ ...input(), shell: 'inherit' }), prompts);
  assert.match(shellAllowed['azpr-review-risk'].system, /Shell may be available under OpenCode permissions/);
  for (const name of PROMPTS) assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, [name]: ' ' }), /Missing or empty prompt/);
});

test('trimmed role instructions stay compact', () => {
  // A guard against prompt growth, not a model limit: the shared severity scale
  // (0.3.5) added about 2,300 characters to every review role; 0.3.7 added about
  // 1,100 to the shared rules and 300 to the verifier's.
  const agents = buildAgents(validateSettings(withRater()), prompts);
  for (const [role, agent] of Object.entries(agents)) if (agent.system) assert.ok(agent.system.length < 18500, `${role}: ${agent.system.length}`);
  assert.ok(agents['azpr-review-rating'].system.length < 6000, 'The rating role carries only its own text and the severity rules.');
});

test('azure.patFile: an absolute path in place of azure.pat, never both; PAT problems never echo the value', () => {
  const azure = extra => ({ ...input(), azure: { organization: 'org', ...extra } });
  const settings = validateSettings(azure({ pat: '', patFile: '/home/me/.config/azpr/pat' }));
  assert.equal(settings.azure.patFile, '/home/me/.config/azpr/pat');
  assert.equal(settings.azure.pat, '');
  assert.throws(() => validateSettings(azure({ pat: PAT, patFile: '/home/me/pat' })), /Set either azure\.pat or azure\.patFile, not both/);
  for (const patFile of ['relative/pat', '/home/me/pat\n', 7]) {
    assert.throws(() => validateSettings(azure({ pat: '', patFile })), /azure\.patFile must be empty or the absolute path of a file that holds only the PAT/);
  }
  assert.throws(() => validateSettings(azure({ pat: '' })), /azure\.pat must be an Azure DevOps personal access token .*or leave it empty and set azure\.patFile/);
  assert.equal(patProblem(PAT), '');
  for (const [value, problem] of [['short', /20 to 1024/], ['two tokens with spaces here', /one token/], ['YOUR_PERSONAL_ACCESS_TOKEN_0123456789', /placeholder/], [42, /one token/]]) {
    assert.match(patProblem(value), problem);
    if (typeof value === 'string') assert.ok(!patProblem(value).includes(value), 'The problem never contains the value.');
  }
  assert.ok(Object.hasOwn(schema.properties.azure.properties, 'patFile'));
});
