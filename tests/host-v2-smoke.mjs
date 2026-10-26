import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
import { fakeProxy } from './fake-proxy.mjs';
import { TESTED_HOST_VERSION } from '../src/host.mjs';
/**
 * Opt-in exact-host fixture: node tests/host-v2-smoke.mjs /absolute/path/opencode [--replace|--native [--package SPEC]]
 * --native packs the package, loads its real entry with external
 * settings, exercises first-run setup and then runs the same review workflow.
 * --package SPEC installs that published package instead (an npm version such
 * as opencode-azure-devops-pr-review@0.2.1, or a Git specification; needs the
 * network) to check a release after publication.
 * Isolated directories, a loopback deterministic provider, a loopback fake
 * Azure DevOps REST service (api-version 7.1, persistent thread state) and one
 * foreign stdio MCP server. Covers the deterministic source check, a full
 * review in which reviewers read through AZPR's tools while foreign tools stay
 * hidden, a verifier repair turn, comment preview and idempotent publication
 * across a host restart, cancellation, a provider 503 that OpenCode retries in
 * the same session, and private auxiliary-request denial. Automatic comment
 * steps: a flag after the PR URL previews the comments of a COMPLETE review in
 * a run of its own, automatic publication posts a quick review's
 * high-severity finding and holds back only a comment with an image until a
 * typed --publish, a review without findings gets no step, afterReview publish
 * posts and reads the comments back, and a repeated plan whose findings are all
 * discussed posts nothing. The fresh run also
 * stalls a model stream until the stage inactivity watchdog stops it, while an
 * answer that keeps streaming longer than the watchdog's window runs on.
 * The fresh run also reaches Azure DevOps over HTTPS only through an
 * authenticating CONNECT proxy with a fixture CA (openssl generates it).
 * It does not validate a real provider, real Azure DevOps, a real corporate
 * proxy or visual rendering.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
assert.ok(binary?.startsWith('/'), 'Supply the exact host binary as an absolute path.');
const replacement = process.argv[3] === '--replace';
const native = process.argv[3] === '--native';
const publishedPackage = native && process.argv[4] === '--package' ? process.argv[5] : undefined;
assert.ok(process.argv.length <= 4 || (publishedPackage && process.argv.length === 6), 'Only --native accepts a following --package SPEC.');
const fixturesRoot = join(sourceRoot, '.local');
await mkdir(fixturesRoot, { recursive: true });
const fixture = await mkdtemp(join(fixturesRoot, 'host-v2-smoke-'));
const directories = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
await mkdir(join(directories.config, 'plugins'), { recursive: true });
const runtimeDirectory = join(directories.config, 'plugins', 'azpr-v2');
const externalSettings = join(fixture, 'xdg-config', 'azpr', 'settings.json');
const selectedSettings = join(fixture, 'private settings', 'settings.json');
const installedSettingsPath = native ? selectedSettings : join(runtimeDirectory, 'settings.json');
const packageDirectory = join(fixture, 'package');
let nativePackage = publishedPackage;
const settings = JSON.parse(await readFile(join(sourceRoot, 'config', 'settings.example.json'), 'utf8'));
for (const role of ['functional', 'risk', 'verifier']) settings.models.review[role] = `fixture/${role}`;
settings.models.quick = { reviewer: 'fixture/quick' };
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
// The smallest inactivity window, so the stalled-stream step takes about a
// minute; the hanging reviews below are stopped well before it (keep
// AZPR_TUI_HOLD_SECONDS under 60).
settings.workflow = { ...settings.workflow, stageIdleSeconds: 60 };
settings.outputLanguage = 'zh-TW';
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings, null, 2));
const install = args => {
  const result = spawnSync('/bin/sh', [join(sourceRoot, 'install.sh'), '--config-dir', directories.config, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
};
if (native && !publishedPackage) {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', fixture], { cwd: sourceRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(pack.status, 0, pack.stderr);
  const metadata = JSON.parse(pack.stdout)[0];
  assert.ok(metadata.files.some(file => file.path === 'server.js'));
  assert.ok(metadata.files.some(file => file.path === 'src/setup.mjs'));
  assert.ok(metadata.files.every(file => !file.path.includes('.local/') && !file.path.endsWith('/settings.json')));
  const extract = spawnSync('tar', ['-xzf', join(fixture, metadata.filename), '-C', fixture], { encoding: 'utf8', timeout: 15000 });
  assert.equal(extract.status, 0, extract.stderr);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=AZPR fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Native package fixture']]) {
    const git = spawnSync('git', args, { cwd: packageDirectory, encoding: 'utf8', timeout: 15000 });
    assert.equal(git.status, 0, git.stderr);
  }
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageDirectory, encoding: 'utf8', timeout: 15000 });
  assert.equal(sha.status, 0, sha.stderr);
  nativePackage = `git+file://${packageDirectory}#${sha.stdout.trim()}`;
} else if (!native) install(['--settings', join(fixture, 'settings.json')]);
if (replacement) {
  const before = await readFile(join(runtimeDirectory, 'settings.json'));
  await rm(join(runtimeDirectory, 'server.js'), { force: true });
  install(['--replace']);
  assert.deepEqual(await readFile(join(runtimeDirectory, 'settings.json')), before);
}

// ------------------------------------------------------------ fake provider
const requests = [];
const overloaded = new Set();
let child, logs = '', stall = null, longStream = null, commentImage = false, commentDiscussed = false;
const lastUser = messages => messages?.findLast(message => message.role === 'user')?.content;
const firstUser = messages => messages?.find(message => message.role === 'user')?.content;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  const sessionID = request.headers['x-opencode-session-id'];
  requests.push({ path: request.url, model: parsed.model, sessionID, tools: (parsed.tools ?? []).map(tool => tool.function?.name), last: textOf(lastUser(parsed.messages)).slice(0, 200),
    toolResults: parsed.messages?.filter(message => message.role === 'tool').length ?? 0,
    lastTool: textOf(parsed.messages?.findLast(message => message.role === 'tool')?.content).slice(0, 600) });
  let payload;
  try { payload = JSON.parse(textOf(firstUser(parsed.messages))); } catch { /* ordinary chat */ }
  const repair = textOf(lastUser(parsed.messages)).startsWith('AZPR runtime');
  const toolResults = parsed.messages?.filter(message => message.role === 'tool').length ?? 0;
  if (payload?.userContext?.includes('hang-smoke')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture waits for cancellation\n\n');
    return;
  }
  // The first request of each risk session fails once, like an overloaded provider.
  if (payload?.userContext?.includes('retry-smoke') && parsed.model === 'risk' && !overloaded.has(sessionID)) {
    overloaded.add(sessionID);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fixture provider overloaded', type: 'server_error' } }));
    return;
  }
  // The first functional session's stream starts and then stops sending.
  if (payload?.userContext?.includes('stall-smoke') && parsed.model === 'functional' && !stall) {
    stall = { sessionID, at: Date.now(), closed: null };
    response.on('close', () => { stall.closed = Date.now(); });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture stream stalls\n\n');
    return;
  }
  const fileTool = parsed.tools?.find(tool => tool.function?.name === 'azpr_read_file')?.function.name;
  let call, final = 'Ordinary fixture answer.';
  const finding = (id, path) => ({ id, summary: '缺少防護會遺失狀態', evidence: 'HEAD: `fixture code` 略過防護。BASE: 有防護。', counterevidence: '呼叫端沒有再次檢查。', location: `head:${path}:1`, severity: 'high', suggestion: '恢復防護並加上回歸測試。' });
  // The first functional session's answer streams for 66 s, one chunk per second.
  if (payload?.userContext?.includes('stream-smoke') && parsed.model === 'functional' && !longStream) {
    const files = payload.assignment.files;
    const answer = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '初審完成。' });
    longStream = { sessionID, at: Date.now(), chunks: 0, finishedAt: null };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl_long', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    const timer = setInterval(() => {
      const chunk = ++longStream.chunks;
      send({ content: answer.slice(Math.ceil(answer.length * (chunk - 1) / 66), Math.ceil(answer.length * chunk / 66)) });
      if (chunk < 66) return;
      clearInterval(timer);
      longStream.finishedAt = Date.now();
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    }, 1000);
    response.on('close', () => clearInterval(timer));
    return;
  }
  if (payload?.assignment?.files && !payload.assignment.findingIds) {
    const files = payload.assignment.files;
    if (!toolResults && fileTool) call = { name: fileTool, arguments: { path: files[0], version: 'head' } };
    // A reviewer mistaking a repository path for a local one must get an answer, not a pending approval.
    else if (toolResults === 1 && parsed.model === 'functional' && parsed.tools?.some(tool => tool.function?.name === 'grep')) call = { name: 'grep', arguments: { pattern: 'guard', path: '/scale_lab' } };
    // An existing directory outside the project reaches the permission hook, whatever the host's default.
    else if (toolResults === 2 && parsed.model === 'functional' && parsed.tools?.some(tool => tool.function?.name === 'grep')) call = { name: 'grep', arguments: { pattern: 'guard', path: '/etc' } };
    else if (toolResults === 1 && parsed.model === 'risk') call = { name: 'azpr_search_code', arguments: { query: 'second line of', path: '/src' } };
    // A quick reviewer that stops early: PARTIAL with a gap; its one follow-up finishes the review or gives no usable answer.
    else if (payload.userContext?.includes('no-findings-smoke')) final = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [], report: '沒有發現。' });
    else if (payload.userContext?.includes('follow-up') && parsed.model === 'quick' && !repair) final = JSON.stringify({ status: 'PARTIAL', coverage: { files, gaps: ['呼叫端尚未查核。'] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '提早停止。' });
    else if (payload.userContext?.includes('follow-up-unusable') && parsed.model === 'quick') final = '還在查核呼叫端。';
    else final = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '初審完成。' });
  } else if (payload?.assignment?.findingIds) {
    const findings = payload.assignment.findings;
    final = repair
      ? JSON.stringify({ dispositions: findings.slice(1).map(item => ({ id: item.id, status: 'MERGED', mergedInto: findings[0].id, reason: '相同根因。' })) })
      : JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...findings[0], reason: '已回查原始碼。' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: '驗證完成。' });
  } else if (payload?.commentWork?.kind === 'plan' && commentDiscussed && Array.isArray(payload.existingDiscussions)) {
    // Every finding is already discussed by AZPR's own comment on the PR.
    const threadId = payload.existingDiscussions.find(thread => thread.azpr && thread.path)?.threadId;
    final = JSON.stringify({ status: 'READY', comments: [], skipped: payload.findings.map(item => ({ findingId: item.id, cause: 'existing-thread', threadId, reason: `討論串 ${threadId} 已說明。` })) });
  } else if (payload?.commentWork?.kind === 'plan') {
    final = JSON.stringify({ status: 'READY', ...(payload.commentWork.allowSummary ? { summary: '此 PR 調整 fixture 的狀態處理。' } : {}),
      // With commentImage the comment sits on the second line (a new marker) and shows an image.
      comments: payload.findings.map(item => { const path = /head:([^:]+)/.exec(item.location)[1]; return { findingId: item.id, severity: item.severity, path,
        startLine: commentImage ? 2 : 1, endLine: commentImage ? 2 : 1, anchor: commentImage ? `second line of ${path}` : 'fixture code',
        body: `🔴 high: ${item.summary}\n\n**📝 Summary**\n觸發與影響。\n\n**🔎 Evidence**\n原始碼事實。\n\n**💡 Suggested fix**\n修正方式。${commentImage ? '\n\n![trace](https://outside.example/trace.png)' : ''}` }; }),
      skipped: [] });
  }
  const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: final };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;

