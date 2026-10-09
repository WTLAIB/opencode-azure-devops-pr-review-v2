// Real shell operations in disposable directories; no live models or Azure calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, rmSync, chmodSync, statSync, lstatSync, symlinkSync, renameSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROMPTS } from '../src/config.mjs';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = 'plugins/azpr-v2';
const TEAM_PAT = 'team-private-pat-0123456789abcdef';
const requiredFiles = [
  'install.sh', 'scripts/merge-settings.py', 'config/settings.example.json',
  ...['plugin.js', 'session.mjs', 'runtime.mjs', 'config.mjs', 'output.mjs', 'comments.mjs', 'comment-data.mjs', 'comment-work.mjs', 'diagnostics.mjs', 'attribution.mjs',
    'host.mjs', 'tool-queue.mjs', 'azure.mjs', 'review-tools.mjs', 'review-work.mjs', 'store.mjs'].map(name => 'src/' + name),
  ...['common', 'functional', 'risk', 'deep', 'final', 'comment-policy', 'comment-plan'].map(name => 'src/prompts/' + name + '.md'),
];
const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const temp = mkdtempSync(join(tmpdir(), 'azpr-v2-install-'));
  roots.push(temp);
  const root = join(temp, 'config space', 'opencode');
  mkdirSync(root, { recursive: true });
  const config = JSON.stringify({
    model: 'original/developer',
    agent: { build: { model: 'original/build' }, plan: { model: 'original/plan' } },
    mcp: { servers: { ado: { type: 'local', command: ['existing-server'], codemode: false } } },
    permission: { bash: 'ask' },
  });
  writeFileSync(join(root, 'opencode.json'), config);
  mkdirSync(join(root, 'plugins'));
  writeFileSync(join(root, 'plugins/another.js'), 'export default { id: "another", setup() {} };\n');
  mkdirSync(join(root, 'commands'));
  writeFileSync(join(root, 'commands/my-command.md'), 'Original command\n');
  return { temp, root, config };
}
function run(file, args = [], extra = {}) {
  return spawnSync('/bin/sh', [file, ...args], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env }, ...extra,
  });
}
function install(s, args = [], extra = {}) {
  return run(join(s.source ?? pkg, 'install.sh'), ['--config-dir', s.root, ...args], extra);
}
function uninstall(s, args = [], extra = {}) {
  return run(join(pkg, 'uninstall.sh'), ['--config-dir', s.root, ...args], extra);
}
function minimalSource(s) {
  s.source = join(s.temp, 'manual source');
  for (const file of requiredFiles) {
    mkdirSync(dirname(join(s.source, file)), { recursive: true });
    cpSync(join(pkg, file), join(s.source, file));
  }
}
async function installedAgents(s) {
  const { validateSettings, buildAgents, PROMPTS: names } = await import(pathToFileURL(join(s.root, destination, 'config.mjs')).href);
  const settings = validateSettings(JSON.parse(readFileSync(join(s.root, destination, 'settings.json'), 'utf8')));
  const prompts = Object.fromEntries(names.map(name => [name, readFileSync(join(s.root, destination, 'prompts', name + '.md'), 'utf8')]));
  const agents = buildAgents(settings, prompts);
  assert.equal(Object.keys(agents).length, 8);
  return agents;
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? '')); }
function bad(result) { assert.notEqual(result.status, 0); }
function original(s) {
  assert.equal(readFileSync(join(s.root, 'opencode.json'), 'utf8'), s.config);
  assert.equal(readFileSync(join(s.root, 'plugins/another.js'), 'utf8'), 'export default { id: "another", setup() {} };\n');
  assert.equal(readFileSync(join(s.root, 'commands/my-command.md'), 'utf8'), 'Original command\n');
}
function clean(s) { assert.ok(!readdirSync(s.root).some(name => name.startsWith('.azpr-'))); }
function profile(s) {
  const settings = JSON.parse(readFileSync(join(pkg, 'config/settings.example.json'), 'utf8'));
  Object.assign(settings.models.review, { functional: 'team/functional', risk: 'team/risk', verifier: 'team/verifier' });
  Object.assign(settings.models.deep, { functional: 'team/deep-functional', risk: 'team/deep-risk', verifier: 'team/deep-verifier' });
  Object.assign(settings.azure, { organization: 'team', pat: TEAM_PAT });
  const file = join(s.temp, 'team.json');
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}
function installed(s, file) { return join(s.root, destination, file); }
function wrapper(s, content) {
  const bin = join(s.temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'mv'), content);
  chmodSync(join(bin, 'mv'), 0o755);
  return { env: { ...process.env, PATH: bin + ':' + process.env.PATH } };
}

