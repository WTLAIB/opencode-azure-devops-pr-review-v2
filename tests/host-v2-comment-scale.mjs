import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host scale fixture. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-comment-scale.mjs /absolute/path/opencode
 * 120 changed files are reviewed in shards; one shard reports a nearly full
 * context so the host attempts compaction, which AZPR refuses and splits the
 * shard instead. 30 findings are verified in two sessions; the second verifier
 * moves one finding into a file of the first, so a duplicate-check session
 * merges it. The other 29 are planned in pages of four and published; a
 * second publish creates nothing.
 * Synthetic completions test orchestration, not model review quality.
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
await mkdir(join(root, '.local'), { recursive: true });
const fixture = await mkdtemp(join(root, '.local/host-v2-scale-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = Array.from({ length: 120 }, (_, i) => `/src/module-${String(Math.floor(i / 10)).padStart(2, '0')}/file-${String(i).padStart(3, '0')}.ts`);
const requests = [];
let child, logs = '', overflowShards = 0;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* summaries etc. */ }
    const results = input.messages.filter(m => m.role === 'tool').length;
    requests.push({ model: input.model, sessionID: request.headers['x-opencode-session-id'], files: payload?.assignment?.files?.length, work: payload?.commentWork?.kind, toolResults: results, requestCharacters: body.length });
    const fileTool = input.tools?.find(t => t.function.name === 'azpr_read_file')?.function.name;
    let call, final, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (payload?.assignment?.files && !payload.assignment.findingIds) {
      const assigned = payload.assignment.files;
      // The first functional shard is "too large": report a nearly full context after its read.
      const tooLarge = input.model === 'functional' && assigned.length > 15 && assigned[0] === files[0];
      if (!results && fileTool) {
        call = { name: fileTool, arguments: { path: assigned[0], version: 'head' } };
        if (tooLarge) { usage = { prompt_tokens: 59000, completion_tokens: 10, total_tokens: 59010 }; overflowShards++; }
      } else {
        const prefix = input.model === 'functional' ? 'F' : 'R', first = Number(payload.assignment.firstFindingId.split('-')[1]);
        const findings = input.model === 'risk' ? assigned.slice(0, 6).map((path, i) => ({ id: `${prefix}-${first + i}`, summary: `State lost in ${path}`, evidence: 'HEAD drops the guard.', counterevidence: 'No caller re-checks.', location: `head:${path}:1`, severity: i % 3 === 2 ? 'low' : 'high', suggestion: 'Restore the guard.' })) : [];
        final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings, report: `Shard ${payload.assignment.shard} reviewed.` };
      }
    } else if (payload?.assignment?.kind === 'duplicates') {
      const moved = payload.assignment.findings.find(f => f.movedFrom), kept = payload.assignment.findings.find(f => !f.movedFrom);
      final = { status: 'COMPLETE', merged: [{ id: moved.id, mergedInto: kept.id, reason: 'Same guard lost in the same file.' }], report: '' };
    } else if (payload?.assignment?.findingIds) {
      // The second verifier moves its first high finding into a file the first verifier owns.
      const move = payload.assignment.shard === '2/2' ? payload.assignment.findings.find(f => f.severity === 'high') : undefined;
      final = { status: 'COMPLETE', confirmed: payload.assignment.findings.map(f => ({ ...f, ...(f === move ? { location: `head:${files[0]}:1`, movedFrom: f.location } : {}), reason: 'Verified.' })), merged: [], rejected: [], needsInfo: [], newFindings: [], report: `Advice for shard ${payload.assignment.shard}: extract the guard into one helper.` };
    } else if (payload?.commentWork?.kind === 'plan') {
      final = { status: 'READY', ...(payload.commentWork.allowSummary ? { summary: 'Fixture change.' } : {}),
        comments: payload.findings.filter(f => f.severity !== 'low').map(f => ({ findingId: f.id, severity: f.severity, path: /head:([^:]+)/.exec(f.location)[1], startLine: 1, endLine: 1, anchor: 'fixture code', body: `🔴 high: ${f.summary}\n\nTrigger, evidence and correction.` })),
        skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, reason: 'Low severity stays in the summary.' })) };
    } else {
      final = 'Fixture summary.';
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'fixture_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: typeof final === 'string' ? final : JSON.stringify(final) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'scale', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    emit({ id: 'scale', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage });
    response.end('data: [DONE]\n\n');
  } catch (error) { logs += '\nPROVIDER: ' + error.stack; response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } })); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 321, files, sources: Object.fromEntries(files.map(path => [path, 'fixture code\nsecond line\n'])) });
