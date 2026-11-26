import { privateSessions, withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for the summary OpenCode writes in the background before a compaction.
 * node tests/host-v2-background-compaction.mjs /absolute/path/opencode
 * OpenCode 2.3.1 and later write such a summary by default (compaction.background;
 * the experimental.background_compaction option of 2.3.0 and earlier is gone), so
 * the fixture leaves the host's compaction settings alone.
 * A review of two passes over one shard. Each pass's reviewer reports, with
 * its second response, a context past the host's background-summary threshold
 * but below its compaction threshold, so the host asks for a summary in the
 * background. AZPR refuses it before anything is sent and both turns go on.
 * The first pass's next request fails with HTTP 401, a permanent failure: no
 * shard split and no replacement session may follow. The second pass's
 * reviewer answers, and its answer is accepted (the host asks for a summary
 * again once the turn has ended, which is refused as well). It reviewed every
 * file, so the review is COMPLETE and its coverage is complete, and the
 * receipt says that no file was reviewed in every pass.
 * The models' window is 100,000 tokens. OpenCode (2.3.0 to the tested version) compacts in the turn
 * once the context reaches the window less the larger of 15 % of it and, for a
 * window of at least 32,000 tokens, 16,000 tokens, where no buffer is configured
 * (here 84,000), and starts a
 * summary earlier: within 60,000 tokens of that ceiling, at most half the room
 * the session began with (here from 42,000 tokens on). One response alone
 * therefore never reaches the threshold, and the large context (80,000) comes
 * with the second response.
 * The settings switch the rating off (rater: false): no rating role exists.
 * With --cleanup the same review runs with debug off, as installed by default:
 * its run deletes the failed pass's session and keeps the one holding the
 * report. A second review follows in which the second pass reviews nothing, so
 * that no session gives a usable answer. It saves no review (PARTIAL), so its
 * run keeps the session holding its report and deletes the other: the fixture
 * checks that on the host and in the run's record of kept sessions. The checks
 * that read debug records belong to the default mode.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), binary = process.argv[2], cleanup = process.argv[3] === '--cleanup';