test('manual copy list and all runtime modules and prompts match the required source package', () => {
  const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Manual copying without Git'));
  const listed = /```text\n([\s\S]*?)\n```/.exec(section)[1].trim().split('\n');
  assert.deepEqual(listed.sort(), [...requiredFiles].sort());
  const runtime = readdirSync(join(pkg, 'src')).filter(name => /\.(mjs|js|py)$/.test(name)).map(name => 'src/' + name);
  assert.deepEqual([...runtime, ...PROMPTS.map(name => 'src/prompts/' + name + '.md')].sort(), requiredFiles.filter(file => file.startsWith('src/')).sort());
  assert.ok(!existsSync(join(pkg, 'commands')));
});

test('fresh installation creates one V2 package and preserves existing configuration and unrelated files', async () => {
  const s = setup();
  ok(install(s)); original(s); clean(s);
  for (const name of ['runtime.mjs', 'session.mjs', 'plugin.js', 'comments.mjs', 'config.mjs', 'settings.schema.json', 'README.md', 'docs/ARCHITECTURE.md', 'uninstall.sh']) {
    assert.ok(existsSync(installed(s, name)), name);
  }
  assert.deepEqual(JSON.parse(readFileSync(installed(s, 'package.json'), 'utf8')), { type: 'module', exports: './server.js', private: true });
  const { default: plugin } = await import(pathToFileURL(installed(s, 'plugin.js')).href);
  assert.equal(plugin.id, 'azpr');
  assert.equal(typeof plugin.setup, 'function');
  assert.deepEqual(readdirSync(join(s.root, 'plugins')).sort(), ['another.js', 'azpr-v2']);
  assert.deepEqual(readdirSync(join(s.root, 'commands')), ['my-command.md']);
  for (const name of ['azpr', 'skills', 'agents', 'azpr-v2-backups']) assert.ok(!existsSync(join(s.root, name)));
  assert.equal(statSync(installed(s, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8')).models, '_help'), false);
});

// OpenCode 2.0.22 Host.resolve resolves local <directory>/server before index;
// a package's exports field alone does not select its local directory entry.
async function loadDirectoryEntry(s) {
  const entry = createRequire(import.meta.url).resolve(installed(s, 'server'));
  const loaded = await import(pathToFileURL(entry).href);
  const original = await import(pathToFileURL(installed(s, 'plugin.js')).href);
  assert.equal(loaded.default, original.default);
  assert.equal(loaded.default.id, 'azpr');
  assert.equal(typeof loaded.default.setup, 'function');
  assert.ok(lstatSync(installed(s, 'server.js')).isFile(), 'The installer owns a regular entry file, not a workaround symlink.');
  return entry;
}

test('local directory entry resolves and loads from a minimal fresh install', async () => {
  const s = setup(); minimalSource(s);
  ok(install(s, ['--settings', profile(s)]));
  await loadDirectoryEntry(s);
  assert.equal(readdirSync(installed(s, '')).length, 20); // 16 JS modules + entry + metadata + settings + prompts
  original(s); clean(s);
});

test('replacement repairs an exports-only package without changing private settings', async () => {
  const s = setup(); ok(install(s, ['--settings', profile(s)]));
  rmSync(installed(s, 'server.js'), { force: true });
  writeFileSync(installed(s, 'package.json'), JSON.stringify({ type: 'module', exports: './plugin.js', private: true }));
  const settings = readFileSync(installed(s, 'settings.json'));
  ok(install(s, ['--replace']));
  await loadDirectoryEntry(s);
  assert.deepEqual(readFileSync(installed(s, 'settings.json')), settings);
  original(s); clean(s);
});

test('replacement replaces the temporary entry symlink with a generated regular file', async () => {
  const s = setup(); ok(install(s, ['--settings', profile(s)]));
  rmSync(installed(s, 'server.js'), { force: true });
  symlinkSync('plugin.js', installed(s, 'server.js'));
  const settings = readFileSync(installed(s, 'settings.json'));
  ok(install(s, ['--replace']));
  await loadDirectoryEntry(s);
  assert.deepEqual(readFileSync(installed(s, 'settings.json')), settings);
  original(s); clean(s);
});

test('26-file manual source package installs and compiles every role without optional files or npm', async () => {
  const s = setup(); minimalSource(s); assert.equal(requiredFiles.length, 26);
  ok(install(s, ['--settings', profile(s)]));
  for (const name of ['README.md', 'docs', 'uninstall.sh', 'settings.schema.json', 'node_modules']) assert.ok(!existsSync(installed(s, name)));
  const agents = await installedAgents(s);
  assert.deepEqual(agents['azpr-review-functional'].model, { providerID: 'team', id: 'functional' });
  assert.deepEqual(agents['azpr-deep-verifier'].model, { providerID: 'team', id: 'deep-verifier' });
  const before = readFileSync(installed(s, 'settings.json'), 'utf8');
  ok(install(s, ['--replace']));
  assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), before);
  original(s); clean(s);
});

test('every required module, prompt, or settings helper is checked before replacement', () => {
  const s = setup(); ok(install(s, ['--settings', profile(s)])); minimalSource(s);
  const paths = ['settings.json', 'runtime.mjs', 'plugin.js', 'package.json'];
  const before = paths.map(path => readFileSync(installed(s, path), 'utf8'));
  for (const file of requiredFiles.filter(file => file !== 'install.sh')) {
    const path = join(s.source, file); renameSync(path, path + '.held');
    try {
      const result = install(s, ['--replace']); bad(result);
      assert.ok(result.stderr.includes(file + ' is missing or unreadable'));
      assert.deepEqual(paths.map(path => readFileSync(installed(s, path), 'utf8')), before);
      clean(s);
    } finally { renameSync(path + '.held', path); }
  }
  original(s);
});

test('a stale settings example cannot reintroduce removed settings into a current profile', () => {
  const s = setup(), file = profile(s); ok(install(s, ['--settings', file])); minimalSource(s);
  const before = readFileSync(installed(s, 'settings.json'), 'utf8');
  const defaultsPath = join(s.source, 'config/settings.example.json');
  const defaults = JSON.parse(readFileSync(defaultsPath, 'utf8')); defaults.structuredOutput = true;
  writeFileSync(defaultsPath, JSON.stringify(defaults));
  const result = install(s, ['--replace', '--settings', file]); bad(result);
  assert.match(result.stderr, /current version-2 nested model layout/);
  assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), before); original(s); clean(s);
});

