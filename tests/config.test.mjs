import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCKED_NATIVE_TOOLS, NATIVE_TOOL_PERMISSIONS, PROMPTS, ROLES, allowedTools, buildAgents,
  nativeToolPermissions, patProblem, validateSettings, stageModel, firstModel, migrateSettings, modeReady, privateAgent,
  promptVariant, raterState, reviewerRoles, MAX_REVIEWERS, MIGRATION_NEEDED, MODES, SETTING_DEFAULTS, withMissingSettings,
} from '../src/config.mjs';

const example = JSON.parse(await readFile(new URL('../config/settings.example.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../config/settings.schema.json', import.meta.url), 'utf8'));
const prompts = Object.fromEntries(await Promise.all(PROMPTS.map(async name =>
  [name, await readFile(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8')])));
const PAT = 'fixture-pat-0123456789abcdefghij';
// Two passes of /pr-review with different models; deep and quick are off, as in the example.
const input = () => ({ ...structuredClone(example), models: {
  review: { reviewers: ['provider/family/first', 'provider/second'], rater: '' },
  deep: { reviewers: [], rater: '' },
}, azure: { ...example.azure, organization: 'org', pat: PAT } });

test('settings reject removed transports and unknown keys', () => {
  for (const key of ['structuredOutput', 'steps', 'maxStageCharacters', 'comments', 'auxiliaryModels', 'outputRetries', 'verification', 'shellToolPermission']) {
    assert.equal(Object.hasOwn(example, key), false, key);
    assert.equal(Object.hasOwn(schema.properties, key), false, key);
    assert.throws(() => validateSettings({ ...input(), [key]: false }), /Unknown setting/, key);
  }
  for (const version of [1, 4, '3', undefined]) assert.throws(() => validateSettings({ ...input(), version }), error => /version must be 3/.test(error.message) && error.needsMigration === undefined, String(version));
  // A file of AZPR 0.4.x is not read as it is. Its error says what to do, and a caller can tell it from a broken file.
  assert.throws(() => validateSettings({ ...input(), version: 2 }), error => error.message === MIGRATION_NEEDED && error.needsMigration === true);
  assert.match(MIGRATION_NEEDED, /settings version 2[\s\S]*run \/pr-setup[\s\S]*Nothing is changed until you confirm/);
  // What the 0.4.x pipeline was set with is no setting any more.
  assert.throws(() => validateSettings({ ...input(), workflow: { shardFindings: 15 } }), /Unknown setting workflow\.shardFindings/);
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, _help: { reviewers: 'Documentation' } } }), /Unknown setting models\._help/);
  for (const key of ['functional', 'risk', 'verifier']) {
    assert.throws(() => validateSettings({ ...input(), models: { ...input().models, review: { ...input().models.review, [key]: 'p/m' } } }), new RegExp(`Unknown setting models\\.review\\.${key}`));
  }
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, quick: { reviewer: 'p/m' } } }), /Unknown setting models\.quick\.reviewer;/);
  for (const key of ['shardFindings']) assert.equal(Object.hasOwn(schema.properties.workflow.properties, key), false, key);
  assert.equal(Object.hasOwn(schema.properties.models.properties, '_help'), false);
  assert.throws(() => validateSettings({ ...input(), mcp: { server: 'x' } }), /settings\.mcp is no longer used/);
  assert.throws(() => validateSettings({ ...input(), azure: { ...input().azure, server: 'x' } }), /Unknown setting azure\.server/);
  assert.throws(() => validateSettings({ ...input(), workflow: { shards: 2 } }), /Unknown setting workflow\.shards/);
});

test('terminalPanel: the panel opens by itself by default, or only with /pr-panel', () => {
  assert.equal(example.terminalPanel, 'auto');
  assert.deepEqual(schema.properties.terminalPanel.enum, ['auto', 'manual']);
  assert.equal(schema.properties.terminalPanel.default, 'auto');
  const raw = input();
  delete raw.terminalPanel;
  assert.equal(validateSettings(raw).terminalPanel, 'auto');
  assert.equal(validateSettings({ ...input(), terminalPanel: 'manual' }).terminalPanel, 'manual');
  for (const value of ['off', true, '', null]) assert.throws(() => validateSettings({ ...input(), terminalPanel: value }), /^Error: terminalPanel must be auto or manual\.$/);
});

test('every setting with a default is in the example, the schema and the completion of a settings file', () => {
  // What a person must choose has no default: the review models and the organization.
  const chosen = { version: 3, models: { review: { reviewers: ['provider/a', 'provider/b'] } }, azure: { organization: 'org', patFile: '/private/pat' } };
  const { settings, added } = withMissingSettings(chosen);
  // The example is the completed file, with placeholders where a person chooses.
  const { $schema, ...documented } = structuredClone(example);
  Object.assign(documented.models.review, chosen.models.review);
  Object.assign(documented.azure, chosen.azure);
  assert.equal($schema, './settings.schema.json');
  assert.deepEqual(settings, documented, 'config/settings.example.json and SETTING_DEFAULTS name the same settings with the same values.');
  // New names follow the ones a file has, in the order of the example.
  assert.deepEqual(Object.keys(settings), ['version', 'models', 'azure', ...Object.keys(example).filter(key => !['$schema', 'version', 'models', 'azure'].includes(key))]);
  assert.deepEqual(added, ['models.review.rater', 'models.deep', 'models.quick', 'enabled', 'returnReport', 'debug', 'outputLanguage', 'runTimeoutSeconds', 'shell',
    'progressNotices', 'deletePrivateSessions', 'terminalPanel', 'afterReview', 'azure.pat', 'azure.concurrency', 'azure.callTimeoutSeconds', 'azure.archiveMegabytes',
    'azure.proxy', 'azure.caFile', 'azure.verifyTls', 'workflow'], 'A group added as a whole is named once.');
  // Every default has a schema entry with the same default. A list is one value.
  const defaultsOf = (node, at) => Object.entries(node).flatMap(([key, value]) => value !== null && typeof value === 'object' && !Array.isArray(value) ? defaultsOf(value, [...at, key]) : [[[...at, key], value]]);
  const defaults = defaultsOf(SETTING_DEFAULTS, []);
  for (const [path, value] of defaults) {
    const entry = path.reduce((node, key) => node?.properties?.[key], schema);
    assert.ok(entry, `settings.schema.json describes ${path.join('.')}`);
    if (Object.hasOwn(entry, 'default')) assert.deepEqual(entry.default, value, `The schema's default of ${path.join('.')}`);
  }
  for (const path of ['models.deep.reviewers', 'models.quick.reviewers', 'models.review.rater', 'models.deep.rater', 'models.quick.rater']) {
    assert.ok(defaults.some(([at]) => at.join('.') === path), `${path} has a default`);
    assert.ok(Object.hasOwn(path.split('.').reduce((node, key) => node.properties[key], schema), 'default'), `The schema states the default of ${path}`);
  }
  assert.equal(defaults.some(([at]) => at.join('.') === 'models.review.reviewers'), false, 'The review models are chosen, never defaulted.');
  assert.equal(schema.properties.terminalPanel.default, SETTING_DEFAULTS.terminalPanel);
  assert.throws(() => { SETTING_DEFAULTS.afterReview.review = 'publish'; }, TypeError, 'The defaults cannot be changed at runtime.');
  // A list default is copied into a file: the file's list is its own, and the default stays empty and frozen.
  assert.notEqual(settings.models.deep.reviewers, SETTING_DEFAULTS.models.deep.reviewers);
  settings.models.deep.reviewers.push('provider/x');
  assert.deepEqual(SETTING_DEFAULTS.models.deep.reviewers, []);
  assert.deepEqual(withMissingSettings(chosen).settings.models.deep.reviewers, []);
  assert.throws(() => { SETTING_DEFAULTS.models.quick.reviewers.push('provider/x'); }, TypeError);
});

