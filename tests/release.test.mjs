import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the npm package is publishable and carries the runtime entry', () => {
  assert.equal(pkg.name, 'opencode-azure-devops-pr-review');
  assert.equal(pkg.private, undefined, 'npm refuses to publish a private package');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.exports, './server.js');
  assert.equal(pkg.repository?.url, 'git+https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git');
  for (const entry of ['server.js', 'src/', 'LICENSE']) assert.ok(pkg.files.includes(entry), entry);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[field], undefined, field);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublishOnly']) assert.equal(pkg.scripts?.[hook], undefined, hook);
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
