/** Opt-in exact-host scale fixture. Fake loopback models/MCP only; no Azure account.
 * node tests/host-v2-comment-scale.mjs /absolute/path/opencode
 * Synthetic completions test transport/accounting, not model review quality.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), binary = process.argv[2];
assert.ok(binary?.startsWith('/'));
const fixture = await mkdtemp(join(root, '.local/host-v2-comment-scale-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const snapshot = { repository: 'fixture/project/repository', prId: 123, base: 'a'.repeat(40), head: 'b'.repeat(40), scope: 'pr', files: ['/src/fixture.js', ...Array.from({ length: 6000 }, (_, i) => `/file-${i}.ts`)] };
const finding = id => ({ id, summary: `Distinct fixture defect ${id}`, location: 'head:/src/fixture.js:1', severity: 'high', evidence: `Required guard missing at ${id}.`, counterevidence: 'Fixture caller checked.', suggestion: 'Restore this guard and regression case.' });
const sourcePrefix = '  fixture-source\n\nfixture-third-line\n';
const source = size => sourcePrefix + 'x\n'.repeat(Math.ceil(size / 2)).slice(0, size - sourcePrefix.length);
const sizes = { functional: 3307749, risk: 120, verifier: 2200000 };
const requests = [], receipts = [], posted = new Map();
let child, logs = '', nextThread = 1000;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), payload = JSON.parse(input.messages.findLast(m => m.role === 'user').content);
    const sessionID = request.headers['x-opencode-session-id'];
    const results = input.messages.filter(m => m.role === 'tool');
    requests.push({ sessionID, model: input.model, work: payload.commentWork, inputCharacters: JSON.stringify(payload).length, requestCharacters: body.length, toolResults: results.length, toolArguments: input.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(call => call.function.arguments) });
    const fixtureTool = input.tools?.find(t => t.function.description === 'Deterministic scale fixture.')?.function.name;
    let call, final;
    if (payload.prUrl) {
      if (!results.length) call = { name: fixtureTool, arguments: { operation: 'source', size: sizes[input.model], path: snapshot.files[0], revision: snapshot.head } };
      else if (payload.reviews) final = { status: 'COMPLETE', snapshot, currentHead: snapshot.head, currentBase: snapshot.base, confirmed: payload.reviews.flatMap(r => r.findings).map(f => ({ ...f, reason: 'Fixture verified.' })), merged: [], rejected: [], needsInfo: [], newFindings: [], report: Array.from({ length: 400 }, (_, i) => `Advice ${i}: Preserve a distinct supported component tradeoff and its correction.\n`).join('') };
      else final = { status: 'COMPLETE', snapshot, coverage: { files: snapshot.files, gaps: [] }, findings: Array.from({ length: 35 }, (_, i) => finding(`${input.model === 'functional' ? 'F' : 'R'}-${i + 1}`)), report: 'Fixture initial review complete.' };
    } else if (payload.commentWork.kind === 'plan') {
      if (payload.commentWork.page === 1 && !payload.continuation) {
        if ((input.tools?.length ?? 0) > 0 && results.length < 8) {
          const shell = input.tools.find(t => t.function.name === 'shell'); assert.ok(shell);
          const code = `const fs=require('node:fs');const rows=fs.readFileSync(${JSON.stringify(payload.reportReference.pages)},'utf8').trim().split('\\n');console.log(rows[${results.length}]);`;
          call = { name: 'shell', arguments: { command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, description: 'Read a bounded original report page' } };
        } else {
          assert.equal(input.tools?.length ?? 0, 0, 'The runtime must finish a long read-only session with a checkpoint.');
          final = { status: 'CONTINUE', comments: [], skipped: [], continuation: `Read ${results.length} bounded report rows. Complete assigned findings and assigned report segment in the next session.` };
        }
      } else if (!results.length) call = { name: fixtureTool, arguments: { operation: 'discussions', size: 2200000 } };
      else {
        assert.ok(JSON.stringify(results).includes('AZPR saved this complete observed tool result privately.'));
        const report = typeof payload.report === 'string' ? payload.report : JSON.parse(await readFile(payload.report.azprData.file, 'utf8'));
        final = { status: 'READY', comments: payload.findings.map(f => ({ findingId: f.id, severity: f.severity, path: snapshot.files[0], startLine: 1, endLine: 1, anchor: 'fixture-source', body: `issue (high): ${f.id} loses state\n\n` + 'Supported trigger, evidence and correction. '.repeat(15) })), skipped: [], summaryDetails: report };
      }
    } else if (payload.commentWork.kind === 'publication-check') {
      if (!results.length) call = { name: fixtureTool, arguments: { operation: 'discussions', size: 2200000 } };
      else final = { status: 'READY', comments: [], skipped: [] };
    } else {
      const items = [...(payload.summary ? [payload.summary] : []), ...payload.comments];
      if (!results.length) call = { name: fixtureTool, arguments: { operation: 'metadata' } };
      else if (results.length <= items.length) {
        const item = items[results.length - 1];
        call = { name: fixtureTool, arguments: { operation: 'publish', marker: item.marker, content: item.content } };
      } else final = { status: 'DONE', ...(payload.summary ? { summaryThreadId: posted.get(payload.summary.marker) } : {}), posted: payload.comments.map(c => ({ findingId: c.findingId, threadId: posted.get(c.marker) })) };
    }
    if (call?.arguments.operation === 'publish') {
      assert.ok(!posted.has(call.arguments.marker), 'Never repeat a saved write.'); posted.set(call.arguments.marker, nextThread++);
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'fixture_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: JSON.stringify(final) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'scale', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    emit({ id: 'scale', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end('data: [DONE]\n\n');
  } catch (error) { logs += '\nPROVIDER: ' + error.stack; response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } })); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const mcpPath = join(fixture, 'mcp.mjs');
await writeFile(mcpPath, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
for await(const line of createInterface({input:process.stdin})) {if(!line.trim())continue;const req=JSON.parse(line);if(req.id===undefined)continue;let result={};
if(req.method==='initialize')result={protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'scale',version:'1'}};
if(req.method==='tools/list')result={tools:[{name:'arbitrary_fixture',description:'Deterministic scale fixture.',inputSchema:{type:'object',properties:{operation:{type:'string'},size:{type:'number'},path:{type:'string'},revision:{type:'string'},marker:{type:'string'},content:{type:'string'}},required:['operation']}}]};
if(req.method==='tools/call'){const args=req.params.arguments;appendFileSync(${JSON.stringify(join(fixture, 'mcp-calls.jsonl'))},JSON.stringify(args)+'\\n');const prefix=${JSON.stringify(sourcePrefix)};let text=args.size?prefix+'x\\n'.repeat(Math.ceil(args.size/2)).slice(0,args.size-prefix.length):'Current fixture metadata.';if(args.operation==='publish')text=JSON.stringify({threadId:'fixture',content:args.content});result={content:[{type:'text',text}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');}
`);
const settings = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
for (const profile of ['review', 'deep']) for (const role of ['functional', 'risk', 'verifier']) settings.models[profile][role] = `fixture/${role}`;
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
await writeFile(join(dirs.config, 'plugins/network-guard.js'), `export default {id:'scale.network.guard',async setup(ctx){await ctx.session.hook('http.request',event=>{if(!event.request.url.startsWith(${JSON.stringify(providerURL + '/')}))throw new Error('Only loopback fixture model requests are authorized.');});}};`);
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/risk', providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'fixture-only' }, models: Object.fromEntries(['functional', 'risk', 'verifier'].map(id => [id, { limit: { context: id === 'risk' ? 400000 : 4000000, output: 16000 } }])) } }, mcp: { servers: { fixture: { type: 'local', command: [process.execPath, mcpPath], codemode: false } } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1' };
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Host startup timed out.')), 30000).unref())]);
  const api = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const text = await response.text(); assert.ok(response.ok, text); return text ? JSON.parse(text) : undefined; };
  assert.equal((await api('/api/info')).version, '2.0.22');
  for (const command of ['pr-review', 'pr-deep']) {
    snapshot.prId = command === 'pr-review' ? 123 : 124;
    const origin = (await api('/api/session', { title: 'Scale fixture ' + command, location: { directory: dirs.work }, permissions: [{ action: 'shell', resource: '*', effect: 'allow' }] })).data;
    for (let i = 0; i < 50; i++) { if ((await api('/api/mcp')).data.some(s => s.status?.status === 'connected')) break; await new Promise(r => setTimeout(r, 100)); }
    await api(`/api/session/${origin.id}/command`, { name: command, text: `https://dev.azure.com/fixture/project/_git/repository/pullrequest/${snapshot.prId}`, delivery: 'steer' });
    const reviewReceipt = (await api(`/api/session/${origin.id}/inbox`)).data.at(-1).payload.text; receipts.push(reviewReceipt); assert.match(reviewReceipt, /\] COMPLETE/);
    await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
    const receipt = (await api(`/api/session/${origin.id}/inbox`)).data.at(-1).payload.text; receipts.push(receipt); assert.match(receipt, /\] MODEL_REPORTED_POSTED/);
    const debug = /Private debug directory: ([^\n]+)/.exec(receipt)[1], result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8')), plan = JSON.parse(await readFile(join(debug, 'comment-plan.json'), 'utf8'));
    assert.equal(plan.comments.length, 70);
    for (let i = 0; i < 400; i++) assert.ok(plan.summary.content.includes(`Advice ${i}:`));
    assert.ok(result.stages.every(s => s.inputCharacters < 48000 && !s.requestObservations.rejected));
    assert.ok(result.stages.filter(s => s.stage === 'comment-publish').length > 3);
    assert.ok(result.stages.some(s => s.stage === 'comment-plan' && s.modelRequests >= 3 && s.modelRequests <= 9));
    const first = JSON.parse(await readFile(join(debug, `01-azpr-${command === 'pr-deep' ? 'deep' : 'review'}-comment-plan.request.json`), 'utf8'));
    const index = (await readFile(first.payload.evidenceIndex.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(index.map(item => item.output.characters).sort((a, b) => a - b), [120, 2200000, 3307749]);
    for (const entry of index) assert.equal(await readFile(entry.output.file, 'utf8'), source(entry.output.characters));
    const writes = (await readFile(join(fixture, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(c => c.operation === 'publish');
    for (const item of [plan.summary, ...plan.comments]) assert.equal(writes.filter(w => w.marker === item.marker && w.content === item.content).length, 1);
    assert.ok(requests.filter(r => r.work).every(r => r.requestCharacters < 250000), 'Accumulated comment context stays bounded, including expanded saved-text tool arguments.');
    console.log(JSON.stringify({ command, status: 'PASS', sourceCharacters: index.reduce((n, e) => n + e.output.characters, 0), files: snapshot.files.length, comments: plan.comments.length, commentSessions: result.stages.length, maxInputCharacters: Math.max(...result.stages.map(s => s.inputCharacters)), maxCommentRequestCharacters: Math.max(...requests.filter(r => r.work).map(r => r.requestCharacters)) }));
  }
} finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(resolveDone => provider.close(resolveDone));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(fixture, 'receipts.json'), JSON.stringify(receipts, null, 2));
  console.error('Private scale evidence: ' + fixture);
}