// ------------------------------------------------- fake Azure DevOps REST
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 123, files: ['/src/fixture.js', '/src/other.js'] });
const adoServer = createServer((request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
adoServer.listen(0, '127.0.0.1');
await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;

// A foreign MCP server: ordinary sessions see its tool, private reviewers must not.
const foreignPath = join(fixture, 'foreign-mcp.mjs');
await writeFile(foreignPath, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'foreign', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Foreign fixture tool', inputSchema: { type: 'object', properties: {} } }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'foreign result' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`);
await writeFile(join(directories.config, 'plugins', 'network-guard.js'), `export default { id: 'azpr.fixture.guard', async setup(ctx) {
  await ctx.session.hook('http.request', event => { if (!event.request.url.startsWith(${JSON.stringify(providerURL + '/')})) throw new Error('Fixture forbids non-loopback model requests'); });
} };`);
await writeFile(join(directories.config, 'opencode.json'), JSON.stringify({
  update: 'disable', snapshots: false, warming: false, model: 'fixture/fixture',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries(['fixture', 'functional', 'risk', 'verifier', 'quick'].map(id => [id, { limit: { context: 100000, output: 4000 } }])) } },
  mcp: { servers: { foreign: { type: 'local', command: [process.execPath, foreignPath], codemode: false } } },
}, null, 2));

// ------------------------------------------------------------------- host
const password = randomUUID();
const env = {
  PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache, XDG_STATE_HOME: directories.state,
  TMPDIR: directories.tmp, OPENCODE_TEST_HOME: directories.home, OPENCODE_CONFIG_DIR: directories.config, OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1',
  AZPR_TEST_AZURE_BASE_URL: azureURL,
};
if (native) {
  const added = spawnSync(binary, ['plugin', 'add', nativePackage], { cwd: directories.work, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /installed and added/);
  const config = JSON.parse(await readFile(join(directories.config, 'opencode.json'), 'utf8'));
  assert.ok(config.plugins.includes(nativePackage));
}
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
const stopHost = async () => {
  if (child && child.exitCode === null) {
    const stopping = child, exited = once(stopping, 'exit');
    stopping.kill('SIGTERM');
    let timer;
    try { await Promise.race([exited, new Promise(resolveStopped => { timer = setTimeout(() => { stopping.kill('SIGKILL'); resolveStopped(); }, 5000).unref(); })]); }
    finally { clearTimeout(timer); }
  }
};
const startHost = async () => {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directories.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  const ready = new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('exit', code => rejectReady(new Error(`Host exited before readiness: ${code}`)));
    child.stdout.on('data', data => { logs += data; startup += data; const found = startup.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (found) resolveReady(found[1]); });
    child.stderr.on('data', data => { logs += data; });
  });
  return Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture host startup timeout')), 30000).unref())]);
};
const threads = async () => azure.state.threads;

