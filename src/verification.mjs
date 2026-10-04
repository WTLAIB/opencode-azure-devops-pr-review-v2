/** Optional, command-scoped Linux verification. No model command runs on the host. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VERIFICATION_TOOL = 'azpr_verify';
export const VERIFICATION_DESCRIPTION = 'Run a command of your choice in a disposable, offline verification environment at an exact local Git commit. Only active initial reviewers and the verifier may use this tool. It cannot access your host working tree or credentials.';
export const VERIFICATION_INPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    commit: { type: 'string', description: 'Full reviewed source or target commit SHA, established from PR metadata.' },
    command: { type: 'string', description: 'Shell command or script of your choice. Starts in /workspace; /source is the immutable commit. All changes are disposable. No external network.' },
  }, required: ['commit', 'command'],
};
const defaults = Object.freeze({ enabled: false, rootfs: '', repositories: [], timeoutSeconds: 120, memoryMiB: 4096, processes: 128, storageMiB: 512 });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function repositoryURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Expected an HTTPS repository URL without credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/pullrequest\/[1-9][0-9]*\/?$/i, '').replace(/\/$/, '');
  if (!/\/_git\/[^/]+$/i.test(url.pathname)) throw new Error('Expected an Azure repository URL ending in /_git/<repository>.');
  return url.href;
}
export function validateVerification(value = {}) {
  if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) throw new Error('verification contains unknown settings or is not an object.');
  const config = { ...defaults, ...value };
  if (typeof config.enabled !== 'boolean' || typeof config.rootfs !== 'string' || (config.rootfs && (!config.rootfs.startsWith('/') || /[\0\r\n]/.test(config.rootfs)))) throw new Error('verification requires enabled (boolean) and an absolute rootfs path when configured.');
  if (!Array.isArray(config.repositories)) throw new Error('verification.repositories must be an array of {url, path}.');
  const urls = new Set();
  config.repositories = config.repositories.map(entry => {
    if (!object(entry) || Object.keys(entry).some(k => !['url', 'path'].includes(k)) || typeof entry.url !== 'string' || typeof entry.path !== 'string' || !entry.path.startsWith('/') || /[\0\r\n]/.test(entry.path)) throw new Error('Each verification repository requires a URL and an absolute trusted local Git path.');
    const url = repositoryURL(entry.url);
    if (url !== entry.url.replace(/\/$/, '') || urls.has(url)) throw new Error('Use unique canonical repository URLs, without a PR suffix, in verification.repositories.');
    urls.add(url);
    return { url, path: entry.path };
  });
  for (const [key, min, max] of [['timeoutSeconds', 1, 7200], ['memoryMiB', 64, 65536], ['processes', 8, 4096], ['storageMiB', 16, 8192]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`verification.${key} must be an integer from ${min} to ${max}.`);
  }
  if (config.enabled && (!config.rootfs || !config.repositories.length)) throw new Error('Enabled verification requires a trusted rootfs and at least one explicitly mapped local repository.');
  return config;
}

/** Clean environment for trusted helpers too: no provider tokens, proxy, Git or Python injection. */
const helperEnvironment = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/nonexistent', PYTHONNOUSERSITE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
const OUTPUT_BYTES = 1024 * 1024; // Execution transport only; never a review-stage budget.

