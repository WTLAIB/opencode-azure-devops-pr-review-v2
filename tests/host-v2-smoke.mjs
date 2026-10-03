/**
 * Opt-in exact-host fixture: node tests/host-v2-smoke.mjs /absolute/path/opencode
 * Uses isolated directories, a loopback deterministic provider, and a fake stdio
 * MCP. Covers session helpers, full review, native guards, and cancellation.
 * The ordinary-agent shell positive control writes only inside its own fixture.
 * This does not validate a real provider, official Azure MCP, or TUI rendering.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
assert.ok(binary?.startsWith('/'), 'Supply the exact downloaded host binary as an absolute path.');
const fixturesRoot = join(sourceRoot, '.local');
await mkdir(fixturesRoot, { recursive: true });
const fixture = await mkdtemp(join(fixturesRoot, 'host-v2-smoke-'));
const directories = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
await mkdir(join(directories.config, 'plugins'), { recursive: true });
const requests = [];
const workflowReceipts = [];
let forbiddenFetches = 0;
let child;
let logs = '';
const provider = createServer(async (request, response) => {
  if (request.url === '/v1/forbidden') { forbiddenFetches++; response.end('Forbidden fixture fetch was reached'); return; }
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  requests.push({ path: request.url, body: parsed });
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Unexpected fixture route' } }));
    return;
  }
  const tool = parsed.tools?.find(item => item.function?.description === 'Read-only deterministic smoke fixture.');
  const hasResult = parsed.messages?.some(message => message.role === 'tool');
  const rawPrompt = parsed.messages?.findLast(message => message.role === 'user')?.content;
  let payload;
  try { payload = JSON.parse(rawPrompt); } catch {}
  const userContext = payload?.userContext ?? '';
  const shellControl = rawPrompt === 'fixture-shell-positive-control';
  if (userContext.includes('hang-smoke')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture waits for cancellation\n\n');
    return;
  }
  const snapshot = { repository: 'fixture/project/repository', prId: 123, base: 'a'.repeat(40), head: 'b'.repeat(40), scope: 'pr', files: ['/src/fixture.js'] };
  const finding = id => ({ id, summary: 'Deterministic fixture finding', location: 'head:/src/fixture.js:1', severity: 'high', evidence: 'Fixture read returned the source marker.', counterevidence: 'Fixture explicitly omits the required guard.', suggestion: 'Add the fixture guard and its regression.' });
  let final = { status: 'READY', fixture: 'literal-source' };
  if (payload?.prUrl) {
    if (userContext.includes('smoke-check')) final = { status: 'READY', snapshot: { ...snapshot, scope: 'cumulative' }, sourceAccess: { diff: 'Deterministic local MCP fixture only.' }, requirements: 'Fixture readiness contract.', report: 'Local fixture readiness passed.' };
    else if (payload.reviews) final = { status: 'COMPLETE', snapshot, currentHead: snapshot.head, currentBase: snapshot.base, confirmed: payload.reviews.flatMap(review => review.findings).map(item => ({ ...item, reason: 'Deterministic verifier fixture checked the source marker.' })), merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'Deterministic fixture final report.' };
    else final = { status: 'COMPLETE', snapshot, coverage: { files: snapshot.files, gaps: [] }, findings: [finding(parsed.model === 'functional' ? 'F-1' : 'R-1')], report: 'Deterministic initial fixture.' };
  }
  const forced = userContext.includes('force-shell') ? 'shell' : userContext.includes('force-execute') ? 'execute' : undefined;
  const toolName = shellControl ? 'shell' : forced ?? tool?.function.name;
  const priorToolResults = parsed.messages?.filter(message => message.role === 'tool').length ?? 0;
  const callTool = toolName && (forced ? priorToolResults < 2 : !hasResult);
  const args = shellControl ? { command: `touch ${JSON.stringify(join(fixture, 'SHELL_CONTROL_EXECUTED'))}`, description: 'Harmless fixture shell positive control' } : forced === 'shell' ? { command: `touch ${join(fixture, 'NATIVE_EXECUTED')}`, description: 'Fixture forbidden shell' } : forced === 'execute' ? { code: `return await fetch(${JSON.stringify(providerURL + '/forbidden')})` } : { value: 'fixture-source' };
  const delta = callTool
    ? { tool_calls: [{ index: 0, id: forced ? 'call_fixture_forbidden_' + (priorToolResults + 1) : 'call_fixture_read', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }
    : { content: JSON.stringify(final) };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const resultPath = join(fixture, 'result.json');
const mcpPath = join(fixture, 'mcp.mjs');
const runtimeDirectory = join(fixture, 'runtime');
await cp(join(sourceRoot, 'src'), runtimeDirectory, { recursive: true });
const settings = JSON.parse(await readFile(join(sourceRoot, 'config', 'settings.example.json'), 'utf8'));
for (const role of ['functional', 'risk', 'verifier']) settings.models.review[role] = `fixture/${role}`;
settings.shellToolPermission = 'ask';
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
await writeFile(join(runtimeDirectory, 'settings.json'), JSON.stringify(settings, null, 2));
await writeFile(join(directories.config, 'plugins', 'azpr.js'), `export { default } from ${JSON.stringify(pathToFileURL(join(runtimeDirectory, 'plugin.js')).href)};\n`);
await writeFile(mcpPath, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'azpr-smoke-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'read_fixture', description: 'Read-only deterministic smoke fixture.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
  else if (request.method === 'tools/call') {
    appendFileSync(${JSON.stringify(join(fixture, 'mcp-calls.jsonl'))}, JSON.stringify(request.params) + '\\n');
    result = { content: [{ type: 'text', text: 'fixture-source' }] };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`);
await writeFile(join(directories.config, 'plugins', 'smoke.js'), `
import { writeFile } from 'node:fs/promises';
import { createReviewSession, requestReview, interruptSession, appendReport } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'src', 'session.mjs')).href)};
export default { id: 'azpr.fixture.smoke', async setup(ctx) {
  const observations = { app: ctx.app, prompts: 0, contexts: 0, before: [], after: [] };
  await ctx.agent.transform(editor => editor.update('fixture-helper', agent => {
    agent.hidden = true;
    agent.model = { providerID: 'fixture', id: 'fixture' };
    agent.system = 'Return the deterministic fixture response. Use the read fixture tool once.';
    agent.permissions.push(...['shell', 'execute', 'subagent', 'edit', 'write', 'patch', 'webfetch', 'websearch'].map(action => ({action,resource:'*',effect:'deny'})));
  }));
  await ctx.agent.transform(editor => editor.update('fixture-control', agent => {
    agent.hidden = true;
    agent.model = { providerID: 'fixture', id: 'fixture' };
    agent.system = 'Use the supplied harmless shell fixture once, then return the deterministic response.';
    agent.permissions.push({action:'shell',resource:'*',effect:'allow'});
  }));
  await ctx.session.hook('prompt', event => { if (event.metadata?.fixture === true) observations.prompts++; });
  await ctx.session.hook('context', event => { if(event.agent === 'fixture-helper') observations.contexts++; });
  await ctx.session.hook('http.request', event => {
    if (!event.request.url.startsWith(${JSON.stringify(providerURL + '/')})) throw new Error('Fixture forbids non-loopback model requests');
  });
  await ctx.tool.hook('execute.before', event => { if(event.agent === 'fixture-helper') observations.before.push(event.tool); });
  await ctx.tool.hook('execute.after', event => { if(event.agent === 'fixture-helper') observations.after.push({tool:event.tool,status:event.status}); });
  await ctx.command.transform(editor => editor.add({ name:'fixture-smoke', description:'Local deterministic host fixture', async execute(input) {
    try {
      for (let attempt=0;attempt<50;attempt++) {
        const tools = await ctx.tool.list();
        if (tools.some(tool => tool.description === 'Read-only deterministic smoke fixture.')) break;
        await new Promise(resolve => setTimeout(resolve,100));
      }
      const made = await createReviewSession(ctx, {origin:input.sessionID,title:'Host fixture',role:'fixture-helper',model:'fixture/fixture'});
      const answer = await requestReview(ctx, {sessionID:made.id,text:input.prompt.text,role:'fixture-helper',model:'fixture/fixture',metadata:{fixture:true}});
      const cancellation = await interruptSession(ctx,{sessionID:made.id});
      const control = await createReviewSession(ctx, {origin:input.sessionID,title:'Shell positive control',role:'fixture-control',model:'fixture/fixture'});
      const controlAnswer = await requestReview(ctx, {sessionID:control.id,text:'fixture-shell-positive-control',role:'fixture-control',model:'fixture/fixture'});
      const report = await appendReport(ctx,{sessionID:input.sessionID,text:'Deterministic fixture report\\n'+answer.parts.map(p=>p.text).join('')});
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ok:true,observations,made,answer,cancellation,control,controlAnswer,report},null,2));
    } catch(error) {
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ok:false,observations,error:String(error),stack:error.stack,response:error.response},null,2));
      throw error;
    }
  }}));
}};
`);
await writeFile(join(directories.config, 'opencode.json'), JSON.stringify({
  update: 'disable', snapshots: false, warming: false,
  model: 'fixture/fixture',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'fixture-only' }, models: Object.fromEntries(['fixture', 'functional', 'risk', 'verifier'].map(id => [id, { limit: { context: 100000, output: 4000 } }])) } },
  mcp: { servers: { fixture: { type: 'local', command: [process.execPath, mcpPath], codemode: false } } },
}, null, 2));
const password = randomUUID();
const env = {
  PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: directories.data,
  XDG_CACHE_HOME: directories.cache, XDG_STATE_HOME: directories.state,
  TMPDIR: directories.tmp, OPENCODE_TEST_HOME: directories.home,
  OPENCODE_CONFIG_DIR: directories.config, OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1',
};
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directories.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('exit', code => rejectReady(new Error(`Host exited before readiness: ${code}`)));
    child.stdout.on('data', data => {
      logs += data;
      const found = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (found) resolveReady(found[1]);
    });
    child.stderr.on('data', data => { logs += data; });
  });
  const url = await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture host startup timeout')), 30000).unref())]);
  const api = async (path, body) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': directories.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Fixture API ${path}: ${response.status} ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  };
  const info = await api('/api/info');
  assert.equal(info.version, '2.0.22');
  const made = await api('/api/session', { title: 'Fixture origin', location: { directory: directories.work } });
  const origin = made.data;
  // Fixture setup waits for host discovery; the product does not wrap MCP reads.
  let connected = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const catalog = await api('/api/mcp');
    if (catalog.data?.some(server => server.name === 'fixture' && server.status?.status === 'connected')) { connected = true; break; }
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  assert.equal(connected, true, 'Fixture MCP did not connect.');
  await api(`/api/session/${origin.id}/command`, { name: 'fixture-smoke', text: 'Literal $ARGUMENTS `pwd` @private.txt', delivery: 'steer' });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.observations.prompts, 1);
  assert.equal(result.observations.contexts, 2);
  assert.equal(result.observations.before.length, 1);
  assert.equal(result.observations.after[0].status, 'completed');
  assert.equal(result.cancellation.settled, true);
  assert.equal(result.report.queued, true);
  assert.equal(requests.length, 4);
  await access(join(fixture, 'SHELL_CONTROL_EXECUTED'));
  assert.equal(result.controlAnswer.info.finish, 'stop');
  const inbox = await api(`/api/session/${origin.id}/inbox`);
  assert.equal(inbox.data.length, 1);
  assert.equal(inbox.data[0].type, 'synthetic');
  assert.equal(inbox.data[0].payload.description, inbox.data[0].payload.text);
  const invokeReview = async (command, suffix, expected) => {
    const created = await api('/api/session', { title: 'Workflow fixture ' + suffix, location: { directory: directories.work } });
    await api(`/api/session/${created.data.id}/command`, { name: command, text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 ' + suffix, delivery: 'steer' });
    const queued = await api(`/api/session/${created.data.id}/inbox`);
    const receipt = queued.data.at(-1)?.payload?.text;
    workflowReceipts.push({ command, suffix, receipt });
    assert.match(receipt ?? '', expected);
    return created.data.id;
  };
  await invokeReview('pr-check', 'smoke-check', /\] READY/);
  await invokeReview('pr-review', 'smoke-review', /\] COMPLETE/);
  await invokeReview('pr-check', 'smoke-check force-shell', /\] INCOMPLETE/);
  await invokeReview('pr-check', 'smoke-check force-execute', /\] INCOMPLETE/);
  assert.ok(workflowReceipts.filter(row => row.suffix.includes('force-')).every(row => row.receipt.includes('blocked-native-tools=2')));
  assert.equal(forbiddenFetches, 0);
  await assert.rejects(access(join(fixture, 'NATIVE_EXECUTED')));
  const cancelledOrigin = (await api('/api/session', { title: 'Cancellation fixture', location: { directory: directories.work } })).data;
  const beforeCancel = requests.length;
  const cancellation = api(`/api/session/${cancelledOrigin.id}/command`, { name: 'pr-check', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 smoke-check hang-smoke', delivery: 'steer' }).then(value => ({ value }), error => ({ error }));
  for (let attempt = 0; attempt < 50 && requests.length === beforeCancel; attempt++) await new Promise(resolveReady => setTimeout(resolveReady, 100));
  assert.equal(requests.length, beforeCancel + 1, 'Cancellation fixture must reach the fake provider.');
  await api(`/api/session/${cancelledOrigin.id}/command`, { name: 'pr-stop', text: '', delivery: 'steer' });
  const stopped = await cancellation;
  assert.equal(stopped.error, undefined, String(stopped.error));
  const stoppedInbox = await api(`/api/session/${cancelledOrigin.id}/inbox`);
  const cancellationReceipt = stoppedInbox.data.map(item => item.payload?.text).find(value => /\] CANCELLED/.test(value ?? ''));
  assert.ok(cancellationReceipt, 'Manual cancellation must leave its CANCELLED receipt.');
  assert.equal(requests.length, beforeCancel + 1, 'Manual cancellation must not restart the fake provider.');
  workflowReceipts.push({ command: 'pr-check + pr-stop', suffix: 'hang-smoke', receipt: cancellationReceipt });
  const mcpCalls = (await readFile(join(fixture, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(mcpCalls.length, 5, 'Exactly one helper, one check, and three review stage MCP reads are expected.');
  for (const call of mcpCalls) {
    assert.equal(call.name, 'read_fixture');
    assert.deepEqual(call.arguments, { value: 'fixture-source' });
  }
  assert.equal(requests.length, 17);
  console.log(JSON.stringify({ status: 'PASS', host: info.version, providerRequests: requests.length, mcpToolCalls: mcpCalls.length, shellPositiveControl: true, workflows: workflowReceipts.map(({command,suffix})=>({command,suffix})), forbiddenFetches, actualOS: process.platform, fixture }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolveStopped => setTimeout(() => { child.kill('SIGKILL'); resolveStopped(); }, 5000).unref())]);
  }
  provider.closeAllConnections();
  await new Promise(resolveClosed => provider.close(resolveClosed));
  await writeFile(join(fixture, 'host.log'), logs);
  await writeFile(join(fixture, 'provider-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'workflow-receipts.json'), JSON.stringify(workflowReceipts, null, 2));
  console.error(`Private fixture evidence: ${fixture}`);
}
