import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/**
 * Opt-in exact-host fixture: node tests/host-v2-smoke.mjs /absolute/path/opencode [--replace]
 * Isolated directories, a loopback deterministic provider, a loopback fake
 * Azure DevOps REST service (api-version 7.1, persistent thread state) and one
 * foreign stdio MCP server. Covers the deterministic source check, a full
 * review in which reviewers read through AZPR's tools while foreign tools stay
 * hidden, a verifier repair turn, comment preview and idempotent publication
 * across a host restart, cancellation, and private auxiliary-request denial.
 * It does not validate a real provider, real Azure DevOps or visual rendering.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
assert.ok(binary?.startsWith('/'), 'Supply the exact host binary as an absolute path.');
const replacement = process.argv[3] === '--replace';
const fixturesRoot = join(sourceRoot, '.local');
await mkdir(fixturesRoot, { recursive: true });
const fixture = await mkdtemp(join(fixturesRoot, 'host-v2-smoke-'));
const directories = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
await mkdir(join(directories.config, 'plugins'), { recursive: true });
const runtimeDirectory = join(directories.config, 'plugins', 'azpr-v2');
const settings = JSON.parse(await readFile(join(sourceRoot, 'config', 'settings.example.json'), 'utf8'));
for (const role of ['functional', 'risk', 'verifier']) settings.models.review[role] = `fixture/${role}`;
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
settings.outputLanguage = 'zh-TW';
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings, null, 2));
const install = args => {
  const result = spawnSync('/bin/sh', [join(sourceRoot, 'install.sh'), '--config-dir', directories.config, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
};
install(['--settings', join(fixture, 'settings.json')]);
if (replacement) {
  const before = await readFile(join(runtimeDirectory, 'settings.json'));
  await rm(join(runtimeDirectory, 'server.js'), { force: true });
  install(['--replace']);
  assert.deepEqual(await readFile(join(runtimeDirectory, 'settings.json')), before);
}

// ------------------------------------------------------------ fake provider
const requests = [];
let child, logs = '';
const lastUser = messages => messages?.findLast(message => message.role === 'user')?.content;
const firstUser = messages => messages?.find(message => message.role === 'user')?.content;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  const sessionID = request.headers['x-opencode-session-id'];
  requests.push({ path: request.url, model: parsed.model, sessionID, tools: (parsed.tools ?? []).map(tool => tool.function?.name), last: textOf(lastUser(parsed.messages)).slice(0, 200) });
  let payload;
  try { payload = JSON.parse(textOf(firstUser(parsed.messages))); } catch { /* ordinary chat */ }
  const repair = textOf(lastUser(parsed.messages)).startsWith('AZPR runtime');
  const toolResults = parsed.messages?.filter(message => message.role === 'tool').length ?? 0;
  if (payload?.userContext?.includes('hang-smoke')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture waits for cancellation\n\n');
    return;
  }
  const fileTool = parsed.tools?.find(tool => tool.function?.name === 'azpr_read_file')?.function.name;
  let call, final = 'Ordinary fixture answer.';
  const finding = (id, path) => ({ id, summary: '缺少防護會遺失狀態', evidence: 'HEAD: `fixture code` 略過防護。BASE: 有防護。', counterevidence: '呼叫端沒有再次檢查。', location: `head:${path}:1`, severity: 'high', suggestion: '恢復防護並加上回歸測試。' });
  if (payload?.assignment?.files && !payload.assignment.findingIds) {
    const files = payload.assignment.files;
    if (!toolResults && fileTool) call = { name: fileTool, arguments: { path: files[0], version: 'head' } };
    else final = JSON.stringify({ status: 'COMPLETE', coverage: { files, gaps: [] }, additionalFiles: [], findings: [finding(payload.assignment.firstFindingId, files[0])], report: '初審完成。' });
  } else if (payload?.assignment?.findingIds) {
    const findings = payload.assignment.findings;
    final = repair
      ? JSON.stringify({ dispositions: findings.slice(1).map(item => ({ id: item.id, status: 'MERGED', mergedInto: findings[0].id, reason: '相同根因。' })) })
      : JSON.stringify({ status: 'COMPLETE', confirmed: [{ ...findings[0], reason: '已回查原始碼。' }], merged: [], rejected: [], needsInfo: [], newFindings: [], report: '驗證完成。' });
  } else if (payload?.commentWork?.kind === 'plan') {
    final = JSON.stringify({ status: 'READY', ...(payload.commentWork.allowSummary ? { summary: '此 PR 調整 fixture 的狀態處理。' } : {}),
      comments: payload.findings.map(item => ({ findingId: item.id, severity: item.severity, path: /head:([^:]+)/.exec(item.location)[1], startLine: 1, endLine: 1, anchor: 'fixture code', body: `🔴 high: ${item.summary}\n\n**📝 Summary**\n觸發與影響。\n\n**🔎 Evidence**\n原始碼事實。\n\n**💡 Suggested fix**\n修正方式。` })),
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
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'fixture-only' },
    models: Object.fromEntries(['fixture', 'functional', 'risk', 'verifier'].map(id => [id, { limit: { context: 100000, output: 4000 } }])) } },
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
  assert.equal((await api('/api/info')).version, '2.0.22');
  const waitForMcp = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await api('/api/mcp')).data?.some(server => server.name === 'foreign' && server.status?.status === 'connected')) return;
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    }
    throw new Error('Fixture MCP did not connect.');
  };
  await waitForMcp();
  const commands = await api('/api/command');
  for (const name of ['pr-check', 'pr-review', 'pr-stop', 'pr-deep', 'pr-comment']) assert.ok(commands.data.some(command => command.name === name), name);
  const agents = await api('/api/agent');
  for (const role of ['functional', 'risk', 'verifier', 'comment-plan']) assert.ok(agents.data.some(agent => agent.name === `azpr-review-${role}`), role);
  const newOrigin = async title => (await api('/api/session', { title, location: { directory: directories.work } })).data.id;
  const latest = async origin => (await api(`/api/session/${origin}/inbox`)).data.at(-1)?.payload?.text ?? '';
  const inbox = async origin => (await api(`/api/session/${origin}/inbox`)).data.map(item => item.payload?.text ?? '');
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123';
  const results = {};

  // 1. Deterministic source check: no model request.
  const checkOrigin = await newOrigin('Check');
  const beforeCheck = requests.length;
  await api(`/api/session/${checkOrigin}/command`, { name: 'pr-check', text: prUrl, delivery: 'steer' });
  const check = await latest(checkOrigin);
  assert.match(check, /\] READY/, check);
  assert.equal(requests.length, beforeCheck, '/pr-check must not call a model.');
  results.check = 'READY without model requests';

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
  assert.ok(reviewRequests.every(request => ['azpr_read_file', 'azpr_list_files', 'azpr_pr_threads'].every(name => request.tools.includes(name))), 'Reviewers see the AZPR tools.');
  assert.ok(reviewRequests.every(request => !request.tools.some(name => /foreign|lookup/.test(name))), 'Foreign MCP tools are hidden from private reviewers.');
  assert.ok(azure.callsTo('items').some(call => call.query['versionDescriptor.version'] === 'b'.repeat(40)), 'A reviewer read HEAD through azpr_read_file.');
  const verifierRequests = reviewRequests.filter(request => request.model === 'verifier');
  assert.equal(new Set(verifierRequests.map(request => request.sessionID)).size, 1, 'The repair turn stays in the verifier session.');
  assert.ok(verifierRequests.some(request => request.last.startsWith('AZPR runtime')), 'The verifier received a correction request.');
  assert.ok(azure.callsTo('changes').length >= 1, 'The runtime reads the change list itself.');
  assert.ok(azure.callsTo('pr').length >= 3, 'The runtime reads the PR for the snapshot and rechecks versions after verification.');
  assert.ok(azure.state.calls.every(call => call.query['api-version'] === '7.1'), 'Every REST call pins api-version 7.1.');
  const saved = await readdir(join(directories.state, 'opencode', 'azpr-v2', 'reviews'));
  assert.ok(saved.includes(`${reviewID}.json`), 'Completed reviews are persisted.');
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
  await waitForMcp();
  const beforeRepublish = requests.length;
  const writesBefore = azure.callsTo('createThread').length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
  const republished = await latest(reviewOrigin);
  assert.match(republished, /\] POSTED/, republished);
  assert.match(republished, /ALREADY_PRESENT/);
  assert.equal(azure.callsTo('createThread').length, writesBefore, 'No duplicate comments after a restart.');
  assert.equal(requests.length, beforeRepublish, 'Re-publishing a saved plan needs no model.');
  results.comments = 'PREVIEW, POSTED, restart, re-run ALREADY_PRESENT without duplicates';

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

  console.log(JSON.stringify({ status: 'PASS', installation: replacement ? 'replace' : 'fresh', host: '2.0.22', providerRequests: requests.length, azureCalls: azure.state.calls.length, results, fixture }, null, 2));
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