const adoServer = createServer((request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
adoServer.listen(0, '127.0.0.1'); await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;
const settings = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
for (const role of ['functional', 'risk', 'verifier']) settings.models.review[role] = `fixture/${role}`;
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
settings.workflow = { ...settings.workflow, shardFiles: 24, shardFindings: 15, parallelSessions: 4 };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/risk',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'fixture-only' },
    models: Object.fromEntries(['functional', 'risk', 'verifier'].map(id => [id, { limit: { context: 64000, output: 4000 } }])) } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  const origin = (await api('/api/session', { title: 'Scale fixture', location: { directory: dirs.work } })).data;
  const latest = async () => (await api(`/api/session/${origin.id}/inbox`)).data.at(-1).payload.text;
  await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321', delivery: 'steer' });
  const receipt = await latest();
  assert.match(receipt, /\] COMPLETE\n/, receipt);
  const debug = /Private debug directory: ([^\n]+)/.exec(receipt)[1];
  const result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8'));
  const stages = role => result.stages.filter(stage => stage.role === `azpr-review-${role}`);
  const functional = stages('functional');
  const overflowed = functional.filter(stage => stage.failureClass === 'overflow');
  const compactionObserved = functional.some(stage => stage.requestObservations?.kinds?.compaction > 0);
  assert.equal(stages('risk').filter(stage => stage.status !== 'FAILED').length, 5, 'Five risk shards of 24 files.');
  assert.equal(overflowed.length, 1, 'Exactly one functional shard overflowed.');
  assert.ok(compactionObserved, 'The host attempted compaction and AZPR refused it.');
  assert.deepEqual(functional.filter(stage => stage.status !== 'FAILED').map(stage => stage.label).sort().slice(0, 2), ['shard 1/5a', 'shard 1/5b']);
  assert.equal(stages('verifier').length, 2, '30 findings in two verification sessions.');
  assert.deepEqual(stages('dedupe').map(stage => stage.status), ['COMPLETE'], 'One file holds findings of both verifiers.');
  const merged = (await readFile(join(debug, 'report.md'), 'utf8')).match(/MERGED → R-1:\*\* Same guard lost in the same file\./g) ?? [];
  assert.equal(merged.length, 1, 'The moved duplicate is merged into the finding that stays.');
  const coverage = functional.filter(stage => stage.status !== 'FAILED').reduce((n, stage) => n + stage.result.coverage.files.length, 0);
  assert.equal(coverage, 120, 'Every file is reviewed once by the functional role, including split shards.');
  await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
  const posted = await latest();
  assert.match(posted, /\] POSTED/, posted);
  const state = azure.state;
  assert.equal(state.threads.length, 20, '19 high findings inline plus one summary; 10 low findings stay in the summary.');
  const planner = result.stages.length ? JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(posted)[1], 'result.json'), 'utf8')).stages.filter(s => s.stage === 'comment-plan') : [];
  assert.equal(planner.length, 8, '29 findings in planning pages of four.');
  await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
  assert.match(await latest(), /ALREADY_PRESENT/);
  assert.equal(azure.callsTo('createThread').length, 20, 'A second publish writes nothing.');
  console.log(JSON.stringify({ status: 'PASS', files: files.length, functionalSessions: functional.length, overflowSplits: overflowed.length, compactionObserved, overflowShardsReported: overflowShards,
    riskSessions: stages('risk').length, verifierSessions: stages('verifier').length, duplicateChecks: stages('dedupe').length, plannerSessions: planner.length, threads: state.threads.length, providerRequests: requests.length,
    maxRequestCharacters: Math.max(...requests.map(r => r.requestCharacters)), azureCalls: azure.state.calls.length }, null, 2));
} finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(resolveDone => provider.close(resolveDone));
  adoServer.closeAllConnections(); await new Promise(resolveDone => adoServer.close(resolveDone));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  console.error('Private scale evidence: ' + fixture);
}
