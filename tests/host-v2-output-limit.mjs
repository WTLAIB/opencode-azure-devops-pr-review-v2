import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for a reviewer's answer that reaches the model's output limit.
 * node tests/host-v2-output-limit.mjs /absolute/path/opencode
 * Two reviews of one pull request of two files in one shard, one pass, no rating, one after another in one
 * host. The model's answer ends with finish reason "length":
 * - split: the first answer of the shard of two files is cut; OpenCode asks the model to go on, and it answers
 *   the rest, so the turn's marker says it succeeded. AZPR takes no output of that turn, fails it as
 *   output-limit (not for another message), and splits the shard in two; each half answers whole, and the
 *   review is COMPLETE.
 * - exhausted: every answer is cut, until OpenCode gives up and fails the step. The shard of two files fails as
 *   output-limit and is split; each half of one file fails the same way, once: it is not split and not tried
 *   in a new session. The review is INCOMPLETE.
 * The fixture also holds the form of the host that AZPR tells such a turn by: an assistant message of the
 * turn with finish "length".
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
assert.equal(process.argv[3], undefined, 'The fixture takes no option.');
await mkdir(join(root, '.local'), { recursive: true });
const fixture = await mkdtemp(join(root, '.local/host-v2-output-limit-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = ['/src/a.ts', '/src/b.ts'];
const SCENARIOS = ['split', 'exhausted'];
const requests = [], receipts = [];
let child, logs = '';
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* not a reviewer prompt */ }
    const scenario = /\boutput-limit-(split|exhausted)\b/.exec(payload?.userContext ?? '')?.[1];
    // OpenCode's message that asks the model to go on is a user message of the request.
    const continued = users.slice(1).some(m => /output token limit/.test(textOf(m.content)));
    const assigned = payload?.assignment?.files ?? [];
    const entry = { scenario: scenario ?? null, reviewer: Boolean(payload?.assignment), files: assigned.length, continued };
    let final, finish = 'stop';
    // A cut answer and the rest of it, which together are a whole answer: what joins them is not what AZPR goes by.
    const cut = `{"status":"COMPLETE","coverage":{"files":${JSON.stringify(assigned).slice(0, -1)}`;
    const rest = `],"gaps":[]},"findings":[],"report":"Reviewed (${scenario}, continued)."}`;
    if (payload?.assignment?.files && scenario) {
      // A shard of two files is cut first in both scenarios; in "exhausted" every answer is. In "split" the model then
      // goes on where it was cut.
      if (scenario === 'exhausted' || (assigned.length > 1 && !continued)) { final = cut; finish = 'length'; }
      else if (assigned.length > 1) final = rest;
      else final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings: [], report: `Reviewed (${scenario}).` };
    } else {
      final = 'Fixture summary.';
    }
    entry.finish = finish;
    entry.text = typeof final === 'string' ? final : JSON.stringify(final);
    requests.push(entry);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'limit', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: typeof final === 'string' ? final : JSON.stringify(final) }, finish_reason: null }] });
    emit({ id: 'limit', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end('data: [DONE]\n\n');
  } catch (error) { logs += '\nPROVIDER: ' + error.stack; response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } })); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 321, files, sources: Object.fromEntries(files.map(path => [path, 'export const value = 1;\n'])) });