test('completing a settings file changes nothing about how it behaves, keeps what is there and is done once', () => {
  const files = [
    { version: 3, models: { review: { reviewers: ['provider/a', 'provider/b'] }, quick: { reviewers: ['provider/q'] } }, azure: { organization: 'org', pat: PAT } },
    { version: 3, enabled: false, models: { review: { reviewers: ['provider/a', 'provider/a', 'provider/b'], rater: 'provider/r' }, deep: { reviewers: ['provider/d'] } },
      debug: { enabled: true }, afterReview: { review: 'publish' }, workflow: { parallelSessions: 2 }, runTimeoutSeconds: 600, terminalPanel: 'manual',
      azure: { organization: 'org', pat: '', patFile: '/private/pat', verifyTls: false } },
    // A rating that was turned off stays off: false is a value, not a missing one.
    { ...input(), models: { ...input().models, review: { reviewers: ['provider/a'], rater: false }, quick: { rater: false } } },
    withMissingSettings(input()).settings,
  ];
  for (const raw of files) {
    const before = structuredClone(raw);
    const { settings, added } = withMissingSettings(raw);
    assert.deepEqual(raw, before, 'The input is not changed.');
    assert.deepEqual(validateSettings(settings), validateSettings(raw), 'A default written into the file is the default validation assumed.');
    // Every value that was there is there, under the same name.
    const kept = (from, to, at) => { for (const [key, value] of Object.entries(from)) {
      if (value !== null && typeof value === 'object') kept(value, to[key], `${at}${key}.`); else assert.deepEqual(to[key], value, `${at}${key}`);
    } };
    kept(raw, settings, '');
    assert.deepEqual(Object.keys(settings).slice(0, Object.keys(raw).length), Object.keys(raw), 'Existing names keep their order; new ones follow.');
    assert.deepEqual(withMissingSettings(settings), { settings, added: [] }, 'A completed file lacks nothing.');
    assert.equal(added.length === 0, raw === files[3], 'Only the full example lacks nothing.');
  }
  // A value of the wrong kind is left for validation to name; nothing is put in its place.
  assert.deepEqual(withMissingSettings({ version: 3, debug: 'yes', workflow: null }).settings.debug, 'yes');
  assert.equal(withMissingSettings({ version: 3, debug: 'yes', workflow: null }).settings.workflow, null);
  assert.deepEqual(withMissingSettings({ version: 3, models: { review: 'provider/a', deep: { reviewers: 'provider/d' } } }).settings.models,
    { review: 'provider/a', deep: { reviewers: 'provider/d', rater: '' }, quick: { reviewers: [], rater: '' } });
  assert.deepEqual(files.map(raw => withMissingSettings(raw).settings.models.quick), [{ reviewers: ['provider/q'], rater: '' }, { reviewers: [], rater: '' }, { rater: false, reviewers: [] }, { reviewers: [], rater: '' }]);
});