test('optional copy failures warn without preventing a valid source installation', async () => {
  const s = setup(), bin = join(s.temp, 'optional-copy-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cp'), '#!/bin/sh\ncase "$*" in */README.md*|*/docs*|*/uninstall.sh*|*/settings.schema.json*) exit 71;; esac\nexec /bin/cp "$@"\n');
  chmodSync(join(bin, 'cp'), 0o755);
  const result = install(s, ['--settings', profile(s)], { env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
  ok(result); assert.match(result.stderr, /WARNING: Could not copy optional/);
  assert.deepEqual((await installedAgents(s))['azpr-review-risk'].model, { providerID: 'team', id: 'risk' });
  original(s); clean(s);
});

test('duplicate installation refuses without explicit replacement', () => {
  const s = setup(); ok(install(s));
  const before = readFileSync(installed(s, 'settings.json'), 'utf8');
  bad(install(s)); assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), before);
  original(s); clean(s);
});

test('replacement preserves chosen model mappings, language and bytes without a backup', async () => {
  const s = setup(), file = profile(s), settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.outputLanguage = 'zh-TW';
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  ok(install(s, ['--settings', file])); ok(install(s, ['--replace']));
  assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), readFileSync(file, 'utf8'));
  assert.ok(!existsSync(join(s.root, 'azpr-v2-backups')));
  const agents = await installedAgents(s);
  assert.match(agents['azpr-review-verifier'].system, /outputLanguage: zh-TW/);
  for (const role of ['functional', 'risk', 'verifier']) assert.deepEqual(agents['azpr-review-' + role].permissions.find(rule => rule.action === 'shell'), { action: 'shell', resource: '*', effect: 'deny' });
  original(s); clean(s);
});

