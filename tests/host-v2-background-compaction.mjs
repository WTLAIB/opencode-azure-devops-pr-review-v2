import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for OpenCode's experimental.background_compaction.
 * node tests/host-v2-background-compaction.mjs /absolute/path/opencode
 * The functional reviewer's first response reports a context past the host's
 * background-summary threshold but below its compaction threshold, so the host
 * asks for a summary in the background. AZPR refuses it before anything is sent
 * and the turn goes on. The reviewer's next request fails with HTTP 401, a
 * permanent failure: no shard split and no replacement session may follow.
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
const fixture = await mkdtemp(join(root, '.local/host-v2-background-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = Array.from({ length: 4 }, (_, i) => `/src/file-${i}.ts`);
const requests = [];
let child, logs = '';
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* not a reviewer prompt */ }
    const results = input.messages.filter(m => m.role === 'tool').length;
    requests.push({ model: input.model, reviewer: Boolean(payload?.assignment), toolResults: results });
    const fileTool = input.tools?.find(t => t.function.name === (input.model === 'risk' ? 'azpr_read_diff' : 'azpr_read_file'))?.function.name;
    let call, final, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (payload?.assignment?.files && !payload.assignment.findingIds) {
      const assigned = payload.assignment.files;
      if (input.model === 'functional' && results) {
        // The provider key expired after the first request: a permanent failure.
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Fixture key expired', type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      if (!results && fileTool) {
        call = { name: fileTool, arguments: fileTool === 'azpr_read_diff' ? { path: assigned[0] } : { path: assigned[0], version: 'head' } };
        // 80% of the 100,000-token window: past the background-summary threshold, below compaction.
        if (input.model === 'functional') usage = { prompt_tokens: 80000, completion_tokens: 10, total_tokens: 80010 };
      } else {
        final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings: [], report: `Shard ${payload.assignment.shard} reviewed.` };
      }
    } else {
      final = 'Fixture summary.';
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'fixture_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: typeof final === 'string' ? final : JSON.stringify(final) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'background', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    emit({ id: 'background', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage });
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
settings.workflow = { ...settings.workflow, shardFiles: 24, parallelSessions: 4 };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/risk',
  experimental: { background_compaction: true },
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries(['functional', 'risk', 'verifier'].map(id => [id, { limit: { context: 100000, output: 4000 } }])) } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  const origin = (await api('/api/session', { title: 'Background compaction fixture', location: { directory: dirs.work } })).data;
  await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321', delivery: 'steer' });
  const receipt = (await api(`/api/session/${origin.id}/inbox`)).data.at(-1).payload.text;
  const result = JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(receipt)[1], 'result.json'), 'utf8'));
  const functional = result.stages.filter(stage => stage.role === 'azpr-review-functional');
  assert.equal(functional.length, 1, `One functional session: no shard split and no replacement.\n${receipt}`);
  const [stage] = functional;
  assert.ok(stage.requestObservations.kinds.compaction >= 1 && stage.requestObservations.rejected >= 1, 'The host asked for a background summary and AZPR refused it.');
  assert.equal(stage.requestObservations.authorizedPrimary, 2, 'The turn went on after the refused summary.');
  assert.deepEqual([stage.status, stage.failureClass, stage.execution?.provider?.status, stage.execution?.compaction], ['FAILED', 'permanent', 401, undefined]);
  assert.ok(!result.stages.some(other => /shard \d+\/\d+[ab]$/.test(other.label ?? '')), 'No split shard was started.');
  assert.doesNotMatch(receipt, /context limit/, receipt);
  assert.equal(requests.filter(r => r.model === 'functional').length, 2, 'No summary request reached the provider.');
  const host = /v(\d+\.\d+\.\d+)/.exec(spawnSync(binary, ['--version'], { encoding: 'utf8', env }).stdout)?.[1] ?? 'unknown';
  console.log(JSON.stringify({ status: 'PASS', host, functionalSessions: functional.length,
    failureClass: stage.failureClass, providerStatus: stage.execution.provider.status, refusedRequests: stage.requestObservations.rejected,
    compactionRequests: stage.requestObservations.kinds.compaction, providerRequests: requests.length }, null, 2));
} finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(resolveDone => provider.close(resolveDone));
  adoServer.closeAllConnections(); await new Promise(resolveDone => adoServer.close(resolveDone));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  console.error('Private background-compaction evidence: ' + fixture);
}