test('afterReview: a preview for every mode by default, none or publish per mode; errors name the setting, never its value', () => {
  assert.deepEqual(example.afterReview, { quick: 'preview', review: 'preview', deep: 'preview' });
  assert.deepEqual(Object.keys(schema.properties.afterReview.properties).sort(), ['deep', 'quick', 'review']);
  for (const mode of ['quick', 'review', 'deep']) assert.deepEqual(schema.properties.afterReview.properties[mode].enum, ['none', 'preview', 'publish']);
  const raw = input();
  delete raw.afterReview;
  assert.deepEqual(validateSettings(raw).afterReview, { quick: 'preview', review: 'preview', deep: 'preview' }, 'Without the setting a review is followed by a preview, which posts nothing.');
  for (const mode of ['quick', 'review', 'deep']) assert.equal(schema.properties.afterReview.properties[mode].default, 'preview');
  assert.deepEqual(validateSettings(input()).afterReview, validateSettings(raw).afterReview, 'The example matches the defaults.');
  assert.deepEqual(validateSettings({ ...input(), afterReview: { review: 'publish' } }).afterReview, { quick: 'preview', review: 'publish', deep: 'preview' }, 'A missing mode takes the default; publication is never a default.');
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
  assert.deepEqual(settings.azure, { organization: 'org', pat: PAT, patFile: '', concurrency: 6, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true });
  assert.deepEqual(settings.workflow, { shardFiles: 25, parallelSessions: 8, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 });
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

test('models.<mode>.reviewers: one model per review pass, 1 to 4; only review needs one; errors name the entry, never its value', () => {
  const withList = (mode, reviewers) => ({ ...input(), models: { ...input().models, [mode]: { reviewers } } });
  assert.equal(MAX_REVIEWERS, 4);
  for (const mode of MODES) {
    for (const list of [['p/a'], ['p/a', 'p/a'], ['p/a', 'q/b#high', 'p/a', 'r/c']]) {
      assert.deepEqual(validateSettings(withList(mode, list)).models[mode], { reviewers: list, rater: '' }, 'An entry may repeat; the order is the order of the passes.');
    }
    assert.throws(() => validateSettings(withList(mode, ['p/a', 'p/b', 'p/c', 'p/d', 'p/e'])), new RegExp(`^Error: models\\.${mode}\\.reviewers takes at most 4 models`));
    for (const value of ['p/a', { 0: 'p/a' }, null, 7, true]) {
      assert.throws(() => validateSettings(withList(mode, value)), new RegExp(`^Error: models\\.${mode}\\.reviewers must be a list of models`), JSON.stringify(value));
    }
    for (const bad of ['YOUR_PROVIDER/YOUR_MODEL', 'Sonnet Display Name', 'openai/gpt-6.1-sol#', 'openai#high', '', 7, null, ['p/a']]) {
      assert.throws(() => validateSettings(withList(mode, ['p/a', bad])),
        error => error.message.startsWith(`models.${mode}.reviewers[1]: select an actual provider/model ID`) && !(typeof bad === 'string' && bad && error.message.includes(bad)), JSON.stringify(bad));
    }
    assert.equal(schema.properties.models.properties[mode].properties.reviewers.maxItems, MAX_REVIEWERS, mode);
    assert.equal(schema.properties.models.properties[mode].properties.reviewers.minItems, mode === 'review' ? 1 : 0, mode);
  }
  // An empty list leaves deep or quick off, and is what a missing section means. Review needs a model.
  for (const mode of ['deep', 'quick']) {
    assert.deepEqual(validateSettings(withList(mode, [])).models[mode], { reviewers: [], rater: '' });
    const raw = input();
    delete raw.models[mode];
    assert.deepEqual(validateSettings(raw).models[mode], { reviewers: [], rater: '' });
    assert.equal(modeReady(validateSettings(raw), mode), false);
  }
  assert.throws(() => validateSettings(withList('review', [])), /^Error: models\.review\.reviewers needs at least one model/);
  assert.throws(() => validateSettings({ ...input(), models: { deep: { reviewers: ['p/a'] } } }), /^Error: models\.review must be a JSON object/);
  assert.throws(() => validateSettings({ ...input(), models: { review: { rater: '' } } }), /^Error: models\.review\.reviewers must be a list of models/);
  assert.deepEqual(schema.properties.models.required, ['review']);
  assert.deepEqual(schema.properties.models.properties.review.required, ['reviewers']);
  // What the list means for a run: a reviewer role per entry, and the first entry's model for the stages after the passes.
  const settings = validateSettings({ ...input(), models: { review: { reviewers: ['p/a', 'q/b#high', 'p/a'] }, quick: { reviewers: ['q/fast'] } } });
  assert.deepEqual(reviewerRoles(settings, 'review'), ['azpr-review-reviewer', 'azpr-review-reviewerb', 'azpr-review-reviewerc']);
  assert.deepEqual(reviewerRoles(settings, 'quick'), ['azpr-quick-reviewer']);
  assert.deepEqual(reviewerRoles(settings, 'deep'), []);
  assert.deepEqual(MODES.map(mode => [mode, modeReady(settings, mode), firstModel(settings, mode)]), [['review', true, 'p/a'], ['deep', false, ''], ['quick', true, 'q/fast']]);
  assert.equal(modeReady(settings, 'comment'), false, 'Only the three review modes have models.');
  assert.deepEqual(['reviewer', 'reviewerb', 'reviewerc', 'reviewerd', 'dedupe', 'rating', 'comment-plan', 'comment-plan-verified'].map(stage => stageModel(settings, `azpr-review-${stage}`)),
    ['p/a', 'q/b#high', 'p/a', '', 'p/a', 'p/a', 'p/a', 'p/a']);
  assert.deepEqual(['reviewer', 'dedupe', 'rating', 'comment-plan'].map(stage => stageModel(settings, `azpr-deep-${stage}`)), ['', '', '', ''], 'A mode that is off has no model, and never another mode\'s.');
});

test('migrateSettings: what a settings file of 0.4.x becomes, with no value lost or invented', () => {
  const old = { $schema: './settings.schema.json', version: 2,
    models: { _help: { functional: 'What it reviews.' }, review: { functional: 'p/f#high', risk: 'q/r', verifier: 'p/v', rater: '' },
      deep: { functional: 'p/df', risk: '', verifier: 'p/dv', rater: 'p/dx' }, quick: { reviewer: 'p/q' } },
    enabled: true, outputLanguage: 'zh-TW', shell: 'ask', afterReview: { quick: 'preview', review: 'publish', deep: 'none' },
    azure: { organization: 'org', pat: '', patFile: '/private/pat', proxy: 'http://user:word@proxy.example.com:8080', verifyTls: false },
    workflow: { shardFiles: 10, shardFindings: 7, parallelSessions: 4 } };
  const before = structuredClone(old);
  const { settings, summary } = migrateSettings(old);
  assert.deepEqual(old, before, 'The input is not changed.');
  assert.deepEqual(settings, { $schema: './settings.schema.json', version: 3,
    // The two reviewers in their order; the verifier's model is dropped. Deep was off without all three roles and stays off.
    models: { review: { reviewers: ['p/f#high', 'q/r'], rater: '' }, deep: { reviewers: [], rater: 'p/dx' }, quick: { reviewers: ['p/q'], rater: '' } },
    enabled: true, outputLanguage: 'zh-TW', shell: 'ask', afterReview: { quick: 'preview', review: 'publish', deep: 'none' },
    azure: { organization: 'org', pat: '', patFile: '/private/pat', proxy: 'http://user:word@proxy.example.com:8080', verifyTls: false },
    workflow: { shardFiles: 10, parallelSessions: 4 } });
  assert.deepEqual(Object.keys(settings), Object.keys(old), 'Every name keeps its place.');
  assert.deepEqual(Object.keys(settings.workflow), ['shardFiles', 'parallelSessions']);
  const valid = validateSettings(settings);
  assert.deepEqual(valid.models, settings.models);
  assert.deepEqual([valid.afterReview.review, valid.shell, valid.azure.verifyTls, valid.workflow.shardFiles], ['publish', 'ask', false, 10], 'What a person had chosen stays chosen.');
  assert.deepEqual(summary, { modes: {
    review: { before: { functional: 'p/f#high', risk: 'q/r', verifier: 'p/v', rater: '' }, after: { reviewers: ['p/f#high', 'q/r'], rater: '' }, state: 'on' },
    deep: { before: { functional: 'p/df', risk: '', verifier: 'p/dv', rater: 'p/dx' }, after: { reviewers: [], rater: 'p/dx' }, state: 'partial' },
    quick: { before: { reviewer: 'p/q' }, after: { reviewers: ['p/q'], rater: '' }, state: 'on' },
  }, shardFindings: 7, publish: ['review'] });
  // Deep with its three roles becomes its two reviewers; modes that were off stay off.
  const full = migrateSettings({ version: 2, models: { review: { functional: 'p/f', risk: 'p/f', verifier: 'p/v', rater: 'p/x' },
    deep: { functional: 'p/df', risk: 'p/dr', verifier: 'p/dv' } }, azure: { organization: 'org', pat: PAT } });
  assert.deepEqual(full.settings.models, { review: { reviewers: ['p/f', 'p/f'], rater: 'p/x' }, deep: { reviewers: ['p/df', 'p/dr'], rater: '' }, quick: { reviewers: [], rater: '' } });
  assert.deepEqual([full.summary.modes.deep.state, full.summary.modes.quick.state, full.summary.shardFindings, full.summary.publish], ['on', 'off', undefined, []]);
  assert.deepEqual(Object.keys(full.settings), ['version', 'models', 'azure'], 'Nothing is added: the completion of a settings file does that.');
  validateSettings(full.settings);
  // The update repairs nothing. A value 0.4.x refused in a slot that still exists stays where it goes now, and so
  // does a key the update does not know: the file is no more usable than before, and the settings check names
  // the fault. Only what no longer exists goes, whatever it held (a verifier, help texts 0.4.x could not read).
  const odd = migrateSettings({ version: 2, models: { review: { functional: 7, risk: ['p/r'], verifier: { id: 'p/v' }, rater: null, ratr: 'p/x' }, quick: 'p/q', extra: 1, _help: 'Notes' } });
  assert.deepEqual(odd.settings.models, { review: { reviewers: [7, ['p/r']], rater: null, ratr: 'p/x' }, deep: { reviewers: [], rater: '' }, quick: 'p/q', extra: 1, _help: 'Notes' });
  assert.deepEqual(['review', 'deep', 'quick'].map(mode => odd.summary.modes[mode].state), ['kept', 'off', 'kept']);
  assert.throws(() => validateSettings(odd.settings), /^Error: Unknown setting models\.extra; check for a typo\.$/);
  const refused = changes => { try { validateSettings(withMissingSettings(migrateSettings({ version: 2, ...changes }).settings).settings); return ''; } catch (error) { return error.message; } };
  const usable = { review: { functional: 'p/f', risk: 'p/r', verifier: 'p/v' } }, azure = { organization: 'org', pat: PAT };
  assert.equal(refused({ models: usable, azure }), '', 'A file 0.4.x could use gives one this version can use.');
  for (const [models, problem] of [
    [{ review: { ...usable.review, rater: 12 } }, /^models\.review\.rater must be ""/],
    [{ review: { ...usable.review, ratr: 'p/x' } }, /^Unknown setting models\.review\.ratr; check for a typo\.$/],
    [{ review: { ...usable.review, rater: 'Some Model' } }, /^models\.review\.rater: select an actual provider\/model ID/],
    [{ review: { ...usable.review, risk: 'REPLACE_PROVIDER/REPLACE_MODEL' } }, /^models\.review\.reviewers\[1\]: select an actual provider\/model ID/],
    [{ review: { functional: 'p/f', risk: 'p/r' } }, /^models\.review\.reviewers needs at least one model/],
    [{ ...usable, deep: { functional: 7 } }, /^models\.deep\.reviewers\[0\]: select an actual provider\/model ID/],
    [{ ...usable, deep: 'p/d' }, /^models\.deep must be a JSON object\.$/],
    [{ ...usable, quick: { reviewer: 'Fast Model' } }, /^models\.quick\.reviewers\[0\]: select an actual provider\/model ID/],
    [{ ...usable, other: {} }, /^Unknown setting models\.other; check for a typo\.$/],
    [{ ...usable, _help: { reviewer: 'notes' } }, /^Unknown setting models\._help; check for a typo\.$/],
  ]) assert.match(refused({ models, azure }), problem, JSON.stringify(models));
  assert.match(refused({ models: 'p/m', azure }), /^models must be a JSON object\.$/);
  // What no longer exists goes, whatever it held: a verifier, readable help texts, shardFindings.
  for (const models of [{ review: { ...usable.review, verifier: 7 } }, { ...usable, _help: { functional: 'notes' } }]) assert.equal(refused({ models, azure }), '', JSON.stringify(models));
  assert.equal(refused({ models: usable, azure, workflow: { shardFindings: 'many' } }), '');
  // A group that names reviewers already was written for neither version: 0.4.x refused that key. The group is
  // kept as it is, whatever reviewers holds, so that its models are not mixed with the ones the update would map,
  // and the settings check names it.
  const clash = migrateSettings({ version: 2, models: { review: { functional: 'p/a', risk: 'p/b', verifier: 'p/v', reviewers: ['p/other'] },
    deep: { functional: 'p/d', risk: 'p/e', verifier: 'p/v', reviewers: null }, quick: { reviewer: 'p/q', reviewers: ['p/r'] } } });
  assert.deepEqual(clash.settings.models, { review: { functional: 'p/a', risk: 'p/b', verifier: 'p/v', reviewers: ['p/other'] },
    deep: { functional: 'p/d', risk: 'p/e', verifier: 'p/v', reviewers: null }, quick: { reviewer: 'p/q', reviewers: ['p/r'] } });
  assert.deepEqual(['review', 'deep', 'quick'].map(mode => [clash.summary.modes[mode].state, clash.summary.modes[mode].clash]), [['kept', true], ['kept', true], ['kept', true]]);
  assert.match(refused({ models: { review: { ...usable.review, reviewers: ['p/other'] } }, azure }), /^Unknown setting models\.review\.(functional|risk|verifier); check for a typo\.$/);
  // 0.4.x had no rater for /pr-quick; one the file names anyway is kept.
  assert.deepEqual(migrateSettings({ version: 2, models: { ...usable, quick: { reviewer: 'p/q', rater: 'p/r' } } }).settings.models.quick, { reviewers: ['p/q'], rater: 'p/r' });
  // A file without models gets the empty layout.
  assert.deepEqual(migrateSettings({ version: 2, enabled: false }).settings, { version: 3, enabled: false, models: { review: { reviewers: [], rater: '' }, deep: { reviewers: [], rater: '' }, quick: { reviewers: [], rater: '' } } });
  for (const raw of [null, [], 'text', {}, { version: 1 }, { version: 3 }, { version: '2' }]) assert.throws(() => migrateSettings(raw), /Only settings of version 2 are migrated/, JSON.stringify(raw));
});

test('agents: one per configured role, a reviewer role per entry of the list; a mode without reviewers has none', () => {
  const settings = validateSettings(input());
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(Object.keys(agents).sort(), ['azpr-review-comment-plan', 'azpr-review-comment-plan-verified', 'azpr-review-dedupe', 'azpr-review-rating',
    'azpr-review-reviewer', 'azpr-review-reviewerb']);
  for (const [id, agent] of Object.entries(agents)) {
    assert.equal(agent.id, id);
    assert.equal(agent.mode, 'primary');
    assert.equal(agent.hidden, true);
    assert.deepEqual(agent.request, { settings: {}, headers: {}, body: {} });
    for (const key of ['prompt', 'permission', 'disable', 'steps']) assert.equal(Object.hasOwn(agent, key), false, key);
  }
  // Pass i runs with entry i; the duplicate check, the rating and the planners run with the first entry.
  assert.deepEqual(agents['azpr-review-reviewer'].model, { providerID: 'provider', id: 'family/first' });
  assert.deepEqual(agents['azpr-review-reviewerb'].model, { providerID: 'provider', id: 'second' });
  for (const stage of ['dedupe', 'rating', 'comment-plan', 'comment-plan-verified']) assert.deepEqual(agents[`azpr-review-${stage}`].model, agents['azpr-review-reviewer'].model, stage);
  // A variant (reasoning effort) uses OpenCode's own provider/model#variant notation.
  const withVariant = input();
  withVariant.models.review.reviewers[1] = 'openai/gpt-6.1-sol#high';
  assert.deepEqual(buildAgents(validateSettings(withVariant), prompts)['azpr-review-reviewerb'].model, { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' });
  for (const bad of ['openai/gpt-6.1-sol#', 'openai/gpt-6.1-sol#high#max', 'openai#high', '#high']) {
    const settings = input();
    settings.models.review.reviewers[1] = bad;
    assert.throws(() => validateSettings(settings), /models\.review\.reviewers\[1\]: select an actual provider\/model ID/, bad);
  }
  // One pass: one reviewer role. The roles of positions the list does not have are not registered.
  const one = input();
  one.models.review.reviewers = ['provider/only'];
  assert.deepEqual(Object.keys(buildAgents(validateSettings(one), prompts)).sort(), ['azpr-review-comment-plan', 'azpr-review-comment-plan-verified', 'azpr-review-dedupe', 'azpr-review-rating', 'azpr-review-reviewer']);
  // Deep and quick have roles only with reviewers of their own, and the same stages as review.
  const full = input();
  full.models.deep = { reviewers: ['other/deep-a', 'other/deep-b', 'other/deep-c', 'other/deep-d'] };
  assert.equal(Object.keys(buildAgents(validateSettings(full), prompts)).some(role => role.startsWith('azpr-quick-')), false, 'Quick roles need models.quick.reviewers.');
  full.models.quick = { reviewers: ['other/quick#high'] };
  const fullAgents = buildAgents(validateSettings(full), prompts);
  assert.deepEqual(Object.keys(fullAgents).filter(role => role.startsWith('azpr-deep-')).sort(), ['azpr-deep-comment-plan', 'azpr-deep-comment-plan-verified', 'azpr-deep-dedupe',
    'azpr-deep-rating', 'azpr-deep-reviewer', 'azpr-deep-reviewerb', 'azpr-deep-reviewerc', 'azpr-deep-reviewerd']);
  assert.deepEqual(['reviewer', 'reviewerb', 'reviewerc', 'reviewerd'].map(stage => fullAgents[`azpr-deep-${stage}`].model.id), ['deep-a', 'deep-b', 'deep-c', 'deep-d']);
  // Quick saved no review of the verified kind, so it has no planner for one.
  assert.deepEqual(Object.keys(fullAgents).filter(role => role.startsWith('azpr-quick-')).sort(), ['azpr-quick-comment-plan', 'azpr-quick-dedupe', 'azpr-quick-rating', 'azpr-quick-reviewer']);
  for (const role of ['azpr-quick-reviewer', 'azpr-quick-dedupe', 'azpr-quick-rating', 'azpr-quick-comment-plan']) assert.deepEqual(fullAgents[role].model, { providerID: 'other', id: 'quick', variant: 'high' }, role);
  const all = input();
  for (const mode of MODES) all.models[mode] = { reviewers: ['p/a', 'p/b', 'p/c', 'p/d'] };
  assert.deepEqual(Object.keys(buildAgents(validateSettings(all), prompts)).sort(), Object.keys(ROLES).sort(), 'Every role exists once every mode has four reviewers.');
  assert.equal(Object.keys(ROLES).length, 23);
  assert.throws(() => validateSettings({ ...input(), models: { ...input().models, quick: { reviewers: ['YOUR_PROVIDER/YOUR_MODEL'] } } }), /models\.quick\.reviewers\[0\]: select an actual provider\/model ID/);
  assert.deepEqual(buildAgents(validateSettings({ ...input(), enabled: false }), prompts), {});
  // The roles of the 0.4.x pipeline are no roles any more, and stay AZPR's own names: a session that a saved
  // review still names is never taken for an ordinary one.
  for (const name of ['azpr-review-functional', 'azpr-review-risk', 'azpr-review-verifier', 'azpr-deep-functional', 'azpr-deep-risk', 'azpr-deep-verifier']) {
    assert.equal(privateAgent(name), true, name);
    assert.equal(Object.hasOwn(ROLES, name), false, name);
    assert.deepEqual(allowedTools(name, 'inherit'), [], `${name}: no tools`);
  }
  for (const name of Object.keys(ROLES)) assert.equal(privateAgent(name), true, name);
  for (const name of ['build', 'azpr-quick-verifier', 'azpr-quick-functional', 'azpr-quick-comment-plan-verified', 'azpr-review', 'azpr-review-reviewere', '', null, undefined, 7, ['azpr-review-reviewer']]) {
    assert.equal(privateAgent(name), false, String(name));
  }
});

test('prompts: the review roles stay byte-identical; every mode runs them and differs only in its models; none claims a verification', async () => {
  const { createHash } = await import('node:crypto');
  const sha = value => createHash('sha256').update(value).digest('hex');
  // System prompts of the review roles as of 0.5.0, which replaced the two reviewer roles, the verifier and
  // the quick reviewer of 0.4.x with one reviewer prompt for every pass of every mode: the reviewer checks
  // each finding against the source itself, since no later stage does; the duplicate check compares the
  // findings that different sessions reported in one file on one side of the change, and learned that the
  // same kind of mistake at several places is several findings; the rating reads findings that their own
  // reviewer checked. The shared rules lost the passages that described the verifier. The comment planner
  // has two wordings: "reviewers" for the reviews of this pipeline, and "verified"
  // (azpr-<mode>-comment-plan-verified) for the reviews that 0.4.x saved with a verifier's findings, whose
  // wording is the one 0.4.6 had: its two hashes below are those of 0.4.6's azpr-review-comment-plan.
  // Changing a review prompt is a deliberate change: update these together with the validation notes.
  // Every reviewer position, and every mode, runs the same prompts with other models.
  const golden = {
    'deny/en/azpr-review-reviewer': '8fff0584f54187d55b8ba1e337009e91807ff45d9436d544bc53421ae0ae3a75',
    'deny/en/azpr-review-dedupe': 'b61aa336297c11362a7b5f558d116dcdd630b9c3c83578186fc2debb808f1444',
    'deny/en/azpr-review-rating': '8ae16562ad909c05da4f9bc5e1645b6dadf4d7b50c7c3004045a6708b9e5f33a',
    'deny/en/azpr-review-comment-plan': '3f1ed96428f9d81c051540771ab8aa0ead219c917270847d667b7fc87407aa6f',
    'deny/en/azpr-review-comment-plan-verified': 'd725b456618e26cc1140f8997f9db36cfb8e20add65c533151da54ba6b46fc15',
    'ask/zh-TW/azpr-review-reviewer': '2ab429cb47a2af7320ac64fd7de338fb01a3e58447b104ad6cf10efc81ca7fd5',
    'ask/zh-TW/azpr-review-dedupe': '030d6480e943afbdc752c011a9131b7a8d8ff58fceeddcacb19abd7434d4008c',
    'ask/zh-TW/azpr-review-rating': 'cc2d48da260a15d65df77d24f283f0cc31b280aaab29e261c73c8ff4ab9d70a8',
    'ask/zh-TW/azpr-review-comment-plan': 'a5614d5b7b902d31141466b755403e33de7b641bbccf851b83b4640d7beb2387',
    'ask/zh-TW/azpr-review-comment-plan-verified': 'f0393eeddb2dd8fd54beea3adcb6dfa74c499922f24129487aa138abeeb552ea',
  };
  const models = { review: { reviewers: ['p/a', 'p/b', 'p/c', 'p/d'], rater: 'p/x' }, deep: { reviewers: ['p/da', 'p/db', 'p/dc', 'p/dd'], rater: 'p/dx' },
    quick: { reviewers: ['p/qa', 'p/qb', 'p/qc', 'p/qd'], rater: 'p/qx' } };
  const later = /-reviewer[bcd]$/;
  for (const [shell, outputLanguage] of [['deny', 'en'], ['ask', 'zh-TW']]) {
    const agents = buildAgents(validateSettings({ version: 3, models, azure: { organization: 'org', pat: 'x'.repeat(52) }, shell, outputLanguage }), prompts);
    assert.deepEqual(Object.keys(agents).sort(), Object.keys(ROLES).sort());
    assert.deepEqual(Object.keys(agents).filter(role => role.startsWith('azpr-review-') && !later.test(role)).map(role => `${shell}/${outputLanguage}/${role}`).sort(),
      Object.keys(golden).filter(key => key.startsWith(`${shell}/${outputLanguage}/`)).sort(), 'Every review role is hash-locked.');
    for (const [role, agent] of Object.entries(agents)) {
      assert.doesNotMatch(agent.system, /<!-- azpr:/, `${role}: variant markers are removed`);
      // Nothing verifies a finding after its reviewer, so no prompt says that something did. Only the planner of
      // the reviews 0.4.x saved speaks of a verifier's findings.
      if (ROLES[role].variant === 'verified') assert.match(agent.system, /The supplied findings are the verifier's corrected findings/, role);
      else assert.doesNotMatch(agent.system, /\bverified\b|\bconfirmed\b|already merged|corrected findings|verifier's|verifier will|disposition reasons/i, role);
      assert.equal(promptVariant(role), ROLES[role].stage === 'comment-plan-verified' ? 'verified' : 'reviewers', role);
      if (later.test(role)) {
        // Every pass runs the first pass's prompt: the passes differ in their models only.
        const first = agents[role.replace(later, '-reviewer')];
        assert.equal(agent.system, first.system, role);
        assert.deepEqual(agent.permissions, first.permissions, role);
        assert.notDeepEqual(agent.model, first.model, role);
        continue;
      }
      if (!role.startsWith('azpr-review-')) {
        // Deep and quick differ from review in their models only.
        const review = agents[role.replace(/^azpr-(?:deep|quick)-/, 'azpr-review-')];
        assert.equal(agent.system, review.system, role);
        assert.deepEqual(agent.permissions, review.permissions, role);
        assert.notDeepEqual(agent.model, review.model, role);
        continue;
      }
      assert.equal(sha(agent.system), golden[`${shell}/${outputLanguage}/${role}`], `${shell}/${outputLanguage}/${role}`);
    }
  }
  const agents = buildAgents(validateSettings({ version: 3, models, azure: { organization: 'org', pat: 'x'.repeat(52) } }), prompts);
  // A reviewer knows that nothing checks its findings afterwards, and checks them against the source itself.
  assert.match(agents['azpr-review-reviewer'].system, /no verifier checks your findings afterwards/);
  assert.match(agents['azpr-review-reviewer'].system, /\n## Check each finding yourself\n[\s\S]*thinking it over again is not a check/);
  // It files a defect it reaches in another changed file at that file's defective lines.
  assert.match(agents['azpr-review-reviewer'].system, /on the defective lines[\s\S]*also when they are in\s+another changed file or in unchanged code/);
  assert.doesNotMatch(agents['azpr-review-reviewer'].system, /other changed files are context only/);
  // The duplicate check merges only across sessions, and keeps the same kind of mistake at several places apart.
  assert.match(agents['azpr-review-dedupe'].system, /The same kind of mistake made at several places,\s+each needing its own change, is several findings/);
  assert.match(agents['azpr-review-dedupe'].system, /Merge only findings of different sessions/);
  // The planners say where their findings come from, each in its own wording.
  assert.match(agents['azpr-review-comment-plan'].system, /no separate verification re-checked them/);
  assert.match(agents['azpr-review-comment-plan'].system, /A finding with\s+`"inline": false` has no location that can carry an inline comment/);
  assert.doesNotMatch(agents['azpr-review-comment-plan-verified'].system, /no separate verification|has no location that can carry an inline comment/);
  assert.match(agents['azpr-review-comment-plan-verified'].system, /The verifier already merged duplicate findings/);
  // Combining what two sessions reported twice is offered only where the input lists candidates (reviews saved by a 0.4.x quick run).
  assert.match(agents['azpr-review-comment-plan'].system, /Where the input has `mergeCandidates`[\s\S]*findingIds[\s\S]*mergeReason[\s\S]*when unsure, comment on each finding separately/);
  assert.doesNotMatch(agents['azpr-review-comment-plan-verified'].system, /mergeCandidates/);
});

test('models.<mode>.rater: "" lets the first reviewer model rate, a model names the rater, false turns the rating off', () => {
  const base = validateSettings(input());
  assert.equal(base.models.review.rater, '');
  assert.equal(raterState(base, 'review'), 'first');
  assert.equal(stageModel(base, 'azpr-review-rating'), 'provider/family/first', 'No rater named: the first reviewer model rates.');
  assert.deepEqual(buildAgents(base, prompts)['azpr-review-rating'].model, { providerID: 'provider', id: 'family/first' });
  const chosen = input();
  chosen.models.review.rater = 'strong/rater#high';
  const settings = validateSettings(chosen);
  assert.equal(raterState(settings, 'review'), 'named');
  assert.equal(stageModel(settings, 'azpr-review-rating'), 'strong/rater#high');
  const agents = buildAgents(settings, prompts);
  assert.deepEqual(agents['azpr-review-rating'].model, { providerID: 'strong', id: 'rater', variant: 'high' });
  for (const stage of ['reviewer', 'dedupe', 'comment-plan', 'comment-plan-verified']) assert.deepEqual(agents[`azpr-review-${stage}`].model, { providerID: 'provider', id: 'family/first' }, `${stage}: only the rating uses the rater.`);
  // false: no rating session and no rating role; the other roles are as they were.
  const off = input();
  off.models.review.rater = false;
  const offSettings = validateSettings(off);
  assert.equal(offSettings.models.review.rater, false);
  assert.equal(raterState(offSettings, 'review'), 'off');
  assert.equal(stageModel(offSettings, 'azpr-review-rating'), '');
  const offAgents = buildAgents(offSettings, prompts);
  assert.deepEqual(Object.keys(offAgents).sort(), Object.keys(buildAgents(base, prompts)).filter(role => role !== 'azpr-review-rating').sort(), 'No rating role is registered where the rating is off.');
  // A rater turns no mode on, and every mode rates by its own setting, never by another mode's.
  const raterOnly = input();
  raterOnly.models.deep = { rater: 'strong/rater' };
  assert.equal(modeReady(validateSettings(raterOnly), 'deep'), false);
  assert.equal(stageModel(validateSettings(raterOnly), 'azpr-deep-rating'), 'strong/rater');
  assert.equal(Object.keys(buildAgents(validateSettings(raterOnly), prompts)).some(role => role.startsWith('azpr-deep-')), false, 'A mode without reviewers has no role, also no rating.');
  const deep = input();
  deep.models.review.rater = 'strong/rater';
  deep.models.deep = { reviewers: ['other/deep-a', 'other/deep-b'] };
  deep.models.quick = { reviewers: ['other/quick'], rater: false };
  const deepSettings = validateSettings(deep);
  assert.deepEqual(MODES.map(mode => raterState(deepSettings, mode)), ['named', 'first', 'off']);
  assert.equal(stageModel(deepSettings, 'azpr-deep-rating'), 'other/deep-a', 'Deep rates with its own first reviewer model, never with the review rater.');
  const deepAgents = buildAgents(deepSettings, prompts);
  assert.deepEqual(['azpr-review-rating', 'azpr-deep-rating', 'azpr-quick-rating'].map(role => deepAgents[role]?.model), [{ providerID: 'strong', id: 'rater' }, { providerID: 'other', id: 'deep-a' }, undefined]);
  deep.models.quick.rater = 'other/quick-rater';
  assert.deepEqual(buildAgents(validateSettings(deep), prompts)['azpr-quick-rating'].model, { providerID: 'other', id: 'quick-rater' });
  const withRater = rater => ({ ...input(), models: { ...input().models, review: { ...input().models.review, rater } } });
  for (const rater of ['YOUR_PROVIDER/YOUR_MODEL', 'off', 'none', 'no']) assert.throws(() => validateSettings(withRater(rater)), /^Error: models\.review\.rater: select an actual provider\/model ID/, rater);
  for (const rater of [7, true, null, ['p/r'], { model: 'p/r' }]) {
    assert.throws(() => validateSettings(withRater(rater)), /^Error: models\.review\.rater must be "" \(the first reviewer model rates\), a provider\/model ID, or false \(no severity rating\)\.$/, JSON.stringify(rater));
  }
  for (const mode of MODES) {
    // A string or false, as validation takes it: true is no rater.
    assert.deepEqual(schema.properties.models.properties[mode].properties.rater.anyOf, [{ type: 'string' }, { const: false }], mode);
    assert.equal(schema.properties.models.properties[mode].properties.rater.default, '', mode);
    assert.equal(example.models[mode].rater, '', `${mode}: the example leaves the rating to the first reviewer model`);
    assert.equal((schema.properties.models.properties[mode].required ?? []).includes('rater'), false, mode);
  }
});

test('prompt variants keep shared lines and refuse malformed blocks', async () => {
  const { selectVariant } = await import('../src/config.mjs');
  const text = 'a\n<!-- azpr:verified -->\nv1\n<!-- azpr:reviewers -->\nr1\n<!-- azpr:end -->\nb\n';
  assert.equal(selectVariant(text, 'verified'), 'a\nv1\nb\n');
  assert.equal(selectVariant(text, 'reviewers'), 'a\nr1\nb\n');
  assert.equal(selectVariant('<!-- azpr:reviewers -->\nonly reviewers\n<!-- azpr:end -->\nshared', 'verified'), 'shared');
  // The marker of 0.4.x is no marker: a prompt that still carries it keeps the line, which the hash lock would show.
  assert.equal(selectVariant('<!-- azpr:quick -->\nshared', 'reviewers'), '<!-- azpr:quick -->\nshared');
  assert.throws(() => selectVariant('<!-- azpr:reviewers -->\nopen', 'reviewers', 'x'), /Unterminated variant block in x\.md/);
  assert.throws(() => selectVariant('<!-- azpr:end -->', 'reviewers', 'x'), /end without a start/);
  assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, common: prompts.common + '\n<!-- azpr:reviewers -->\n' }), /Unterminated variant block in common\.md/);
  // Only the two comment prompts have two wordings; a reviewer, the duplicate check and the rating have one.
  for (const name of PROMPTS) assert.equal(/<!-- azpr:/.test(prompts[name]), ['comment-policy', 'comment-plan'].includes(name), name);
  assert.deepEqual([...PROMPTS].sort(), ['comment-plan', 'comment-policy', 'common', 'dedupe', 'rating', 'review']);
});

test('tools: an explicit allowlist of AZPR and read tools; denied natives and shell per setting', () => {
  for (const name of ['execute', 'edit', 'write', 'patch', 'skill', 'subagent', 'webfetch', 'websearch', 'question', 'opencode_session_rename', 'opencode_session_move', 'opencode_models']) {
    assert.ok(BLOCKED_NATIVE_TOOLS.includes(name), name);
  }
  for (const name of ['read', 'glob', 'grep', 'shell']) assert.equal(Object.hasOwn(NATIVE_TOOL_PERMISSIONS, name), false, name);
  assert.equal(nativeToolPermissions('azpr-review-reviewerb', 'deny').shell, 'deny');
  assert.equal(nativeToolPermissions('azpr-review-reviewerb', 'ask').shell, 'ask');
  assert.equal(Object.hasOwn(nativeToolPermissions('azpr-review-reviewerb', 'inherit'), 'shell'), false);
  for (const role of Object.keys(ROLES).filter(role => ROLES[role].tools !== false)) {
    assert.deepEqual(allowedTools(role, 'deny'), ['azpr_read_diff', 'azpr_read_file', 'azpr_search_code', 'azpr_find_files', 'azpr_list_files', 'azpr_pr_threads', 'read', 'glob', 'grep'], role);
  }
  assert.ok(allowedTools('azpr-deep-comment-plan', 'ask').includes('shell'));
  assert.deepEqual(allowedTools('build', 'inherit'), [], 'Ordinary agents are not governed by AZPR.');
  for (const name of [...BLOCKED_NATIVE_TOOLS, 'ado_repo_file', 'repo_pull_request_thread_write']) assert.equal(allowedTools('azpr-review-reviewerb', 'inherit').includes(name), false, name);
  // The rating role reads only the finding text in its input: no tool at all, whatever the shell setting.
  assert.deepEqual(Object.keys(ROLES).filter(role => ROLES[role].tools === false).sort(), ['azpr-deep-rating', 'azpr-quick-rating', 'azpr-review-rating']);
  for (const shell of ['deny', 'ask', 'inherit']) {
    for (const mode of MODES) {
      assert.deepEqual(allowedTools(`azpr-${mode}-rating`, shell), [], `${mode} ${shell}`);
      assert.equal(nativeToolPermissions(`azpr-${mode}-rating`, shell).shell, 'deny', `${mode} ${shell}`);
    }
  }
  const agents = buildAgents(validateSettings({ ...input(), shell: 'ask' }), prompts);
  assert.ok(Object.hasOwn(agents, 'azpr-review-rating'));
  for (const [role, agent] of Object.entries(agents)) {
    assert.equal(agent.permissions.some(rule => rule.action === '*' || rule.effect === 'allow'), false, role);
    assert.deepEqual(agent.permissions.find(rule => rule.action === 'shell'), { action: 'shell', resource: '*', effect: ROLES[role].tools === false ? 'deny' : 'ask' });
  }
});

test('prompts: one JSON transport, shared tool policy, shell guidance and language routing', () => {
  const agents = buildAgents(validateSettings({ ...input(), outputLanguage: 'zh-TW' }), prompts);
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
      assert.match(agent.system, /Write each reason and the report in this language\./, role);
      continue;
    }
    assert.match(agent.system, /Read the PR repository with AZPR's tools \(azpr_\*\)/);
    assert.match(agent.system, /the runtime alone posts comments/);
    assert.match(agent.system, /never the PR repository/);
    assert.match(agent.system, /Shell is unavailable in this session/);
    // Each kind of role is told which of its texts are in the output language.
    assert.match(agent.system, ROLES[role].comment ? /Write comment titles, explanations, skip reasons and summary prose in this language\./
      : ROLES[role].format === 'dedupe' ? /Write each reason and the report in this language\./
        : /Write human-readable finding fields \(summary, evidence, counterevidence, suggestion\) and the report in this language\./, role);
  }
  assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, common: prompts.common.replace('## Severity', '## Levels') }), /common\.md has no "## Severity" section/);
  assert.match(agents['azpr-review-reviewer'].system, /^# Private Azure PR review rules\n/);
  assert.match(agents['azpr-review-comment-plan'].system, /^# Azure PR comment policy\n/);
  assert.match(agents['azpr-review-reviewer'].system, /\n# Role: reviewer\n[\s\S]*counterevidence/);
  assert.match(agents['azpr-review-dedupe'].system, /\n# Role: duplicate check\n/);
  assert.match(agents['azpr-review-comment-plan'].system, /azprData/);
  const shellAllowed = buildAgents(validateSettings({ ...input(), shell: 'inherit' }), prompts);
  assert.match(shellAllowed['azpr-review-reviewerb'].system, /Shell may be available under OpenCode permissions/);
  for (const name of PROMPTS) assert.throws(() => buildAgents(validateSettings(input()), { ...prompts, [name]: ' ' }), /Missing or empty prompt/);
});

test('trimmed role instructions stay compact', () => {
  // A guard against prompt growth, not a model limit: the shared severity scale
  // (0.3.5) added about 2,300 characters to every review role; 0.3.7 added about
  // 1,100 to the shared rules. 0.5.0 has one reviewer prompt, which states the reviewer's own check.
  const all = input();
  for (const mode of MODES) all.models[mode] = { reviewers: ['p/a', 'p/b', 'p/c', 'p/d'] };
  const agents = buildAgents(validateSettings(all), prompts);
  assert.equal(Object.keys(agents).length, Object.keys(ROLES).length);
  for (const [role, agent] of Object.entries(agents)) assert.ok(agent.system.length < 18500, `${role}: ${agent.system.length}`);
  for (const mode of MODES) assert.ok(agents[`azpr-${mode}-rating`].system.length < 6000, 'The rating role carries only its own text and the severity rules.');
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