assert.ok(binary?.startsWith('/'));
assert.ok(cleanup || process.argv[3] === undefined, 'The only option is --cleanup.');
await mkdir(join(root, '.local'), { recursive: true });
const fixture = await mkdtemp(join(root, '.local/host-v2-background-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = Array.from({ length: 4 }, (_, i) => `/src/file-${i}.ts`);
const requests = [], receipts = [];
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
    // Each pass has a model of its own: the first pass reads whole files, the second pass diffs.
    const fileTool = input.tools?.find(t => t.function.name === (input.model === 'second' ? 'azpr_read_diff' : 'azpr_read_file'))?.function.name;
    let call, final, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (payload?.assignment?.files) {
      const assigned = payload.assignment.files;
      // Each reviewer reads two files. After a small first response the second one reports 80% of the 100,000-token
      // window: past the host's background-summary threshold (42,000 here), below its compaction ceiling
      // (84,000). The context stays that large for the rest of the turn.
      const reads = 2, large = { prompt_tokens: 80000, completion_tokens: 10, total_tokens: 80010 };
      if (input.model === 'first' && results >= reads) {
        // The first pass's provider key expired after its second request: a permanent failure.
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Fixture key expired', type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      if (results < reads && fileTool) {
        call = { name: fileTool, arguments: fileTool === 'azpr_read_diff' ? { path: assigned[results] } : { path: assigned[results], version: 'head' } };
        if (results === 1) usage = large;
      } else if (/\bnothing-reviewed\b/.test(payload.userContext ?? '')) {
        // The second review of the --cleanup run: an answer that names no reviewed file is not a usable review.
        usage = large;
        final = { status: 'PARTIAL', coverage: { files: [], gaps: ['The fixture reviewed nothing.'] }, findings: [], report: 'Nothing was reviewed.' };
      } else {
        // The second pass's reviewer answers after its refused summary.
        usage = large;
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
// Two passes, each with a model of its own so that the fake provider can tell them apart; no severity rating.
settings.models.review = { reviewers: ['fixture/first', 'fixture/second'], rater: false };
settings.debug = { enabled: !cleanup, directory: join(fixture, 'debug') };
settings.workflow = { ...settings.workflow, shardFiles: 24, parallelSessions: 4 };
// These steps drive each comment step themselves; the default (a preview after every review) is covered by the runtime tests.
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
// No compaction setting: OpenCode 2.3.1 and later write background summaries by default (compaction.background).
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/second',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries(['first', 'second'].map(id => [id, { limit: { context: 100000, output: 4000 } }])) } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
// What every review of this fixture says of its first pass, whose only session failed after the refused summary.
const FAILED_PASS = /^- azpr-review-reviewer \[pass 1\/2\]: FAILED; session=ses_[A-Za-z0-9]+; model=fixture\/first; failure=permanent; error=\[AZPR\] Model provider request failed \(HTTP 401; 2 tool calls observed\)\. Check provider access and the role's tool permissions\. Reviewer execution did not finish successfully \(session=failed; terminal=failed; assistantResponses=3; finish=error\)\.$/m;
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  const origin = (await api('/api/session', { title: 'Background compaction fixture', location: { directory: dirs.work } })).data;
  const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321';
  const notices = async () => (await api(`/api/session/${origin.id}/inbox`)).data.map(item => item.payload?.text ?? '');
  const review = async text => {
    await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text, delivery: 'steer' });
    receipts.push((await notices()).at(-1));
    return receipts.at(-1);
  };
  const idOf = text => /^\[AZPR ([a-f0-9]{8})\]/.exec(text)[1];
  const receipt = await review(prUrl);
  const host = /v(\d+\.\d+\.\d+)/.exec(spawnSync(binary, ['--version'], { encoding: 'utf8', env }).stdout)?.[1] ?? 'unknown';
  // One role per entry of models.review.reviewers, the duplicate check and the comment planners; rater: false leaves no rating role.
  assert.deepEqual((await api('/api/agent')).data.map(agent => agent.name).filter(name => name.startsWith('azpr-')).sort(),
    ['azpr-review-comment-plan', 'azpr-review-comment-plan-verified', 'azpr-review-dedupe', 'azpr-review-reviewer', 'azpr-review-reviewerb'],
    'The private roles follow the settings: two passes and no rating role.');
  // One pass's only session failed and the other pass reviewed every file: the review is COMPLETE and every file
  // was reviewed, none of them in every pass.
  assert.match(receipt, /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete, 0\/4 file\(s\) in every pass; verification none\n/, receipt);
  assert.match(receipt, FAILED_PASS, receipt);
  assert.match(receipt, /^- azpr-review-reviewerb \[pass 2\/2\]: COMPLETE; session=ses_[A-Za-z0-9]+; model=fixture\/second$/m, receipt);
  assert.doesNotMatch(receipt, /context limit|azpr-review-(?:dedupe|rating)/, receipt);
  assert.ok((await notices()).every(text => !/context limit|splitting/.test(text)), 'No notice of the conversation speaks of a context limit or a split.');
  assert.equal(requests.filter(r => r.model === 'first').length, 3, 'No summary request reached the provider.');
  assert.equal(requests.filter(r => r.model === 'second').length, 3, 'The second pass read two diffs and answered: no summary request of its session reached the provider either.');
  if (cleanup) {
    // Debug is off, as installed by default. The review is saved, so its run keeps the session holding the
    // report, which is the second pass's, and deletes the failed one.
    const sessions = privateSessions(rawApi, dirs.state);
    const kept = async text => {
      const created = sessions.named(text), holder = /Report delivery: report queued to session=(\S+)\./.exec(text)[1];
      const left = [];
      for (const id of created) if (await sessions.exists(id)) left.push(id);
      return { created, holder, left };
    };
    const first = await kept(receipt);
    assert.equal(first.created.length, 2, 'One session per pass: without findings neither a duplicate check nor a rating runs.');
    assert.equal(first.holder, /^- azpr-review-reviewerb [^\n]*session=(ses_[A-Za-z0-9]+)/m.exec(receipt)[1], "The report is in the second pass's session.");
    assert.deepEqual(first.left, [first.holder], 'Only the session holding the report exists on the host.');
    assert.match(receipt, /\nSession notice: 1 reviewer session\(s\) of this run were deleted/);
    const held = async id => (await rawApi(`/api/session/${id}/inbox`)).data.at(-1).payload.text;
    assert.ok((await held(first.holder)).startsWith(`# AZPR ${idOf(receipt)} — COMPLETE\n`), 'The session that is left holds the report.');
    assert.equal((await sessions.listed()).length, 1, 'The host lists one private session, the report.');
    assert.deepEqual(await sessions.records(), {}, 'Nothing is left to delete, and no unfinished run keeps a session.');
    // The same PR again, with a second pass that reviews nothing: no session gives a usable answer, so the review
    // is PARTIAL and none is saved. Its run keeps the session holding its report and deletes the other.
    const unusable = await review(`${prUrl} nothing-reviewed`);
    assert.match(unusable, /^\[AZPR [a-f0-9]{8}\] PARTIAL; coverage incomplete, 0\/4 file\(s\) reviewed, 0\/4 in every pass; verification none\n/, unusable);
    assert.match(unusable, FAILED_PASS, unusable);
    assert.match(unusable, /^- azpr-review-reviewerb \[pass 2\/2\]: PARTIAL; session=ses_[A-Za-z0-9]+; model=fixture\/second$/m, unusable);
    assert.ok(!/context limit/.test(unusable) && (await notices()).every(text => !/context limit|splitting/.test(text)), 'No split in the second review either.');
    const second = await kept(unusable);
    assert.equal(second.created.length, 2, 'One session per pass.');
    assert.equal(second.holder, /^- azpr-review-reviewerb [^\n]*session=(ses_[A-Za-z0-9]+)/m.exec(unusable)[1], "The report is in the second pass's session.");
    assert.deepEqual(second.left, [second.holder], 'Only the session holding the report of the unsaved review exists on the host.');
    assert.match(unusable, /\nSession notice: 1 reviewer session\(s\) of this run were deleted/);
    assert.ok((await held(second.holder)).startsWith(`# AZPR ${idOf(unusable)} — PARTIAL\n`), 'The session that is left holds the report of the unsaved review.');
    assert.equal((await sessions.listed()).length, 2, 'The host lists two private sessions: the report of each review.');
    assert.deepEqual(await sessions.records(), { [idOf(unusable)]: [second.holder] }, "The unfinished run's record names the session it keeps, and nothing is left to delete.");
    assert.deepEqual(['first', 'second'].map(model => requests.filter(r => r.model === model).length), [6, 6], 'No summary request reached the provider.');
    console.log(JSON.stringify({ status: 'PASS', mode: 'cleanup', host, review: 'COMPLETE', reviewSessions: first.created.length, deletedAfterReview: first.created.length - 1, privateSessionsLeft: first.left.length,
      unsavedReview: 'PARTIAL', unsavedReviewSessions: second.created.length, keptByUnfinishedRun: second.left.length, providerRequests: requests.length }, null, 2));
  } else {
    const debug = /Private debug directory: ([^\n]+)/.exec(receipt)[1];
    const result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8'));
    assert.equal(result.status, 'COMPLETE');
    const failed = result.stages.filter(stage => stage.role === 'azpr-review-reviewer');
    assert.equal(failed.length, 1, `One session of the first pass: no shard split and no replacement.\n${receipt}`);
    const [stage] = failed;
    assert.ok(stage.requestObservations.kinds.compaction >= 1 && stage.requestObservations.rejected >= 1, 'The host asked for a background summary and AZPR refused it.');
    assert.equal(stage.requestObservations.authorizedPrimary, 3, 'The turn went on after the refused summary.');
    assert.deepEqual([stage.status, stage.failureClass, stage.execution?.provider?.status, stage.execution?.compaction], ['FAILED', 'permanent', 401, undefined]);
    assert.ok(!result.stages.some(other => /shard \d+\/\d+[ab]$/.test(other.label ?? '')), 'No split shard was started.');
    // The second pass's reviewer met the same refusal (before its third request, and again once it had answered,
    // when the host asks anew), went on and answered: a refused summary ends nothing.
    const [completed] = result.stages.filter(other => other.role === 'azpr-review-reviewerb');
    assert.ok(completed.requestObservations.kinds.compaction >= 1 && completed.requestObservations.rejected >= 1, 'The host asked the second reviewer for a background summary too, and AZPR refused it.');
    assert.deepEqual([completed.status, completed.failureClass, completed.requestObservations.authorizedPrimary], ['COMPLETE', undefined, 3], 'That reviewer went on, and its answer was accepted.');
    assert.deepEqual(result.stages.map(other => [other.role, other.label, other.status]).sort(), [['azpr-review-reviewer', 'pass 1/2', 'FAILED'], ['azpr-review-reviewerb', 'pass 2/2', 'COMPLETE']], 'One session per pass and no other stage.');
    // The report states the two numbers of the coverage: every file reviewed, none in both passes.
    assert.match(await readFile(join(debug, 'report.md'), 'utf8'), /^\*\*Coverage:\*\* complete — 4\/4 changed file\(s\) reviewed, 0\/4 in all 2 passes$/m);
    console.log(JSON.stringify({ status: 'PASS', host, review: result.status, firstPassSessions: failed.length,
      failureClass: stage.failureClass, providerStatus: stage.execution.provider.status, refusedRequests: stage.requestObservations.rejected,
      compactionRequests: stage.requestObservations.kinds.compaction, refusedForCompletedReviewer: completed.requestObservations.rejected, providerRequests: requests.length }, null, 2));
  }
} finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(resolveDone => provider.close(resolveDone));
  adoServer.closeAllConnections(); await new Promise(resolveDone => adoServer.close(resolveDone));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'receipts.txt'), receipts.join('\n\n==========\n\n'));
  console.error('Private background-compaction evidence: ' + fixture);
}