const adoServer = createServer((request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
adoServer.listen(0, '127.0.0.1'); await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;
const settings = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
// One pass and no rating: each review's reviewer sessions are its shard's and its halves'.
settings.models.review = { reviewers: ['fixture/first'], rater: false };
settings.debug = { enabled: true, directory: join(fixture, 'debug') };
settings.workflow = { ...settings.workflow, shardFiles: 24, parallelSessions: 2 };
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/first',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: { first: { limit: { context: 100000, output: 4000 } } } } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  const origin = (await api('/api/session', { title: 'Output limit fixture', location: { directory: dirs.work } })).data;
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321';
  const outcomes = {};
  for (const scenario of SCENARIOS) {
    await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text: `${prUrl} output-limit-${scenario}`, delivery: 'steer' });
    const receipt = (await api(`/api/session/${origin.id}/inbox`)).data.map(item => item.payload?.text ?? '').at(-1);
    receipts.push(receipt);
    const debug = /Private debug directory: ([^\n]+)/.exec(receipt)?.[1];
    assert.ok(debug, receipt);
    const result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8'));
    const reviewers = result.stages.filter(stage => stage.role === 'azpr-review-reviewer');
    const messages = {};
    for (const stage of reviewers) messages[stage.sessionID] = (await rawApi(`/api/session/${stage.sessionID}/context`)).data ?? [];
    outcomes[scenario] = { receipt, result, reviewers, messages };
  }
  const host = /v(\d+\.\d+\.\d+)/.exec(spawnSync(binary, ['--version'], { encoding: 'utf8', env }).stdout)?.[1] ?? 'unknown';
  // What OpenCode writes of instructions into a session by itself (an update of its date instruction after midnight,
  // say) is no step of a turn: the shapes leave it out.
  const steps = messages => messages.filter(message => message.type !== 'system');
  const shapes = messages => steps(messages).map(message => message.type === 'assistant' ? `assistant:${message.finish}${message.error ? `/${message.error.type}` : ''}` : message.type === 'idle' ? `idle:${message.outcome}` : message.type);
  const of = scenario => requests.filter(entry => entry.scenario === scenario);

  // split: the cut turn of the shard of two files fails as output-limit; its halves answer, and the review is COMPLETE.
  const split = outcomes.split;
  assert.match(split.receipt, /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete; verification none\n/, split.receipt);
  assert.doesNotMatch(split.receipt, /another message/, 'The turn did not fail for another message.');
  assert.deepEqual(split.reviewers.map(stage => [stage.label ?? '', stage.status, stage.failureClass ?? '']),
    [['', 'FAILED', 'output-limit'], ['shard 1/1a', 'COMPLETE', ''], ['shard 1/1b', 'COMPLETE', '']]);
  assert.match(split.receipt, /^- azpr-review-reviewer: FAILED; session=ses_[A-Za-z0-9]+; model=fixture\/first; failure=output-limit; error=\[AZPR\] A response of this turn reached the model's output limit \(finish=length\)\. No output of the turn was accepted\.$/m, split.receipt);
  assert.match(split.receipt, /^- azpr-review-reviewer \[shard 1\/1a\]: COMPLETE; [^\n]*\n- azpr-review-reviewer \[shard 1\/1b\]: COMPLETE; /m, split.receipt);
  const [cutStage] = split.reviewers;
  assert.equal(cutStage.execution, undefined, 'The turn\'s marker said it succeeded: no execution summary.');
  const cutShapes = shapes(split.messages[cutStage.sessionID]);
  assert.deepEqual(cutShapes, ['user', 'assistant:length', 'synthetic', 'assistant:stop', 'idle:succeeded'],
    'OpenCode recorded the cut step with finish "length", asked the model to go on, and the turn succeeded.');
  assert.match(String(steps(split.messages[cutStage.sessionID])[2].text ?? ''), /output token limit/, 'OpenCode\'s own message asks the model to go on.');
  assert.deepEqual(of('split').map(entry => [entry.files, entry.continued, entry.finish]), [[2, false, 'length'], [2, true, 'stop'], [1, false, 'stop'], [1, false, 'stop']]);
  const [first, second] = of('split');
  assert.deepEqual(JSON.parse(first.text + second.text).coverage.files, files, 'The cut answer and its rest join into a whole answer, which AZPR still did not take.');

  // exhausted: OpenCode gives up after two continuations; the shard of two files is split, and each half of one
  // file fails once, not split and not tried in a new session.
  const exhausted = outcomes.exhausted;
  assert.match(exhausted.receipt, /^\[AZPR [a-f0-9]{8}\] INCOMPLETE; verification none\n/, exhausted.receipt);
  assert.doesNotMatch(exhausted.receipt, /another message/, 'No turn failed for another message.');
  assert.equal(exhausted.reviewers.length, 3, 'The shard of two files and its two halves, each once.');
  for (const stage of exhausted.reviewers) {
    assert.deepEqual([stage.status, stage.failureClass, stage.execution?.outputLimit, stage.execution?.terminalOutcome, stage.execution?.lastFinish],
      ['FAILED', 'output-limit', true, 'failed', 'length'], JSON.stringify(stage));
    const own = shapes(exhausted.messages[stage.sessionID]);
    assert.deepEqual([own[0], own.filter(shape => shape.startsWith('assistant:length')).length, own.filter(shape => shape === 'synthetic').length, own.at(-1)], ['user', 3, 2, 'idle:failed'], JSON.stringify(own));
  }
  assert.deepEqual(exhausted.reviewers.map(stage => stage.label ?? ''), ['', 'shard 1/1a', 'shard 1/1b']);
  assert.equal(of('exhausted').length, 9, 'Three cut answers in each of the three sessions.');

  // The conversation's own model was asked nothing: every request was a reviewer's.
  assert.ok(requests.every(entry => entry.reviewer && entry.scenario), JSON.stringify(requests));
  console.log(JSON.stringify({ status: 'PASS', host, split: 'the cut turn FAILED as output-limit (its marker said it succeeded); the shard split in two; COMPLETE',
    exhausted: 'OpenCode gave up after two continuations; the shard FAILED as output-limit and was split; each half FAILED once; INCOMPLETE', providerRequests: requests.length }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  adoServer.closeAllConnections(); await new Promise(done => adoServer.close(done));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'receipts.txt'), receipts.join('\n\n==========\n\n'));
  console.error('Private output limit evidence: ' + fixture);
}
