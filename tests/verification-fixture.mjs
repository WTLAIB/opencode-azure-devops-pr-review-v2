/** Trusted local toolchain fixture; never copies a user's configuration or home. */
import { copyFile, chmod, mkdir, writeFile, stat, cp, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export const verificationURL = 'https://dev.azure.com/fixture/project/_git/repository';
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const nodeCommand = code => `node -e ${shellQuote(code)}`;
export function namespaceSupport() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return false;
  return spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--ipc', '--net', '--uts', '--fork', '/bin/true']).status === 0;
}
export async function verificationFixture(directory, { python = false } = {}) {
  const rootfs = join(directory, 'rootfs'), repository = join(directory, 'repository');
  for (const name of ['proc', 'dev', 'tmp', 'workspace', 'source', 'home', 'bin', 'usr/bin']) await mkdir(join(rootfs, name), { recursive: true });
  async function copyExecutable(source, target) {
    const paths = new Map([[source, target]]);
    const dependencies = spawnSync('/usr/bin/ldd', [source], { encoding: 'utf8' });
    for (const path of dependencies.stdout?.match(/\/[A-Za-z0-9_./+-]+/g) ?? []) {
      try { if ((await stat(path)).isFile()) paths.set(path, path); } catch {}
    }
    for (const [from, to] of paths) {
      const dest = join(rootfs, to);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(from, dest);
      await chmod(dest, (await stat(from)).mode & 0o777);
    }
  }
  await copyExecutable('/bin/sh', '/bin/sh');
  await copyExecutable(process.execPath, '/usr/bin/node');
  if (python) {
    await copyExecutable('/usr/bin/python3', '/usr/bin/python3');
    const paths = JSON.parse(spawnSync('/usr/bin/python3', ['-I', '-c', 'import json,sysconfig,_ctypes; print(json.dumps([sysconfig.get_path("stdlib"),_ctypes.__file__]))'], { encoding: 'utf8' }).stdout);
    await cp(paths[0], join(rootfs, paths[0]), { recursive: true });
    await copyExecutable(paths[1], paths[1]);
  }
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, 'example.cjs'), 'exports.divide = (a, b) => a / b;\n');
  await writeFile(join(repository, 'committed.txt'), 'committed source\n');
  await writeFile(join(repository, '.gitattributes'), 'committed.txt export-ignore\nexample.cjs export-subst\n');
  await symlink(join(repository, 'untracked-secret.txt'), join(repository, 'escape-link'));
  const git = args => {
    const result = spawnSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (result.status !== 0) throw new Error('Fixture Git preparation failed.');
    return result.stdout.trim();
  };
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Trusted fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  await writeFile(join(repository, 'committed.txt'), 'UNCOMMITTED must not be tested\n');
  await writeFile(join(repository, 'untracked-secret.txt'), 'HOST_FIXTURE_SECRET\n');
  return { commit, repository, rootfs, git, config: { enabled: true, rootfs, repositories: [{ url: verificationURL, path: repository }], timeoutSeconds: 10, memoryMiB: 4096, processes: 128, storageMiB: 64 } };
}