test('explicit current-layout settings replace the installed model mapping without changing the source', () => {
  const s = setup(); ok(install(s)); const file = profile(s), raw = readFileSync(file, 'utf8');
  ok(install(s, ['--replace', '--settings', file]));
  assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), raw);
  assert.equal(readFileSync(file, 'utf8'), raw);
  original(s); clean(s);
});

test('installation omits only legacy help from supplied and replacement settings, including stale defaults', async () => {
  const s=setup(), file=profile(s), settings=JSON.parse(readFileSync(file,'utf8'));
  settings.models._help={functional:'PRIVATE_HELP_TEXT',risk:'Risk documentation',verifier:'Verifier documentation'};
  settings.outputLanguage='zh-TW';settings.debug={enabled:true,directory:'private diagnostics'};settings.runTimeoutSeconds=2400;
  const raw=JSON.stringify(settings,null,2)+'\n';writeFileSync(file,raw);
  minimalSource(s);
  const defaultsPath=join(s.source,'config/settings.example.json');
  const defaults=JSON.parse(readFileSync(defaultsPath,'utf8'));defaults.models._help=settings.models._help;
  const defaultsRaw=JSON.stringify(defaults);writeFileSync(defaultsPath,defaultsRaw);
  const expected=structuredClone(settings);delete expected.models._help;
  for(const replacing of [false,true]) {
    if(replacing) writeFileSync(installed(s,'settings.json'),raw);
    const result=install(s,replacing?['--replace']:['--settings',file]);ok(result);
    assert.match(result.stdout,/Removed documentation-only models\._help/);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_HELP_TEXT|team\/|private diagnostics|team-private-pat/);
    assert.deepEqual(JSON.parse(readFileSync(installed(s,'settings.json'),'utf8')),expected);
    assert.equal(readFileSync(file,'utf8'),raw);assert.equal(readFileSync(defaultsPath,'utf8'),defaultsRaw);
    assert.equal(statSync(installed(s,'settings.json')).mode & 0o777,0o600);
    const agents=await installedAgents(s);
    assert.deepEqual(agents['azpr-review-risk'].model,{providerID:'team',id:'risk'});
    assert.match(agents['azpr-review-verifier'].system,/outputLanguage: zh-TW/);
    original(s);clean(s);
  }
  const cleanBytes=readFileSync(installed(s,'settings.json'),'utf8');
  const result=install(s,['--replace']);ok(result);
  assert.doesNotMatch(result.stdout,/Removed documentation-only/);
  assert.equal(readFileSync(installed(s,'settings.json'),'utf8'),cleanBytes);
  original(s);clean(s);
});

