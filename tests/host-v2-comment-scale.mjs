import { privateSessions, withCommandCompletion } from './host-command.mjs';
import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host scale fixture. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-comment-scale.mjs /absolute/path/opencode
 * 120 changed files are reviewed in five shards by two passes, each pass with
 * a model of its own. One shard of the first pass reports a nearly full
 * context so the host attempts compaction, which AZPR refuses and splits the
 * shard instead. The second pass reports six findings per shard, the first
 * pass one, at a place where the second pass reports one too: a duplicate-check
 * session for that file merges the two reports. The 30 findings that remain
 * are rated in two sessions without tools by the first reviewer model (the
 * default, rater: ""): the reviewers file every finding as medium and the
 * rating makes every third one low and the others high, so every count below
 * follows the rating. The 30 findings are planned in pages of four, two pages
 * at a time, and published; a second publish creates nothing. Before the pages
 * a grouping pass says that three high findings are one defect in three files:
 * they share a page and one comment, which lists the other two places.
 * The list of 120 changed files is too long for a planning page's input, which
 * names the private data it lies in instead: the first page reads two rows of
 * it with OpenCode's native read tool, and the fixture checks that the host
 * returned each row whole (it cuts a line that is longer than 2,000 characters).
 * With --cleanup the same review runs with debug off, as installed by default.
 * A run then deletes its sessions when it ends, which debug prevents: the
 * fixture checks on the host that only the session holding the report is left
 * after the review, that a preview keeps none of its planner sessions and that
 * no session record stays. The checks that read debug records belong to the
 * default mode.
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
import { HOST_READ_LINE_CHARACTERS } from '../src/host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), binary = process.argv[2], cleanup = process.argv[3] === '--cleanup';
assert.ok(binary?.startsWith('/'));
assert.ok(cleanup || process.argv[3] === undefined, 'The only option is --cleanup.');
await mkdir(join(root, '.local'), { recursive: true });
const fixture = await mkdtemp(join(root, '.local/host-v2-scale-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = Array.from({ length: 120 }, (_, i) => `/src/module-${String(Math.floor(i / 10)).padStart(2, '0')}/file-${String(i).padStart(3, '0')}.ts`);
const requests = [], receipts = [];
// The level the rating gives a finding follows the place of its file in its shard of 24 files: every third one is low.
const levelOf = finding => Number(/file-(\d{3})\.ts/.exec(finding.location)[1]) % 24 % 3 === 2 ? 'low' : 'high';
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let child, logs = '', overflowShards = 0;
// Planning requests in flight: the first page waits for a second one, so two lanes must overlap.
let planning = 0, planningMost = 0, planningGate = null;
// The findings the grouping pass called one defect at several places, each with its location.
let grouped = [];
// What the duplicate checks and the rating sessions were given.
const duplicateChecks = [], ratings = [];
// What the first planning page read of the changed-file list: the reference its input named and the read's result.
let rowsRead = null;
// A file of the project with a line of exactly the length the host's read returns whole, and one a character longer.
const limitFile = join(dirs.work, 'read-limit.txt');
await writeFile(limitFile, `${'a'.repeat(HOST_READ_LINE_CHARACTERS)}\n${'b'.repeat(HOST_READ_LINE_CHARACTERS + 1)}\n`);
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* summaries etc. */ }
    const results = input.messages.filter(m => m.role === 'tool').length;
    requests.push({ model: input.model, sessionID: request.headers['x-opencode-session-id'], files: payload?.assignment?.files?.length, kind: payload?.assignment?.kind, work: payload?.commentWork?.kind, toolResults: results, requestCharacters: body.length });
    const offered = name => input.tools?.some(t => t.function.name === name);
    let calls = [], final, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (payload?.assignment?.kind === 'duplicates') {
      // One file holds a finding of each pass: the second report repeats the first.
      const [kept, ...repeated] = payload.assignment.findings;
      duplicateChecks.push({ file: payload.assignment.file, side: payload.assignment.side, sessions: payload.assignment.findings.map(f => f.session) });
      final = { status: 'COMPLETE', merged: repeated.map(f => ({ id: f.id, mergedInto: kept.id, reason: 'Same guard lost in the same file.' })), report: '' };
    } else if (payload?.assignment?.kind === 'rating') {
      // The rating sees neither a tool nor the level a reviewer gave; it sets the level of every finding.
      ratings.push({ findings: payload.assignment.findings.length, tools: input.tools?.length ?? 0, levels: payload.assignment.findings.filter(f => Object.hasOwn(f, 'severity')).length });
      final = { status: 'COMPLETE', ratings: payload.assignment.findings.map(f => ({ id: f.id, severity: levelOf(f), reason: 'Rated from the text.' })), report: '' };
    } else if (payload?.assignment?.files) {
      const assigned = payload.assignment.files, first = Number(payload.assignment.firstFindingId.split('-')[1]);
      const finding = (path, i, summary) => ({ id: `F-${first + i}`, summary, evidence: 'HEAD drops the guard.', counterevidence: 'No caller re-checks.', location: `head:${path}:1`, severity: 'medium', suggestion: 'Restore the guard.' });
      if (input.model === 'first') {
        // The first pass reads its first file whole. Its first shard is "too large": with its read it reports a context
        // of 59,000 tokens, past the 48,000 at which OpenCode (2.3.0 through 2.4.1) compacts a window of 64,000.
        const tooLarge = assigned.length > 15 && assigned[0] === files[0];
        if (!results && offered('azpr_read_file')) {
          calls = [{ name: 'azpr_read_file', arguments: { path: assigned[0], version: 'head' } }];
          if (tooLarge) { usage = { prompt_tokens: 59000, completion_tokens: 10, total_tokens: 59010 }; overflowShards++; }
        } else {
          // Its one finding is in the PR's first file, where the second pass reports the same defect in other words.
          final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings: assigned[0] === files[0] ? [finding(files[0], 0, `Guard dropped in ${files[0]}`)] : [], report: `Shard ${payload.assignment.shard} reviewed.` };
        }
      } else {
        // The second pass reads the diffs of its first six files in one step and reports a finding in each.
        const reported = assigned.slice(0, 6);
        if (!results && offered('azpr_read_diff')) calls = reported.map(path => ({ name: 'azpr_read_diff', arguments: { path } }));
        else final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings: reported.map((path, i) => finding(path, i, `State lost in ${path}`)), report: `Shard ${payload.assignment.shard} reviewed.` };
      }
    } else if (payload?.commentWork?.kind === 'group') {
      // The pass before the pages: the first three high findings are the same lost guard in three files.
      grouped = payload.findings.slice(0, 3).map(({ id, location }) => ({ id, location }));
      final = { status: 'READY', groups: [{ findingIds: grouped.map(f => f.id), reason: 'The same guard is lost in each file.' }] };
    } else if (payload?.commentWork?.kind === 'plan' && payload.commentWork.page === 1 && !results && payload.snapshot?.allFiles?.azprData && offered('read')) {
      // The first page looks at the start of the changed-file list before it plans: rows 1 and 2 of the pages of
      // that private value, as the planner's instructions say (one or two rows at a time, with offset and limit).
      // And the two lines of a file of the project that stand on either side of what the host's read returns whole.
      calls = [{ name: 'read', arguments: { path: payload.snapshot.allFiles.azprData.pages, offset: 1, limit: 2 } }, { name: 'read', arguments: { path: limitFile, offset: 1, limit: 2 } }];
    } else if (payload?.commentWork?.kind === 'plan') {
      if (payload.commentWork.page === 1 && results) {
        const [rows, limit] = input.messages.filter(m => m.role === 'tool').slice(-2).map(m => textOf(m.content));
        rowsRead = { reference: payload.snapshot.allFiles.azprData, result: rows, limit };
      }
      planningMost = Math.max(planningMost, ++planning);
      if (!planningGate) {
        let open, limit; planningGate = { promise: new Promise(resolve => { open = resolve; }), open };
        await Promise.race([planningGate.promise, new Promise(resolve => { limit = setTimeout(resolve, 10000); })]);
        clearTimeout(limit); // Otherwise the timer keeps this process alive after the last assertion.
      } else planningGate.open();
      planning--;
      // One comment for a listed group of repeats, at its first finding; every other finding gets its own.
      const repeats = payload.repeatCandidates ?? [], together = new Set(repeats.flat()), byId = new Map(payload.findings.map(f => [f.id, f]));
      const at = f => ({ severity: f.severity, path: /head:([^:]+)/.exec(f.location)[1], startLine: 1, endLine: 1, anchor: 'fixture code' });
      final = { status: 'READY', ...(payload.commentWork.allowSummary ? { summary: 'Fixture change.' } : {}),
        comments: [...repeats.map(ids => ({ findingIds: ids, mergeReason: 'One guard, lost in each file.', ...at(byId.get(ids[0])), body: '🔴 high: State lost where the guard was dropped\n\nTrigger, evidence and correction.' })),
          ...payload.findings.filter(f => f.severity !== 'low' && !together.has(f.id)).map(f => ({ findingId: f.id, ...at(f), body: `🔴 high: ${f.summary}\n\nTrigger, evidence and correction.` }))],
        skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, cause: 'low-severity', reason: 'Low severity stays in the summary.' })) };
    } else {
      final = 'Fixture summary.';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish = null, rest = {}) => response.write('data: ' + JSON.stringify({ id: 'scale', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...rest }) + '\n\n');
    // Tool calls of one step arrive as one chunk each, as a provider streams parallel calls.
    if (calls.length) calls.forEach((call, index) => emit({ ...(index ? {} : { role: 'assistant' }), tool_calls: [{ index, id: `fixture_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
    else emit({ role: 'assistant', content: typeof final === 'string' ? final : JSON.stringify(final) });
    emit({}, calls.length ? 'tool_calls' : 'stop', { usage });
    response.end('data: [DONE]\n\n');
  } catch (error) { logs += '\nPROVIDER: ' + error.stack; response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } })); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
// Every file gains its second line in the PR: a diff of it shows HEAD source, which counts as that session's read of the file.
const BASE = 'a'.repeat(40);
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 321, files, base: BASE,
  sources: Object.fromEntries(files.flatMap(path => [[path, 'fixture code\nsecond line\n'], [`${BASE}:${path}`, 'fixture code\n']])) });
const adoServer = createServer((request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
adoServer.listen(0, '127.0.0.1'); await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;
const settings = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
// Two passes, each with a model of its own so that the fake provider can tell them apart. The rater stays at its
// default (""): the first reviewer model rates.
settings.models.review = { reviewers: ['fixture/first', 'fixture/second'], rater: '' };
settings.debug = { enabled: !cleanup, directory: join(fixture, 'debug') };
settings.workflow = { ...settings.workflow, shardFiles: 24, parallelSessions: 4 };
// These steps drive each comment step themselves; the default (a preview after every review) is covered by the runtime tests.
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
const install = spawnSync('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')], { encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
// A window of 64,000 tokens: OpenCode (2.3.0 through 2.4.1) compacts in the turn once the context reaches the window less 16,000 tokens.
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, warming: false, model: 'fixture/second',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries(['first', 'second'].map(id => [id, { limit: { context: 64000, output: 4000 } }])) } } }));
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
// The disclosure line of every comment of this review: its method and the models of its stages.
const DISCLOSURE = 'AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification. Models: `fixture/first`, `fixture/second`';
const THREADS = 19; // 20 high findings in 18 inline comments (three of them share one) plus one summary; 10 low findings stay in the summary.
try {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await Promise.race([new Promise((resolveReady, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('Host exited ' + code))); child.stdout.on('data', data => { logs += data; const match = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); }); child.stderr.on('data', data => { logs += data; }); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  const rawApi = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const api = withCommandCompletion(rawApi, 300000);
  const origin = (await api('/api/session', { title: 'Scale fixture', location: { directory: dirs.work } })).data;
  const notices = async () => (await api(`/api/session/${origin.id}/inbox`)).data.map(item => item.payload?.text ?? '');
  const latest = async () => { receipts.push((await notices()).at(-1)); return receipts.at(-1); };
  // What a model gets when it reads rows of AZPR's private data with the host's native read tool. The host returns a
  // line of at most 2,000 characters whole and cuts a longer one (OpenCode 2.3.0 through 2.4.1), so AZPR writes rows
  // that fit: each row the page read is whole JSON, and their texts are the value itself, from its start.
  const rowsWhole = async () => {
    assert.ok(rowsRead, 'The first planning page read two rows of the changed-file list with the native read tool.');
    const numbered = rowsRead.result.split('\n').filter(line => /^\d+: /.test(line));
    assert.doesNotMatch(rowsRead.result, /line truncated to/, `The host cut a row of AZPR's private data (longest line ${Math.max(...numbered.map(line => line.length))} characters): a model that reads it gets part of the value.`);
    assert.equal(numbered.length, 2, `The read returned rows 1 and 2: ${rowsRead.result.slice(0, 300)}`);
    const rows = numbered.map(line => { try { return JSON.parse(line.replace(/^\d+: /, '')); } catch { return null; } });
    assert.ok(rows.every(row => row && Number.isInteger(row.start) && Number.isInteger(row.end) && typeof row.text === 'string'), `A row is not whole JSON: ${numbered.map(line => line.slice(-80)).join(' | ')}`);
    const value = await readFile(rowsRead.reference.file, 'utf8');
    assert.deepEqual(JSON.parse(value), files, 'The private value is the list of the PR\'s changed files.');
    assert.deepEqual([rows[0].start, rows[1].start, rows[1].end < value.length], [0, rows[0].end, true], 'The two rows follow each other from the start of the value, which goes on after them.');
    assert.equal(rows[0].text + rows[1].text, value.slice(0, rows[1].end), 'The rows hold the value\'s own text, nothing lost.');
    // The length that decides whether a row an earlier version wrote can stay (`wholePages`): the host returns a
    // line of exactly that many characters whole, and cuts one that is a character longer, saying so in the line.
    const [whole, cut] = rowsRead.limit.split('\n').filter(line => /^\d+: /.test(line)).map(line => line.replace(/^\d+: /, ''));
    assert.equal(whole, 'a'.repeat(HOST_READ_LINE_CHARACTERS), `The host's read no longer returns a line of ${HOST_READ_LINE_CHARACTERS} characters whole (it returned ${whole?.length}): ${rowsRead.limit.slice(0, 200)}`);
    assert.ok(cut?.startsWith('b'.repeat(HOST_READ_LINE_CHARACTERS)) && !cut.startsWith('b'.repeat(HOST_READ_LINE_CHARACTERS + 1)) && /truncated/.test(cut),
      `The host's read no longer cuts a line of ${HOST_READ_LINE_CHARACTERS + 1} characters after ${HOST_READ_LINE_CHARACTERS}: ${String(cut).slice(-120)}`);
    return `${numbered.length} rows of ${Math.max(...numbered.map(line => line.length))} characters at most, whole; a line of ${HOST_READ_LINE_CHARACTERS} characters is returned whole and one of ${HOST_READ_LINE_CHARACTERS + 1} is cut`;
  };
  await api(`/api/session/${origin.id}/command`, { name: 'pr-review', text: 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321', delivery: 'steer' });
  const receipt = await latest(), reviewId = /^\[AZPR ([a-f0-9]{8})\]/.exec(receipt)[1];
  // The run's first notice names its passes and their models.
  assert.ok((await notices()).includes(`[AZPR ${reviewId}] STARTED /pr-review (2 passes: fixture/first, fixture/second). Work continues in this OpenCode process; the result will return to this conversation. Stop with /pr-stop ${reviewId}.`), 'The STARTED notice names the two passes.');
  // Both passes reviewed every file, the split shard in its two halves: coverage is complete, in every pass.
  assert.match(receipt, /^\[AZPR [a-f0-9]{8}\] COMPLETE; coverage complete, 120\/120 file\(s\) in every pass; verification none\n/, receipt);
  // One reviewer session of the first pass filled its context; its shard was reviewed in two halves instead.
  const stageLines = receipt.split('\n').filter(line => line.startsWith('- azpr-'));
  assert.deepEqual(stageLines.filter(line => line.includes('failure=')).map(line => line.replace(/session=ses_[A-Za-z0-9]+/, 'session=…')),
    ['- azpr-review-reviewer [pass 1/2 shard 1/5]: FAILED; session=…; model=fixture/first; failure=overflow; error=[AZPR] Reviewer execution did not finish successfully (session=failed; terminal=failed; assistantResponses=1; finish=tool-calls).'],
    'Exactly one stage failed: the shard that filled its context.');
  for (const half of ['a', 'b']) assert.match(receipt, new RegExp(`^- azpr-review-reviewer \\[pass 1/2 shard 1/5${half}\\]: COMPLETE; session=ses_[A-Za-z0-9]+; model=fixture/first$`, 'm'), `The receipt names half ${half} of the split shard.`);
  assert.equal((await notices()).filter(text => text === `[AZPR ${reviewId}] PROGRESS — Review pass 1/2 shard 1/5 reached its context limit on 24 files; splitting the shard in two.`).length, 1, 'The conversation was told once that the shard is split.');
  assert.equal(overflowShards, 1, 'The fake provider reported a full context once: neither half does.');
  // One role per entry of models.review.reviewers, and with the default rater a rating role; no role of a mode that is off.
  assert.deepEqual((await api('/api/agent')).data.map(agent => agent.name).filter(name => name.startsWith('azpr-')).sort(),
    ['azpr-review-comment-plan', 'azpr-review-comment-plan-verified', 'azpr-review-dedupe', 'azpr-review-rating', 'azpr-review-reviewer', 'azpr-review-reviewerb'],
    'The private roles follow the settings.');
  // The duplicate check compared the two reports in the PR's first file: one of each pass, the first pass's from the half that holds the file.
  assert.deepEqual(duplicateChecks, [{ file: files[0], side: 'head', sessions: ['1/5a pass 1', '1/5 pass 2'] }], 'One duplicate check: one file holds findings of two reviewer sessions.');
  // 31 reports less the merged one are rated, 25 to a session, without tools and without the reviewers' levels.
  assert.deepEqual(ratings.map(rating => rating.findings).sort((a, b) => b - a), [25, 5], '30 findings are rated in two sessions.');
  assert.ok(ratings.every(rating => rating.tools === 0 && rating.levels === 0), 'A rating session gets no tool and no level.');
  if (cleanup) {
    // Debug is off, as installed by default: a run's sessions are deleted when it ends.
    const sessions = privateSessions(rawApi, dirs.state);
    const created = sessions.named(receipt), report = /Report delivery: report queued to session=(\S+)\./.exec(receipt)[1];
    const left = [];
    for (const id of created) if (await sessions.exists(id)) left.push(id);
    assert.equal(created.length, 15, 'The receipt names the session of every stage: 7 and 5 reviewers, a duplicate check and 2 ratings.');
    assert.match(receipt, new RegExp(`^- azpr-review-rating \\[[12]/2\\]: COMPLETE; session=${report}; model=fixture/first$`, 'm'), 'The report is in a session of the last stage, the rating.');
    assert.deepEqual(left, [report], 'After the review only the session holding the report exists on the host.');
    assert.equal(Number(/\nSession notice: (\d+) reviewer session\(s\) of this run were deleted/.exec(receipt)?.[1]), created.length - 1, 'The receipt counts the deleted sessions.');
    assert.match((await rawApi(`/api/session/${report}/inbox`)).data.at(-1).payload.text, new RegExp(`^# AZPR ${reviewId} — COMPLETE\n`), 'The session that is left holds the report.');
    assert.equal((await sessions.listed()).length, 1, 'The host lists one private session, the report.');
    assert.deepEqual(await sessions.records(), {}, 'Nothing is left to delete, and no unfinished run keeps a session.');
    // A preview plans in nine sessions (the grouping pass and eight pages) and keeps none of them; the report session stays.
    await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '', delivery: 'steer' });
    assert.match(await latest(), /\] PREVIEW/);
    assert.equal(requests.filter(r => r.work).length, 10, 'A grouping pass and eight pages, the first of which read two rows of private data before it planned.');
    const rowsOfData = await rowsWhole();
    assert.equal(planningMost, 2, 'Two planning pages were in flight at once, never more.');
    assert.equal((await sessions.listed()).length, 1, 'A comment run keeps none of its sessions.');
    assert.ok(await sessions.exists(report), 'The report session is still there after the preview.');
    await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
    assert.match(await latest(), /\] POSTED/);
    assert.equal(azure.state.threads.length, THREADS, 'The saved preview is posted as in the default mode.');
    // A command typed in the report session still acts on its review.
    await rawApi(`/api/session/${report}/command`, { name: 'pr-comment', text: '--show', delivery: 'steer' });
    assert.match((await rawApi(`/api/session/${report}/inbox`)).data.at(-1).payload.text, new RegExp(`^\\[AZPR\\] Saved preview of review ${reviewId}`));
    assert.deepEqual([(await sessions.listed()).length, await sessions.records()], [1, {}]);
    console.log(JSON.stringify({ status: 'PASS', mode: 'cleanup', files: files.length, reviewSessions: created.length, deletedAfterReview: created.length - 1, privateSessionsLeft: 1,
      plannerSessionsLeft: 0, privateDataRows: rowsOfData, threads: azure.state.threads.length, providerRequests: requests.length, azureCalls: azure.state.calls.length }, null, 2));
  } else {
    const debug = /Private debug directory: ([^\n]+)/.exec(receipt)[1];
    const result = JSON.parse(await readFile(join(debug, 'result.json'), 'utf8'));
    const stages = stage => result.stages.filter(record => record.role === `azpr-review-${stage}`);
    const first = stages('reviewer'), second = stages('reviewerb'), reviewed = pass => pass.filter(stage => stage.status !== 'FAILED');
    const overflowed = first.filter(stage => stage.failureClass === 'overflow');
    assert.equal(overflowed.length, 1, 'Exactly one shard of the first pass overflowed.');
    const compactionObserved = overflowed[0].requestObservations?.kinds?.compaction > 0 && overflowed[0].requestObservations.rejected > 0 && Boolean(overflowed[0].execution?.compaction);
    assert.ok(compactionObserved, 'The host attempted compaction in the failed turn and AZPR refused it.');
    assert.equal(result.stages.filter(stage => stage.requestObservations?.kinds?.compaction > 0).length, 1, 'No other session met a compaction or a background summary.');
    assert.deepEqual(reviewed(first).map(stage => stage.label).sort(), ['pass 1/2 shard 1/5a', 'pass 1/2 shard 1/5b', 'pass 1/2 shard 2/5', 'pass 1/2 shard 3/5', 'pass 1/2 shard 4/5', 'pass 1/2 shard 5/5'], 'The first pass: the split shard in two halves, and four whole shards.');
    assert.deepEqual(second.map(stage => [stage.label, stage.status]).sort(), [1, 2, 3, 4, 5].map(shard => [`pass 2/2 shard ${shard}/5`, 'COMPLETE']), 'The second pass: five shards of 24 files.');
    assert.ok(first.every(stage => stage.completedTools === 1), 'Each reviewer of the first pass read its first file.');
    assert.ok(second.every(stage => stage.completedTools === 6), 'Each reviewer of the second pass read its six files as diffs.');
    for (const [name, pass] of [['first', first], ['second', second]]) {
      assert.equal(reviewed(pass).reduce((n, stage) => n + stage.result.coverage.files.length, 0), 120, `Every file is reviewed once by the ${name} pass, including split shards.`);
    }
    assert.deepEqual(stages('dedupe').map(stage => [stage.label, stage.status, stage.model]), [['', 'COMPLETE', 'fixture/first']], 'One file holds findings of two reviewer sessions.');
    // The settings name no rater, so the first reviewer model rates: 30 findings in two sessions.
    assert.deepEqual(stages('rating').map(stage => [stage.label, stage.status, stage.model]).sort(), [['1/2', 'COMPLETE', 'fixture/first'], ['2/2', 'COMPLETE', 'fixture/first']], 'The first reviewer model rates in two sessions.');
    assert.equal(result.stages.length, 15, 'Seven and five reviewer sessions, one duplicate check and two ratings.');
    const report = await readFile(join(debug, 'report.md'), 'utf8');
    assert.match(report, /^\*\*Coverage:\*\* complete — 120\/120 changed file\(s\) reviewed, 120\/120 in all 2 passes$/m);
    // The second pass's report of the first file is merged into the first pass's, which stays.
    assert.deepEqual(report.match(/^- \*\*F-\d+ — MERGED[^\n]*$/gm), ['- **F-2 — MERGED → F-1:** Same guard lost in the same file. [Runtime: merged by the duplicate check of independent reviewer sessions.]'], 'The repeated report is merged into the finding that stays.');
    // Every level is the rating's: the reviewers filed medium, and the report shows both.
    assert.match(report, /^high: 20 · medium: 0 · low: 10$/m);
    assert.deepEqual(['high', 'low'].map(level => report.match(new RegExp(`^### F-\\d+ — [^\\n]* \\(${level}; reviewer: medium\\)$`, 'gm'))?.length), [20, 10], 'The rating set the level of all 30 findings.');
    await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
    const posted = await latest();
    assert.match(posted, new RegExp(`^\\[AZPR [a-f0-9]{8}\\] POSTED; source review=${reviewId}\n`), posted);
    assert.match(posted, new RegExp(`\nPublication \\(VERIFIED=${THREADS}\\):\n`), 'Every item was created and read back.');
    const state = azure.state;
    assert.equal(state.threads.length, THREADS, '20 high findings in 18 inline comments (three of them share one) plus one summary; 10 low findings stay in the summary.');
    const inline = state.threads.filter(thread => thread.threadContext), summary = state.threads.find(thread => !thread.threadContext).comments[0].content;
    assert.ok(inline.length === THREADS - 1 && inline.every(thread => thread.comments[0].content.includes(`\n\n---\n${DISCLOSURE}\n\n<!-- azpr-comment:`)), 'Every inline comment discloses the review method and the models.');
    assert.ok(summary.startsWith(`🤖 ${DISCLOSURE}\n\n## PR Review Summary\n`), 'The summary begins with the same disclosure; with complete coverage it names no gap.');
    const stagesOfPlan = JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(posted)[1], 'result.json'), 'utf8')).stages;
    assert.ok(stagesOfPlan.length && stagesOfPlan.every(stage => stage.role === 'azpr-review-comment-plan' && stage.model === 'fixture/first'), 'The first reviewer model plans the comments of a review of this pipeline.');
    const passes = stagesOfPlan.filter(s => s.commentWork.kind === 'group'), planner = stagesOfPlan.filter(s => s.commentWork.kind === 'plan');
    assert.deepEqual(passes.map(s => [s.label, s.status]), [['grouping', 'READY']], 'One grouping pass before the pages.');
    assert.equal(planner.length, 8, '30 findings in planning pages of four; the three repeats share a page.');
    // The first page read two rows of the changed-file list before it planned, in one session of two requests.
    assert.deepEqual(planner.map(s => [s.commentWork.page, s.modelRequests]).sort((a, b) => a[0] - b[0]), [1, 2, 3, 4, 5, 6, 7, 8].map(page => [page, page === 1 ? 2 : 1]), 'Only the first page asked its model twice.');
    const rowsOfData = await rowsWhole();
    // The three places of the one defect: a comment at the first, the two others listed under its text, each still a row of the index.
    assert.deepEqual(grouped, [0, 1, 3].map((file, index) => ({ id: `F-${[1, 3, 5][index]}`, location: `head:${files[file]}:1` })), 'The grouping pass was given the high findings in the order of the review.');
    const shared = state.threads.filter(thread => /📍 Also at/.test(thread.comments[0].content));
    assert.equal(shared.length, 1, 'One comment covers the three places.');
    assert.equal(shared[0].threadContext.filePath, files[0], 'The shared comment stands at the first place.');
    assert.match(shared[0].comments[0].content, new RegExp('^' + escaped('🔴 high: State lost where the guard was dropped\n\nTrigger, evidence and correction.\n\n' +
      '**📍 Also at** (the same defect; fix these places with it):\n' + grouped.slice(1).map(({ id, location }) => `- \`${location.replace(/^head:/, '')}\` (${id})`).join('\n') +
      `\n\n---\n${DISCLOSURE}\n\n`) + '<!-- azpr-comment:[a-f0-9]{32} -->\n\n<!-- azpr-comment:[a-f0-9]{32} -->$'), shared[0].comments[0].content);
    assert.match(posted, new RegExp(`^- ${grouped.map(f => f.id).join(', ')} \\(${escaped(files[0])}:1\\): VERIFIED; thread=\\d+$`, 'm'), 'The receipt names the findings of the shared comment.');
    assert.match(summary, /^high: 20 · medium: 0 · low: 10$/m, 'The summary counts the rated levels.');
    for (const { id } of grouped) assert.match(summary, new RegExp(`\\| 🔴 high \\| ${id} — `), `${id} keeps its row in the summary index.`);
    assert.equal(planningMost, 2, 'Two planning pages were in flight at once, never more.');
    await api(`/api/session/${origin.id}/command`, { name: 'pr-comment', text: '--publish', delivery: 'steer' });
    assert.match(await latest(), new RegExp(`\nPublication \\(ALREADY_PRESENT=${THREADS}\\):\n`), 'A second publication finds every item on the PR.');
    assert.equal(azure.callsTo('createThread').length, THREADS, 'A second publish writes nothing.');
    console.log(JSON.stringify({ status: 'PASS', files: files.length, firstPassSessions: first.length, overflowSplits: overflowed.length, compactionObserved, overflowShardsReported: overflowShards,
      secondPassSessions: second.length, duplicateChecks: stages('dedupe').length, ratingSessions: stages('rating').length, groupingPasses: passes.length, plannerSessions: planner.length, planningInFlightMax: planningMost, privateDataRows: rowsOfData, sharedComments: shared.length, threads: state.threads.length, providerRequests: requests.length,
      maxRequestCharacters: Math.max(...requests.map(r => r.requestCharacters)), azureCalls: azure.state.calls.length }, null, 2));
  }
} finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(resolveDone => provider.close(resolveDone));
  adoServer.closeAllConnections(); await new Promise(resolveDone => adoServer.close(resolveDone));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(fixture, 'receipts.txt'), receipts.join('\n\n==========\n\n'));
  console.error('Private scale evidence: ' + fixture);
}
