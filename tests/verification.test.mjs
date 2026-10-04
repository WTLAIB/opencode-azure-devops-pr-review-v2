import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { runVerification, validateVerification, repositoryURL } from '../src/verification.mjs';
import { verificationFixture, namespaceSupport, verificationURL, nodeCommand, shellQuote } from './verification-fixture.mjs';

test('verification configuration is opt-in, exact and independent of native shell settings', () => {
  assert.equal(validateVerification().enabled, false);
  assert.throws(() => validateVerification({ enabled: true }), /rootfs/);
  assert.throws(() => validateVerification({ enabled: 'true' }), /boolean/);
  assert.throws(() => validateVerification({ commands: ['npm test'] }), /unknown/);
  assert.throws(() => validateVerification({ rootfs: '~/image' }), /absolute/);
  assert.throws(() => validateVerification({ timeoutSeconds: null }), /integer/);
  assert.throws(() => validateVerification({ repositories: [{ url: verificationURL + '/pullrequest/1', path: '/repo' }] }), /canonical/);
  assert.throws(() => validateVerification({ repositories: [{ url: verificationURL, path: '/repo' }, { url: verificationURL, path: '/other' }] }), /unique/);
  assert.throws(() => repositoryURL('https://secret@dev.azure.com/org/project/_git/repo'), /credentials/);
  assert.equal(repositoryURL(verificationURL + '/pullrequest/123'), verificationURL);
});