test('malformed legacy help is preserved instead of discarding unrecognized settings data', () => {
  const s=setup(), file=profile(s);ok(install(s,['--settings',file]));
  const baseline=JSON.parse(readFileSync(file,'utf8'));
  for(const help of [null,[],42,{risk:false},{unknown:'PRIVATE_HELP_VALUE'}]) {
    const settings=structuredClone(baseline);settings.models._help=help;
    const raw=JSON.stringify(settings);writeFileSync(installed(s,'settings.json'),raw);
    const result=install(s,['--replace']);bad(result);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_HELP_VALUE/);
    assert.equal(readFileSync(installed(s,'settings.json'),'utf8'),raw);
    original(s);clean(s);
  }
});

test('current partial settings merge only missing defaults and preserve existing values', () => {
  const s = setup(), file = join(s.temp, 'partial.json');
  const partial = { version: 2, models: { review: { functional: 'team/new' } }, outputLanguage: 'zh-TW', enabled: false, debug: { enabled: true }, custom: { array: [1, 2], value: null } };
  const raw = JSON.stringify(partial); writeFileSync(file, raw);
  const result = install(s, ['--settings', file]); ok(result);
  assert.doesNotMatch(result.stdout + result.stderr, /team\/new/);
  const merged = JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8'));
  assert.equal(merged.models.review.functional, 'team/new');
  assert.deepEqual(merged.debug, { enabled: true, directory: '' });
  for(const key of ['comments','auxiliaryModels','outputRetries']) assert.equal(Object.hasOwn(merged,key),false);
  for (const key of ['enabled', 'outputLanguage', 'custom']) assert.deepEqual(merged[key], partial[key]);
  assert.equal(merged.runTimeoutSeconds, null);
  assert.equal(readFileSync(file, 'utf8'), raw);
  original(s); clean(s);
});

for (const value of [undefined, null, 2400]) test(`current profile preserves timeout intent: ${value}`, () => {
  const s = setup(), file = profile(s), settings = JSON.parse(readFileSync(file, 'utf8'));
  if (value === undefined) delete settings.runTimeoutSeconds; else settings.runTimeoutSeconds = value;
  writeFileSync(file, JSON.stringify(settings));
  ok(install(s, ['--settings', file]));
  assert.equal(JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8')).runTimeoutSeconds, value ?? null);
  const once = readFileSync(installed(s, 'settings.json'), 'utf8');
  ok(install(s, ['--replace'])); assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), once);
  original(s); clean(s);
});

for (const raw of ['{"private":"DO_NOT_PRINT",}', '{"version":2,"version":2}', '{"models":{"review":{},"review":{}}}', '[]', 'null', '{"value":NaN}', '{"value":1e999}']) {
  test(`invalid JSON settings fail before replacing installed files: ${raw}`, () => {
    const s = setup(); ok(install(s)); const file = installed(s, 'settings.json'); writeFileSync(file, raw);
    const before = readFileSync(installed(s, 'runtime.mjs'), 'utf8');
    const result = install(s, ['--replace']); bad(result); assert.match(result.stderr, /valid JSON objects/);
    assert.doesNotMatch(result.stderr, /DO_NOT_PRINT/);
    assert.equal(readFileSync(file, 'utf8'), raw); assert.equal(readFileSync(installed(s, 'runtime.mjs'), 'utf8'), before);
    original(s); clean(s);
  });
}

for (const invalid of [
  { version: 1 }, { version: 3 }, { version: true }, { version: '2' },
  { models: { freeA: 'private/old' } }, { version: 2, models: { freeB: 'private/old' } },
  { version: 2, models: { deep: 'private/old' } }, { models: null },
  { steps: { initial: 60 } }, { maxStageCharacters: null }, { structuredOutput: false }, { mcp: 'legacy' }, { azure: 'legacy' },
  { comments: { enabled: false, maxComments: 5 } }, { auxiliaryModels: "preserve" }, { outputRetries: 0 },
]) test(`removed settings and V1 profiles are rejected without migration: ${JSON.stringify(invalid)}`, () => {
  const s = setup(); ok(install(s)); const file = installed(s, 'settings.json'), raw = JSON.stringify(invalid); writeFileSync(file, raw);
  const result = install(s, ['--replace']); bad(result); assert.match(result.stderr, /current version-2 nested model layout/);
  assert.doesNotMatch(result.stdout + result.stderr, /private\/old/);
  assert.equal(readFileSync(file, 'utf8'), raw); assert.ok(existsSync(installed(s, 'runtime.mjs')));
  original(s); clean(s);
});

