import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the npm package is publishable and carries the runtime entry', () => {
  assert.equal(pkg.name, 'opencode-azure-devops-pr-review');
  assert.equal(pkg.private, undefined, 'npm refuses to publish a private package');
  assert.equal(pkg.publishConfig?.access, 'public');
  // The server part, and the part OpenCode's terminal UI loads by itself when the plugin is active.
  assert.deepEqual(pkg.exports, { '.': './server.js', './tui': './src/tui.js' });
  assert.equal(pkg.repository?.url, 'git+https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git');
  // The runtime plus the README, changelog and license; npmjs.com resolves the README's links and images on GitHub.
  assert.deepEqual(pkg.files, ['server.js', 'src/', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[field], undefined, field);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublishOnly']) assert.equal(pkg.scripts?.[hook], undefined, hook);
  // Only the compiler of the terminal panel's JSX, at exact versions; npm installs none of it with the package.
  assert.deepEqual(pkg.devDependencies, { '@babel/core': '7.29.7', 'babel-preset-solid': '1.9.16' });
});

test('the terminal part is shipped compiled and binds only what OpenCode provides', () => {
  const compiled = read('src/tui.js');
  assert.match(compiled, /^\/\/ Generated from tui-view\.jsx by scripts\/build-tui\.mjs \(@babel\/core 7\.29\.7, babel-preset-solid 1\.9\.16; /, 'The file names the compiler that made it.');
  assert.ok(existsSync(new URL('../src/tui-view.jsx', import.meta.url)), 'Its source is in the repository and in the package.');
  // OpenCode 2.3.0 compiles no JSX under node_modules, where it installs packages: nothing here may need its compiler.
  assert.doesNotMatch(compiled, /<\/?[A-Za-z][\w.]*(?:\s[^<>]*)?\/?>\s*$/m, 'No JSX is left in the compiled file.');
  const imports = [...compiled.matchAll(/^import\s+(?:\{([^}]*)\}|[\w$]+)\s+from\s+"([^"]+)";?$/gm)].map(([, names = '', source]) => ({ source, names: names.split(',').map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean) }));
  assert.equal(imports.length, [...compiled.matchAll(/^import\b/gm)].length, 'Every import has the plain form the host rewrites to its own modules.');
  // The host hands a plugin its own copies of these; a copy of its own would be a second renderer.
  assert.deepEqual([...new Set(imports.map(item => item.source))].sort(), ['./tui-model.mjs', '@opentui/core', '@opentui/solid', 'solid-js']);
  const helpers = new Set(['createComponent', 'createElement', 'createTextNode', 'effect', 'insert', 'insertNode', 'memo', 'mergeProps', 'setProp', 'spread', 'use']);
  for (const name of imports.filter(item => item.source === '@opentui/solid').flatMap(item => item.names)) assert.ok(helpers.has(name), `@opentui/solid: ${name} is one of the universal renderer's helpers`);
  // Solid's control flow comes from solid-js: the compiler would otherwise expect it from the renderer.
  const solid = imports.filter(item => item.source === 'solid-js').flatMap(item => item.names);
  for (const name of ['For', 'Show']) assert.ok(solid.includes(name), `${name} is imported from solid-js`);
  assert.doesNotMatch(read('src/tui-model.mjs'), /^import\b|\bimport\(/m, 'What the panel shows is worked out without any import.');
  assert.doesNotMatch(compiled + read('src/tui-model.mjs'), /settings\.json|node:fs|process\.env/, 'The terminal part reads no file and no environment.');
  // One command of its own, to show or hide the panel. Whether the panel opens by itself is a setting of AZPR
  // (terminalPanel), which reaches it with the notices: it keeps no preference of its own.
  assert.deepEqual([...compiled.matchAll(/slash:\s*\{\s*name:\s*"([^"]+)"/g)].map(match => match[1]), ['pr-panel']);
  assert.doesNotMatch(compiled, /\.storage\b/, 'The terminal part stores nothing.');
});

test('release notes and install instructions name the package version', () => {
  const version = pkg.version;
  assert.equal(read('CHANGELOG.md').match(/^## (\S+)/m)?.[1], version, 'The newest changelog section is the package version.');
  assert.ok(existsSync(new URL(`../docs/releases/v${version}.md`, import.meta.url)), `docs/releases/v${version}.md exists`);
  for (const path of ['README.md', 'docs/QUICKSTART.md', `docs/releases/v${version}.md`]) {
    const text = read(path);
    assert.ok(text.includes(`opencode plugin add ${pkg.name}@${version}`), `${path} installs ${pkg.name}@${version}`);
    assert.ok(text.includes(`github:WTLAIB/opencode-azure-devops-pr-review-v2#v${version}`), `${path} names the v${version} Git package`);
    for (const [, other] of text.matchAll(/opencode plugin (?:add|remove) (?:opencode-azure-devops-pr-review@|'github:WTLAIB\/opencode-azure-devops-pr-review-v2#v)(\d+\.\d+\.\d+)/g)) {
      assert.equal(other, version, `${path} installs or removes only v${version}`);
    }
  }
});

test('release notes link only absolute URLs, since they become the GitHub Release body', () => {
  for (const name of readdirSync(new URL('../docs/releases/', import.meta.url))) {
    const text = read(`docs/releases/${name}`);
    const targets = [...text.matchAll(/\]\(([^)\s]+)/g), ...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1]);
    for (const target of targets) assert.match(target, /^https:\/\//, `${name} links ${target}`);
  }
});
