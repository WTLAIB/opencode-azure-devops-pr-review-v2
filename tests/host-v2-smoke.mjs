import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
import { fakeProxy } from './fake-proxy.mjs';
import { TESTED_HOST_VERSION } from '../src/host.mjs';
/**
 * Opt-in exact-host fixture: node tests/host-v2-smoke.mjs /absolute/path/opencode [--replace|--native [--package SPEC]]
 * --native packs the package, loads its real entry with external
 * settings, exercises first-run setup, reviews once with exactly the settings
 * that setup wrote (two passes of one model, which the provider cannot tell
 * apart: the runtime removes their identical findings, the same model rates
 * and the default comment preview follows) and then runs the same review
 * workflow.
 * --package SPEC installs that published package instead (an npm version such
 * as opencode-azure-devops-pr-review@0.2.1, or a Git specification; needs the
 * network) to check a release after publication.
 * Isolated directories, a loopback deterministic provider, a loopback fake
 * Azure DevOps REST service (api-version 7.1, persistent thread state), two
 * foreign stdio MCP servers (one direct, one behind CodeMode) and an image
 * model. Covers the deterministic source check; a mode without reviewer models
 * (/pr-deep here), which is refused before any session starts; a full review
 * of two passes with a model each, in which reviewers read through AZPR's
 * tools while foreign tools, CodeMode MCP tools and image generation stay
 * hidden; the duplicate check, which merges what the two passes reported at
 * one place after a correction turn in its session; the severity rating, one
 * request without tools whose input carries no level; the saved record of how
 * the findings were produced; comment preview and idempotent publication
 * across a host restart; a quick review (one reviewer session and its rating)
 * and the follow-up turn of a PARTIAL answer; cancellation; a provider 503
 * that OpenCode retries in the same session; a provider stream cut mid-answer
 * whose step OpenCode retries; and private auxiliary-request denial. The
 * private sessions are sessions of their own: the conversation's model gets no
 * request while a review runs. Automatic comment
 * steps: a flag after the PR URL previews the comments of a COMPLETE review in
 * a run of its own, automatic publication posts a quick review's
 * finding and holds back only a comment with an image until a
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
// /pr-review: two passes with a model each, so that the fake provider can tell them apart; the first one also
// checks duplicates and plans the comments. The severity rating gets its own model here, so its requests can be
// told from theirs. /pr-quick: one pass, whose model also rates (rater: ""). /pr-deep stays off, as the example
// leaves it: a list without a model.
settings.models.review = { reviewers: ['fixture/first', 'fixture/second'], rater: 'fixture/rater' };
settings.models.quick = { reviewers: ['fixture/quick'], rater: '' };
assert.deepEqual(settings.models.deep, { reviewers: [], rater: '' }, 'The settings example leaves /pr-deep off.');
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
// The smallest inactivity window, so the stalled-stream step takes about a
// minute; the hanging reviews below are stopped well before it (keep
// AZPR_TUI_HOLD_SECONDS under 60).
settings.workflow = { ...settings.workflow, stageIdleSeconds: 60 };
settings.outputLanguage = 'zh-TW';
// These steps drive each comment step themselves; the default (a preview after every review) is covered by the runtime tests.
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
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
// It sees a request's model ID, its session and the stage's payload (the first user message), never a role
// name. What a request is for follows from the payload alone (`kind`): a reviewer pass, the duplicate check, the
// severity rating, comment planning or an ordinary conversation. The model ID tells the two passes of /pr-review
// apart only where they have a model each ('first' and 'second'); two passes of one model get the same answers.
const requests = [];
const overloaded = new Set();
let child, logs = '', stall = null, longStream = null, commentImage = false, commentDiscussed = false;
const cut = new Set();
const lastUser = messages => messages?.findLast(message => message.role === 'user')?.content;
const firstUser = messages => messages?.find(message => message.role === 'user')?.content;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const kindOf = payload => payload?.assignment?.kind === 'duplicates' ? 'duplicates' : payload?.assignment?.kind === 'rating' ? 'rating'
  : Array.isArray(payload?.assignment?.files) ? 'review' : ['group', 'plan'].includes(payload?.commentWork?.kind) ? payload.commentWork.kind : 'chat';
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  const sessionID = request.headers['x-opencode-session-id'];
  let payload;
  try { payload = JSON.parse(textOf(firstUser(parsed.messages))); } catch { /* ordinary chat */ }
  const kind = kindOf(payload);
  requests.push({ path: request.url, model: parsed.model, sessionID, kind, tools: (parsed.tools ?? []).map(tool => tool.function?.name), last: textOf(lastUser(parsed.messages)).slice(0, 200),
    first: textOf(firstUser(parsed.messages)).slice(0, 20000),
    toolResults: parsed.messages?.filter(message => message.role === 'tool').length ?? 0,
    lastTool: textOf(parsed.messages?.findLast(message => message.role === 'tool')?.content).slice(0, 600) });
  const repair = textOf(lastUser(parsed.messages)).startsWith('AZPR runtime');
  const toolResults = parsed.messages?.filter(message => message.role === 'tool').length ?? 0;
  if (payload?.userContext?.includes('hang-smoke')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture waits for cancellation\n\n');
    return;
  }
  // The first request of each session of the second review pass fails once, like an overloaded provider.
  if (payload?.userContext?.includes('retry-smoke') && kind === 'review' && parsed.model === 'second' && !overloaded.has(sessionID)) {
    overloaded.add(sessionID);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fixture provider overloaded', type: 'server_error' } }));
    return;
  }
  // The stream of the first session of the first review pass starts and then stops sending.
  if (payload?.userContext?.includes('stall-smoke') && kind === 'review' && parsed.model === 'first' && !stall) {
    stall = { sessionID, at: Date.now(), closed: null };
    response.on('close', () => { stall.closed = Date.now(); });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture stream stalls\n\n');
    return;
  }
  const fileTool = parsed.tools?.find(tool => tool.function?.name === 'azpr_read_file')?.function.name;
  let call, final = 'Ordinary fixture answer.';
  // Every reviewer reports the same defect at the same line, as medium. The second review model words it
  // differently: its record is no exact duplicate of the first model's, so the duplicate check has to merge it.
  const finding = (id, path) => ({ id, summary: parsed.model === 'second' ? '少了防護，狀態會遺失' : '缺少防護會遺失狀態', evidence: 'HEAD: `fixture code` 略過防護。BASE: 有防護。', counterevidence: '呼叫端沒有再次檢查。', location: `head:${path}:1`, severity: 'medium', suggestion: '恢復防護並加上回歸測試。' });
  if (kind === 'review') {
    const files = payload.assignment.files;
    // Every reviewer reads the file first: the runtime accepts a finding only at a file its own session read.
    if (!toolResults && fileTool) call = { name: fileTool, arguments: { path: files[0], version: 'head' } };
    // A reviewer mistaking a repository path for a local one must get an answer, not a pending approval.
    else if (toolResults === 1 && parsed.model === 'first' && parsed.tools?.some(tool => tool.function?.name === 'grep')) call = { name: 'grep', arguments: { pattern: 'guard', path: '/scale_lab' } };
    // An existing directory outside the project reaches the permission hook, whatever the host's default.
    else if (toolResults === 2 && parsed.model === 'first' && parsed.tools?.some(tool => tool.function?.name === 'grep')) call = { name: 'grep', arguments: { pattern: 'guard', path: '/etc' } };
    else if (toolResults === 1 && parsed.model === 'second') call = { name: 'azpr_search_code', arguments: { query: 'second line of', path: '/src' } };
    // A quick reviewer that stops early: PARTIAL with a gap; its one follow-up finishes the review or gives no usable answer.
    else if (payload.userContext?.includes('no-findings-smoke')) final = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [], report: '沒有發現。' });
    else if (payload.userContext?.includes('follow-up') && parsed.model === 'quick' && !repair) final = JSON.stringify({ status: 'PARTIAL', coverage: { files, gaps: ['呼叫端尚未查核。'] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '提早停止。' });
    else if (payload.userContext?.includes('follow-up-unusable') && parsed.model === 'quick') final = '還在查核呼叫端。';
    else final = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '審查完成。' });
  } else if (kind === 'duplicates') {
    // What two sessions reported in one file. The first answer merges the two findings into each other, which
    // leaves no finding that stays; on the correction turn the later ones are merged into the first.
    const [kept, ...others] = payload.assignment.findingIds;
    final = JSON.stringify({ status: 'COMPLETE', report: '', merged: repair
      ? others.map(id => ({ id, mergedInto: kept, reason: '相同根因與修正。' }))
      : [{ id: kept, mergedInto: others[0], reason: '相同根因。' }, { id: others[0], mergedInto: kept, reason: '相同根因。' }] });
  } else if (kind === 'rating') {
    // The rating session has only the finding text: it answers with a level for every finding, above the reviewers'.
    final = JSON.stringify({ status: 'COMPLETE', ratings: payload.assignment.findingIds.map(id => ({ id, severity: 'high', reason: '一般使用就會遺失狀態。' })), report: '' });
  } else if (kind === 'group') {
    // The pass before several planning pages: nothing repeats in these reviews.
    final = JSON.stringify({ status: 'READY', groups: [] });
  } else if (kind === 'plan' && commentDiscussed && Array.isArray(payload.existingDiscussions)) {
    // Every finding is already discussed by AZPR's own comment on the PR.
    const threadId = payload.existingDiscussions.find(thread => thread.azpr && thread.path)?.threadId;
    final = JSON.stringify({ status: 'READY', comments: [], skipped: payload.findings.map(item => ({ findingId: item.id, cause: 'existing-thread', threadId, reason: `討論串 ${threadId} 已說明。` })) });
  } else if (kind === 'plan') {
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
  // The first answer of each quick reviewer session breaks off mid-stream: the connection closes after part of the text.
  if (payload?.userContext?.includes('cut-smoke') && kind === 'review' && parsed.model === 'quick' && !call && !cut.has(sessionID)) {
    cut.add(sessionID);
    emit({ id: 'chatcmpl_cut', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: final.slice(0, 60) }, finish_reason: null }] });
    setTimeout(() => response.destroy(), 150);
    return;
  }
  // The answer of the first session of the first review pass, after its reads, streams for 66 s, one chunk per second.
  if (payload?.userContext?.includes('stream-smoke') && kind === 'review' && parsed.model === 'first' && !call && !longStream) {
    longStream = { sessionID, at: Date.now(), chunks: 0, finishedAt: null };
    const send = (content, finish_reason = null) => emit({ id: 'chatcmpl_long', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: content, finish_reason }] });
    send({ role: 'assistant' });
    const timer = setInterval(() => {
      const chunk = ++longStream.chunks;
      send({ content: final.slice(Math.ceil(final.length * (chunk - 1) / 66), Math.ceil(final.length * chunk / 66)) });
      if (chunk < 66) return;
      clearInterval(timer);
      longStream.finishedAt = Date.now();
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    }, 1000);
    response.on('close', () => clearInterval(timer));
    return;
  }
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
    // An image model makes OpenCode 2.2.2 and later offer experimental_image_generate to every agent.
    models: { ...Object.fromEntries(['fixture', 'first', 'second', 'rater', 'quick'].map(id => [id, { limit: { context: 100000, output: 4000 } }])),
      image: { type: 'image', limit: { context: 100000, output: 4000 } } } } },
  // With CodeMode execute denied, OpenCode 2.2.0 and later list a CodeMode MCP server's tools directly.
  mcp: { servers: { foreign: { type: 'local', command: [process.execPath, foreignPath], codemode: false },
    'foreign-codemode': { type: 'local', command: [process.execPath, foreignPath], codemode: true } } },
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
        commands.some(command => command.name === name && (!configured || !command.description?.includes('not ready here'))))) return;
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    } while (Date.now() < end);
    throw new Error('Fixture AZPR command catalog did not finish loading.');
  };
  await waitForCommands(!native);
  const hostVersion = (await api('/api/info')).version;
  assert.equal(hostVersion, TESTED_HOST_VERSION, `OpenCode ${hostVersion} is not the tested ${TESTED_HOST_VERSION}.`);
  const newOrigin = async title => (await api('/api/session', { title, location: { directory: directories.work } })).data.id;
  const latest = async origin => (await api(`/api/session/${origin}/inbox`)).data.at(-1)?.payload?.text ?? '';
  const inbox = async origin => (await api(`/api/session/${origin}/inbox`)).data.map(item => item.payload?.text ?? '');
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123';
  const stageRecords = async receipt => JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(receipt)[1], 'result.json'), 'utf8')).stages;
  // A completed review as AZPR saved it: the record says how its findings were produced.
  const savedReview = async id => JSON.parse(JSON.parse(await readFile(join(directories.state, 'opencode', 'azpr-v2', 'reviews', `${id}.json`), 'utf8')).body);
  // The report a review left in the session its receipt names.
  const reportOf = async receipt => {
    const [, id] = /\[AZPR ([a-f0-9]{8})\]/.exec(receipt), holder = /\nReport delivery: report queued to session=(ses_\w+)\.\n/.exec(receipt)?.[1];
    assert.ok(holder, receipt);
    return (await inbox(holder)).find(text => text.startsWith(`# AZPR ${id} — COMPLETE\n\n`)) ?? '';
  };
  const RECEIPT = /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/;
  // The first line of a review's receipt: status, coverage (with several passes: how many files every pass reviewed) and verification.
  const COMPLETE_TWO_PASSES = /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete, 2\/2 file\(s\) in every pass; verification none\n/;
  const COMPLETE_ONE_PASS = /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete; verification none\n/;
  // What a review's receipt says of its status, in one text for every mode.
  const STATUS = '\nStatus: COMPLETE means at least one review session produced a usable result and no source-commit change was detected. A REPORTED finding was checked by its reviewer against the source and by the runtime for form and source only; nothing verified it separately. A finding that failed the runtime\'s checks, or that comes from an answer that was not usable, is NEEDS_INFO. Coverage says whether every changed file was reviewed, and with several passes how many files every pass reviewed. STALE means the PR source commit changed during the review. PARTIAL means no session produced a usable result. None of these approves the PR.\n';
  // A review's receipt, found by its STARTED notice (which names the passes): a comment step it hands on may already have notices after it.
  const reviewReceipt = async (origin, name) => {
    const texts = await inbox(origin);
    const prefix = texts.findLast(text => text.includes(`] STARTED /${name} (`)).split(']')[0] + ']';
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
  // The private roles of settings with two review passes and one quick pass, both with a rating: one reviewer role
  // per entry of a mode's list, and none for /pr-deep, whose list is empty.
  const PRIVATE_ROLES = ['azpr-quick-comment-plan', 'azpr-quick-dedupe', 'azpr-quick-rating', 'azpr-quick-reviewer', 'azpr-review-comment-plan',
    'azpr-review-comment-plan-verified', 'azpr-review-dedupe', 'azpr-review-rating', 'azpr-review-reviewer', 'azpr-review-reviewerb'];
  const privateRoles = async () => (await rawApi('/api/agent')).data.map(agent => agent.name).filter(name => name.startsWith('azpr-')).sort();
  let nativeSetup;
  if (native) {
    const origin = (await rawApi('/api/session', { title: 'Native setup', location: { directory: directories.work } })).data.id;
    const invoke = async (name, text) => {
      await rawApi(`/api/session/${origin}/command`, { name, text, delivery: 'steer' });
      return (await rawApi(`/api/session/${origin}/inbox`)).data.at(-1)?.payload?.text ?? '';
    };
    assert.deepEqual(await privateRoles(), []);
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
    // A first setup is loaded at once: nothing was in use before it, so this is the one time the settings are read.
    assert.equal(saved, `[AZPR] SETTINGS SAVED\nSettings: ${externalSettings}\nOrganization: fixture; PAT file: ${patFile}\nAZPR has loaded them: run /pr-check <PR URL>. No model or Azure request was made.`);
    const initial = JSON.parse(await readFile(externalSettings, 'utf8'));
    assert.equal((await stat(externalSettings)).mode & 0o777, 0o600);
    // One model named for a first setup: two review passes and one quick pass of it, the first reviewer model
    // rating (rater: ""), and /pr-deep left off. The file is in this version's layout.
    assert.equal(initial.version, 3);
    assert.deepEqual(initial.models, { review: { reviewers: ['fixture/fixture', 'fixture/fixture'], rater: '' },
      quick: { reviewers: ['fixture/fixture'], rater: '' }, deep: { reviewers: [], rater: '' } });
    // The file names every setting from the start, those setup does not ask for at their defaults.
    assert.deepEqual([initial.terminalPanel, initial.afterReview, initial.workflow.shardFiles], ['auto', { quick: 'preview', review: 'preview', deep: 'preview' }, 25]);
    assert.ok(!Object.hasOwn(initial.workflow, 'shardFindings'), 'The verifier\'s batch size is no setting any more.');
    assert.equal(initial.azure.pat, '');
    assert.equal(initial.azure.patFile, patFile);
    // Without a restart the private roles are registered and the review commands are the real ones.
    for (let attempt = 0; attempt < 50 && !(await privateRoles()).length; attempt++) await new Promise(resolveReady => setTimeout(resolveReady, 100));
    assert.deepEqual(await privateRoles(), PRIVATE_ROLES, 'The first setup loaded the runtime with the roles of the lists it wrote.');
    assert.ok((await rawApi('/api/command')).data.filter(command => command.name.startsWith('pr-')).every(command => !/not ready here/.test(command.description ?? '')));
    assert.match(await invoke('pr-review', '--help'), /^\[AZPR\] \/pr-review <Azure DevOps PR URL>/, 'The review command itself answers.');
    assert.equal(requests.length, 0);
    assert.equal(azure.state.calls.length, 0);
    // A review with exactly what setup wrote, without a restart: two passes of one model, which nothing tells
    // apart by its model ID. Both report the same finding in the same words, so the runtime removes the exact
    // duplicate and no duplicate check is asked; the first reviewer model rates; and the default comment step
    // follows, a preview that posts nothing.
    const firstOrigin = await newOrigin('First review');
    await api(`/api/session/${firstOrigin}/command`, { name: 'pr-review', text: setupUrl, delivery: 'steer' });
    const firstReceipt = await reviewReceipt(firstOrigin, 'pr-review');
    const firstReview = /\[AZPR ([a-f0-9]{8})\]/.exec(firstReceipt)[1];
    assert.ok((await inbox(firstOrigin)).includes(`[AZPR ${firstReview}] STARTED /pr-review (2 passes: fixture/fixture, fixture/fixture). Work continues in this OpenCode process; the result will return to this conversation. After a COMPLETE review it previews the comments automatically (afterReview.review: preview); nothing is posted. Stop with /pr-stop ${firstReview}.`),
      'The start notice names the passes and the comment step that follows.');
    assert.match(firstReceipt, COMPLETE_TWO_PASSES, firstReceipt);
    assert.match(firstReceipt, /^- azpr-review-reviewer \[pass 1\/2\]: COMPLETE; session=ses_\w+; model=fixture\/fixture$/m, firstReceipt);
    assert.match(firstReceipt, /^- azpr-review-reviewerb \[pass 2\/2\]: COMPLETE; session=ses_\w+; model=fixture\/fixture$/m, firstReceipt);
    assert.match(firstReceipt, /^- azpr-review-rating: COMPLETE; session=ses_\w+; model=fixture\/fixture$/m, firstReceipt);
    assert.doesNotMatch(firstReceipt, /azpr-review-dedupe|Repair notice|Retry notice/, 'Identical records need no duplicate check.');
    assert.ok(firstReceipt.includes(STATUS), firstReceipt);
    assert.match(firstReceipt, /\n\*\*Automatic preview\*\* \(`afterReview\.review: preview`\): AZPR now plans a comment preview as a separate command with its own receipt; nothing is posted\./, firstReceipt);
    const firstPreview = await commentStep(firstOrigin, firstReceipt);
    assert.match(firstPreview.started ?? '', new RegExp(`STARTED /pr-comment \\(automatic preview after review ${firstReview} completed; afterReview\\.review: preview\\)`), JSON.stringify(firstPreview));
    assert.match(firstPreview.receipt, new RegExp(`^\\[AZPR [a-f0-9]{8}\\] PREVIEW; source review=${firstReview}\\nActed on review ${firstReview} \\(/pr-review\\) of PR #123 in project/repository\\.\\nStarted automatically after review ${firstReview} completed \\(afterReview\\.review: preview\\)\\.\\n`), firstPreview.receipt);
    assert.match(firstPreview.receipt, /\nInline comments prepared: 1\n/, firstPreview.receipt);
    // The level is the rating's (the reviewers said medium), and the comment says how the review was made, in the settings' language.
    assert.match(firstPreview.receipt, /\n🔴 high: [^\n]+\n\n\*\*📝 Summary\*\*/, firstPreview.receipt);
    assert.ok(firstPreview.receipt.includes('\n🤖 AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification. Models: `fixture/fixture`\n'), firstPreview.receipt);
    assert.equal(azure.callsTo('createThread').length, 0, 'A preview posts nothing.');
    // Every request ran in a private session of its own, on the one model: two reviewer sessions (a file read and
    // the answer each), one rating request without tools, then comment planning.
    assert.ok(requests.every(request => request.model === 'fixture' && request.sessionID !== firstOrigin && request.sessionID !== origin), JSON.stringify(requests.map(request => [request.model, request.kind])));
    const firstKinds = kind => requests.filter(request => request.kind === kind);
    assert.deepEqual([firstKinds('review').length, new Set(firstKinds('review').map(request => request.sessionID)).size, firstKinds('duplicates').length, firstKinds('rating').length, firstKinds('plan').length > 0],
      [4, 2, 0, 1, true], JSON.stringify(requests.map(request => [request.kind, request.sessionID])));
    assert.deepEqual(firstKinds('rating')[0].tools, [], 'The rating session is offered no tool.');
    // The saved record says how the findings were produced: the two passes, no duplicate check (the two records
    // were identical, which the runtime settles itself) and the rating by the first reviewer model.
    const firstRecord = await savedReview(firstReview);
    assert.equal(firstRecord.verification, 'none');
    assert.deepEqual(firstRecord.method, { kind: 'reviewers', version: 1, requested: ['fixture/fixture', 'fixture/fixture'],
      passes: [{ pass: 1, model: 'fixture/fixture', sessions: 1, failed: 0 }, { pass: 2, model: 'fixture/fixture', sessions: 1, failed: 0 }],
      duplicateCheck: { groups: 0, failed: 0, merged: 0, refused: 0 },
      rating: { state: 'first', model: 'fixture/fixture', sessions: 1, failed: 0, rated: 1, kept: 0 } });
    assert.deepEqual(firstRecord.final.dispositions.map(row => [row.id, row.status, row.mergedInto ?? null, row.sessions, row.reason]),
      [['F-1', 'REPORTED', null, ['1/1 pass 1', '1/1 pass 2'], 'Reported by its reviewer, which checked it against the source it read; it passed the runtime\'s format and source checks. No separate verification ran.'],
        ['F-2', 'MERGED', 'F-1', ['1/1 pass 2'], 'Identical in every field to F-1. [Runtime: exact duplicate.]']]);
    assert.deepEqual([firstRecord.final.dispositions[0].reviewerSeverity, firstRecord.final.dispositions[0].ratedSeverity, firstRecord.final.dispositions[0].finding.severity], ['medium', 'high', 'high']);
    const requestsAfterFirst = requests.length;
    // The copy OpenCode installed (under its package cache) holds no settings.
    const installedCopies = (await readdir(directories.cache, { recursive: true }))
      .filter(path => path.includes('node_modules') && path.endsWith(join('src', 'setup.mjs')))
      .map(path => join(directories.cache, dirname(dirname(path))));
    assert.ok(installedCopies.length > 0, 'OpenCode installed the AZPR package under its cache.');
    for (const copy of [packageDirectory, ...installedCopies]) await assert.rejects(stat(join(copy, 'src', 'settings.json')), { code: 'ENOENT' });
    // Use the workflow fixture's models (one per review pass, a rater of its own) and diagnostics after
    // proving that setup saves the one selected model as the lists of each mode and no secret.
    await stopHost();
    assert.equal(requests.length, requestsAfterFirst, 'Nothing asked a model after the first review and its preview.');
    settings.azure = { ...settings.azure, pat: '', patFile };
    await mkdir(dirname(selectedSettings), { mode: 0o700 });
    await writeFile(selectedSettings, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rm(externalSettings);
    const config = JSON.parse(await readFile(join(directories.config, 'opencode.json'), 'utf8'));
    config.plugins = config.plugins.map(plugin => plugin === nativePackage ? { package: nativePackage, options: { settingsFile: selectedSettings } } : plugin);
    await writeFile(join(directories.config, 'opencode.json'), JSON.stringify(config, null, 2));
    url = await startHost();
    await waitForCommands();
    nativeSetup = `${publishedPackage ? `CLI plugin add ${publishedPackage}` : 'npm pack plus CLI plugin add from an isolated Git commit'}; missing config blocks reviews; setup validates model and private PAT file without network calls and is loaded without a restart, uses the default XDG PAT file and takes the organization from a PR URL; it writes the model as two review passes and one quick pass, and a review with exactly those settings completes (identical findings of the two passes removed by the runtime, rating by the same model, the default preview after it); default XDG and explicit options.settingsFile both work; external mode-600 settings survive restart; installed package holds no settings or PAT`;
  }
  const waitForMcp = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const connected = new Set(((await api('/api/mcp')).data ?? []).filter(server => server.status?.status === 'connected').map(server => server.name));
      if (connected.has('foreign') && connected.has('foreign-codemode')) return;
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    }
    throw new Error('Fixture MCP did not connect.');
  };
  await waitForMcp();
  const commands = await api('/api/command');
  for (const name of ['pr-check', 'pr-review', 'pr-stop', 'pr-deep', 'pr-quick', 'pr-comment']) assert.ok(commands.data.some(command => command.name === name), name);
  assert.deepEqual(await privateRoles(), PRIVATE_ROLES, 'One reviewer role per entry of a mode\'s list, the duplicate check, the rating and comment planning; none for /pr-deep, which is off.');
  const results = nativeSetup ? { nativeSetup } : {};

  // 1. Deterministic source check: no model request.
  const checkOrigin = await newOrigin('Check');
  const beforeCheck = requests.length;
  await api(`/api/session/${checkOrigin}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
  const check = await latest(checkOrigin);
  assert.match(check, /\] READY/, check);
  assert.equal(requests.length, beforeCheck, '/pr-check must not call a model.');
  assert.ok(check.includes(`| AZPR | ok | Running ${native ? nativePackage : 'a local source installation'}`), check);
  // What each mode runs with: its passes in order and the model that rates; a mode without a model is off.
  for (const row of ['| Review models | ok | 2 passes: fixture/first, fixture/second; severity rating by fixture/rater. |',
    '| Deep models | ok | Not set: /pr-deep stays off until models.deep.reviewers names at least one model (stronger models than models.review.reviewers, or more passes). |',
    '| Quick models | ok | 1 pass: fixture/quick; severity rating by fixture/quick (the first reviewer model). |']) assert.ok(check.includes(`\n${row}\n`), check);
  assert.ok(check.includes('\n\nModels checked: reviewers[0], reviewers[1], rater (profile review). Also checked for /pr-quick: reviewers[0] (profile quick).\n'), check);
  results.check = 'READY without model requests; names the running installation and the models of each mode';
  // 1b. A mode whose list names no model is off: its command is refused at once, with the reason, and starts
  //     nothing: no notice, no session, no model or Azure DevOps request.
  const offOrigin = await newOrigin('Deep is off');
  const sessionsBeforeOff = new Set((await rawApi('/api/session')).data.map(session => session.id));
  assert.ok(sessionsBeforeOff.has(offOrigin), 'The session list shows a session created a moment ago.');
  const callsBeforeOff = azure.state.calls.length;
  const refusal = await fetch(`${url}/api/session/${offOrigin}/command`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': directories.work },
    body: JSON.stringify({ name: 'pr-deep', text: prUrl, delivery: 'steer' }), signal: AbortSignal.timeout(60000) });
  const refusalText = await refusal.text();
  // OpenCode answers a command that throws with its error (2.3.2: HTTP 500, CommandExecutionError).
  assert.equal(refusal.ok, false, refusalText);
  assert.deepEqual(JSON.parse(refusalText), { _tag: 'CommandExecutionError', command: 'pr-deep',
    message: '[AZPR] /pr-deep is off: models.deep.reviewers names no model. Name at least one with /pr-setup or in the settings file (stronger than those of models.review, or more passes), then restart the OpenCode service (opencode service restart). No fallback to the models of another mode.' }, `${refusal.status} ${refusalText}`);
  assert.deepEqual(await inbox(offOrigin), [], 'A refused command leaves no notice.');
  assert.deepEqual((await rawApi('/api/session')).data.map(session => session.id).filter(id => !sessionsBeforeOff.has(id)), [], 'A refused command starts no session.');
  assert.equal(requests.length, beforeCheck, 'A refused command asks no model.');
  assert.equal(azure.state.calls.length, callsBeforeOff, 'A refused command makes no Azure DevOps request.');
  results.modeOff = '/pr-deep without reviewer models is refused with the reason; no notice, session, model or Azure DevOps request';
  // A conversation nobody named: its first command with a PR names it after that PR, since an AZPR command never
  // makes the conversation's own model run, which is what names a conversation otherwise. One that has a name keeps it.
  const unnamed = (await api('/api/session', { location: { directory: directories.work } })).data.id;
  assert.ok(!(await rawApi(`/api/session/${unnamed}`)).data.title, 'OpenCode leaves a new conversation without a title.');
  await api(`/api/session/${unnamed}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
  const unnamedCheck = await latest(unnamed);
  assert.match(unnamedCheck, /\] READY/);
  let named;
  for (const end = Date.now() + 10000; !(named = (await rawApi(`/api/session/${unnamed}`)).data.title) && Date.now() < end;) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(named, 'AZPR: PR #123 (repository)');
  assert.equal((await rawApi(`/api/session/${checkOrigin}`)).data.title, 'Check', 'A conversation that has a name keeps it.');
  assert.equal(requests.length, beforeCheck, 'Naming a conversation asks no model.');
  // OpenCode has no rename that applies only to an unnamed conversation, so AZPR watches the renames the host
  // reports and lets a name that anyone else gave stand. That depends on this host reporting them to a plugin:
  // the run's debug record says that AZPR's own rename came back in the feed, and that a named one was left alone.
  const nameRecord = async receipt => {
    const directory = /Private debug directory: ([^\n]+)/.exec(receipt)?.[1];
    assert.ok(directory, 'The check\'s receipt names its debug directory.');
    for (const end = Date.now() + 10000; Date.now() < end;) {
      try { return JSON.parse(await readFile(join(directory, 'conversation-name.json'), 'utf8')); } catch { await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
    }
    return undefined;
  };
  assert.deepEqual(await nameRecord(unnamedCheck), { outcome: 'named', title: 'AZPR: PR #123 (repository)' }, 'The host reported AZPR\'s rename of the conversation.');
  assert.deepEqual(await nameRecord(check), { outcome: 'kept' });
  results.title = 'an unnamed conversation is named after the PR, and the host reports the rename; a named one keeps its name';
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

  // 2. Full review: two passes with a model each, the duplicate check with a correction turn, the severity
  //    rating, and hidden shell.
  const reviewOrigin = await newOrigin('Review');
  const beforeReview = requests.length, callsBeforeReview = azure.state.calls.length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-review', text: `${prUrl} 重點檢查狀態處理`, delivery: 'steer' });
  const receipt = await latest(reviewOrigin);
  assert.match(receipt, COMPLETE_TWO_PASSES, receipt);
  const reviewID = /\[AZPR ([a-f0-9]{8})\]/.exec(receipt)[1];
  // One line per stage: the two passes (in the order their sessions were created), then the duplicate check,
  // which runs with the first reviewer model and needed one correction turn, then the rating on its own model.
  assert.match(receipt, /^- azpr-review-reviewer \[pass 1\/2\]: COMPLETE; session=ses_\w+; model=fixture\/first; observed-tool-errors=2$/m, receipt);
  assert.match(receipt, /^- azpr-review-reviewerb \[pass 2\/2\]: COMPLETE; session=ses_\w+; model=fixture\/second$/m, receipt);
  assert.match(receipt, /\n- azpr-review-dedupe: COMPLETE; session=ses_\w+; model=fixture\/first; repair-turns=1\n- azpr-review-rating: COMPLETE; session=ses_\w+; model=fixture\/rater\n\nRepair notice: some answers did not meet the output contract and the same session was asked to correct them\./, receipt);
  assert.equal(receipt.match(/repair-turns=/g).length, 1, 'Only the duplicate check needed a correction turn.');
  assert.doesNotMatch(receipt, /attempt=2|Retry notice|follow-up=/, receipt);
  assert.ok(receipt.includes(STATUS), receipt);
  const notices = await inbox(reviewOrigin);
  assert.ok(notices.includes(`[AZPR ${reviewID}] STARTED /pr-review (2 passes: fixture/first, fixture/second). Work continues in this OpenCode process; the result will return to this conversation. Stop with /pr-stop ${reviewID}.`), 'The start notice names the passes and their models.');
  assert.ok(notices.some(text => /PROGRESS — PR #123 at bbbbbbbbbb: 2 changed file/.test(text)), 'Progress notices reach the conversation.');
  for (const message of ['Review: 2 session(s) for 1 shard(s) in 2 independent passes; no separate verification follows.',
    'Duplicate check: 1 file(s) hold findings from more than one reviewer session.', 'Duplicate check finished: 1 finding(s) merged into another session\'s finding.',
    'Severity rating: 1 finding(s) in 1 session(s).', 'Review finished: 1 reported finding(s), 0 need more information; 2/2 file(s) reviewed, 2/2 in every pass.']) {
    assert.ok(notices.includes(`[AZPR ${reviewID}] PROGRESS — ${message}`), message);
  }
  // What the provider was asked during the review, by the stage each request belongs to and by model.
  const during = requests.slice(beforeReview);
  const reviewRequests = during.filter(request => request.kind === 'review'), duplicateRequests = during.filter(request => request.kind === 'duplicates');
  assert.deepEqual([...new Set(during.map(request => `${request.kind} ${request.model}`))].sort(), ['duplicates first', 'rating rater', 'review first', 'review second'],
    'The passes run with their own models, the duplicate check with the first reviewer model and the rating with the rater.');
  assert.equal(new Set(reviewRequests.map(request => request.sessionID)).size, 2, 'One reviewer session per pass of the one shard.');
  // Reviewers and the duplicate check have AZPR's tools; nothing else that could act or leave the project.
  const toolRequests = [...reviewRequests, ...duplicateRequests];
  assert.equal(toolRequests.length, 9, 'Two passes (four and three requests) and the duplicate check with its correction turn.');
  for (const request of toolRequests) {
    assert.ok(!request.tools.includes('shell'), 'Shell is hidden from private reviewers by default.');
    assert.ok(!request.tools.includes('execute'), 'CodeMode execute is hidden.');
  }
  assert.ok(toolRequests.every(request => ['azpr_read_diff', 'azpr_read_file', 'azpr_search_code', 'azpr_find_files', 'azpr_list_files', 'azpr_pr_threads'].every(name => request.tools.includes(name))), 'Reviewers see the AZPR tools.');
  assert.ok(toolRequests.every(request => !request.tools.some(name => /foreign|lookup/.test(name))), 'Foreign MCP tools, direct or CodeMode, are hidden from private reviewers.');
  assert.ok(toolRequests.every(request => !request.tools.includes('experimental_image_generate')), 'Image generation is hidden from private reviewers.');
  assert.ok(azure.callsTo('items').some(call => call.query['versionDescriptor.version'] === 'b'.repeat(40)), 'A reviewer read HEAD through azpr_read_file.');
  assert.ok(reviewRequests.some(request => request.model === 'second' && /^2 match\(es\) for "second line of" in 2 file\(s\)[\s\S]*\/src\/fixture\.js:2: second line of \/src\/fixture\.js/.test(request.lastTool)),
    'A reviewer searched file contents at HEAD through azpr_search_code.');
  assert.equal(azure.state.calls.slice(callsBeforeReview).filter(call => call.route === 'items' && call.query.$format === 'zip').length, 1, 'Content search reads one repository archive per run and commit.');
  const afterGrep = count => reviewRequests.find(request => request.model === 'first' && request.toolResults === count)?.lastTool ?? '';
  // Depending on the host, OpenCode reports that the path does not exist (2.0.32 did) or asks, which AZPR refuses with guidance.
  assert.match(afterGrep(2), /outside the local OpenCode project|Search path does not exist: \/scale_lab/, 'A native grep on a repository path gets an answer instead of waiting for approval.');
  assert.match(afterGrep(3), /outside the local OpenCode project/, 'A native grep outside the project is refused with guidance instead of waiting for approval.');
  assert.equal((await api('/api/permission/request')).data?.length ?? 0, 0, 'No private session waits for an approval.');
  // The duplicate check: one session, asked about the two findings the passes reported in one file. Its first
  // answer named no finding that stays, so the same session was asked to correct it.
  assert.equal(new Set(duplicateRequests.map(request => request.sessionID)).size, 1, 'The correction turn stays in the duplicate check\'s session.');
  assert.equal(duplicateRequests.length, 2, 'The duplicate check\'s answer and its correction.');
  assert.ok(/"kind":"duplicates","file":"\/src\/fixture\.js","side":"head","findingIds":\["F-1","F-2"\]/.test(duplicateRequests[0].first) && /"session":"1\/1 pass 1"/.test(duplicateRequests[0].first) && /"session":"1\/1 pass 2"/.test(duplicateRequests[0].first),
    'The duplicate check gets the findings of one file with the session that reported each.');
  assert.ok(!duplicateRequests[0].last.startsWith('AZPR runtime'));
  assert.ok(duplicateRequests[1].last.startsWith('AZPR runtime: your duplicate check needs correction.\n- F-1: the merges form a cycle; keep one of these findings and merge the others into it.\n- F-2: the merges form a cycle;'), duplicateRequests[1].last);
  // The severity rating: one session on its own model, with no tool at all and no level in its input.
  const ratingRequests = during.filter(request => request.model === 'rater');
  assert.equal(ratingRequests.length, 1, 'One rating request for the finding that is still reported.');
  assert.equal(ratingRequests[0].kind, 'rating');
  assert.deepEqual(ratingRequests[0].tools, [], 'The rating session is offered no tool.');
  assert.ok(!/"severity"/.test(ratingRequests[0].first) && /"kind":"rating"/.test(ratingRequests[0].first), 'The rating input carries finding text without a level.');
  assert.ok(/"findingIds":\["F-1"\]/.test(ratingRequests[0].first) && !/prUrl|userContext|"snapshot"|pass 1|pass 2/.test(ratingRequests[0].first), 'The rating input names the one finding, and neither the PR nor where the finding came from.');
  assert.match(receipt, /azpr-review-rating: COMPLETE; session=\S+; model=fixture\/rater/);
  const reviewCalls = azure.state.calls.slice(callsBeforeReview);
  assert.ok(reviewCalls.filter(call => call.route === 'changes').length >= 1, 'The runtime reads the change list itself.');
  assert.ok(reviewCalls.filter(call => call.route === 'pr').length >= 2, 'The runtime reads the PR for the snapshot and rechecks its versions when the review ends.');
  assert.ok(azure.state.calls.every(call => call.query['api-version'] === '7.1'), 'Every REST call pins api-version 7.1.');
  const saved = await readdir(join(directories.state, 'opencode', 'azpr-v2', 'reviews'));
  assert.ok(saved.includes(`${reviewID}.json`), 'Completed reviews are persisted.');
  // The saved record says how the findings were produced, which every later reader of the review goes by: no
  // separate verification, the two passes, one duplicate check that merged one finding, and one rating.
  const record = await savedReview(reviewID);
  assert.equal(record.verification, 'none');
  assert.deepEqual(record.method, { kind: 'reviewers', version: 1, requested: ['fixture/first', 'fixture/second'],
    passes: [{ pass: 1, model: 'fixture/first', sessions: 1, failed: 0 }, { pass: 2, model: 'fixture/second', sessions: 1, failed: 0 }],
    duplicateCheck: { groups: 1, failed: 0, merged: 1, refused: 0 },
    rating: { state: 'named', model: 'fixture/rater', sessions: 1, failed: 0, rated: 1, kept: 0 } });
  // The finding of the first pass stays and stands for both sessions; the second pass's is merged into it. The
  // rating raised the level, and the record keeps the one each reviewer gave.
  assert.deepEqual(record.final.dispositions.map(row => [row.id, row.status, row.mergedInto ?? null, row.sessions]),
    [['F-1', 'REPORTED', null, ['1/1 pass 1', '1/1 pass 2']], ['F-2', 'MERGED', 'F-1', ['1/1 pass 2']]]);
  const [kept, merged] = record.final.dispositions;
  assert.deepEqual([kept.finding.summary, kept.finding.severity, kept.reviewerSeverity, kept.ratedSeverity, kept.alsoReported], ['缺少防護會遺失狀態', 'high', 'medium', 'high', [{ id: 'F-2', sessions: ['1/1 pass 2'], severity: 'medium' }]]);
  assert.deepEqual([merged.mergedFinding.summary, merged.reason], ['少了防護，狀態會遺失', '相同根因與修正。 [Runtime: merged by the duplicate check of independent reviewer sessions.]']);
  // The report in the review session: no separate verification, the coverage with both numbers, the level in
  // effect next to the reviewer's own, and what the duplicate check merged. (Its sentences about the method are
  // written from the record's `method`, which is compared above; the unit tests hold their wording.)
  const report = await reportOf(receipt);
  assert.ok(report.includes('\n\n**回報的發現由審查者依原始碼自行查證；沒有另外的驗證。**\n\n**覆蓋範圍:** 完整 — 已審查 2/2 個變更檔, 2/2 個在全部 2 次審查都審過\n\n## PR Review Summary\n\n'), report);
  assert.ok(report.includes('\n\n### F-1 — 缺少防護會遺失狀態 (high; 審查者: medium)\n\n'), report);
  assert.ok(report.includes('\n- **F-2 — MERGED → F-1:** 相同根因與修正。 [Runtime: merged by the duplicate check of independent reviewer sessions.]'), report);
  const reviewStages = await stageRecords(receipt);
  assert.deepEqual([reviewStages.slice(0, 2).map(stage => stage.role).sort(), ...reviewStages.slice(2).map(stage => stage.role)], [['azpr-review-reviewer', 'azpr-review-reviewerb'], 'azpr-review-dedupe', 'azpr-review-rating'],
    'Four sessions: the two passes, the duplicate check and the rating.');
  assert.ok(reviewStages.every(stage => stage.tokens?.requests?.length === stage.modelRequests && stage.tokens.input >= stage.modelRequests),
    'Debug stage records keep the token usage the host reported for every model request.');
  assert.deepEqual(reviewStages.map(stage => [stage.role, stage.modelRequests]).sort(), [['azpr-review-dedupe', 2], ['azpr-review-rating', 1], ['azpr-review-reviewer', 4], ['azpr-review-reviewerb', 3]]);
  assert.ok(reviewStages.filter(stage => stage.stage.startsWith('reviewer')).every(stage => stage.sessionReads >= 1), 'The runtime recorded what each reviewer session read: a finding counts only at a file its own session read.');
  assert.deepEqual(reviewStages.find(stage => stage.role === 'azpr-review-dedupe').repairs.map(repair => repair.issues.length), [2], 'One correction turn, for the two merges that named no finding that stays.');
  // The private sessions are sessions of their own: OpenCode 2.3.0 and later hand every answer of a child session to
  // its parent and wake the parent's own model with it. The conversation's model was asked nothing while the review
  // ran, and each session is placed where the conversation is and names its run, role and conversation.
  assert.ok(during.every(request => request.sessionID !== reviewOrigin && request.model !== 'fixture'), "The conversation's own model received no request during the review.");
  const conversation = (await api(`/api/session/${reviewOrigin}`)).data;
  for (const stage of reviewStages) {
    const session = (await api(`/api/session/${stage.sessionID}`)).data;
    assert.equal(session.parentID ?? null, null, 'A private session has no parent.');
    assert.equal(session.location.directory, conversation.location.directory, "A private session is created at the conversation's location.");
    assert.deepEqual(session.metadata, { azpr: { run: reviewID, role: stage.role, conversation: reviewOrigin } }, 'A private session names its run, role and conversation.');
  }
  results.privateSessions = `${reviewStages.length} private sessions of their own (no parent, the conversation's location, AZPR metadata); the conversation's model received no request during the review`;
  results.review = 'COMPLETE with two passes on two models, the duplicate check merging their finding after a correction turn, the rating on its own model without tools, hidden shell and a persisted review that states its method';

  // 3. Preview, then publication, then a restart and an idempotent re-run.
  const beforePreview = requests.length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: '', delivery: 'steer' });
  const preview = await latest(reviewOrigin);
  assert.match(preview, /\] PREVIEW/, preview);
  // The first reviewer model plans the comments. The summary and the comment say how the review was made and name
  // the models of its stages, and the comment's level is the rating's.
  assert.deepEqual([...new Set(requests.slice(beforePreview).map(request => `${request.kind} ${request.model}`))], ['plan first'], 'The first reviewer model planned the comments.');
  const disclosure = 'AI 審查，非人工審查或核准。審查方式：發現由審查者依原始碼自行查證，沒有另外的驗證。模型： `fixture/first`, `fixture/second`, `fixture/rater`';
  assert.ok(preview.includes(`\n<azpr_comment_data>\n🤖 ${disclosure}\n\n## PR Review Summary\n\n`), preview);
  assert.ok(preview.includes('\n\nInline comments prepared: 1\n\n### F-1 — /src/fixture.js:1-1\n\n🔴 high: 缺少防護會遺失狀態\n\n'), preview);
  assert.ok(preview.includes(`\n\n---\n${disclosure}\n\n<!-- azpr-comment:`), preview);
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

  // 3b. Quick review: one pass, so one reviewer session and no duplicate check; its model also rates
  //     (rater: ""), in a session of its own without tools. The comment preview names the method.
  const quickOrigin = await newOrigin('Quick');
  const beforeQuick = requests.length;
  await api(`/api/session/${quickOrigin}/command`, { name: 'pr-quick', text: prUrl, delivery: 'steer' });
  const quickReceipt = await latest(quickOrigin);
  assert.match(quickReceipt, COMPLETE_ONE_PASS, quickReceipt);
  const quickID = /\[AZPR ([a-f0-9]{8})\]/.exec(quickReceipt)[1];
  assert.match(quickReceipt, new RegExp(`^\\[AZPR ${quickID}\\] COMPLETE; coverage complete; verification none\\n- azpr-quick-reviewer: COMPLETE; session=ses_\\w+; model=fixture/quick\\n- azpr-quick-rating: COMPLETE; session=ses_\\w+; model=fixture/quick\\n\\n`), quickReceipt);
  assert.ok(quickReceipt.includes(STATUS), 'Every mode\'s receipt says the same of its status.');
  assert.ok((await inbox(quickOrigin)).includes(`[AZPR ${quickID}] STARTED /pr-quick (1 pass: fixture/quick). Work continues in this OpenCode process; the result will return to this conversation. Stop with /pr-stop ${quickID}.`), 'The start notice names the one pass.');
  const quickRequests = requests.slice(beforeQuick);
  assert.ok(quickRequests.every(request => request.model === 'quick'), 'Only the quick model was asked.');
  assert.deepEqual(quickRequests.map(request => request.kind), ['review', 'review', 'rating'], 'The reviewer\'s file read and answer, then one rating request.');
  assert.equal(new Set(quickRequests.filter(request => request.kind === 'review').map(request => request.sessionID)).size, 1, 'One reviewer session for the one shard.');
  assert.ok(quickRequests.every(request => !request.tools.includes('shell') && !request.tools.some(name => /foreign|lookup/.test(name)) &&
    !request.tools.includes('experimental_image_generate')), 'The quick sessions see only their tools.');
  const [quickRating] = quickRequests.filter(request => request.kind === 'rating');
  assert.deepEqual(quickRating.tools, [], 'The rating session is offered no tool.');
  assert.ok(!quickRequests.slice(0, 2).some(request => request.sessionID === quickRating.sessionID) && !/"severity"/.test(quickRating.first), 'The rating is a session of its own, and its input carries no level.');
  const quickStages = await stageRecords(quickReceipt);
  assert.deepEqual(quickStages.map(stage => stage.role), ['azpr-quick-reviewer', 'azpr-quick-rating']);
  assert.ok(quickStages[0].sessionReads >= 1, 'The runtime recorded what the quick session read.');
  const quickRecord = await savedReview(quickID);
  assert.deepEqual([quickRecord.profile, quickRecord.verification, quickRecord.method], ['quick', 'none', { kind: 'reviewers', version: 1, requested: ['fixture/quick'],
    passes: [{ pass: 1, model: 'fixture/quick', sessions: 1, failed: 0 }], duplicateCheck: { groups: 0, failed: 0, merged: 0, refused: 0 },
    rating: { state: 'first', model: 'fixture/quick', sessions: 1, failed: 0, rated: 1, kept: 0 } }]);
  await api(`/api/session/${quickOrigin}/command`, { name: 'pr-comment', text: '', delivery: 'steer' });
  const quickPreview = await latest(quickOrigin);
  assert.match(quickPreview, /\] PREVIEW; source review=/, quickPreview);
  assert.match(quickPreview, /🤖 AI 審查，非人工審查或核准。審查方式：發現由審查者依原始碼自行查證，沒有另外的驗證。模型： `fixture\/quick`\n/);
  // The reviewer said medium; the level in the comment is the rating's.
  assert.match(quickPreview, /🔴 high: [^\n]+\n\n\*\*📝 Summary\*\*/);
  assert.ok(requests.slice(beforeQuick).every(request => request.model === 'quick'), 'The quick reviewer model planned the comments.');
  results.quick = 'COMPLETE with one reviewer session and its rating by the same model, no duplicate check; PREVIEW names the method';

  // 3c. A reviewer's answer that is PARTIAL with unfinished work gets one follow-up in the same session;
  //     a follow-up without a usable answer keeps the answer it followed.
  for (const [context, outcome] of [['follow-up-smoke', 'completed'], ['follow-up-unusable-smoke', 'unusable']]) {
    const origin = await newOrigin(`Quick follow-up ${outcome}`);
    const before = requests.length;
    await api(`/api/session/${origin}/command`, { name: 'pr-quick', text: `${prUrl} ${context}`, delivery: 'steer' });
    const receipt = await latest(origin);
    assert.match(receipt, new RegExp(`^\\[AZPR [a-f0-9]{8}\\] COMPLETE; coverage ${outcome === 'completed' ? 'complete' : 'incomplete'}; verification none\\n`), receipt);
    // A follow-up that answered prose gets its correction turn, which answers prose too: the receipt names both.
    assert.match(receipt, new RegExp(`^- azpr-quick-reviewer: ${outcome === 'completed' ? 'COMPLETE' : 'PARTIAL'};[^\\n]*follow-up=${outcome}${outcome === 'unusable' ? '; repair=failed:unusable' : ''}$`, 'm'), receipt);
    assert.match(receipt, /\nFollow-up notice: a session answered PARTIAL and named unfinished work, so the same session was asked once to continue \(follow-up=completed, still-partial, unusable or failed\)\. A follow-up that failed or gave no usable answer kept the answer it followed\.\n/, receipt);
    const followRequests = requests.slice(before).filter(request => request.kind === 'review');
    assert.equal(new Set(followRequests.map(request => request.sessionID)).size, 1, 'The follow-up stays in the same session.');
    assert.equal(followRequests.filter(request => request.last.startsWith('AZPR runtime: your answer is PARTIAL')).length, 1, 'One follow-up prompt.');
    const stages = await stageRecords(receipt);
    // The finding of the answer that stands is rated like any other.
    assert.deepEqual(stages.map(record => record.role), ['azpr-quick-reviewer', 'azpr-quick-rating']);
    const [stage] = stages;
    assert.equal(stage.followUp.outcome, outcome);
    assert.equal(stage.result.findings.length, 1, 'The finding survives the follow-up.');
    if (outcome === 'unusable') {
      assert.equal(stage.result.report, '提早停止。', 'The answer the follow-up followed stands.');
      assert.deepEqual([stage.repairFailure.turn, stage.repairFailure.failureClass], [2, 'unusable']);
    }
  }
  results.quickFollowUp = 'PARTIAL, then one follow-up in the same session: COMPLETE, or the earlier answer kept when the follow-up is unusable';

  // 3d. Automatic comment steps from a flag right after the PR URL: a preview in a run of its own;
  //     automatic publication posts a quick review's finding and holds back only a comment with
  //     an image, which a typed --publish posts; a review without findings gets no step.
  const writesBeforeAuto = azure.callsTo('createThread').length;
  const autoOrigin = await newOrigin('Automatic preview');
  await api(`/api/session/${autoOrigin}/command`, { name: 'pr-review', text: `${prUrl} --preview`, delivery: 'steer' });
  const autoReceipt = await reviewReceipt(autoOrigin, 'pr-review');
  assert.match(autoReceipt, COMPLETE_TWO_PASSES, autoReceipt);
  assert.match(autoReceipt, /\*\*自動預覽\*\*（`--preview`）/, autoReceipt);
  const autoReview = /\[AZPR ([a-f0-9]{8})\]/.exec(autoReceipt)[1];
  const autoPreview = await commentStep(autoOrigin, autoReceipt);
  assert.match(autoPreview.started ?? '', new RegExp(`STARTED /pr-comment \\(automatic preview after review ${autoReview} completed; --preview\\)`), JSON.stringify(autoPreview));
  assert.match(autoPreview.receipt, new RegExp(`\\] PREVIEW; source review=${autoReview}\\nActed on [^\\n]+\\nStarted automatically after review ${autoReview} completed \\(--preview\\)\\.\\n`), autoPreview.receipt);
  const quickPublishOrigin = await newOrigin('Automatic quick publication');
  await api(`/api/session/${quickPublishOrigin}/command`, { name: 'pr-quick', text: `${prUrl} --publish`, delivery: 'steer' });
  const quickPublishReceipt = await reviewReceipt(quickPublishOrigin, 'pr-quick');
  // The receipt of every mode states that nothing verified the findings separately, in its first line and in what
  // it says of its status; a quick review has no hint of its own any more. The comments carry the disclosure.
  assert.match(quickPublishReceipt, COMPLETE_ONE_PASS, quickPublishReceipt);
  assert.ok(quickPublishReceipt.includes(STATUS) && !/Verification hint/.test(quickPublishReceipt), quickPublishReceipt);
  assert.match(quickPublishReceipt, /\*\*自動發布\*\*（`--publish`）/, quickPublishReceipt);
  const quickPublished = await commentStep(quickPublishOrigin, quickPublishReceipt);
  // Its markers are those of section 3: the summary is present and the deleted comment stays deleted.
  assert.match(quickPublished.receipt ?? '', /\] POSTED; [^\n]+\nActed on [^\n]+\nStarted automatically [^\n]+\(--publish\)\.\n(?!Automatic publication held back)/, JSON.stringify(quickPublished));
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto);
  commentImage = true;
  const imageOrigin = await newOrigin('Automatic publication with an image');
  await api(`/api/session/${imageOrigin}/command`, { name: 'pr-review', text: `${prUrl} --publish`, delivery: 'steer' });
  const imageReceipt = await reviewReceipt(imageOrigin, 'pr-review');
  const imaged = await commentStep(imageOrigin, imageReceipt);
  commentImage = false;
  assert.match(imaged.receipt ?? '', /\] POSTED; [^\n]+\nActed on [^\n]+\nStarted automatically [^\n]+\nAutomatic publication held back 1 item\(s\) for a person: the comment for F-1 \(\/src\/fixture\.js:2\) contains an image\. They are not published; after reading the preview, post them with \/pr-comment [a-f0-9]{8} --publish\n/, JSON.stringify(imaged));
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
  assert.match(emptyReceipt, COMPLETE_ONE_PASS, emptyReceipt);
  assert.doesNotMatch(emptyReceipt, /azpr-quick-rating/, 'Without a reported finding there is nothing to rate.');
  const requestsAfterEmpty = requests.length;
  const empty = await commentStep(emptyOrigin, emptyReceipt);
  assert.match(empty.skipped ?? '', /Automatic publication skipped: the review has no findings to comment on, so nothing was planned or posted and no model was used\./, JSON.stringify(empty));
  assert.equal(requests.length, requestsAfterEmpty, 'No model request follows a review without findings.');
  assert.equal(azure.callsTo('createThread').length, writesBeforeAuto + 2, 'Nothing more was posted.');
  results.automatic = '--preview: COMPLETE review, then its own PREVIEW run; quick --publish with a finding POSTED; --publish with an image in its inline comment: the summary POSTED, that comment held back until a typed --publish posted it; no findings: one notice, no model request';

  // 4. Cancellation of a hanging provider request.
  const cancelOrigin = await newOrigin('Cancel');
  const beforeCancel = requests.length;
  const cancelled = api(`/api/session/${cancelOrigin}/command`, { name: 'pr-review', text: `${prUrl} hang-smoke`, delivery: 'steer' });
  // Both passes reach the provider and hang there.
  for (let attempt = 0; attempt < 200 && requests.length < beforeCancel + 2; attempt++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(requests.slice(beforeCancel).map(request => request.model).sort(), ['first', 'second'], 'The hanging review must reach the provider with both passes.');
  await api(`/api/session/${cancelOrigin}/command`, { name: 'pr-stop', text: '', delivery: 'steer' });
  await cancelled;
  const cancelReceipt = (await inbox(cancelOrigin)).find(text => RECEIPT.test(text)) ?? '';
  assert.match(cancelReceipt, /^\[AZPR [a-f0-9]{8}\] CANCELLED; verification none\nReason \(review\): User requested \/pr-stop\.\n/, 'Manual cancellation leaves a CANCELLED receipt.');
  // Both passes had started; each session's line says that it was cancelled.
  for (const [role, label, model] of [['reviewer', 'pass 1/2', 'first'], ['reviewerb', 'pass 2/2', 'second']]) {
    assert.match(cancelReceipt, new RegExp(`\\n- azpr-review-${role} \\[${label}\\]: FAILED; session=ses_\\w+; model=fixture/${model}; failure=cancelled; error=User requested /pr-stop\\.\\n`), cancelReceipt);
  }
  assert.doesNotMatch(cancelReceipt, /azpr-review-(?:dedupe|rating)|Report data/, 'Nothing follows the stopped passes.');
  results.cancellation = 'CANCELLED';

  // 4b. A provider 503 is retried by OpenCode in the same session: the host
  // prepares the request again (context, then model.request), so AZPR allows it.
  const retryOrigin = await newOrigin('Provider retry');
  const beforeRetry = requests.length;
  await api(`/api/session/${retryOrigin}/command`, { name: 'pr-review', text: `${prUrl} retry-smoke`, delivery: 'steer' });
  const retried = await latest(retryOrigin);
  assert.match(retried, COMPLETE_TWO_PASSES, retried);
  assert.doesNotMatch(retried, /attempt=2|Retry notice/, 'No new session was needed.');
  const secondRequests = requests.slice(beforeRetry).filter(request => request.model === 'second');
  assert.ok(secondRequests.length >= 2 && secondRequests[0].sessionID === secondRequests[1].sessionID && secondRequests[0].last === secondRequests[1].last, 'OpenCode resent the request in the same session.');
  assert.equal(new Set(secondRequests.map(request => request.sessionID)).size, 1, 'The second pass stayed in its one session.');
  const retriedStage = (await stageRecords(retried)).find(stage => stage.role === 'azpr-review-reviewerb');
  assert.equal(retriedStage.requestObservations.retries.length, 1, JSON.stringify(retriedStage.requestObservations));
  assert.equal(retriedStage.requestObservations.retries[0].allowed, true);
  assert.equal(retriedStage.requestObservations.rejected, 0);
  assert.equal(retriedStage.requestObservations.kinds.primary, retriedStage.requestObservations.authorizedPrimary);
  results.hostRetry = `provider 503 retried in place by OpenCode (retry delay ${retriedStage.requestObservations.retries[0].delayMs ?? 'unknown'} ms); ${retriedStage.requestObservations.authorizedPrimary} authorized primary requests, 0 rejected`;

  // 4b2. A provider stream that breaks off mid-answer: OpenCode (2.3.0 and later) retries that step by itself, in the
  // same session and without the text the break cut off, so AZPR takes the retried answer and starts no new session.
  const cutOrigin = await newOrigin('Stream cut');
  const beforeCut = requests.length;
  await api(`/api/session/${cutOrigin}/command`, { name: 'pr-quick', text: `${prUrl} cut-smoke`, delivery: 'steer' });
  const cutReceipt = await latest(cutOrigin);
  assert.match(cutReceipt, COMPLETE_ONE_PASS, cutReceipt);
  assert.match(cutReceipt, /\n- azpr-quick-reviewer: COMPLETE; session=[^;]+; model=fixture\/quick; step-retries=1\n- azpr-quick-rating: COMPLETE; session=[^;]+; model=fixture\/quick\n/, cutReceipt);
  assert.doesNotMatch(cutReceipt, /attempt=2|Retry notice|stream-continuations/, 'No new session and no continuation message were needed.');
  // The reviewer's requests; the rating that follows is a session of its own and one request more.
  const cutRequests = requests.slice(beforeCut).filter(request => request.kind === 'review');
  assert.equal(new Set(cutRequests.map(request => request.sessionID)).size, 1, 'The retried step stays in the same session.');
  assert.equal(cutRequests.length, 3, 'The file read, the answer that broke off and its retry.');
  assert.deepEqual(requests.slice(beforeCut).map(request => request.kind), ['review', 'review', 'review', 'rating'], 'Nothing but the rating follows the retried answer.');
  assert.ok(requests.slice(beforeCut).every(request => !/previous response was interrupted/i.test(request.last)), 'The retry repeats the step; nothing asks the model to continue.');
  const cutStages = await stageRecords(cutReceipt);
  assert.deepEqual(cutStages.map(stage => stage.role), ['azpr-quick-reviewer', 'azpr-quick-rating']);
  const [cutStage] = cutStages;
  assert.equal(cutStage.hostStepRetries, 1);
  assert.equal(cutStage.result.findings.length, 1, 'The answer is the retried one, whole.');
  results.streamCut = `a quick answer cut mid-stream was retried by OpenCode in the same session (${cutRequests.length} requests, step-retries=1); COMPLETE without a new session`;

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
    assert.match(recovered, COMPLETE_TWO_PASSES, recovered);
    assert.ok(recovered.includes(`\n- azpr-review-reviewer [pass 1/2]: FAILED; session=${stall.sessionID}; model=fixture/first; `), recovered);
    assert.match(recovered, /\n- azpr-review-reviewer \[pass 1\/2\]: FAILED; [^\n]*failure=idle; error=\[AZPR\] Stage inactivity watchdog stopped this stage: no activity for 60 s after (model request 1 was sent|a model step started) \(workflow\.stageIdleSeconds\)\./);
    assert.match(recovered, /\n- azpr-review-reviewer \[pass 1\/2\]: COMPLETE; [^\n]*attempt=2/);
    assert.match(recovered, /\nInactivity notice: the stage inactivity watchdog stopped 1 stage\(s\) \(failure=idle\) after 60 s without activity: azpr-review-reviewer \[pass 1\/2\] after /);
    assert.match(recovered, /\nRetry notice: a stage failed for a transient reason and ran again in a new session\.\n/);
    assert.doesNotMatch(recovered, /azpr-review-reviewerb [^\n]*(?:FAILED|attempt=2)/, 'The other pass went on meanwhile, in its one session.');
    assert.doesNotMatch(recovered, /Cancellation warning/, 'OpenCode confirmed the interrupted session settled.');
    assert.ok((await inbox(stallOrigin)).some(text => /PROGRESS — Review pass 1\/2 failed \(\[AZPR\] Stage inactivity watchdog stopped this stage/.test(text)), 'The retry notice names the watchdog.');
    assert.ok(stall.closed !== null, 'OpenCode closed the stalled provider stream after the interrupt.');
    const stoppedAfter = (stall.closed - stall.at) / 1000;
    assert.ok(stoppedAfter >= 59 && stoppedAfter < 75, `The stream was closed ${stoppedAfter} s after it stalled.`);
    const streamed = await latest(streamOrigin);
    assert.match(streamed, COMPLETE_TWO_PASSES, streamed);
    assert.ok(longStream?.finishedAt, 'The long answer was streamed to the end.');
    const streamedFor = (longStream.finishedAt - longStream.at) / 1000;
    assert.ok(streamedFor > 62, `The answer streamed for ${streamedFor} s, longer than the window.`);
    assert.doesNotMatch(streamed, /failure=idle|Inactivity notice/, 'Streamed output is activity.');
    assert.doesNotMatch(streamed, /attempt=2|Retry notice/, 'No new session was needed.');
    assert.match(streamed, new RegExp(`\\n- azpr-review-reviewer \\[pass 1/2\\]: COMPLETE; session=${longStream.sessionID}; model=fixture/first(?:; (?!repair-turns)[^\\n;]+)*\\n`), 'The long answer was accepted as it was streamed, without a correction turn.');
    results.watchdog = `stalled stream stopped after ${stoppedAfter.toFixed(1)} s (failure=idle), closed by OpenCode, retried in a new session; an answer streamed for ${streamedFor.toFixed(1)} s (${longStream.chunks} chunks) ran on; both COMPLETE in ${((Date.now() - started) / 1000).toFixed(1)} s`;
  }

  // 5. Private sessions cannot run auxiliary requests; ordinary sessions can.
  const privateSession = reviewRequests.find(request => request.model === 'second').sessionID;
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
  assert.ok(chatRequest.tools.includes('experimental_image_generate'), 'Positive control: OpenCode offers image generation to ordinary sessions.');
  assert.ok(!chatRequest.tools.some(name => name.startsWith('azpr_')), 'Ordinary sessions never see AZPR tools.');
  results.toolScopes = 'AZPR tools only in private sessions; foreign MCP tools (direct and CodeMode) and image generation only in ordinary sessions';

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
  assert.match(settingPublished.receipt ?? '', /\] POSTED; source review=[a-f0-9]{8}\nActed on [^\n]+\nStarted automatically after review [a-f0-9]{8} completed \(afterReview\.review: publish\)\.\n/, JSON.stringify(settingPublished));
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
  assert.match(repeated.receipt ?? '', /\] NOTHING_TO_POST; source review=[a-f0-9]{8}\nActed on [^\n]+\nStarted automatically [^\n]+\nAutomatic publication found nothing new to post: every finding is already discussed on the PR \(thread \d+\)\. The plan is saved\.\n/, JSON.stringify(repeated));
  assert.equal((await threads()).length, 2, 'No second summary.');
  assert.equal(azure.callsTo('createThread').length - writesBeforeSetting, 2);
  // Restore the settings; the next restart loads them.
  await writeFile(installedSettingsPath, settingsText);
  results.afterReviewSetting = 'afterReview.review publish: COMPLETE review, then its own comment run POSTED, VERIFIED=2 read back; the same review again with every finding already discussed: NOTHING_TO_POST, no second summary';

  // 7. A corporate network: Azure DevOps over HTTPS only through an authenticating
  // CONNECT proxy that re-signs TLS with its own CA (azure.proxy, azure.caFile, azure.verifyTls).
  // OpenCode (2.2.4, 2.3.0) puts 127.0.0.1, localhost and ::1 in NO_PROXY, and Bun then skips even an explicit proxy,
  // so the proxied Azure DevOps fixture listens on 127.0.0.2.
  if (replacement) results.proxy = 'covered by the fresh run';
  else if (spawnSync('openssl', ['version']).status !== 0) results.proxy = 'SKIPPED: openssl is unavailable';
  else {
    const pki = join(fixture, 'pki');
    await mkdir(pki);
    const openssl = args => { const result = spawnSync('openssl', args, { cwd: pki, encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stderr); };
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=AZPR fixture proxy CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.2']);
    await writeFile(join(pki, 'server.ext'), 'subjectAltName=IP:127.0.0.2\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext']);
    const tlsServer = createTlsServer({ key: await readFile(join(pki, 'server.key')), cert: await readFile(join(pki, 'server.pem')) },
      (request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
    tlsServer.listen(0, '127.0.0.2');
    await once(tlsServer, 'listening');
    const tunnelTarget = `127.0.0.2:${tlsServer.address().port}`;
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