for (const rel of ['azpr/settings.json', 'plugins/azpr/settings.json', 'plugins/azpr.js', 'plugin/azpr.js', 'plugin/azpr-v2/package.json', 'commands/pr-review.md', 'command/pr-check.md', 'agents/azpr-deep.md']) {
  test(`old or conflicting integrations are preserved even with --replace: ${rel}`, () => {
    const s = setup(), file = join(s.root, rel); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'EXISTING_PRIVATE_CONTENT');
    const result = install(s, ['--replace']); bad(result);
    assert.match(result.stderr, /Conflicting/); assert.doesNotMatch(result.stderr, /EXISTING_PRIVATE_CONTENT/);
    assert.equal(readFileSync(file, 'utf8'), 'EXISTING_PRIVATE_CONTENT');
    assert.ok(!existsSync(installed(s, 'settings.json'))); original(s); clean(s);
  });
}

test('reserved JSONC keys stop installation without editing configuration', () => {
  const s = setup(), file = join(s.root, 'opencode.jsonc');
  const content = '// User comment\n{"command":{"pr-review":{"template":"mine"}}}\n'; writeFileSync(file, content);
  bad(install(s, ['--replace'])); assert.equal(readFileSync(file, 'utf8'), content);
  original(s); clean(s);
});

for (const rel of ['plugins', destination]) test(`symlinked installation paths never change their targets: ${rel}`, () => {
  const s = setup(), external = join(s.temp, 'external'); mkdirSync(external);
  if (existsSync(join(s.root, rel))) rmSync(join(s.root, rel), { recursive: true });
  symlinkSync(external, join(s.root, rel));
  bad(install(s, ['--replace'])); assert.deepEqual(readdirSync(external), []); clean(s);
});

test('an unrelated package at the V2 destination is never replaced or archived', () => {
  const s = setup(); mkdirSync(installed(s, ''), { recursive: true });
  writeFileSync(installed(s, 'runtime.mjs'), 'ANOTHER_PACKAGE');
  bad(install(s, ['--replace'])); bad(uninstall(s, ['--apply']));
  assert.equal(readFileSync(installed(s, 'runtime.mjs'), 'utf8'), 'ANOTHER_PACKAGE'); original(s); clean(s);
});

test('V2 install lock prevents concurrent installation and removal', () => {
  const s = setup(); ok(install(s)); const lock = join(s.root, '.azpr-v2-install.lock'); mkdirSync(lock);
  bad(install(s, ['--replace'])); bad(uninstall(s, ['--apply']));
  assert.ok(existsSync(lock)); assert.ok(existsSync(installed(s, 'runtime.mjs'))); original(s);
});

test('a V1 install lock is preserved and prevents V2 installation', () => {
  const s = setup(); const lock = join(s.root, '.azpr-install.lock'); mkdirSync(lock);
  bad(install(s)); assert.ok(existsSync(lock)); assert.ok(!existsSync(installed(s, 'runtime.mjs'))); original(s);
});

test('invalid installer arguments do not install files', () => {
  const s = setup();
  for (const args of [['--settings', join(s.temp, 'missing')], ['--unknown'], ['--settings']]) bad(install(s, args));
  assert.ok(!existsSync(installed(s, 'runtime.mjs'))); original(s); clean(s);
});