try {
  let url = await startHost();
  const rawApi = async (path, body) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': directories.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Fixture API ${path}: ${response.status} ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  };
  const api = withCommandCompletion(rawApi, 120000);
  // Listening and model readiness precede asynchronous Git-plugin command
  // registration. Do not treat an incomplete startup catalog as a plugin error.
  const waitForCommands = async (configured = true) => {
    const end = Date.now() + 20000;
    do {
      const commands = (await rawApi('/api/command')).data;
      if (['pr-setup', 'pr-check', 'pr-review', 'pr-deep', 'pr-quick', 'pr-stop', 'pr-comment'].every(name =>
        commands.some(command => command.name === name && (!configured || !command.description?.includes('setup required'))))) return;
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    } while (Date.now() < end);
    throw new Error('Fixture AZPR command catalog did not finish loading.');
  };
  await waitForCommands(!native);
  const hostVersion = (await api('/api/info')).version;
  assert.equal(hostVersion, TESTED_HOST_VERSION, `OpenCode ${hostVersion} is not the tested ${TESTED_HOST_VERSION}.`);
  let nativeSetup;
  if (native) {
    const origin = (await rawApi('/api/session', { title: 'Native setup', location: { directory: directories.work } })).data.id;
    const invoke = async (name, text) => {
      await rawApi(`/api/session/${origin}/command`, { name, text, delivery: 'steer' });
      return (await rawApi(`/api/session/${origin}/inbox`)).data.at(-1)?.payload?.text ?? '';
    };
    assert.ok(!(await rawApi('/api/agent')).data.some(agent => agent.name.startsWith('azpr-')));
    assert.match(await invoke('pr-check', 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123'), /SETUP REQUIRED/);
    assert.match(await invoke('pr-setup', '--help'), /--organization[\s\S]*--model[\s\S]*--pat-file/);
    // Without --pat-file, setup uses the default PAT file under XDG_CONFIG_HOME; --organization also takes a PR URL.
    const patFile = join(fixture, 'xdg-config', 'azpr', 'pat');
    const setupUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123';
    assert.ok((await invoke('pr-setup', `--organization ${setupUrl} --model fixture/fixture`))
      .startsWith(`[AZPR] No --pat-file was given, and the default PAT file ${patFile} could not be used (not found).`));
    await mkdir(dirname(patFile), { recursive: true, mode: 0o700 });
    await writeFile(patFile, FAKE_PAT, { mode: 0o600 });
    assert.match(await invoke('pr-setup', '--organization fixture --model fixture/missing'), /unavailable/);
    await assert.rejects(stat(externalSettings), { code: 'ENOENT' });
    const saved = await invoke('pr-setup', `--organization ${setupUrl} --model fixture/fixture`);
    assert.ok(saved.startsWith(`[AZPR] SETTINGS SAVED\nSettings: ${externalSettings}\nOrganization: fixture; PAT file: ${patFile}\nTo load them, restart the OpenCode service (in a terminal: opencode service restart;`), saved);
    const initial = JSON.parse(await readFile(externalSettings, 'utf8'));
    assert.equal((await stat(externalSettings)).mode & 0o777, 0o600);
    assert.ok(Object.values(initial.models.review).every(model => model === 'fixture/fixture'));
    assert.equal(initial.models.quick.reviewer, 'fixture/fixture');
    assert.equal(initial.azure.pat, '');
    assert.equal(initial.azure.patFile, patFile);
    assert.match(await invoke('pr-review', 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123'), /SETUP REQUIRED/);
    assert.equal(requests.length, 0);
    assert.equal(azure.state.calls.length, 0);
    // The copy OpenCode installed (under its package cache) holds no settings.
    const installedCopies = (await readdir(directories.cache, { recursive: true }))
      .filter(path => path.includes('node_modules') && path.endsWith(join('src', 'setup.mjs')))
      .map(path => join(directories.cache, dirname(dirname(path))));
    assert.ok(installedCopies.length > 0, 'OpenCode installed the AZPR package under its cache.');
    for (const copy of [packageDirectory, ...installedCopies]) await assert.rejects(stat(join(copy, 'src', 'settings.json')), { code: 'ENOENT' });
    // Use the workflow fixture's role-specific models and diagnostics after
    // proving that setup saves exactly one selected model and no secret.
    await stopHost();
    settings.azure = { ...settings.azure, pat: '', patFile };
    await mkdir(dirname(selectedSettings), { mode: 0o700 });
    await writeFile(selectedSettings, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rm(externalSettings);
    const config = JSON.parse(await readFile(join(directories.config, 'opencode.json'), 'utf8'));
    config.plugins = config.plugins.map(plugin => plugin === nativePackage ? { package: nativePackage, options: { settingsFile: selectedSettings } } : plugin);
    await writeFile(join(directories.config, 'opencode.json'), JSON.stringify(config, null, 2));
    url = await startHost();
    await waitForCommands();
    nativeSetup = `${publishedPackage ? `CLI plugin add ${publishedPackage}` : 'npm pack plus CLI plugin add from an isolated Git commit'}; missing config blocks reviews; setup validates model and private PAT file without network calls, uses the default XDG PAT file and takes the organization from a PR URL; default XDG and explicit options.settingsFile both work; external mode-600 settings survive restart; installed package holds no settings or PAT`;
  }
  const waitForMcp = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await api('/api/mcp')).data?.some(server => server.name === 'foreign' && server.status?.status === 'connected')) return;
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    }
    throw new Error('Fixture MCP did not connect.');
  };
  await waitForMcp();
  const commands = await api('/api/command');
  for (const name of ['pr-check', 'pr-review', 'pr-stop', 'pr-deep', 'pr-quick', 'pr-comment']) assert.ok(commands.data.some(command => command.name === name), name);
  const agents = await api('/api/agent');
  for (const role of ['functional', 'risk', 'verifier', 'dedupe', 'comment-plan']) assert.ok(agents.data.some(agent => agent.name === `azpr-review-${role}`), role);
  for (const role of ['reviewer', 'comment-plan']) assert.ok(agents.data.some(agent => agent.name === `azpr-quick-${role}`), `quick ${role}`);
  const newOrigin = async title => (await api('/api/session', { title, location: { directory: directories.work } })).data.id;
  const latest = async origin => (await api(`/api/session/${origin}/inbox`)).data.at(-1)?.payload?.text ?? '';
  const inbox = async origin => (await api(`/api/session/${origin}/inbox`)).data.map(item => item.payload?.text ?? '');
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123';
  const results = nativeSetup ? { nativeSetup } : {};
  const stageRecords = async receipt => JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(receipt)[1], 'result.json'), 'utf8')).stages;
  const RECEIPT = /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/;
  // A review's receipt, found by its STARTED notice: a comment step it hands on may already have notices after it.
  const reviewReceipt = async (origin, name) => {
    const texts = await inbox(origin);
    const prefix = texts.findLast(text => text.includes(`] STARTED /${name}.`)).split(']')[0] + ']';
    return texts.find(text => text.startsWith(prefix) && RECEIPT.test(text));
  };
  // The comment step a COMPLETE review hands on: its own run's STARTED notice and receipt, or the notice that it was skipped.
  const commentStep = async (origin, receipt) => {
    const review = /\[AZPR ([a-f0-9]{8})\]/.exec(receipt)[1];
    const end = Date.now() + 120000;
    do {
      const texts = await inbox(origin);
      const later = texts.slice(texts.indexOf(receipt) + 1);
      const skipped = later.find(text => text.startsWith(`[AZPR ${review}] Automatic `));
      if (skipped) return { skipped };
      const started = later.find(text => /\] STARTED \/pr-comment /.test(text));
      const done = started && later.find(text => text.startsWith(started.split(']')[0] + ']') && RECEIPT.test(text));
      if (done) return { started, receipt: done };
      await new Promise(resolveLater => setTimeout(resolveLater, 50));
    } while (Date.now() < end);
    throw new Error('Fixture timed out waiting for the automatic comment step.');
  };

  // 1. Deterministic source check: no model request.
  const checkOrigin = await newOrigin('Check');
  const beforeCheck = requests.length;
  await api(`/api/session/${checkOrigin}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
  const check = await latest(checkOrigin);
  assert.match(check, /\] READY/, check);
  assert.equal(requests.length, beforeCheck, '/pr-check must not call a model.');
  assert.ok(check.includes(`| AZPR | ok | Running ${native ? nativePackage : 'a local source installation'}`), check);
  results.check = 'READY without model requests; names the running installation';
  if (native && !publishedPackage) {
    // A second AZPR entry (the same package without its commit): OpenCode runs the first and lists the second as a duplicate.
    const configPath = join(directories.config, 'opencode.json');
    const original = await readFile(configPath, 'utf8');
    const second = `git+file://${packageDirectory}`;
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(original), plugins: [...JSON.parse(original).plugins, second] }, null, 2));
    await stopHost();
    url = await startHost();
    await waitForCommands();
    let duplicate;
    for (const end = Date.now() + 60000; !(duplicate = (await rawApi('/api/plugin')).data.find(plugin => plugin.source?.target === second))?.state?.error;) {
      if (Date.now() > end) throw new Error(`Fixture second AZPR entry was not listed: ${JSON.stringify(duplicate)}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    assert.equal(duplicate.state.status, 'failed');
    assert.match(duplicate.state.error, /Duplicate plugin ID: azpr/);
    const duplicateOrigin = await newOrigin('Duplicate entry');
    await api(`/api/session/${duplicateOrigin}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
    const warned = await latest(duplicateOrigin);
    assert.match(warned, /\] READY/, warned);
    assert.ok(warned.includes(`| AZPR | WARNING | Another AZPR entry is configured but not running; keep one (see Upgrading in the README). Running ${nativePackage}; not running: git+file://`), warned);
    await writeFile(configPath, original);
    await stopHost();
    url = await startHost();
    await waitForCommands();
    results.duplicateEntry = 'a second AZPR entry stays unloaded (Duplicate plugin ID) and /pr-check warns';
  }

  // 2. Full review with sharded initials, a verifier repair turn and hidden shell.
  const reviewOrigin = await newOrigin('Review');
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-review', text: `${prUrl} 重點檢查狀態處理`, delivery: 'steer' });
  const receipt = await latest(reviewOrigin);
  assert.match(receipt, /\] COMPLETE\n/, receipt);
  assert.match(receipt, /repair-turns=1/);
  const reviewID = /\[AZPR ([a-f0-9]{8})\]/.exec(receipt)[1];
  const notices = await inbox(reviewOrigin);
  assert.ok(notices.some(text => /PROGRESS — PR #123 at bbbbbbbbbb: 2 changed file/.test(text)), 'Progress notices reach the conversation.');
  const reviewRequests = requests.slice(beforeCheck).filter(request => ['functional', 'risk', 'verifier'].includes(request.model));
  assert.ok(reviewRequests.length >= 5);
  for (const request of reviewRequests) {
    assert.ok(!request.tools.includes('shell'), 'Shell is hidden from private reviewers by default.');
    assert.ok(!request.tools.includes('execute'), 'CodeMode execute is hidden.');
  }
  assert.ok(reviewRequests.every(request => ['azpr_read_diff', 'azpr_read_file', 'azpr_search_code', 'azpr_find_files', 'azpr_list_files', 'azpr_pr_threads'].every(name => request.tools.includes(name))), 'Reviewers see the AZPR tools.');
  assert.ok(reviewRequests.every(request => !request.tools.some(name => /foreign|lookup/.test(name))), 'Foreign MCP tools are hidden from private reviewers.');
  assert.ok(azure.callsTo('items').some(call => call.query['versionDescriptor.version'] === 'b'.repeat(40)), 'A reviewer read HEAD through azpr_read_file.');
  assert.ok(reviewRequests.some(request => request.model === 'risk' && /^2 match\(es\) for "second line of" in 2 file\(s\)[\s\S]*\/src\/fixture\.js:2: second line of \/src\/fixture\.js/.test(request.lastTool)),
    'A reviewer searched file contents at HEAD through azpr_search_code.');
  assert.equal(azure.callsTo('items').filter(call => call.query.$format === 'zip').length, 1, 'Content search reads one repository archive per run and commit.');
  const afterGrep = count => reviewRequests.find(request => request.model === 'functional' && request.toolResults === count)?.lastTool ?? '';
  // Depending on the host, OpenCode reports that the path does not exist (2.0.32 did) or asks, which AZPR refuses with guidance.
  assert.match(afterGrep(2), /outside the local OpenCode project|Search path does not exist: \/scale_lab/, 'A native grep on a repository path gets an answer instead of waiting for approval.');
  assert.match(afterGrep(3), /outside the local OpenCode project/, 'A native grep outside the project is refused with guidance instead of waiting for approval.');
  assert.equal((await api('/api/permission/request')).data?.length ?? 0, 0, 'No private session waits for an approval.');
  const verifierRequests = reviewRequests.filter(request => request.model === 'verifier');
  assert.equal(new Set(verifierRequests.map(request => request.sessionID)).size, 1, 'The repair turn stays in the verifier session.');
  assert.ok(verifierRequests.some(request => request.last.startsWith('AZPR runtime')), 'The verifier received a correction request.');
  assert.ok(azure.callsTo('changes').length >= 1, 'The runtime reads the change list itself.');
  assert.ok(azure.callsTo('pr').length >= 3, 'The runtime reads the PR for the snapshot and rechecks versions after verification.');
  assert.ok(azure.state.calls.every(call => call.query['api-version'] === '7.1'), 'Every REST call pins api-version 7.1.');
  const saved = await readdir(join(directories.state, 'opencode', 'azpr-v2', 'reviews'));
  assert.ok(saved.includes(`${reviewID}.json`), 'Completed reviews are persisted.');
  const reviewStages = await stageRecords(receipt);
  assert.ok(reviewStages.length >= 3 && reviewStages.every(stage => stage.tokens?.requests?.length === stage.modelRequests && stage.tokens.input >= stage.modelRequests),
    'Debug stage records keep the token usage the host reported for every model request.');
  results.review = 'COMPLETE with verifier repair turn, hidden shell and persisted review';

  // 3. Preview, then publication, then a restart and an idempotent re-run.
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: '', delivery: 'steer' });
  const preview = await latest(reviewOrigin);
  assert.match(preview, /\] PREVIEW/, preview);
  assert.equal((await threads()).length, 0);
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: `${reviewID} --publish`, delivery: 'steer' });
  const posted = await latest(reviewOrigin);
  assert.match(posted, /\] POSTED/, posted);
  const created = await threads();
  assert.equal(created.length, 2, 'One summary and one inline comment.');
  assert.ok(created.every(thread => /<!-- azpr-comment:[a-f0-9]{32} -->$/.test(thread.comments[0].content)));
  assert.ok(created.some(thread => thread.threadContext?.filePath === '/src/fixture.js'));
  await stopHost();
  url = await startHost();
  await waitForCommands();
  await waitForMcp();
  const beforeRepublish = requests.length;
  const writesBefore = azure.callsTo('createThread').length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
  const republished = await latest(reviewOrigin);
  assert.match(republished, /\] POSTED/, republished);
  assert.match(republished, /ALREADY_PRESENT/);
  assert.equal(azure.callsTo('createThread').length, writesBefore, 'No duplicate comments after a restart.');
  assert.equal(requests.length, beforeRepublish, 'Re-publishing a saved plan needs no model.');
  // Someone deletes the inline comment: as in Azure DevOps the thread stays listed, flagged deleted, without content.
  Object.assign(created.find(thread => thread.threadContext), { isDeleted: true, comments: [{ id: 1, isDeleted: true, commentType: 'text' }] });
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
  const afterDelete = await latest(reviewOrigin);
  assert.match(afterDelete, /\] POSTED/, afterDelete);
  assert.match(afterDelete, /\(\/src\/fixture\.js:\d+\): DELETED; thread=\d+/, afterDelete);
  assert.equal(azure.callsTo('createThread').length, writesBefore, 'A comment deleted on the PR is not posted again.');
  results.comments = 'PREVIEW, POSTED, restart, re-run ALREADY_PRESENT without duplicates, a deleted comment DELETED and not posted again';

  // 3b. Quick review: one reviewer session, no verifier; the comment preview names the method.
  const quickOrigin = await newOrigin('Quick');
  const beforeQuick = requests.length;
  await api(`/api/session/${quickOrigin}/command`, { name: 'pr-quick', text: prUrl, delivery: 'steer' });
  const quickReceipt = await latest(quickOrigin);
  assert.match(quickReceipt, /\] COMPLETE; coverage complete; verification none \(quick review\)\n/, quickReceipt);
  assert.match(quickReceipt, /azpr-quick-reviewer: COMPLETE; session=[^;]+; model=fixture\/quick/);
  const quickRequests = requests.slice(beforeQuick);
  assert.ok(quickRequests.length >= 2 && quickRequests.every(request => request.model === 'quick'), 'Only the quick reviewer called a model.');
  assert.equal(new Set(quickRequests.map(request => request.sessionID)).size, 1, 'One quick session for the one shard.');
  assert.ok(quickRequests.every(request => !request.tools.includes('shell') && !request.tools.some(name => /foreign|lookup/.test(name))), 'The quick reviewer sees only its tools.');
  const quickStages = await stageRecords(quickReceipt);
  assert.deepEqual(quickStages.map(stage => stage.role), ['azpr-quick-reviewer']);
  assert.ok(quickStages[0].sessionReads >= 1, 'The runtime recorded what the quick session read.');
  await api(`/api/session/${quickOrigin}/command`, { name: 'pr-comment', text: '', delivery: 'steer' });
  const quickPreview = await latest(quickOrigin);
  assert.match(quickPreview, /\] PREVIEW; source review=/, quickPreview);
  assert.match(quickPreview, /🤖 AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型： `fixture\/quick`/);
  assert.match(quickPreview, /🔴 high: [^\n]+\n\n\*\*📝 Summary\*\*/);
  assert.ok(requests.slice(beforeQuick).every(request => request.model === 'quick'), 'The quick reviewer model planned the comments.');
  results.quick = 'COMPLETE with one quick session and no verifier; PREVIEW names the quick method';

  // 3c. A quick answer that is PARTIAL with unfinished work gets one follow-up in the same session;
  //     a follow-up without a usable answer keeps the answer it followed.
  for (const [context, outcome] of [['follow-up-smoke', 'completed'], ['follow-up-unusable-smoke', 'unusable']]) {
    const origin = await newOrigin(`Quick follow-up ${outcome}`);
    const before = requests.length;
    await api(`/api/session/${origin}/command`, { name: 'pr-quick', text: `${prUrl} ${context}`, delivery: 'steer' });
    const receipt = await latest(origin);
    assert.match(receipt, new RegExp(`\\] COMPLETE; coverage ${outcome === 'completed' ? 'complete' : 'incomplete'}; verification none`), receipt);
    assert.match(receipt, new RegExp(`azpr-quick-reviewer: ${outcome === 'completed' ? 'COMPLETE' : 'PARTIAL'};[^\\n]*follow-up=${outcome}`), receipt);
    const followRequests = requests.slice(before);
    assert.equal(new Set(followRequests.map(request => request.sessionID)).size, 1, 'The follow-up stays in the same session.');
    assert.equal(followRequests.filter(request => request.last.startsWith('AZPR runtime: your answer is PARTIAL')).length, 1, 'One follow-up prompt.');
    const [stage] = await stageRecords(receipt);
    assert.equal(stage.followUp.outcome, outcome);
    assert.equal(stage.result.findings.length, 1, 'The finding survives the follow-up.');
    if (outcome === 'unusable') assert.equal(stage.result.report, '提早停止。', 'The answer the follow-up followed stands.');
  }
  results.quickFollowUp = 'PARTIAL, then one follow-up in the same session: COMPLETE, or the earlier answer kept when the follow-up is unusable';

  // 3d. Automatic comment steps from a flag right after the PR URL: a preview in a run of its own;
  //     automatic publication posts a quick high-severity finding and holds back only a comment with
  //     an image, which a typed --publish posts; a review without findings gets no step.
  const writesBeforeAuto = azure.callsTo('createThread').length;
  const autoOrigin = await newOrigin('Automatic preview');
  await api(`/api/session/${autoOrigin}/command`, { name: 'pr-review', text: `${prUrl} --preview`, delivery: 'steer' });
  const autoReceipt = await reviewReceipt(autoOrigin, 'pr-review');
  assert.match(autoReceipt, /\] COMPLETE\n/, autoReceipt);
  assert.match(autoReceipt, /\*\*自動預覽\*\*（`--preview`）/, autoReceipt);
  const autoReview = /\[AZPR ([a-f0-9]{8})\]/.exec(autoReceipt)[1];
  const autoPreview = await commentStep(autoOrigin, autoReceipt);
  assert.match(autoPreview.started ?? '', new RegExp(`STARTED /pr-comment \\(automatic preview after review ${autoReview} completed; --preview\\)`), JSON.stringify(autoPreview));
  assert.match(autoPreview.receipt, new RegExp(`\\] PREVIEW; source review=${autoReview}\\nStarted automatically after review ${autoReview} completed \\(--preview\\)\\.\\n`), autoPreview.receipt);
  const quickPublishOrigin = await newOrigin('Automatic quick publication');
  await api(`/api/session/${quickPublishOrigin}/command`, { name: 'pr-quick', text: `${prUrl} --publish`, delivery: 'steer' });
  const quickPublishReceipt = await reviewReceipt(quickPublishOrigin, 'pr-quick');
  assert.match(quickPublishReceipt, /Verification hint: 1 high-severity finding\(s\)\. These findings are not independently verified; the automatic publication posts them with that disclosure/, quickPublishReceipt);
  const quickPublished = await commentStep(quickPublishOrigin, quickPublishReceipt);
  // Its markers are those of section 3: the summary is present and the deleted comment stays deleted.
  assert.match(quickPublished.receipt ?? '', /\] POSTED; [^\n]+\nStarted automatically [^\n]+\(--publish\)\.\n(?!Automatic publication held back)/, JSON.stringify(quickPublished));
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto);
  commentImage = true;
  const imageOrigin = await newOrigin('Automatic publication with an image');
  await api(`/api/session/${imageOrigin}/command`, { name: 'pr-review', text: `${prUrl} --publish`, delivery: 'steer' });
  const imageReceipt = await reviewReceipt(imageOrigin, 'pr-review');
  const imaged = await commentStep(imageOrigin, imageReceipt);
  commentImage = false;
  assert.match(imaged.receipt ?? '', /\] POSTED; [^\n]+\nStarted automatically [^\n]+\nAutomatic publication held back 1 item\(s\) for a person: the comment for F-1 \(\/src\/fixture\.js:2\) contains an image\. They are not published; after reading the preview, post them with \/pr-comment [a-f0-9]{8} --publish\n/, JSON.stringify(imaged));
  assert.match(imaged.receipt, /Publication \(VERIFIED=1\)/, imaged.receipt);
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto + 1, 'Only the summary was posted automatically.');
  const imageReview = /\[AZPR ([a-f0-9]{8})\]/.exec(imageReceipt)[1];
  const beforeTyped = requests.length;
  await api(`/api/session/${imageOrigin}/command`, { name: 'pr-comment', text: `${imageReview} --publish`, delivery: 'steer' });
  const typed = await latest(imageOrigin);
  assert.match(typed, /\] POSTED; source review=/, typed);
  assert.match(typed, /Publication \((?=[^)]*VERIFIED=1)(?=[^)]*ALREADY_PRESENT=1)[^)]*\)/, typed);
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto + 2, 'The typed --publish posted the held comment.');
  assert.equal(requests.length, beforeTyped, 'Posting the saved plan needs no model.');
  const emptyOrigin = await newOrigin('Automatic step without findings');
  await api(`/api/session/${emptyOrigin}/command`, { name: 'pr-quick', text: `${prUrl} --publish no-findings-smoke`, delivery: 'steer' });
  const emptyReceipt = await reviewReceipt(emptyOrigin, 'pr-quick');
  assert.match(emptyReceipt, /\] COMPLETE; coverage complete; verification none/, emptyReceipt);
  const requestsAfterEmpty = requests.length;
  const empty = await commentStep(emptyOrigin, emptyReceipt);
  assert.match(empty.skipped ?? '', /Automatic publication skipped: the review has no findings to comment on, so nothing was planned or posted and no model was used\./, JSON.stringify(empty));
  assert.equal(requests.length, requestsAfterEmpty, 'No model request follows a review without findings.');
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto + 2, 'Nothing more was posted.');
  results.automatic = '--preview: COMPLETE review, then its own PREVIEW run; quick --publish with a high-severity finding POSTED; --publish with an image in its inline comment: the summary POSTED, that comment held back until a typed --publish posted it; no findings: one notice, no model request';

  // 4. Cancellation of a hanging provider request.
  const cancelOrigin = await newOrigin('Cancel');
  const beforeCancel = requests.length;
  const cancelled = api(`/api/session/${cancelOrigin}/command`, { name: 'pr-review', text: `${prUrl} hang-smoke`, delivery: 'steer' });
  for (let attempt = 0; attempt < 100 && requests.length === beforeCancel; attempt++) await new Promise(r => setTimeout(r, 100));
  assert.ok(requests.length > beforeCancel, 'The hanging review must reach the provider.');
  await api(`/api/session/${cancelOrigin}/command`, { name: 'pr-stop', text: '', delivery: 'steer' });
  await cancelled;
  assert.ok((await inbox(cancelOrigin)).some(text => /\] CANCELLED/.test(text)), 'Manual cancellation leaves a CANCELLED receipt.');
  results.cancellation = 'CANCELLED';

  // 4b. A provider 503 is retried by OpenCode in the same session: the host
  // prepares the request again (context, then model.request), so AZPR allows it.
  const retryOrigin = await newOrigin('Provider retry');
  const beforeRetry = requests.length;
  await api(`/api/session/${retryOrigin}/command`, { name: 'pr-review', text: `${prUrl} retry-smoke`, delivery: 'steer' });
  const retried = await latest(retryOrigin);
  assert.match(retried, /\] COMPLETE\n/, retried);
  assert.doesNotMatch(retried, /azpr-review-risk: [^\n]*attempt=2/, 'No new session was needed.');
  const riskRequests = requests.slice(beforeRetry).filter(request => request.model === 'risk');
  assert.ok(riskRequests.length >= 2 && riskRequests[0].sessionID === riskRequests[1].sessionID && riskRequests[0].last === riskRequests[1].last, 'OpenCode resent the request in the same session.');
  const riskStage = (await stageRecords(retried)).find(stage => stage.role === 'azpr-review-risk');
  assert.equal(riskStage.requestObservations.retries.length, 1, JSON.stringify(riskStage.requestObservations));
  assert.equal(riskStage.requestObservations.retries[0].allowed, true);
  assert.equal(riskStage.requestObservations.rejected, 0);
  assert.equal(riskStage.requestObservations.kinds.primary, riskStage.requestObservations.authorizedPrimary);
  results.hostRetry = `provider 503 retried in place by OpenCode (retry delay ${riskStage.requestObservations.retries[0].delayMs ?? 'unknown'} ms); ${riskStage.requestObservations.authorizedPrimary} authorized primary requests, 0 rejected`;

  // 4c. The stage inactivity watchdog (workflow.stageIdleSeconds: 60), two reviews
  // at once: a model stream that stops sending is stopped, interrupted on the
  // host and retried; an answer that keeps streaming longer than the window runs on.
  if (replacement) results.watchdog = 'covered by the fresh run';
  else {
    const stallOrigin = await newOrigin('Stalled stream'), streamOrigin = await newOrigin('Long stream');
    const started = Date.now();
    await Promise.all([
      api(`/api/session/${stallOrigin}/command`, { name: 'pr-review', text: `${prUrl} stall-smoke`, delivery: 'steer' }),
      api(`/api/session/${streamOrigin}/command`, { name: 'pr-review', text: `${prUrl} stream-smoke`, delivery: 'steer' }),
    ]);
    const recovered = await latest(stallOrigin);
    assert.match(recovered, /\] COMPLETE\n/, recovered);
    assert.ok(recovered.includes(`azpr-review-functional: FAILED; session=${stall.sessionID}`), recovered);
    assert.match(recovered, /azpr-review-functional: FAILED; [^\n]*failure=idle; error=\[AZPR\] Stage inactivity watchdog stopped this stage: no activity for 60 s after (model request 1 was sent|a model step started) \(workflow\.stageIdleSeconds\)\./);
    assert.match(recovered, /azpr-review-functional: COMPLETE; [^\n]*attempt=2/);
    assert.match(recovered, /Inactivity notice: the stage inactivity watchdog stopped 1 stage\(s\) \(failure=idle\) after 60 s without activity: azpr-review-functional after /);
    assert.doesNotMatch(recovered, /Cancellation warning/, 'OpenCode confirmed the interrupted session settled.');
    assert.ok((await inbox(stallOrigin)).some(text => /PROGRESS — Initial F failed \(\[AZPR\] Stage inactivity watchdog stopped this stage/.test(text)), 'The retry notice names the watchdog.');
    assert.ok(stall.closed !== null, 'OpenCode closed the stalled provider stream after the interrupt.');
    const stoppedAfter = (stall.closed - stall.at) / 1000;
    assert.ok(stoppedAfter >= 59 && stoppedAfter < 75, `The stream was closed ${stoppedAfter} s after it stalled.`);
    const streamed = await latest(streamOrigin);
    assert.match(streamed, /\] COMPLETE\n/, streamed);
    assert.ok(longStream?.finishedAt, 'The long answer was streamed to the end.');
    const streamedFor = (longStream.finishedAt - longStream.at) / 1000;
    assert.ok(streamedFor > 62, `The answer streamed for ${streamedFor} s, longer than the window.`);
    assert.doesNotMatch(streamed, /failure=idle|Inactivity notice/, 'Streamed output is activity.');
    assert.doesNotMatch(streamed, /azpr-review-functional: [^\n]*attempt=2/, 'No new session was needed.');
    results.watchdog = `stalled stream stopped after ${stoppedAfter.toFixed(1)} s (failure=idle), closed by OpenCode, retried in a new session; an answer streamed for ${streamedFor.toFixed(1)} s (${longStream.chunks} chunks) ran on; both COMPLETE in ${((Date.now() - started) / 1000).toFixed(1)} s`;
  }

  // 5. Private sessions cannot run auxiliary requests; ordinary sessions can.
  const privateSession = reviewRequests.find(request => request.model === 'risk').sessionID;
  const beforeAux = requests.length;
  await assert.rejects(api(`/api/session/${privateSession}/generate`, { prompt: 'Unauthorized private generation' }));
  await api(`/api/session/${privateSession}/compact`, {});
  await api(`/api/experimental/session/${privateSession}/wait`, {});
  assert.equal(requests.length, beforeAux, 'Private sessions must not send generate or compaction requests.');
  const ordinary = await newOrigin('Ordinary');
  const generated = await api(`/api/session/${ordinary}/generate`, { prompt: 'Ordinary generation positive control' });
  assert.equal(typeof generated.data.text, 'string');
  results.auxiliary = 'private denied, ordinary allowed';

  // Ordinary conversations keep foreign tools and never see AZPR's PAT-backed tools.
  const chat = await newOrigin('Ordinary chat');
  const beforeChat = requests.length;
  await api(`/api/session/${chat}/prompt`, { text: 'Ordinary chat positive control' });
  await api(`/api/experimental/session/${chat}/wait`, {});
  const chatRequest = requests.slice(beforeChat).find(request => request.sessionID === chat);
  assert.ok(chatRequest, 'The ordinary chat reached the provider.');
  assert.ok(chatRequest.tools.some(name => /lookup/.test(name)), 'Ordinary sessions keep foreign MCP tools.');
  assert.ok(!chatRequest.tools.some(name => name.startsWith('azpr_')), 'Ordinary sessions never see AZPR tools.');
  results.toolScopes = 'AZPR tools only in private sessions; foreign MCP tools only in ordinary sessions';

  // 6. Actual TUI: the invoking conversation stays the origin and can cancel.
  const tui = spawn('python3', [join(sourceRoot, 'tests', 'tui-background.py'), binary, url, directories.work, fixture],
    { env: { ...env, AZPR_TUI_HOLD_SECONDS: process.env.AZPR_TUI_HOLD_SECONDS ?? '2' } });
  let tuiOutput = '';
  tui.stdout.on('data', data => { tuiOutput += data; });
  tui.stderr.on('data', data => { tuiOutput += data; });
  assert.equal((await once(tui, 'exit'))[0], 0, tuiOutput);
  results.tui = 'new and existing sessions cancelled from the same TUI';

  // 6b. afterReview from settings: after a COMPLETE /pr-review, AZPR publishes in a run of its own and
  //     reads the comments back. The PR's threads and publication records start empty, so every item is new.
  await stopHost();
  const settingsText = await readFile(installedSettingsPath, 'utf8');
  await writeFile(installedSettingsPath, JSON.stringify({ ...JSON.parse(settingsText), afterReview: { quick: 'none', review: 'publish', deep: 'none' } }, null, 2));
  azure.state.threads.length = 0;
  await rm(join(directories.state, 'opencode', 'azpr-v2', 'attempts'), { recursive: true, force: true });
  url = await startHost();
  await waitForCommands();
  const settingOrigin = await newOrigin('Automatic publication');
  const writesBeforeSetting = azure.callsTo('createThread').length;
  await api(`/api/session/${settingOrigin}/command`, { name: 'pr-review', text: prUrl, delivery: 'steer' });
  const settingReceipt = await reviewReceipt(settingOrigin, 'pr-review');
  assert.match(settingReceipt, /\*\*自動發布\*\*（`afterReview\.review: publish`）/, settingReceipt);
  const settingPublished = await commentStep(settingOrigin, settingReceipt);
  assert.match(settingPublished.receipt ?? '', /\] POSTED; source review=[a-f0-9]{8}\nStarted automatically after review [a-f0-9]{8} completed \(afterReview\.review: publish\)\.\n/, JSON.stringify(settingPublished));
  assert.match(settingPublished.receipt, /Publication \(VERIFIED=2\)/, settingPublished.receipt);
  const settingThreads = await threads();
  assert.equal(settingThreads.length, 2, 'One summary and one inline comment.');
  assert.ok(settingThreads.every(thread => /<!-- azpr-comment:[a-f0-9]{32} -->$/.test(thread.comments[0].content)));
  assert.equal(azure.callsTo('createThread').length - writesBeforeSetting, 2);
  // The same review again: every finding is already discussed by that comment, so automatic
  // publication has nothing new to post and posts no second summary.
  commentDiscussed = true;
  const repeatOrigin = await newOrigin('Automatic publication again');
  await api(`/api/session/${repeatOrigin}/command`, { name: 'pr-review', text: prUrl, delivery: 'steer' });
  const repeated = await commentStep(repeatOrigin, await reviewReceipt(repeatOrigin, 'pr-review'));
  commentDiscussed = false;
  assert.match(repeated.receipt ?? '', /\] NOTHING_TO_POST; source review=[a-f0-9]{8}\nStarted automatically [^\n]+\nAutomatic publication found nothing new to post: every finding is already discussed on the PR \(thread \d+\)\. The plan is saved\.\n/, JSON.stringify(repeated));
  assert.equal((await threads()).length, 2, 'No second summary.');
  assert.equal(azure.callsTo('createThread').length - writesBeforeSetting, 2);
  // Restore the settings; the next restart loads them.
  await writeFile(installedSettingsPath, settingsText);
  results.afterReviewSetting = 'afterReview.review publish: COMPLETE review, then its own comment run POSTED, VERIFIED=2 read back; the same review again with every finding already discussed: NOTHING_TO_POST, no second summary';

  // 7. A corporate network: Azure DevOps over HTTPS only through an authenticating
  // CONNECT proxy that re-signs TLS with its own CA (azure.proxy, azure.caFile, azure.verifyTls).
  if (replacement) results.proxy = 'covered by the fresh run';
  else if (spawnSync('openssl', ['version']).status !== 0) results.proxy = 'SKIPPED: openssl is unavailable';
  else {
    const pki = join(fixture, 'pki');
    await mkdir(pki);
    const openssl = args => { const result = spawnSync('openssl', args, { cwd: pki, encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stderr); };
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=AZPR fixture proxy CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1']);
    await writeFile(join(pki, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext']);
    const tlsServer = createTlsServer({ key: await readFile(join(pki, 'server.key')), cert: await readFile(join(pki, 'server.pem')) },
      (request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
    tlsServer.listen(0, '127.0.0.1');
    await once(tlsServer, 'listening');
    const tunnelTarget = `127.0.0.1:${tlsServer.address().port}`;
    const proxy = await fakeProxy({ credentials: 'azpr:p@ss w0rd' });
    const withCredentials = new URL(proxy.url);
    withCredentials.username = 'azpr';
    withCredentials.password = 'p@ss w0rd';
    const proxyShown = `proxy http://127.0.0.1:${withCredentials.port}`;
    try {
      const installedSettings = installedSettingsPath;
      const base = JSON.parse(await readFile(installedSettings, 'utf8'));
      // Settings are read once, so every variant needs a host restart.
      const checkWith = async network => {
        await stopHost();
        await writeFile(installedSettings, JSON.stringify({ ...base, azure: { ...base.azure, proxy: '', caFile: '', verifyTls: true, ...network } }, null, 2));
        env.AZPR_TEST_AZURE_BASE_URL = `https://${tunnelTarget}`;
        url = await startHost();
        await waitForCommands();
        const origin = await newOrigin('Proxy check');
        await api(`/api/session/${origin}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
        return latest(origin);
      };
      const reached = azure.state.calls.length;
      const ready = await checkWith({ proxy: withCredentials.href, caFile: join(pki, 'ca.pem') });
      assert.match(ready, /\] READY/, ready);
      assert.ok(ready.includes(`${proxyShown} with credentials; 1 extra CA certificate(s) from azure.caFile`), ready);
      assert.ok(!ready.includes('w0rd'), 'Proxy credentials are never shown.');
      const tunnels = proxy.events.filter(event => event.type === 'connect');
      assert.ok(tunnels.length >= 1 && proxy.events.length === tunnels.length, JSON.stringify(proxy.events));
      assert.ok(tunnels.every(event => event.target === tunnelTarget && event.authorization === null &&
        event.proxyAuthorization === `Basic ${Buffer.from('azpr:p@ss w0rd').toString('base64')}`), 'Bun tunnels with percent-decoded proxy credentials; the PAT stays inside TLS.');
      assert.ok(azure.state.calls.length > reached, 'Azure DevOps calls arrived through the tunnel.');

      const beforeUntrusted = azure.state.calls.length;
      const untrusted = await checkWith({ proxy: withCredentials.href });
      assert.match(untrusted, /\] NOT_READY[\s\S]*PR metadata \| FAILED \| Azure DevOps PR failed: the server's TLS certificate was not accepted \([A-Z_]+\)\. If a proxy inspects HTTPS, set azure\.caFile/, untrusted);
      assert.doesNotMatch(untrusted, /after \d attempts/, 'A rejected certificate is not retried.');
      assert.equal(azure.state.calls.length, beforeUntrusted, 'Nothing reaches Azure DevOps over an untrusted connection.');

      const refused = await checkWith({ proxy: proxy.url, caFile: join(pki, 'ca.pem') });
      assert.match(refused, /\] NOT_READY[\s\S]*PR metadata \| FAILED \| A proxy refused PR: it requires authentication \(HTTP 407\)\. Put the proxy user name and password in azure\.proxy/, refused);

      const insecure = await checkWith({ proxy: withCredentials.href, verifyTls: false });
      assert.match(insecure, /\] READY/, insecure);
      assert.match(insecure, /\| TLS verification \| WARNING \| Disabled by azure\.verifyTls: false/);
      results.proxy = `READY through an authenticating CONNECT proxy with azure.caFile (${tunnels.length} tunnel(s)); untrusted certificate NOT_READY without retry; 407 explained; verifyTls false READY with a warning`;
    } finally {
      await proxy.close();
      tlsServer.closeAllConnections();
      await new Promise(resolveClosed => tlsServer.close(resolveClosed));
    }
  }

  console.log(JSON.stringify({ status: 'PASS', installation: native ? 'native' : replacement ? 'replace' : 'fresh', host: hostVersion, providerRequests: requests.length, azureCalls: azure.state.calls.length, results, fixture }, null, 2));
} finally {
  await stopHost();
  provider.closeAllConnections();
  await new Promise(resolveClosed => provider.close(resolveClosed));
  adoServer.closeAllConnections();
  await new Promise(resolveClosed => adoServer.close(resolveClosed));
  await writeFile(join(fixture, 'azure-calls.json'), JSON.stringify(azure.state.calls, null, 2));
  await writeFile(join(fixture, 'host.log'), logs);
  await writeFile(join(fixture, 'provider-requests.json'), JSON.stringify(requests, null, 2));
  console.error(`Private fixture evidence: ${fixture}`);
}