export async function runVerification(config, repository, input, signal) {
  if (!object(input) || Object.keys(input).some(k => !['commit', 'command'].includes(k)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.commit ?? '') || typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) throw new Error('[AZPR] Verification requires an exact commit SHA and a nonempty command.');
  const start = Date.now();
  const record = { repository, commit: input.commit.toLowerCase(), command: input.command, startedAt: new Date(start).toISOString(), status: 'UNAVAILABLE', exitCode: null,
    environment: 'Linux user/mount/PID/IPC/network/UTS namespaces; offline; read-only operator rootfs; immutable /source and disposable /workspace',
    limits: { timeoutSeconds: config.timeoutSeconds, memoryMiB: config.memoryMiB, processes: config.processes, storageMiB: config.storageMiB, capturedOutputBytes: OUTPUT_BYTES },
    interpretation: 'The workspace starts at this commit and is writable. A command exit is not independent proof of a defect, unchanged test inputs, full coverage, or current Azure PR versions.' };
  const finish = extra => Object.assign(record, extra, { durationMs: Date.now() - start });
  const mapping = config.repositories.find(item => item.url === repository);
  if (!config.enabled || !mapping) return finish({ reason: 'No authorized verification environment is configured for this repository.' });
  if (process.platform !== 'linux') return finish({ reason: 'Isolated verification requires Linux.' });
  if (signal?.aborted) return finish({ status: 'CANCELLED', reason: 'Verification was cancelled before startup.' });
  let directory;
  try { directory = await mkdtemp(join(tmpdir(), 'azpr-verify-')); }
  catch { return finish({ reason: 'A private verification directory could not be created.' }); }
  if (signal?.aborted) {
    let directoryRemoved = true;
    try { await rm(directory, { recursive: true, force: true }); } catch { directoryRemoved = false; }
    return finish({ status: 'CANCELLED', cleanupConfirmed: true, directoryRemoved, reason: 'Verification was cancelled before process startup.' });
  }
  return new Promise(resolve => {
    const child = spawn('/usr/bin/python3', ['-I', fileURLToPath(new URL('./verification.py', import.meta.url)), directory], { env: helperEnvironment, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), protocol = Buffer.alloc(0), totalBytes = 0, stopped, timer, forced, settlement, settled = false;
    const stop = status => {
      if (stopped || settled) return;
      stopped = status;
      // unshare --kill-child makes namespace init death kill every descendant,
      // including children that start their own process group/session.
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      forced = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
      forced.unref();
      settlement = setTimeout(() => {
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        resolve(finish({ status: stopped, cleanupConfirmed: false, reason: 'Process settlement could not be confirmed. The private temporary directory is retained.' }));
      }, 5000);
      settlement.unref();
    };
    const abort = () => stop('CANCELLED');
    const append = data => { totalBytes += data.length; if (output.length < OUTPUT_BYTES) output = Buffer.concat([output, data.subarray(0, OUTPUT_BYTES - output.length)]); };
    child.stdout.on('data', append);
    child.stderr.resume(); // Never forward host paths or helper diagnostics.
    child.stdio[3].on('data', data => { if (protocol.length < 16384) protocol = Buffer.concat([protocol, data.subarray(0, 16384 - protocol.length)]); });
    child.stdin.on('error', () => {});
    child.on('error', () => {}); // close supplies the fail-closed result.
    child.on('close', async code => {
      if (settled) return; // Unconfirmed settlement preserves private evidence.
      settled = true; clearTimeout(timer); clearTimeout(forced); clearTimeout(settlement); signal?.removeEventListener('abort', abort);
      let result;
      try { result = JSON.parse(protocol.toString('utf8')); } catch {}
      const status = stopped ?? (code === 0 && result?.status === 'COMPLETED' ? 'COMPLETED' : 'UNAVAILABLE');
      // Helper diagnostics are never raw host paths, Git config or environment.
      let directoryRemoved = true;
      try { await rm(directory, { recursive: true, force: true }); } catch { directoryRemoved = false; }
      resolve(finish({ status, cleanupConfirmed: true, directoryRemoved, exitCode: status === 'COMPLETED' ? result.exitCode : null, signal: result?.signal ?? null,
        reason: stopped ? 'Verification stopped; the process namespace was terminated.' : result?.reason ?? (status === 'COMPLETED' ? undefined : 'Isolation or source preparation failed; no host execution fallback was attempted.'),
        output: output.toString('utf8'), outputBytes: totalBytes, outputTruncated: totalBytes > OUTPUT_BYTES,
        ...(result?.source ? { source: result.source } : {}) }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('TIMED_OUT'), Math.max(0, config.timeoutSeconds * 1000 - (Date.now() - start)));
    if (signal?.aborted) abort();
    child.stdin.end(JSON.stringify({ ...config, repositoryPath: mapping.path, commit: record.commit, command: input.command }));
  });
}

export function verificationNotice(records, language) {
  if (!records.length) return '';
  const chinese = /^zh\b/i.test(language);
  const traditional = chinese && new Intl.Locale(language).maximize().script === 'Hant';
  const title = chinese ? traditional
    ? '隔離驗證紀錄（命令結果不代表完整測試覆蓋；可寫入的工作副本可能經過修改）：'
    : '隔离验证记录（命令结果不代表完整测试覆盖；可写入的工作副本可能经过修改）：'
    : 'Isolated verification records (command results do not establish full test coverage; the writable copy may have been modified):';
  const exit = chinese ? traditional ? '結束代碼' : '退出码' : 'exit code';
  const truncated = chinese ? traditional ? '（輸出截短）' : '（输出截短）' : ' (output truncated)';
  const lines = records.map(r => `- ${r.role}: ${r.status}, ${r.commit}, ${exit} ${r.exitCode ?? '—'}${r.outputTruncated ? truncated : ''}`);
  return `\n\n${title}\n\n${lines.join('\n')}`;
}