test('XDG paths with spaces work and JSON strings are never executed', () => {
  const s = setup(), xdg = join(s.temp, 'XDG space'), file = join(s.temp, 'data.json');
  writeFileSync(file, JSON.stringify({ custom: '$(touch never-execute)' }));
  ok(run(join(pkg, 'install.sh'), ['--settings', file], { cwd: s.temp, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
  assert.equal(JSON.parse(readFileSync(join(xdg, 'opencode', destination, 'settings.json'), 'utf8')).custom, '$(touch never-execute)');
  assert.ok(!existsSync(join(s.temp, 'never-execute')));
});

test('failed replacement restores the original package and settings exactly', () => {
  const s = setup(); ok(install(s, ['--settings', profile(s)]));
  const settings=JSON.parse(readFileSync(installed(s,'settings.json'),'utf8'));
  settings.models._help={functional:'Legacy documentation must survive a failed replacement.'};
  writeFileSync(installed(s,'settings.json'),JSON.stringify(settings,null,2)+'\n');
  const files = ['runtime.mjs', 'settings.json', 'plugin.js', 'server.js', 'package.json'];
  const before = files.map(file => readFileSync(installed(s, file), 'utf8'));
  const extra = wrapper(s, '#!/bin/sh\ncase "$1" in --) shift;; esac\ncase "$1" in */new/plugins/azpr-v2) exit 71;; esac\nexec /bin/mv "$@"\n');
  bad(install(s, ['--replace'], extra));
  assert.deepEqual(files.map(file => readFileSync(installed(s, file), 'utf8')), before);
  original(s); clean(s);
});

test('failed automatic recovery retains the original package and prints its recovery path', () => {
  const s = setup(), file = profile(s); ok(install(s, ['--settings', file]));
  const raw = readFileSync(file, 'utf8');
  const extra = wrapper(s, '#!/bin/sh\ncase "$1" in --) shift;; esac\ncase "$1" in */new/plugins/azpr-v2|*/previous/plugins/azpr-v2) exit 71;; esac\nexec /bin/mv "$@"\n');
  const result = install(s, ['--replace'], extra); bad(result);
  const recovery = /emergency files retained: ([^\n]+)/.exec(result.stderr)?.[1]; assert.ok(recovery);
  assert.equal(readFileSync(join(recovery, 'previous', destination, 'settings.json'), 'utf8'), raw);
  assert.ok(!existsSync(join(s.root, '.azpr-v2-install.lock')));
  assert.ok(!existsSync(join(s.root, 'azpr-v2-backups'))); original(s);
});

test('missing Python stops before modifying an installed package', () => {
  const s = setup(); ok(install(s)); const before = readFileSync(installed(s, 'settings.json'), 'utf8');
  const bin = join(s.temp, 'without-python'); mkdirSync(bin); symlinkSync('/usr/bin/dirname', join(bin, 'dirname'));
  const result = install(s, ['--replace'], { env: { ...process.env, PATH: bin } }); bad(result); assert.match(result.stderr, /Python 3 is required/);
  assert.equal(readFileSync(installed(s, 'settings.json'), 'utf8'), before); original(s); clean(s);
});

test('credentials, main config backups, unrelated skills, and historical installation backups remain untouched', () => {
  const s = setup();
  const files = ['auth.json', 'opencode.json.backup', 'skills/azure-pr-review/SKILL.md', 'azpr-backups/replaced.historical/settings.json', 'azpr-v2-backups/uninstalled.historical/settings.json'];
  for (const file of files) { mkdirSync(dirname(join(s.root, file)), { recursive: true }); writeFileSync(join(s.root, file), 'DO_NOT_READ_OR_EDIT'); }
  ok(install(s)); ok(install(s, ['--replace']));
  for (const file of files) assert.equal(readFileSync(join(s.root, file), 'utf8'), 'DO_NOT_READ_OR_EDIT');
  assert.deepEqual(readdirSync(join(s.root, 'azpr-backups')), ['replaced.historical']);
  assert.deepEqual(readdirSync(join(s.root, 'azpr-v2-backups')), ['uninstalled.historical']); original(s); clean(s);
});

test('uninstall preview preserves the complete V2 package', () => {
  const s = setup(); ok(install(s)); ok(uninstall(s));
  assert.ok(existsSync(installed(s, 'runtime.mjs'))); assert.ok(!existsSync(join(s.root, 'azpr-v2-backups'))); original(s); clean(s);
});

test('explicit uninstall archives only the V2 package including private settings', () => {
  const s = setup(), file = profile(s); ok(install(s, ['--settings', file]));
  mkdirSync(join(s.root, 'plugins/azpr')); writeFileSync(join(s.root, 'plugins/azpr/settings.json'), 'OLD_PRIVATE_PROFILE');
  ok(uninstall(s, ['--apply']));
  assert.ok(!existsSync(installed(s, 'runtime.mjs')));
  const archives = readdirSync(join(s.root, 'azpr-v2-backups')); assert.equal(archives.length, 1);
  const archive = join(s.root, 'azpr-v2-backups', archives[0], destination);
  assert.equal(readFileSync(join(archive, 'settings.json'), 'utf8'), readFileSync(file, 'utf8'));
  assert.ok(statSync(join(archive, 'server.js')).isFile());
  assert.equal(readFileSync(join(s.root, 'plugins/azpr/settings.json'), 'utf8'), 'OLD_PRIVATE_PROFILE'); original(s); clean(s);
});

test('failed uninstall leaves the installed package available', () => {
  const s = setup(); ok(install(s));
  const extra = wrapper(s, '#!/bin/sh\nexit 71\n');
  bad(uninstall(s, ['--apply'], extra));
  assert.ok(existsSync(installed(s, 'settings.json'))); assert.deepEqual(readdirSync(join(s.root, 'azpr-v2-backups')), []); original(s); clean(s);
});

test('uninstall refuses a symlinked archive destination without moving the package', () => {
  const s = setup(); ok(install(s)); const external = join(s.temp, 'external'); mkdirSync(external);
  symlinkSync(external, join(s.root, 'azpr-v2-backups'));
  bad(uninstall(s, ['--apply'])); assert.ok(existsSync(installed(s, 'runtime.mjs'))); assert.deepEqual(readdirSync(external), []); original(s); clean(s);
});

test('uninstall without a V2 installation preserves old integrations and creates no archive', () => {
  const s = setup(); mkdirSync(join(s.root, 'plugins/azpr')); writeFileSync(join(s.root, 'plugins/azpr/settings.json'), 'OLD_PROFILE');
  ok(uninstall(s, ['--apply']));
  assert.equal(readFileSync(join(s.root, 'plugins/azpr/settings.json'), 'utf8'), 'OLD_PROFILE');
  assert.ok(!existsSync(join(s.root, 'azpr-v2-backups'))); original(s); clean(s);
});

test('replacement moves the retired mcp limits into azure and never prints the PAT', async () => {
  const s = setup(), file = profile(s); ok(install(s, ['--settings', file]));
  const settings = JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8'));
  delete settings.azure;
  settings.mcp = { server: 'ado', concurrency: 5, callTimeoutSeconds: 300 };
  writeFileSync(installed(s, 'settings.json'), JSON.stringify(settings, null, 2));
  const result = install(s, ['--replace']); ok(result);
  assert.match(result.stdout, /Moved mcp\.concurrency\/callTimeoutSeconds to azure/);
  const migrated = JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8'));
  assert.equal(Object.hasOwn(migrated, 'mcp'), false);
  assert.deepEqual(migrated.azure, { concurrency: 5, callTimeoutSeconds: 300, organization: '', pat: '' });
  assert.equal(statSync(installed(s, 'settings.json')).mode & 0o777, 0o600);
  // A configured PAT survives replacement byte for byte and is never echoed.
  migrated.azure.organization = 'team'; migrated.azure.pat = TEAM_PAT;
  writeFileSync(installed(s, 'settings.json'), JSON.stringify(migrated, null, 2) + '\n');
  const again = install(s, ['--replace']); ok(again);
  assert.doesNotMatch(again.stdout + again.stderr, /team-private-pat/);
  assert.equal(JSON.parse(readFileSync(installed(s, 'settings.json'), 'utf8')).azure.pat, TEAM_PAT);
  original(s); clean(s);
});