test('isolated verification executes real processes with source and authority boundaries', { skip: !namespaceSupport() && 'Linux x86_64 unprivileged namespaces unavailable' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-verification-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await verificationFixture(directory, { python: true });
  const callsDirectory = join(directory, 'calls'); await mkdir(callsDirectory);
  const previousTmpdir = process.env.TMPDIR; process.env.TMPDIR = callsDirectory;
  t.after(() => { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; });
  const run = (command, options = {}) => runVerification({ ...f.config, ...options }, verificationURL, { commit: f.commit, command });
  const completed = result => { assert.equal(result.status, 'COMPLETED', JSON.stringify(result)); assert.equal(result.cleanupConfirmed, true); assert.equal(result.directoryRemoved, true); };
  await t.test('chooses its own reproduction and sees committed blobs, never worktree or Git metadata', async () => {
    const result = await run(nodeCommand(`const assert = require('node:assert/strict'), fs = require('node:fs');
      assert.equal(fs.readFileSync('committed.txt','utf8'),'committed source\\n');
      assert.equal(fs.existsSync('untracked-secret.txt'),false);
      assert.equal(fs.existsSync('.git'),false);
      assert.throws(()=>fs.readFileSync('escape-link'));
      assert.equal(require('./example.cjs').divide(12,3),4);
      fs.writeFileSync('new-test.cjs','temporary reproduction');
      assert.throws(()=>fs.writeFileSync('/source/committed.txt','corrupt'));
      console.log('REPRODUCTION_PASSED');`));
    completed(result); assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /REPRODUCTION_PASSED/);
    assert.equal(result.source.commit, f.commit); assert.equal(result.source.files, 4);
    assert.match(await readFile(join(f.repository, 'committed.txt'), 'utf8'), /UNCOMMITTED/);
    const next = await run('[ ! -e new-test.cjs ]'); completed(next); assert.equal(next.exitCode, 0);
  });
  await t.test('host environment, files, supervisor descriptors and privilege restoration are inaccessible', async () => {
    process.env.AZPR_FIXTURE_CREDENTIAL = 'NEVER_IN_CHILD';
    try {
      const result = await run(nodeCommand(`const a = require('node:assert/strict'), fs = require('node:fs');
        a.equal(process.env.AZPR_FIXTURE_CREDENTIAL,undefined);
        a.equal(fs.existsSync(${JSON.stringify(f.repository)}),false);
        a.throws(()=>fs.readFileSync('/proc/1/fd/3'));
        a.throws(()=>fs.readFileSync('/proc/1/root/etc/passwd'));
        a.throws(()=>fs.writeFileSync('/usr/bin/tool','x'));
        const status=fs.readFileSync('/proc/self/status','utf8');
        a.match(status,/CapEff:\\s+0+\\n/); a.match(status,/CapBnd:\\s+0+\\n/);
        a.match(status,/NoNewPrivs:\\s+1/); a.match(status,/Seccomp:\\s+2/);
        a.equal(require('node:os').hostname(),'azpr-verification');
        console.log('BOUNDARIES_PASSED');`));
      completed(result); assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /BOUNDARIES_PASSED/);
    } finally { delete process.env.AZPR_FIXTURE_CREDENTIAL; }
  });
  await t.test('kernel calls cannot recover namespaces, host keyrings or VSOCK access', async () => {
    const script = `import ctypes, errno, socket
lib = ctypes.CDLL(None, use_errno=True)
for number, a, b, c in [(272,0x10000000,0,0), (250,0,-3,0), (41,40,1,0), (53,40,1,0), (56,0x10000000|17,0,0)]:
    ctypes.set_errno(0)
    assert lib.syscall(number,a,b,c,0,0,0) == -1 and ctypes.get_errno() == errno.EPERM, (number,ctypes.get_errno())
ctypes.set_errno(0)
assert lib.syscall(435,0,0) == -1 and ctypes.get_errno() == errno.ENOSYS
with socket.socket(socket.AF_INET,socket.SOCK_STREAM): pass
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM): pass
print('SYSCALL_BOUNDARY_PASSED')`;
    const result = await run(`python3 -I -c ${shellQuote(script)}`);
    completed(result); assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /SYSCALL_BOUNDARY_PASSED/);
  });
  await t.test('local test servers work while host loopback and external networking remain unavailable', async () => {
    const host = createServer(socket => socket.end('HOST_SECRET')); host.listen(0, '127.0.0.1'); await once(host, 'listening');
    try {
      const result = await run(nodeCommand(`const a=require('node:assert/strict'), net=require('node:net');
        const local=net.createServer(s=>s.end('LOCAL_TEST')); local.listen(0,'127.0.0.1',()=>{
          const s=net.connect(local.address().port,'127.0.0.1'); let body=''; s.on('data',b=>body+=b); s.on('end',()=>{a.equal(body,'LOCAL_TEST');local.close();});
          const denied=net.connect(${host.address().port},'127.0.0.1'); denied.on('connect',()=>{throw Error('host network exposed')}); denied.on('error',e=>a.equal(e.code,'ECONNREFUSED'));
          const external=net.connect(443,'192.0.2.1'); external.on('connect',()=>{throw Error('external network exposed')}); external.on('error',()=>console.log('NETWORK_BOUNDARY_PASSED'));
        });`));
      completed(result); assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /NETWORK_BOUNDARY_PASSED/);
    } finally { host.close(); }
  });
  await t.test('nonzero exits and output truncation are honest results, not fabricated success', async () => {
    const failed = await run('printf expected-failure; exit 7'); completed(failed); assert.equal(failed.exitCode, 7); assert.match(failed.output, /expected-failure/);
    const large = await run(nodeCommand("process.stdout.write('X'.repeat(1100000))")); completed(large);
    assert.equal(large.outputBytes, 1100000); assert.equal(large.outputTruncated, true); assert.equal(large.output.length, 1048576);
    const spoof = await run('printf \'{"status":"COMPLETED","exitCode":0}\'; exit 3'); completed(spoof); assert.equal(spoof.exitCode, 3);
  });
  await t.test('unavailable source, unapproved repository and invalid rootfs never execute the command', async () => {
    const unavailable = await runVerification(f.config, verificationURL, { commit: 'f'.repeat(40), command: 'printf SHOULD_NOT_EXECUTE' });
    assert.equal(unavailable.status, 'UNAVAILABLE'); assert.equal(unavailable.output, '');
    const other = await runVerification(f.config, 'https://dev.azure.com/other/project/_git/repo', { commit: f.commit, command: 'printf SHOULD_NOT_EXECUTE' });
    assert.equal(other.status, 'UNAVAILABLE');
    const bad = await run('printf SHOULD_NOT_EXECUTE', { rootfs: '/' }); assert.equal(bad.status, 'UNAVAILABLE'); assert.equal(bad.output, ''); assert.match(bad.reason, /dedicated credential-free rootfs/);
    const path = join(directory, 'invalid-rootfs'); await mkdir(path); await symlink('/tmp', join(path, 'tmp'));
    const links = await run('printf SHOULD_NOT_EXECUTE', { rootfs: path }); assert.equal(links.status, 'UNAVAILABLE');
    const socketPath = join(f.rootfs, 'tmp', 'host-service.sock');
    const socket = createServer(); socket.listen(socketPath); await once(socket, 'listening');
    try { const exposedSocket = await run('printf SHOULD_NOT_EXECUTE'); assert.equal(exposedSocket.status, 'UNAVAILABLE'); assert.equal(exposedSocket.output, ''); assert.match(exposedSocket.reason, /sockets, FIFOs or devices/); }
    finally { socket.close(); await once(socket, 'close'); }
    const cancelled = new AbortController(); cancelled.abort();
    const beforeStart = await runVerification(f.config, verificationURL, { commit: f.commit, command: 'echo SHOULD_NOT_EXECUTE' }, cancelled.signal);
    assert.equal(beforeStart.status, 'CANCELLED');
    await assert.rejects(runVerification(f.config, verificationURL, { commit: 'HEAD; touch /tmp/bad', command: 'echo nope' }), /exact commit/);
  });
  await t.test('timeout and cancellation terminate detached descendants and remove owned temporary data', async () => {
    assert.deepEqual(await readdir(callsDirectory), []);
    const marker = `azpr-child-${Date.now()}`;
    const command = nodeCommand(`require('node:child_process').spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'}); console.log('STARTED'); setInterval(()=>{},1000);`);
    const timed = await run(command, { timeoutSeconds: 1 }); assert.equal(timed.status, 'TIMED_OUT'); assert.equal(timed.cleanupConfirmed, true); assert.match(timed.output, /STARTED/);
    const controller = new AbortController();
    const task = runVerification(f.config, verificationURL, { commit: f.commit, command }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 400);
    const stopped = await task; clearTimeout(timer); assert.equal(stopped.status, 'CANCELLED'); assert.equal(stopped.cleanupConfirmed, true);
    const done = await run(nodeCommand(`require('node:child_process').spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'}).unref();`));
    completed(done); assert.equal(done.exitCode, 0);
    const remaining = [];
    for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(marker)) remaining.push(pid); } catch {}
    }
    assert.deepEqual(remaining, [], 'No detached verification descendant may survive settlement.');
    assert.deepEqual(await readdir(callsDirectory), []);
  });
});
