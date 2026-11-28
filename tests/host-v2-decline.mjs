import { withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for a shell request that a person declines.
 * node tests/host-v2-decline.mjs /absolute/path/opencode
 * With shell: "ask" a reviewer's shell request asks a person, here through
 * OpenCode's permission route. Three reviews of one file, one pass each, no
 * rating, one after another in one host:
 * - plain: the first shell request is declined without a message. OpenCode
 *   interrupts that step and gives its message the error "Step interrupted";
 *   it records the end of that execution as a shutdown, so no idle marker
 *   follows. The turn ends at that step: the pass fails as interrupted
 *   (failure=permanent, terminal=interrupted) and is not tried again.
 * - background: the reviewer starts a background command (approved), then asks
 *   for another command. Once that request waits for a person, the fixture
 *   lets the first command end, and declines the request without a message
 *   once its notice waits in the session's inbox. That notice
 *   wakes the session as the declined step ends, and OpenCode starts another
 *   execution at once. Its request is no request of the turn, which ended at
 *   the declined step: AZPR refuses it before anything is sent, and the pass
 *   fails like the plain one.
 * - mixed: as background, but the step whose request is declined ends with a
 *   finish reason OpenCode does not know. That error comes first, so the step's
 *   message keeps it instead of "Step interrupted", and the declined call says
 *   what ended the step: the turn ends there all the same.
 * - message: the first shell request is declined with a message. OpenCode gives
 *   the model the message as the command's result and the turn goes on: the
 *   review is COMPLETE.
 * The fixture also holds the forms of the host that AZPR tells the end of such
 * a turn by: the declined step's message and the missing marker.
 * Synthetic completions test orchestration, not model review quality.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const fixture = await mkdtemp(join(root, '.local/host-v2-decline-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const files = ['/src/app.ts'];
const SCENARIOS = ['plain', 'background', 'mixed', 'message'];
const DECLINE = 'The user declined this tool call';
const MESSAGE = 'Not this command; review without it.';
const marker = join(dirs.work, 'background-done.txt'), gate = join(dirs.work, 'gate.txt');
const requests = [], events = [], receipts = [];
const started = new Set(), declinedAt = {};
let child, logs = '', current;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* not a reviewer prompt */ }
    const tools = input.messages.filter(m => m.role === 'tool');
    const scenario = /\bdecline-(plain|background|mixed|message)\b/.exec(payload?.userContext ?? '')?.[1];
    const entry = { scenario: scenario ?? null, reviewer: Boolean(payload?.assignment), results: tools.length,
      afterDecline: Boolean(scenario && declinedAt[scenario] !== undefined), lastTool: textOf(tools.at(-1)?.content).slice(0, 200) };
    requests.push(entry);
    let call, final, finish;
    const delayed = scenario === 'background' || scenario === 'mixed';
    if (payload?.assignment?.files && scenario) {
      // Only a scenario's first reviewer session asks for shell; a later one answers at once.
      if (tools.length === 0 && !started.has(scenario)) {
        started.add(scenario);
        call = delayed
          // It ends once the fixture opens the gate, which it does when the next request waits for a person.
          ? { name: 'shell', arguments: { command: 'until [ -f gate.txt ]; do sleep 0.1; done; touch background-done.txt', background: true } }
          : { name: 'shell', arguments: { command: 'echo first' } };
      } else if (delayed && tools.length === 1 && !entry.afterDecline) {
        call = { name: 'shell', arguments: { command: 'echo second' } };
        // A finish reason OpenCode does not know: it still runs the call, and the step fails with that error first.
        if (scenario === 'mixed') finish = 'probe_unknown';
      } else {
        final = { status: 'COMPLETE', coverage: { files: payload.assignment.files, gaps: [] }, findings: [], report: `Reviewed (${scenario}).` };
      }
    } else {
      final = 'Fixture summary.';
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'decline_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: typeof final === 'string' ? final : JSON.stringify(final) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'decline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    emit({ id: 'decline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish ?? (call ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
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
// One pass and no rating: each scenario's review has one reviewer session, or two where it is tried again.
settings.models.review = { reviewers: ['fixture/first'], rater: false };
settings.shell = 'ask';
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
let answering = true, responder;
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  // A person answers each shell request of the review under way, as its scenario says.
  const answered = new Set();
  responder = (async () => {
    while (answering) {
      try {
        for (const item of (await rawApi('/api/permission/request')).data ?? []) {
          if (answered.has(item.id)) continue;
          answered.add(item.id);
          const scenario = current, background = JSON.stringify(item).includes('background-done');
          events.push({ scenario, asked: item.action, background });
          if ((scenario === 'background' || scenario === 'mixed') && background) {
            await rawApi(`/api/session/${item.sessionID}/permission/${item.id}/reply`, { decision: 'once' });
            continue;
          }
          if (scenario === 'background' || scenario === 'mixed') {
            // The request waits for a person: the background command may end now. It is declined once that
            // command has ended and its notice waits in the session's inbox, so that the notice wakes the session
            // as the declined step ends.
            await writeFile(gate, '');
            const until = Date.now() + 60000;
            const waiting = async () => JSON.stringify((await rawApi(`/api/session/${item.sessionID}/inbox`)).data ?? []).includes('background-result');
            while (Date.now() < until && !(existsSync(marker) && await waiting())) await sleep(50);
            assert.ok(existsSync(marker) && await waiting(), 'The background command ended and its notice waits in the inbox before the decline.');
          }
          declinedAt[scenario] = Date.now();
          await rawApi(`/api/session/${item.sessionID}/permission/${item.id}/reply`, { decision: 'reject', ...(scenario === 'message' ? { message: MESSAGE } : {}) });
          events.push({ scenario, declined: true, withMessage: scenario === 'message' });
        }
      } catch (error) { events.push({ responderError: String(error.stack ?? error).slice(0, 400) }); }
      await sleep(50);
    }
  })();
  const origin = (await api('/api/session', { title: 'Decline fixture', location: { directory: dirs.work } })).data;
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321';
  const outcomes = {};
  for (const scenario of SCENARIOS) {
    current = scenario;
    await rm(gate, { force: true }); await rm(marker, { force: true });
    await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text: `${prUrl} decline-${scenario}`, delivery: 'steer' });
    const receipt = (await api(`/api/session/${origin.id}/inbox`)).data.map(item => item.payload?.text ?? '').at(-1);
    receipts.push(receipt);
    const debug = /Private debug directory: ([^\n]+)/.exec(receipt)?.[1];
    assert.ok(debug, receipt);
    const result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8'));
    const session = /^- azpr-review-reviewer[^\n]*session=(ses_[A-Za-z0-9]+)/m.exec(receipt)?.[1];
    // Let whatever OpenCode still does in that session settle before its messages are read.
    await sleep(1500);
    const messages = (await rawApi(`/api/session/${session}/context`)).data ?? [];
    outcomes[scenario] = { receipt, result, session, messages };
  }
  answering = false; await responder;
  assert.deepEqual(events.filter(event => event.responderError), [], 'The person answered every request.');
  const host = /v(\d+\.\d+\.\d+)/.exec(spawnSync(binary, ['--version'], { encoding: 'utf8', env }).stdout)?.[1] ?? 'unknown';
  const of = scenario => requests.filter(entry => entry.scenario === scenario);
  const shapes = messages => messages.map(message => message.type === 'assistant' ? `assistant:${message.error?.type ?? message.finish}` : message.type === 'idle' ? `idle:${message.outcome}` : message.type);
  const declinedCall = message => (message.content ?? []).some(part => part.type === 'tool' && part.state?.status === 'error' && part.state.error?.type === 'aborted' && part.state.error.message === DECLINE);
  const interruptedStep = message => message.type === 'assistant' && message.error?.type === 'aborted' && message.error?.message === 'Step interrupted' && declinedCall(message);
  const FAILED = /^- azpr-review-reviewer: FAILED; session=ses_[A-Za-z0-9]+; model=fixture\/first; failure=permanent; error=\[AZPR\] Reviewer execution did not finish successfully \(session=[a-z]+; terminal=interrupted; assistantResponses=\d; finish=error\)\.$/m;

  // plain: the declined step ended its execution without a marker; the turn ended there.
  const plain = outcomes.plain;
  assert.match(plain.receipt, /^\[AZPR [a-f0-9]{8}\] INCOMPLETE; verification none\n/, plain.receipt);
  assert.match(plain.receipt, FAILED, plain.receipt);
  assert.equal([...plain.receipt.matchAll(/^- azpr-review-reviewer/gm)].length, 1, 'The declined pass was not tried again.');
  assert.deepEqual(shapes(plain.messages), ['user', 'assistant:aborted'], 'OpenCode gave the declined step its error and left no idle marker (an end it records as a shutdown).');
  assert.ok(interruptedStep(plain.messages[1]), 'The declined step carries "Step interrupted", and the declined call its own error.');
  const [plainStage] = plain.result.stages;
  assert.deepEqual([plainStage.status, plainStage.failureClass, plainStage.execution?.terminalOutcome, plainStage.execution?.interrupted, plainStage.requestObservations.authorizedPrimary],
    ['FAILED', 'permanent', 'interrupted', true, 1]);
  assert.deepEqual(of('plain').map(entry => [entry.results, entry.afterDecline]), [[0, false]], 'One request, none after the decline.');

  // background: the notice woke the session as the declined step ended, and OpenCode started another execution,
  // whose request AZPR refused: the turn had ended at the declined step.
  const background = outcomes.background;
  assert.match(background.receipt, /^\[AZPR [a-f0-9]{8}\] INCOMPLETE; verification none\n/, background.receipt);
  assert.match(background.receipt, FAILED, background.receipt);
  assert.equal([...background.receipt.matchAll(/^- azpr-review-reviewer/gm)].length, 1, 'The declined pass was not tried again.');
  assert.deepEqual(shapes(background.messages), ['user', 'assistant:tool-calls', 'assistant:aborted', 'synthetic', 'idle:failed'],
    'The declined step without a marker, the notice that woke the session, and the end of the execution OpenCode started then.');
  assert.ok(interruptedStep(background.messages[2]), 'The declined step carries "Step interrupted", and the declined call its own error.');
  assert.match(String(background.messages[3].text ?? ''), /^<background-result kind="shell"/, 'The notice is that of the background command.');
  const [backgroundStage] = background.result.stages;
  assert.deepEqual([backgroundStage.status, backgroundStage.failureClass, backgroundStage.execution?.terminalOutcome, backgroundStage.execution?.interrupted],
    ['FAILED', 'permanent', 'interrupted', true]);
  assert.equal(backgroundStage.requestObservations.authorizedPrimary, 2, 'Two requests of the turn were authorized, none after the declined step.');
  assert.ok(backgroundStage.requestObservations.refusedOutsideTurn >= 1, 'The request of the execution OpenCode started after the decline was refused.');
  assert.deepEqual(of('background').map(entry => [entry.results, entry.afterDecline]), [[0, false], [1, false]], 'No request reached the provider after the decline.');

  // mixed: the declined step's message keeps the error that came first in it; the declined call says what ended
  // the step, and the turn ended there all the same.
  const mixedRun = outcomes.mixed;
  assert.match(mixedRun.receipt, /^\[AZPR [a-f0-9]{8}\] INCOMPLETE; verification none\n/, mixedRun.receipt);
  assert.match(mixedRun.receipt, FAILED, mixedRun.receipt);
  assert.equal([...mixedRun.receipt.matchAll(/^- azpr-review-reviewer/gm)].length, 1, 'The declined pass was not tried again.');
  const mixedShapes = shapes(mixedRun.messages);
  assert.deepEqual([mixedShapes[0], mixedShapes[1], mixedShapes[3], mixedShapes[4], mixedShapes.length], ['user', 'assistant:tool-calls', 'synthetic', 'idle:failed', 5], JSON.stringify(mixedShapes));
  const mixedStep = mixedRun.messages[2];
  assert.ok(mixedStep.type === 'assistant' && mixedStep.error && mixedStep.error.type !== 'aborted' && declinedCall(mixedStep),
    'The declined step carries the error that came first in it, and the declined call its decline.');
  const [mixedStage] = mixedRun.result.stages;
  assert.deepEqual([mixedStage.status, mixedStage.failureClass, mixedStage.execution?.terminalOutcome, mixedStage.execution?.interrupted, mixedStage.requestObservations.authorizedPrimary],
    ['FAILED', 'permanent', 'interrupted', true, 2]);
  assert.ok(mixedStage.requestObservations.refusedOutsideTurn >= 1, 'The request of the execution OpenCode started after the decline was refused.');
  assert.deepEqual(of('mixed').map(entry => [entry.results, entry.afterDecline]), [[0, false], [1, false]], 'No request reached the provider after the decline.');

  // message: the model received the message as the command's result and answered.
  const message = outcomes.message;
  assert.match(message.receipt, /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete; verification none\n/, message.receipt);
  assert.match(message.receipt, /^- azpr-review-reviewer: COMPLETE; session=ses_[A-Za-z0-9]+; model=fixture\/first; observed-tool-errors=1$/m, message.receipt);
  assert.deepEqual(shapes(message.messages), ['user', 'assistant:tool-calls', 'assistant:stop', 'idle:succeeded']);
  const answered2 = of('message');
  assert.deepEqual(answered2.map(entry => [entry.results, entry.afterDecline]), [[0, false], [1, true]]);
  assert.ok(answered2[1].lastTool.includes('permission.rejected') && answered2[1].lastTool.includes(MESSAGE), answered2[1].lastTool);

  // The conversation's own model was asked nothing: every request was a reviewer's.
  assert.ok(requests.every(entry => entry.reviewer && entry.scenario), JSON.stringify(requests));
  console.log(JSON.stringify({ status: 'PASS', host, plain: 'FAILED permanent at the declined step; no idle marker; one request', background: `FAILED permanent; the next execution's request refused (${backgroundStage.requestObservations.refusedOutsideTurn}); two requests authorized, none after the decline`,
    mixed: `FAILED permanent; the declined step carries ${mixedStep.error.type}, its call the decline; the next execution's request refused (${mixedStage.requestObservations.refusedOutsideTurn})`,
    message: 'COMPLETE; the model received the message as the command\'s result', providerRequests: requests.length }, null, 2));
} finally {
  answering = false; await responder?.catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  adoServer.closeAllConnections(); await new Promise(done => adoServer.close(done));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'events.json'), JSON.stringify(events, null, 2)); await writeFile(join(fixture, 'receipts.txt'), receipts.join('\n\n==========\n\n'));
  console.error('Private decline evidence: ' + fixture);
}
