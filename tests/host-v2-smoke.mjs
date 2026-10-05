/**
 * Opt-in exact-host fixture: node tests/host-v2-smoke.mjs /absolute/path/opencode [--replace]
 * Uses isolated directories, a loopback deterministic provider, and a fake stdio
 * MCP. Covers session helpers, full review, native guards, and cancellation.
 * The ordinary-agent shell positive control writes only inside its own fixture.
 * This does not validate a real provider, official Azure MCP, or TUI rendering.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
assert.ok(binary?.startsWith('/'), 'Supply the exact downloaded host binary as an absolute path.');
const replacement = process.argv[3] === '--replace';
assert.ok(process.argv.length <= 4 && (!process.argv[3] || replacement), 'Only --replace is supported.');
const fixturesRoot = join(sourceRoot, '.local');
await mkdir(fixturesRoot, { recursive: true });
const fixture = await mkdtemp(join(fixturesRoot, 'host-v2-smoke-'));
const directories = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work', 'other-project'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
await mkdir(join(directories.config, 'plugins'), { recursive: true });
const runtimeDirectory = join(directories.config, 'plugins', 'azpr-v2');
const verificationMarker = `azpr-project-${randomUUID()}`;
for (const name of ['work', 'other-project']) await writeFile(join(directories[name], 'project-marker.txt'), name);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = code => `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
const settings = JSON.parse(await readFile(join(sourceRoot, 'config', 'settings.example.json'), 'utf8'));
for (const role of ['functional', 'risk', 'verifier']) settings.models.review[role] = `fixture/${role}`;
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
const profile = join(fixture, 'settings.json');
await writeFile(profile, JSON.stringify(settings, null, 2));
const install = args => {
  const result = spawnSync('/bin/sh', [join(sourceRoot, 'install.sh'), '--config-dir', directories.config, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
};
install(['--settings', profile]);
if (replacement) {
  const before = await readFile(join(runtimeDirectory, 'settings.json'));
  await rm(join(runtimeDirectory, 'server.js'), { force: true });
  await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: './plugin.js', private: true }));
  install(['--replace']);
  assert.deepEqual(await readFile(join(runtimeDirectory, 'settings.json')), before);
}
const requests = [];
const workflowReceipts = [];
let forbiddenFetches = 0;
let child;
let logs = '';
let rejectNextPlan = true;
let commentShellProbe;
const continuedResponses = new Map();
const expectedPublishedText = [];
const provider = createServer(async (request, response) => {
  if (request.url === '/v1/forbidden') { forbiddenFetches++; response.end('Forbidden fixture fetch was reached'); return; }
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  requests.push({ path: request.url, body: parsed, sessionID: request.headers['x-opencode-session-id'] });
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Unexpected fixture route' } }));
    return;
  }
  const tool = parsed.tools?.find(item => item.function?.description === 'Read-only deterministic smoke fixture.');
  const hasResult = parsed.messages?.some(message => message.role === 'tool');
  const sessionID = request.headers['x-opencode-session-id'];
  const continued = continuedResponses.get(sessionID);
  const rawPrompt = continued?.prompt ?? parsed.messages?.findLast(message => message.role === 'user')?.content;
  let payload;
  try { payload = JSON.parse(rawPrompt); } catch {}
  if (rejectNextPlan && payload?.target && payload.findings && !payload.comments) {
    rejectNextPlan = false;
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_DIAGNOSTIC', type: 'permission_error' } }));
    return;
  }
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
  if (userContext === 'smoke-review' && payload.reviews) {
    final.rejected=final.confirmed.filter(item=>item.id==='R-1').map(item=>({id:item.id,reason:'Fixture candidate declined by verifier.'}));
    final.confirmed=final.confirmed.filter(item=>item.id!=='R-1');
  }
  if (userContext === 'smoke-review' && parsed.model === 'risk') final.coverage.gaps = ['Tests were not executed in this source-only fixture.'];
  if (payload?.target && payload.findings && !payload.comments) final = { status: 'READY',
    comments: payload.findings.slice(0, 1).map(item => ({ findingId: item.id, severity: item.severity,
      path: snapshot.files[0], startLine: 2, endLine: 2, anchor: 'fixture-source',
      body: 'issue (high): Fixture guard is missing\n\nThe fixture branch loses state. Restore the guard and test that branch.' })),
    skipped: [...payload.findings.slice(1).map(item => ({ findingId: item.id, reason: 'Duplicate fixture concern.' })), ...payload.dispositions.filter(item=>item.status!=='CONFIRMED').map(item=>({findingId:item.id,reason:item.reason}))] };
  const forced = userContext.includes('force-shell') ? 'shell' : userContext.includes('force-execute') ? 'execute' : undefined;
  const projectVerification = userContext.startsWith('project-');
  const localComment = payload?.target && commentShellProbe;
  const hanging = userContext === 'hang-verification' && parsed.model === 'functional';
  const priorToolResults = parsed.messages?.filter(message => message.role === 'tool').length ?? 0;
  const toolName = projectVerification || hanging || shellControl || (localComment && !hasResult) ? 'shell' : forced ?? tool?.function.name;
  const publisher = Boolean(payload?.comments);
  const callTool = toolName && (forced || publisher ? priorToolResults < 2 : !hasResult);
  const args = localComment && !hasResult ? { command: nodeCommand(`const fs=require('node:fs'); const project=fs.readFileSync('project-marker.txt','utf8'); fs.writeFileSync(${JSON.stringify(commentShellProbe + '.json')},JSON.stringify({cwd:process.cwd(),project})); console.log('COMMENT_PROJECT:'+project);`), description: 'Local comment verification fixture' }
    : projectVerification ? { command: nodeCommand(`const fs=require('node:fs'); const cwd=process.cwd(); const project=fs.readFileSync('project-marker.txt','utf8'); fs.writeFileSync(${JSON.stringify(userContext + '-' + parsed.model + '.json')},JSON.stringify({cwd,project,role:${JSON.stringify(parsed.model)}})); console.log('PROJECT_REPRODUCTION:'+project); process.exit(${parsed.model === 'risk' ? 7 : 0});`), description: 'Local project verification fixture' }
    : hanging ? { command: nodeCommand(`process.title=${JSON.stringify(verificationMarker)}; require('node:fs').writeFileSync('running.pid',String(process.pid)); setInterval(()=>{},1000)`), description: 'Cancellable foreground project fixture' }
    : shellControl ? { command: `touch ${shellQuote(join(fixture, 'SHELL_CONTROL_EXECUTED'))}`, description: 'Harmless fixture shell positive control' }
    : forced === 'shell' ? { command: `touch ${shellQuote(join(fixture, 'NATIVE_EXECUTED'))}`, description: 'Fixture forbidden shell' }
    : forced === 'execute' ? { code: `return await fetch(${JSON.stringify(providerURL + '/forbidden')})` }
    : { value: publisher ? 'publisher-error' : 'fixture-source', ...(payload?.prUrl ? { anyPath: snapshot.files[0], anyRevision: snapshot.head } : {}), ...(publisher ? { payload: payload.comments[0].content.replace('Restore the guard', 'Please restore the guard') } : {}) };
  if (publisher && callTool && toolName !== 'shell') expectedPublishedText.push(payload.comments[0].content);
  let content = JSON.stringify(final);
  if (userContext === 'smoke-review' && parsed.model === 'functional') content += '}';
  if (userContext === 'smoke-review' && payload.reviews) content = 'Example: fn({"item": 3}).\n```json\n' + content + '\n```';
  if (payload?.target && payload.findings && !payload.comments) content = '```json\n' + content + '\n```\nLocal verification notes: {"example": 7}.';
  if (userContext === 'smoke-prose' && (parsed.model === 'functional' || payload.reviews)) {
    content = payload.reviews ? 'Useful final prose with an unresolved evidence gap.' : 'Useful initial prose about a reachable fixture issue.';
  }
  let incomplete = false;
  if (continued) { content = continued.tail; continuedResponses.delete(sessionID); }
  else if (!callTool && userContext === 'smoke-review' && payload.reviews) {
    const split = content.indexOf('Deterministic fixture final report.') + 14;
    continuedResponses.set(sessionID, { prompt: rawPrompt, tail: content.slice(split) });
    content = content.slice(0, split); incomplete = true;
  }
  const delta = callTool
    ? { tool_calls: [{ index: 0, id: forced ? 'call_fixture_forbidden_' + (priorToolResults + 1) : 'call_fixture_read', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }
    : { content };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
  if (incomplete) { response.end(); return; }
  emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const resultPath = join(fixture, 'result.json');
const mcpPath = join(fixture, 'mcp.mjs');
await writeFile(mcpPath, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'azpr-smoke-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'read_fixture', description: 'Read-only deterministic smoke fixture.', inputSchema: { type: 'object', properties: { value: { type: 'string' }, payload: { type: 'string' }, anyPath: { type: 'string' }, anyRevision: { type: 'string' } }, required: ['value'] } }] };
  else if (request.method === 'tools/call') {
    appendFileSync(${JSON.stringify(join(fixture, 'mcp-calls.jsonl'))}, JSON.stringify(request.params) + '\\n');
    result = request.params.arguments.value === 'publisher-error'
      ? { isError: true, content: [{ type: 'text', text: 'Fixture publication tool failed.' }] }
      : { content: [{ type: 'text', text: '  fixture-source\\n\\nfixture-third-line\\n' }] };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`);
await writeFile(join(directories.config, 'plugins', 'smoke.js'), `
import { writeFile } from 'node:fs/promises';
import { createReviewSession, requestReview, interruptSession, appendReport } from ${JSON.stringify(pathToFileURL(join(runtimeDirectory, 'session.mjs')).href)};
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
  await ctx.command.transform(editor => editor.add({ name:'fixture-delay-tools', description:'Temporarily withhold fixture registration', async execute() {
    const held = await ctx.tool.transform(editor => {
      for (const tool of editor.list()) if (tool.options?.namespace === 'fixture') editor.remove(tool.id);
    });
    setTimeout(() => { void held.dispose(); }, 500);
  }}));
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
const stopHost = async () => {
  if (child && child.exitCode === null) {
    const stopping = child;
    const exited = once(stopping, 'exit');
    let timer;
    stopping.kill('SIGTERM');
    try {
      await Promise.race([exited, new Promise(resolveStopped => {
        timer = setTimeout(() => { stopping.kill('SIGKILL'); resolveStopped(); }, 5000).unref();
      })]);
    } finally { clearTimeout(timer); }
  }
};
const startHost = async () => {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directories.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '';
  const ready = new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('exit', code => rejectReady(new Error(`Host exited before readiness: ${code}`)));
    child.stdout.on('data', data => {
      logs += data;
      startup += data;
      const found = startup.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (found) resolveReady(found[1]);
    });
    child.stderr.on('data', data => { logs += data; });
  });
  return Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture host startup timeout')), 30000).unref())]);
};
try {
  let url = await startHost();
  const api = async (path, body, directory = directories.work) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': directory }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
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
  const commands = await api('/api/command');
  for (const name of ['pr-check', 'pr-review', 'pr-stop', 'pr-deep', 'pr-comment']) {
    assert.ok(commands.data.some(command => command.name === name), `Installed command missing: ${name}`);
  }
  const agents = await api('/api/agent');
  for (const role of ['check', 'functional', 'risk', 'verifier', 'comment-plan', 'comment-publish']) {
    assert.ok(agents.data.some(agent => agent.name === `azpr-review-${role}`), `Installed role missing: ${role}`);
  }
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
  const permissionReplies = [];
  const invokeReview = async (command, suffix, expected, { directory = directories.work, permissions, approve = false } = {}) => {
    const created = await api('/api/session', { title: 'Workflow fixture ' + suffix, location: { directory }, ...(permissions ? { permissions } : {}) }, directory);
    // Each project owns its MCP lifecycle; fixture startup is not a product retry.
    let connected = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const catalog = await api('/api/mcp', undefined, directory);
      if (catalog.data?.some(server => server.name === 'fixture' && server.status?.status === 'connected')) { connected = true; break; }
      await new Promise(resolveReady => setTimeout(resolveReady, 100));
    }
    assert.equal(connected, true, 'Project fixture MCP did not connect.');
    let done = false;
    const run = api(`/api/session/${created.data.id}/command`, { name: command, text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 ' + suffix, delivery: 'steer' }, directory).then(value => ({ value }), error => ({ error })).finally(() => { done = true; });
    if (approve) {
      while (!done) {
        const pending = await api('/api/permission/request', undefined, directory);
        for (const request of pending.data) {
          assert.equal(request.action, 'shell');
          // The host must have paused before executing any requested command.
          const session = (await api(`/api/session/${request.sessionID}`)).data;
          assert.equal(session.parentID, created.data.id);
          assert.equal(session.location.directory, directory);
          await assert.rejects(access(join(directory, suffix + '-' + session.model.id + '.json')));
          permissionReplies.push({ sessionID: request.sessionID, action: request.action, directory });
          await api(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision: 'once' });
        }
        if (!done) await new Promise(resolveReady => setTimeout(resolveReady, 100));
      }
    }
    const settled = await run;
    if (settled.error) throw settled.error;
    const queued = await api(`/api/session/${created.data.id}/inbox`);
    const receipt = queued.data.at(-1)?.payload?.text;
    workflowReceipts.push({ command, suffix, receipt });
    assert.match(receipt ?? '', expected);
    return created.data.id;
  };
  await invokeReview('pr-check', 'smoke-check', /\] READY/);
  await api(`/api/session/${origin.id}/command`, { name: 'fixture-delay-tools', text: '', delivery: 'steer' });
  const reviewOrigin = await invokeReview('pr-review', 'smoke-review', /\] COMPLETE/);
  const reviewDebug = /Private debug directory: ([^\n]+)/.exec(workflowReceipts.at(-1).receipt)[1];
  const settledTools = JSON.parse(await readFile(join(reviewDebug, 'readiness.json'), 'utf8')).toolRegistration;
  assert.equal(settledTools.status, 'observed');
  assert.ok(settledTools.polls > 1, 'Production readiness must observe delayed registration before inference.');
  const languageRequests = requests.filter(request => {
    try { return JSON.parse(request.body.messages.findLast(message => message.role === 'user').content).userContext === 'smoke-review'; }
    catch { return false; }
  });
  assert.equal(new Set(languageRequests.map(request => request.body.model)).size, 3);
  for (const request of languageRequests) {
    assert.equal(JSON.parse(request.body.messages.findLast(message => message.role === 'user').content).outputLanguage, settings.outputLanguage);
    assert.ok(request.body.messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes(`outputLanguage: ${settings.outputLanguage}`)), 'Configured language must reach the actual provider request for every reviewer.');
  }
  assert.match(workflowReceipts.at(-1).receipt, /output-format-corrections=1/);
  assert.match(workflowReceipts.at(-1).receipt, /azpr-review-risk: PARTIAL/);
  const continuedStage = JSON.parse(await readFile(join(reviewDebug, '03-azpr-review-verifier.result.json'), 'utf8'));
  assert.equal(continuedStage.hostContinuations, 1);
  assert.match(continuedStage.reviewWarnings.join(' '), /OpenCode continued 1 incomplete text stream/);
  assert.equal(continuedResponses.size, 0);
  const reviewID = /\[AZPR ([a-f0-9]{8})\]/.exec(workflowReceipts.at(-1).receipt)[1];
  const beforeRejectedPlan = requests.length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: reviewID, delivery: 'steer' });
  const rejectedPlan = (await api(`/api/session/${reviewOrigin}/inbox`)).data.at(-1)?.payload?.text;
  assert.match(rejectedPlan, /\] INCOMPLETE/);
  assert.match(rejectedPlan, /HTTP 403; 0 tool calls observed/);
  assert.doesNotMatch(rejectedPlan, /PRIVATE_PROVIDER_DIAGNOSTIC/);
  assert.equal(requests.length, beforeRejectedPlan + 1, 'Provider rejection must not trigger a repair or fallback request.');
  await assert.rejects(api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: reviewID + ' --publish', delivery: 'steer' }), /Preview first/);
  assert.equal(requests.length, beforeRejectedPlan + 1, 'A failed preview must not authorize a publisher.');
  workflowReceipts.push({ command: 'pr-comment', suffix: 'provider-rejected-preview', receipt: rejectedPlan });
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: reviewID, delivery: 'steer' });
  const preview = (await api(`/api/session/${reviewOrigin}/inbox`)).data.at(-1)?.payload?.text;
  assert.match(preview, /\] PREVIEW/);
  workflowReceipts.push({ command: 'pr-comment', suffix: 'smoke-review-preview', receipt: preview });
  const beforePublication = requests.length;
  await api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: reviewID + ' --publish', delivery: 'steer' });
  const publication = (await api(`/api/session/${reviewOrigin}/inbox`)).data.at(-1)?.payload?.text;
  assert.match(publication, /\] INCOMPLETE/); assert.match(publication, /publisher tool failed/i);
  assert.match(publication, /UNKNOWN/);
  assert.equal(requests.length, beforePublication + 1, 'A publisher tool error must prevent another model request.');
  const publicationPayload = JSON.parse(requests.at(-1).body.messages.findLast(message => message.role === 'user').content);
  assert.deepEqual(Object.keys(publicationPayload).sort(), ['comments', 'outputLanguage', 'snapshot', 'target']);
  const plannerPayload = JSON.parse(requests[beforeRejectedPlan].body.messages.findLast(message => message.role === 'user').content);
  assert.equal(plannerPayload.reviewToolText.length, 1, 'Identical reviewer observations are shared once with the planner, including original arguments.');
  assert.match(plannerPayload.reviewToolText[0].text, /Request arguments:.*fixture-source/);
  assert.match(plannerPayload.reviewToolText[0].text, /1 \|   fixture-source\n2 \| \n3 \| fixture-third-line/);
  const publicationDebug = /Private debug directory: ([^\n]+)/.exec(publication)[1];
  const publicationStage = JSON.parse(await readFile(join(publicationDebug, '01-azpr-review-comment-publish.result.json'), 'utf8'));
  assert.equal(publicationStage.toolErrors.length, 1);
  assert.match(publicationStage.toolErrors[0].error.message, /Fixture publication tool failed/);
  assert.doesNotMatch(publication, /Fixture publication tool failed/);
  assert.equal(publicationPayload.comments[0].startOffset, 1);
  assert.equal(publicationPayload.comments[0].endOffset, 16);
  assert.equal(publicationPayload.comments[0].anchor, '  fixture-source');
  assert.equal(publicationPayload.comments[0].startLine, 1);
  assert.equal(publicationPayload.comments[0].endLine, 1);
  assert.match(preview, /Fixture candidate declined by verifier/);
  await assert.rejects(api(`/api/session/${reviewOrigin}/command`, { name: 'pr-comment', text: reviewID + ' --publish', delivery: 'steer' }), /already had a publication/);
  workflowReceipts.push({ command: 'pr-comment --publish', suffix: 'publisher-error', receipt: publication });
  await invokeReview('pr-review', 'smoke-prose', /\] PARTIAL/);
  assert.match(workflowReceipts.at(-1).receipt, /Useful final prose/);
  assert.match(workflowReceipts.at(-1).receipt, /Useful initial prose/);
  assert.match(workflowReceipts.at(-1).receipt, /UNREVIEWED/);
  await invokeReview('pr-check', 'smoke-check force-shell', /\] INCOMPLETE/, { permissions: [{ action: 'shell', resource: '*', effect: 'allow' }] });
  await invokeReview('pr-check', 'smoke-check force-execute', /\] INCOMPLETE/);
  assert.ok(workflowReceipts.filter(row => row.suffix.includes('force-')).every(row => row.receipt.includes('blocked-native-tools=2')));
  assert.equal(forbiddenFetches, 0);
  await assert.rejects(access(join(fixture, 'NATIVE_EXECUTED')));
  const shellPermission = effect => [{ action: 'shell', resource: '*', effect }];
  const verifiedOrigin = await invokeReview('pr-review', 'project-allowed', /\] COMPLETE/, { permissions: shellPermission('allow') });
  const verifiedReceipt = workflowReceipts.at(-1).receipt;
  const verifiedID = /\[AZPR ([a-f0-9]{8})\]/.exec(verifiedReceipt)[1];
  commentShellProbe = 'comment-plan-allowed';
  await api(`/api/session/${verifiedOrigin}/command`, { name: 'pr-comment', text: verifiedID, delivery: 'steer' });
  assert.match((await api(`/api/session/${verifiedOrigin}/inbox`)).data.at(-1).payload.text, /\] PREVIEW/);
  const localPlanPayload = JSON.parse(requests.at(-1).body.messages.findLast(message => message.role === 'user').content);
  assert.deepEqual(localPlanPayload.reviewToolText, [], 'Native shell output is not cached as MCP review text.');
  assert.deepEqual(JSON.parse(await readFile(join(directories.work, commentShellProbe + '.json'), 'utf8')), { cwd: directories.work, project: 'work' });
  commentShellProbe = 'comment-publish-allowed';
  const beforeLocalPublisher = requests.length;
  await api(`/api/session/${verifiedOrigin}/command`, { name: 'pr-comment', text: verifiedID + ' --publish', delivery: 'steer' });
  assert.match((await api(`/api/session/${verifiedOrigin}/inbox`)).data.at(-1).payload.text, /publisher tool failed/i);
  assert.equal(requests.length, beforeLocalPublisher + 2, 'Local verification may run, but a later publisher error still stops every subsequent request.');
  const localPublicationPayload = JSON.parse(requests.at(-1).body.messages.findLast(message => message.role === 'user').content);
  assert.equal(Object.hasOwn(localPublicationPayload, 'reviewToolText'), false);
  assert.deepEqual(JSON.parse(await readFile(join(directories.work, commentShellProbe + '.json'), 'utf8')), { cwd: directories.work, project: 'work' });
  commentShellProbe = undefined;
  const approvedOrigin = await invokeReview('pr-review', 'project-approved', /\] COMPLETE/, { directory: directories['other-project'], permissions: shellPermission('ask'), approve: true });
  const approvedID = /\[AZPR ([a-f0-9]{8})\]/.exec(workflowReceipts.at(-1).receipt)[1];
  assert.equal(permissionReplies.length, 3, 'Every reviewer shell call must receive explicit host approval.');
  commentShellProbe = 'comment-plan-approved';
  let planDone = false;
  const approvedPlan = api(`/api/session/${approvedOrigin}/command`, { name: 'pr-comment', text: approvedID, delivery: 'steer' }, directories['other-project']).finally(() => { planDone = true; });
  while (!planDone) {
    for (const request of (await api('/api/permission/request', undefined, directories['other-project'])).data) {
      const session = (await api(`/api/session/${request.sessionID}`)).data;
      assert.equal(session.agent, 'azpr-review-comment-plan');
      assert.equal(session.parentID, approvedOrigin);
      assert.equal(request.action, 'shell');
      await assert.rejects(access(join(directories['other-project'], commentShellProbe + '.json')));
      permissionReplies.push({ sessionID: request.sessionID, action: request.action, directory: directories['other-project'] });
      await api(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision: 'once' });
    }
    if (!planDone) await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  await approvedPlan;
  assert.match((await api(`/api/session/${approvedOrigin}/inbox`)).data.at(-1).payload.text, /\] PREVIEW/);
  assert.deepEqual(JSON.parse(await readFile(join(directories['other-project'], commentShellProbe + '.json'), 'utf8')), { cwd: directories['other-project'], project: 'other-project' });
  assert.equal(permissionReplies.length, 4, 'The comment planner must also receive its own one-time host approval.');
  commentShellProbe = undefined;
  for (const [suffix, name] of [['project-allowed', 'work'], ['project-approved', 'other-project']]) {
    for (const role of ['functional', 'risk', 'verifier']) {
      const observed = JSON.parse(await readFile(join(directories[name], `${suffix}-${role}.json`), 'utf8'));
      assert.deepEqual(observed, { cwd: directories[name], project: name, role });
      const answer = requests.find(request => {
        try { return request.body.model === role && JSON.parse(request.body.messages.findLast(message => message.role === 'user').content).userContext === suffix && request.body.messages.some(message => message.role === 'tool'); }
        catch { return false; }
      });
      assert.ok(answer?.body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('PROJECT_REPRODUCTION:' + name)), 'Actual shell output must reach each reviewer.');
    }
  }
  const deniedOrigin = await invokeReview('pr-review', 'project-denied', /\] COMPLETE/, { permissions: shellPermission('deny') });
  const deniedID = /\[AZPR ([a-f0-9]{8})\]/.exec(workflowReceipts.at(-1).receipt)[1];
  commentShellProbe = 'comment-plan-denied';
  await api(`/api/session/${deniedOrigin}/command`, { name: 'pr-comment', text: deniedID, delivery: 'steer' });
  await assert.rejects(access(join(directories.work, commentShellProbe + '.json')));
  const deniedRequest = requests.findLast(request => {
    try { return Boolean(JSON.parse(request.body.messages.findLast(message => message.role === 'user').content)?.target); }
    catch { return false; }
  });
  assert.ok(!deniedRequest.body.tools.some(item => item.function?.name === 'shell'), 'Inherited host deny must still hide the shell schema.');
  commentShellProbe = undefined;
  for (const role of ['functional', 'risk', 'verifier']) await assert.rejects(access(join(directories.work, `project-denied-${role}.json`)));
  const approvalOrigin = (await api('/api/session', { title: 'Cancel pending approvals', location: { directory: directories.work }, permissions: shellPermission('ask') })).data;
  const approvalCancellation = api(`/api/session/${approvalOrigin.id}/command`, { name: 'pr-review', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 project-cancelled-approval', delivery: 'steer' });
  let approvals = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    approvals = (await api('/api/permission/request')).data;
    if (approvals.length === 2) break;
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  assert.equal(approvals.length, 2, 'Both initials must wait for approval before cancellation.');
  const requestsBeforeStop = requests.length;
  await api(`/api/session/${approvalOrigin.id}/command`, { name: 'pr-stop', text: '', delivery: 'steer' });
  await approvalCancellation;
  assert.ok((await api(`/api/session/${approvalOrigin.id}/inbox`)).data.some(item => /\] CANCELLED/.test(item.payload?.text ?? '')));
  assert.deepEqual((await api('/api/permission/request')).data, []);
  for (const request of approvals) await assert.rejects(api(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision: 'once' }));
  for (const role of ['functional', 'risk', 'verifier']) await assert.rejects(access(join(directories.work, `project-cancelled-approval-${role}.json`)));
  assert.equal(requests.length, requestsBeforeStop, 'Late approvals must not execute commands or restart reviewers.');
  const foregroundProcesses = async () => {
    const found = [];
    for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).startsWith(verificationMarker)) found.push(pid); } catch {}
    }
    return found;
  };
  const toolCancelOrigin = (await api('/api/session', { title: 'Project command cancellation fixture', location: { directory: directories.work }, permissions: shellPermission('allow') })).data;
  const toolCancellation = api(`/api/session/${toolCancelOrigin.id}/command`, { name: 'pr-review', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 hang-verification', delivery: 'steer' });
  let observedProcesses = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    observedProcesses = await foregroundProcesses();
    if (observedProcesses.length) break;
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  assert.equal(observedProcesses.length, 1, 'A real foreground command must start before cancellation.');
  await api(`/api/session/${toolCancelOrigin.id}/command`, { name: 'pr-stop', text: '', delivery: 'steer' });
  await toolCancellation;
  assert.deepEqual(await foregroundProcesses(), []);
  assert.ok((await api(`/api/session/${toolCancelOrigin.id}/inbox`)).data.some(item => /\] CANCELLED/.test(item.payload?.text ?? '')));
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
  assert.equal(mcpCalls.length, 12, 'Source workflows, project preview and cancellation sibling use fixture MCP.');
  for (const call of mcpCalls) {
    assert.equal(call.name, 'read_fixture');
    assert.ok(['fixture-source', 'publisher-error'].includes(call.arguments.value));
  }
  const numberedRequests = requests.filter(request => request.body.messages?.some(message =>
    message.role === 'tool' && JSON.stringify(message.content).includes('AZPR numbered tool text')));
  assert.ok(numberedRequests.length >= 4, 'Actual host must deliver numbered MCP text to reviewer and planner requests.');
  for (const request of numberedRequests) {
    const toolMessage = request.body.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('AZPR numbered tool text'));
    assert.ok(JSON.stringify(toolMessage.content).includes('3 | fixture-third-line'));
    assert.ok(JSON.stringify(toolMessage.content).includes('Request arguments:'));
  }
  assert.ok(numberedRequests.some(request => request.body.messages.some(message => { try { return message.role === 'user' && JSON.parse(message.content).findings; } catch { return false; } })), 'Comment planner receives the numbered source view.');
  assert.equal(mcpCalls.filter(call => call.arguments.value === 'publisher-error').length, 2);
  assert.deepEqual(mcpCalls.filter(call => call.arguments.value === 'publisher-error').map(call => call.arguments.payload), expectedPublishedText, 'The actual MCP must receive saved text after execute.before normalization.');
  const cancellationSiblingRequests = requests.filter(request => {
    try { return request.body.model === 'risk' && JSON.parse(request.body.messages.findLast(message => message.role === 'user').content).userContext === 'hang-verification'; }
    catch { return false; }
  }).length;
  assert.ok([1, 2].includes(cancellationSiblingRequests), 'Cancellation may stop the sibling before or after its tool-result response.');
  assert.equal(requests.length - cancellationSiblingRequests, 57);
  const privateSession = requests.find(request => request.body.model === 'risk')?.sessionID;
  assert.ok(privateSession, 'The private check must reach the loopback provider.');
  const privateAuxiliaryDenied = async () => {
    const before = requests.length;
    await assert.rejects(api(`/api/session/${privateSession}/generate`, { prompt: 'Unauthorized private generation fixture' }));
    await api(`/api/session/${privateSession}/compact`, {});
    await api(`/api/experimental/session/${privateSession}/wait`, {});
    assert.equal(requests.length, before, 'A revoked private session must not send generate or compaction requests.');
  };
  const ordinaryGenerate = async () => {
    const before = requests.length;
    const answer = await api(`/api/session/${result.made.id}/generate`, { prompt: 'Ordinary generation positive control' });
    assert.equal(typeof answer.data.text, 'string');
    assert.equal(requests.length, before + 1, 'Ordinary generation must still reach the fixture provider.');
  };
  await ordinaryGenerate();
  const beforeCompaction = requests.length;
  await api(`/api/session/${result.made.id}/compact`, {});
  await api(`/api/experimental/session/${result.made.id}/wait`, {});
  assert.ok(requests.length > beforeCompaction, 'Ordinary compaction must still reach the fixture provider.');
  await privateAuxiliaryDenied();
  await stopHost();
  url = await startHost();
  await api('/api/session', { title: 'Restart fixture origin', location: { directory: directories.work } });
  for (let attempt = 0; attempt < 50; attempt++) {
    const catalog = await api('/api/mcp');
    if (catalog.data?.some(server => server.name === 'fixture' && server.status?.status === 'connected')) break;
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  await ordinaryGenerate();
  await privateAuxiliaryDenied();
  assert.equal((await readFile(join(fixture, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').length, 12);
  console.log(JSON.stringify({ status: 'PASS', installation: replacement ? 'replace-exports-only' : 'fresh', host: info.version, providerRequests: requests.length, mcpToolCalls: mcpCalls.length, projectVerification: true, projectSwitch: true, hostPermissionApprovals: permissionReplies.length, hostPermissionDenial: true, pendingApprovalCancellation: true, foregroundCancellation: true, nonzeroVerificationPreview: true, shellPositiveControl: true, privateAuxiliaryDenied: true, restartGuard: true, ordinaryAuxiliaryPreserved: true, workflows: workflowReceipts.map(({command,suffix})=>({command,suffix})), forbiddenFetches, actualOS: process.platform, fixture }, null, 2));
} finally {
  await stopHost();
  provider.closeAllConnections();
  await new Promise(resolveClosed => provider.close(resolveClosed));
  await writeFile(join(fixture, 'host.log'), logs);
  await writeFile(join(fixture, 'provider-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'workflow-receipts.json'), JSON.stringify(workflowReceipts, null, 2));
  console.error(`Private fixture evidence: ${fixture}`);
}
