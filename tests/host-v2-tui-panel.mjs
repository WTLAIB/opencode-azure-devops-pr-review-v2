import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for the terminal panel. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-tui-panel.mjs /absolute/path/opencode [--native [--package SPEC]]
 * The real TUI runs in a detached tmux session (tmux is required): the fixture reads its screen and
 * drives its keyboard and mouse. A review of six files starts from the TUI, and its reviewers are
 * held until the panel was seen with them running. Checked on the screen: the panel opens by itself
 * and leaves the keyboard with the prompt; a click on a row opens that session, and the panel is
 * back with the conversation; the report and the comment preview are rendered Markdown; /pr-panel,
 * the panel's one command; a terminal too narrow for two panes is not taken over. The host is then
 * restarted with terminalPanel: manual: the notices carry the setting, and the panel opens only when
 * asked. The settings file starts without the settings newer versions brought: loading AZPR adds
 * them, and commands start all the same.
 * With --native the package is installed by OpenCode's plugin manager, where OpenCode 2.3.0 compiles
 * no JSX: the compiled view must load from there, and the compiler must not be installed with it.
 * --package SPEC installs a published package (an npm version or a public Git commit) instead of
 * the one packed from this checkout.
 * Synthetic completions test the panel and the host, not model review quality.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), binary = process.argv[2], native = process.argv[3] === '--native';
const published = native && process.argv[4] === '--package' ? process.argv[5] : undefined;
assert.ok(binary?.startsWith('/'));
assert.ok(native || process.argv[3] === undefined, 'The only option is --native.');
assert.ok(process.argv.length <= 4 || (published && process.argv.length === 6), 'Only --native accepts a following --package SPEC.');
assert.equal(spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status, 0, 'tmux is required: the fixture runs the TUI in it and reads its screen.');
await mkdir(join(root, '.local'), { recursive: true });
const fixture = await mkdtemp(join(root, '.local/host-v2-tui-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const files = ['/src/orders/reserve.ts', '/src/orders/snapshot.ts', '/src/orders/dispatch.ts', '/src/billing/invoice.ts', '/src/billing/refund.ts', '/src/billing/ledger.ts'];
const requests = [];
let child, logs = '';
// The reviewers' answers wait here until the panel was seen with their sessions running.
let release; const held = new Promise(resolveHeld => { release = resolveHeld; });
const levelOf = id => (Number(id.split('-')[1]) - 1) % 1000 % 3 === 2 ? 'low' : 'high';
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* an ordinary conversation */ }
    const results = input.messages.filter(m => m.role === 'tool').length;
    requests.push({ model: input.model, sessionID: request.headers['x-opencode-session-id'], files: payload?.assignment?.files?.length, work: payload?.commentWork?.kind, toolResults: results });
    const fileTool = input.tools?.find(t => t.function.name === (input.model === 'risk' ? 'azpr_read_diff' : 'azpr_read_file'))?.function.name;
    let call, final;
    if (payload?.assignment?.files && !payload.assignment.findingIds) {
      const assigned = payload.assignment.files;
      if (!results && fileTool) call = { name: fileTool, arguments: fileTool === 'azpr_read_diff' ? { path: assigned[0] } : { path: assigned[0], version: 'head' } };
      else {
        await held;
        const first = Number(payload.assignment.firstFindingId.split('-')[1]);
        const findings = input.model === 'risk' ? assigned.map((path, i) => ({ id: `R-${first + i}`, summary: `\`${path.split('/').at(-1).replace('.ts', '')}\` drops the guard before it changes state`,
          evidence: 'HEAD removes `if (!ready) return`, so **a second caller** sees the half-written state.', counterevidence: 'No caller re-checks the flag.', location: `head:${path}:1`, severity: i % 3 === 2 ? 'low' : 'high', suggestion: 'Restore the guard.' })) : [];
        final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings, report: `Shard ${payload.assignment.shard} reviewed.` };
      }
    } else if (payload?.assignment?.findingIds) {
      final = { status: 'COMPLETE', confirmed: payload.assignment.findings.map(f => ({ ...f, severity: levelOf(f.id), reason: 'Verified against HEAD and BASE.' })), merged: [], rejected: [], needsInfo: [], newFindings: [], report: 'Advice: extract the guard into **one helper**.' };
    } else if (payload?.commentWork?.kind === 'plan') {
      final = { status: 'READY', ...(payload.commentWork.allowSummary ? { summary: 'This change reworks the order and billing helpers.' } : {}),
        comments: payload.findings.filter(f => f.severity !== 'low').map(f => ({ findingId: f.id, severity: f.severity, path: /head:([^:]+)/.exec(f.location)[1], startLine: 1, endLine: 1, anchor: 'fixture code',
          body: `🔴 **high**: ${f.summary}\n\n**Suggested fix**\n\n\`\`\`ts\nif (!ready) return\n\`\`\`` })),
        skipped: payload.findings.filter(f => f.severity === 'low').map(f => ({ findingId: f.id, cause: 'low-severity', reason: 'Low severity stays in the summary.' })) };
    } else final = 'The conversation\'s own model was asked.';
    const delta = call ? { tool_calls: [{ index: 0, id: 'fixture_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: typeof final === 'string' ? final : JSON.stringify(final) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    emit({ id: 'tui', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    emit({ id: 'tui', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
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
settings.workflow = { ...settings.workflow, shardFiles: 3, parallelSessions: 4 };
// Each comment step is typed here; debug stays off, as installed, so a run deletes its sessions when it ends.
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options }); assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}${result.stdout}`); return result.stdout; };
const config = { update: 'disable', snapshots: false, warming: false, model: 'fixture/chat',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries(['functional', 'risk', 'verifier', 'chat'].map(id => [id, { limit: { context: 64000, output: 4000 } }])) } } };
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify(config));
if (native) {
  let spec = published;
  if (!spec) {
    // As published: npm's own packing, installed through OpenCode's plugin manager from an isolated Git commit.
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', fixture], { cwd: root }))[0];
    assert.ok(packed.files.some(file => file.path === 'src/tui.js') && packed.files.some(file => file.path === 'src/tui-model.mjs'), 'The package carries the terminal part.');
    run('tar', ['-xzf', join(fixture, packed.filename), '-C', fixture]);
    const packageDirectory = join(fixture, 'package');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=AZPR fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Native package fixture']]) run('git', args, { cwd: packageDirectory });
    spec = `git+file://${packageDirectory}#${run('git', ['rev-parse', 'HEAD'], { cwd: packageDirectory }).trim()}`;
  }
  assert.match(run(binary, ['plugin', 'add', spec], { cwd: dirs.work, env }), /installed and added/);
  // The package keeps no settings: they are in the user's configuration, with the PAT in a file of its own.
  const patFile = join(fixture, 'xdg-config', 'azpr', 'pat');
  await mkdir(dirname(patFile), { recursive: true, mode: 0o700 });
  await writeFile(patFile, FAKE_PAT, { mode: 0o600 });
  await writeFile(join(dirname(patFile), 'settings.json'), JSON.stringify({ ...settings, azure: { ...settings.azure, pat: '', patFile } }), { mode: 0o600 });
} else {
  await writeFile(join(fixture, 'settings.json'), JSON.stringify(settings));
  run('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings.json')]);
}
// The settings file as a version before these settings existed left it: loading AZPR writes them into it.
const settingsFile = native ? join(fixture, 'xdg-config', 'azpr', 'settings.json') : join(dirs.config, 'plugins', 'azpr-v2', 'settings.json');
const newer = ['terminalPanel', 'deletePrivateSessions', 'progressNotices'];
const older = JSON.parse(await readFile(settingsFile, 'utf8'));
for (const name of newer) { assert.ok(Object.hasOwn(older, name), name); delete older[name]; }
delete older.workflow.stageIdleSeconds;
await writeFile(settingsFile, JSON.stringify(older, null, 2) + '\n', { mode: 0o600 });

// ------------------------------------------------------------------ the terminal
// A Unix socket's path is limited to about a hundred bytes, which a checkout in a long directory exceeds
// (as on a CI runner), and a long TMPDIR too.
const socketRoot = [tmpdir(), '/tmp'].find(directory => Buffer.byteLength(join(directory, 'azpr-tui-XXXXXX', 's')) < 100);
assert.ok(socketRoot, 'No temporary directory with a path short enough for tmux\'s socket.');
const socketDirectory = await mkdtemp(join(socketRoot, 'azpr-tui-'));
const socket = join(socketDirectory, 's'), tmuxConfig = join(fixture, 'tmux.conf');
await writeFile(tmuxConfig, ['set -g default-terminal "tmux-256color"', 'set -as terminal-features ",*:RGB"', 'set -g escape-time 0', 'set -g mouse off', 'set -g status off', 'set -g history-limit 0'].join('\n') + '\n');
const tmux = (...args) => spawnSync('tmux', ['-S', socket, '-f', tmuxConfig, ...args], { encoding: 'utf8', env, timeout: 15000 });
const screen = () => tmux('capture-pane', '-p', '-t', 'azpr').stdout ?? '';
const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Wait until the screen matches; the failure shows the screen as it was last. */
async function see(pattern, what, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let shown = '';
  while (Date.now() < deadline) {
    shown = screen();
    const match = typeof pattern === 'function' ? pattern(shown) : pattern.exec(shown);
    if (match) return match;
    await sleep(200);
  }
  assert.fail(`${what}\n--- screen ---\n${shown}`);
}
const type = text => tmux('send-keys', '-t', 'azpr', '-l', text);
const key = name => tmux('send-keys', '-t', 'azpr', name);
/** Escape on its own: a key that follows at once would make it the prefix of an Alt chord. */
const escape = async () => { key('Escape'); await sleep(500); };
/** The panel's header stays in place while its content scrolls. */
const panelOpen = shown => /AZPR [a-f0-9]{8} · [A-Z_]+ +close/.test(shown);
const wide = character => /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(character);
const columns = text => [...text].reduce((sum, character) => sum + (wide(character) ? 2 : 1), 0);
/** A left click in the middle of the first place the screen shows `text`. */
async function click(text) {
  const lines = (await see(shown => shown.includes(text) && shown, `"${text}" is not on the screen to click.`)).split('\n');
  const row = lines.findIndex(line => line.includes(text));
  const column = columns(lines[row].slice(0, lines[row].indexOf(text))) + Math.max(1, Math.floor(columns(text) / 2));
  for (const action of ['M', 'm']) tmux('send-keys', '-t', 'azpr', '-l', `\x1b[<0;${column};${row + 1}${action}`);
}
/**
 * Type a slash command the way a person does: wait for its suggestion, then send it. AZPR's server commands take
 * arguments, so Enter right after the name only completes it: they are typed with the space that follows the name.
 * The panel's own commands take none and run at once.
 */
async function command(name, suggestion, text) {
  key('C-u');
  type(`/${name}`);
  await see(shown => shown.includes(suggestion), `The TUI did not suggest /${name}.`);
  key('C-u');
  type(text === undefined ? `/${name}` : `/${name} ${text}`.trimEnd() + ' ');
  await sleep(400);
  key('Enter');
}
/** What the TUI suggests for the start of a command, once `expected` is among it. */
async function suggested(prefix, expected) {
  key('C-u');
  type(prefix);
  const shown = await see(now => now.includes(expected) && now, `The TUI did not suggest "${expected}" for ${prefix}.`);
  key('C-u');
  return shown;
}

const result = { status: 'PASS', installation: published ? `native ${published}` : native ? 'native' : 'source' };
let diagnose = async () => {};
try {
  /** Start the host; resolves with its URL. What it prints is searched from where this start began. */
  const serve = () => {
    const from = logs.length;
    const started = child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.race([new Promise((ready, reject) => { started.once('error', reject); started.once('exit', code => reject(new Error('Host exited ' + code))); started.stdout.on('data', data => { logs += data; const match = logs.slice(from).match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) ready(match[1]); }); started.stderr.on('data', data => { logs += data; }); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 30000).unref())]);
  };
  const stopServer = async () => {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer);
  };
  let url = await serve();
  const api = async (path, body) => { const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': dirs.work }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) }); const raw = await response.text(); if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`); return raw ? JSON.parse(raw) : undefined; };
  const origin = (await api('/api/session', { title: 'Panel fixture', location: { directory: dirs.work } })).data.id;
  const queued = async () => (await api(`/api/session/${origin}/inbox`)).data;
  const inbox = async () => (await queued()).map(item => item.payload?.text ?? '');
  // On a failure: what the server holds for each of AZPR's sessions, next to the screen.
  diagnose = async () => {
    const sessions = (await api('/api/session')).data.filter(session => session.metadata?.azpr || session.id === origin);
    const state = [];
    for (const session of sessions) {
      const queued = (await api(`/api/session/${session.id}/inbox`).catch(error => ({ data: [{ payload: { text: String(error) } }] }))).data;
      state.push({ id: session.id, title: session.title, azpr: session.metadata?.azpr, inbox: queued.map(item => ({ id: item.id, type: item.type, head: String(item.payload?.text ?? '').slice(0, 70) })) });
    }
    await writeFile(join(fixture, 'sessions.json'), JSON.stringify(state, null, 2));
  };
  // The server lists the plugin with a terminal part, which the TUI then loads by itself.
  const listed = async () => (await api('/api/plugin')).data.find(plugin => plugin.id === 'azpr');
  const loaded = async () => { for (let attempt = 0; attempt < 100 && !(await listed()); attempt++) await sleep(200); return listed(); };
  assert.deepEqual((await loaded())?.features, { server: true, tui: true });
  assert.equal((await listed()).source.type, native ? 'package' : 'local');
  // Loading AZPR completed the settings file: the newer settings are there at their defaults, the rest is as it was,
  // and the file is the owner's alone. The review below then starts, so the runtime read the completed file.
  const completed = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual(newer.map(name => completed[name]), ['auto', true, true]);
  assert.equal(completed.workflow.stageIdleSeconds, 600);
  assert.deepEqual({ ...completed, workflow: { ...completed.workflow, stageIdleSeconds: undefined }, ...Object.fromEntries(newer.map(name => [name, undefined])) },
    { ...older, workflow: { ...older.workflow, stageIdleSeconds: undefined }, ...Object.fromEntries(newer.map(name => [name, undefined])) });
  assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dirname(settingsFile))).filter(name => /\.tmp$|\.lock$/.test(name)), []);
  result.settings = 'settings an earlier version did not have were written into the file when AZPR loaded';

  /** The TUI in a terminal of this size, showing the fixture's conversation or another session. */
  const openTerminal = async (width, height, session = origin) => {
    const started = tmux('new-session', '-d', '-s', 'azpr', '-x', String(width), '-y', String(height), '-c', dirs.work, binary, '--server', url, '--session', session);
    assert.equal(started.status, 0, `tmux could not start the TUI: ${started.stderr || started.error?.message || 'no message'}`);
    await see(/ctrl\+p\s+commands/, 'The TUI did not start.');
  };
  await openTerminal(170, 46);

  // 1. A review that starts opens the panel by itself, with its sessions running, and the prompt keeps the keyboard.
  await command('pr-review', 'Verified Azure DevOps PR review', 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321');
  const review = (await see(/AZPR ([a-f0-9]{8}) · RUNNING/, 'A review that starts did not open the panel.'))[1];
  await see(shown => /Sessions \(click one to open it\)/.test(shown) && (shown.match(/● Initial [FR] shard [12]\/2 running ses_/g) ?? []).length === 4, 'The panel does not list the four reviewer sessions as running.');
  type('typed-while-the-panel-opened');
  await see(/┃\s+typed-while-the-panel-opened/, 'The keyboard left the prompt when the panel opened by itself.');
  key('C-u');
  result.opensByItself = 'on STARTED, four sessions running, the prompt keeps the keyboard';

  // 2. A click on a row opens that session in a tab; back in the conversation the panel is there again.
  await click('Initial R shard 1/2');
  await see(new RegExp(`^.*Panel fixture.*\\[AZPR ${review}\\] Initial R sh`, 'm'), 'A click on a session row did not open that session.');
  await see(shown => !panelOpen(shown), 'The panel followed into the reviewer session.');
  await click('Panel fixture');
  await see(panelOpen, 'Back in the conversation the panel did not return.');
  result.rows = 'a click opens the session in a tab; the panel returns with the conversation';

  // 3. The report arrives: rendered, read from the session that holds it; the run's other sessions were deleted.
  release();
  await see(new RegExp(`AZPR ${review} · COMPLETE`), 'The panel does not show the review as COMPLETE.', 120000);
  // The conversation shows the table as Markdown source (| Severity | Summary |); the panel draws it as a grid.
  await see(/│ Severity\s+│ Summary/, 'The report\'s table is not rendered in the panel.');
  // The cells show the characters the runtime escaped for Azure DevOps as themselves, backticks included.
  await see(/R-1 — `invoice` drops the guard/, 'The summary cell does not show its text literally.');
  await see(/○ Verification \(report\) complete ses_/, 'The session that holds the report is not listed.');
  await see(/4 session\(s\) were deleted when their run ended\./, 'The panel does not say that the reviewer sessions were deleted.');
  const receipt = (await inbox()).findLast(text => text.startsWith(`[AZPR ${review}] COMPLETE`));
  assert.doesNotMatch(receipt, /<azpr_report_data>/, 'With returnReport: receipt the report is only in its session; the panel read it there.');
  result.report = 'rendered from the report session\'s inbox; deleted sessions counted';

  // 4. A comment preview: its run opens the panel as well, and the preview replaces the report.
  await click('close');
  await see(shown => !panelOpen(shown), 'The panel did not close.');
  await command('pr-comment', 'Preview, adjust or publish review comments', '');
  const preview = (await see(/AZPR ([a-f0-9]{8}) · PREVIEW/, 'The preview did not open the panel.', 120000))[1];
  await see(new RegExp(`\\[AZPR ${preview}\\] PREVIEW; source review=${review}`), 'The panel does not name the preview it shows.');
  await see(/Inline comments prepared: 4/, 'The preview is not shown.');
  assert.equal(azure.state.threads.length, 0, 'A preview posts nothing.');
  result.preview = 'opens the panel and replaces the report';

  // 5. Keyboard: the panel scrolls and closes with Escape once it has the keyboard.
  // A click inside the panel gives it the keyboard. Its header stays while the content scrolls.
  await click('Sessions (click one to open it)');
  key('PageDown');
  await see(shown => panelOpen(shown) && !/Sessions \(click one to open it\)/.test(shown), 'PageDown did not scroll the panel.');
  key('Home');
  await see(/Sessions \(click one to open it\)/, 'Home did not scroll the panel back to its top.');
  await escape();
  await see(shown => !panelOpen(shown), 'Escape did not close the panel that had the keyboard.');
  result.keyboard = 'PageDown, Home and Escape in the panel';

  // 6. /pr-panel shows and hides it. It is the panel's only command: sessions are opened from its rows or with
  // OpenCode's own session list, and whether it opens by itself is the setting terminalPanel.
  await command('pr-panel', 'The sessions of the review in this conversation');
  await see(panelOpen, '/pr-panel did not show the panel.');
  // The prompt keeps the keyboard, so the same command hides it again; q closes a panel that was given the keyboard.
  await command('pr-panel', 'The sessions of the review in this conversation');
  await see(shown => !panelOpen(shown), '/pr-panel did not hide the panel.');
  await command('pr-panel', 'The sessions of the review in this conversation');
  await click('Sessions (click one to open it)');
  key('q');
  await see(shown => !panelOpen(shown), 'q did not close the panel that had the keyboard.');
  assert.doesNotMatch(await suggested('/pr-p', 'The sessions of the review in this conversation'), /pr-panel-auto/, 'The panel has one command.');
  assert.doesNotMatch(await suggested('/pr-s', 'pr-stop'), /pr-sessions/, 'The panel has one command.');
  // --show answers at once with the saved preview, and with the default setting that opens the panel again.
  await command('pr-comment', 'Preview, adjust or publish review comments', '--show');
  await see(panelOpen, 'With terminalPanel: auto a preview shown again did not open the panel.');
  // A saved preview shown again is about its review: the review's status, with the preview as the document.
  await see(new RegExp(`AZPR ${review} · COMPLETE`), 'The saved preview is not shown under its review.');
  await see(new RegExp(`\\[AZPR\\] Saved preview of review ${review}`), 'The saved preview is not named.');
  assert.ok((await queued()).every(item => item.payload?.metadata === undefined), 'With the default setting AZPR\'s notices carry no metadata.');
  await click('close');
  await see(shown => !panelOpen(shown), 'The panel did not close.');
  result.commands = '/pr-panel shows and hides and is the only command of the panel';

  // 7. A terminal too narrow for two panes: the panel does not take the screen unasked.
  assert.equal(tmux('resize-window', '-t', 'azpr', '-x', '100', '-y', '40').status, 0);
  await sleep(1000);
  await command('pr-comment', 'Preview, adjust or publish review comments', '--show');
  await see(/AZPR: report or preview ready\. \/pr-panel shows it\./, 'In a narrow terminal the panel did not announce itself instead of opening.');
  assert.match(screen(), /ctrl\+p\s+commands/, 'The conversation is still on the screen.');
  await command('pr-panel', 'The sessions of the review in this conversation');
  await see(shown => panelOpen(shown) && !/ctrl\+p\s+commands/.test(shown), 'Asked for, the panel did not take the narrow screen.');
  await escape();
  await see(/ctrl\+p\s+commands/, 'Escape did not give the narrow screen back.');
  result.narrow = 'announces itself instead of taking the screen; opens when asked';

  // 8. terminalPanel: manual. Settings are read when AZPR loads, so the host is restarted with the changed file; the
  // conversation, its notices and the saved review are still there.
  tmux('kill-server');
  await stopServer();
  await writeFile(settingsFile, JSON.stringify({ ...completed, terminalPanel: 'manual' }, null, 2) + '\n', { mode: 0o600 });
  url = await serve();
  assert.deepEqual((await loaded())?.features, { server: true, tui: true });
  await openTerminal(170, 46);
  const before = (await queued()).length;
  // A comment run that starts and the preview it returns, then the saved preview shown again: none opens the panel.
  await command('pr-comment', 'Preview, adjust or publish review comments', '');
  for (let attempt = 0; attempt < 600 && !(await inbox()).slice(before).some(text => /^\[AZPR [a-f0-9]{8}\] PREVIEW/.test(text)); attempt++) await sleep(200);
  await command('pr-comment', 'Preview, adjust or publish review comments', '--show');
  for (let attempt = 0; attempt < 150 && !(await inbox()).at(-1)?.startsWith('[AZPR] Saved preview of review'); attempt++) await sleep(200);
  const marked = (await queued()).slice(before);
  assert.deepEqual(marked.map(item => /^\[AZPR(?: [a-f0-9]{8})?\] ?(Saved preview|[A-Z_]+)/.exec(item.payload.text)?.[1]).filter(kind => kind !== 'PROGRESS'), ['STARTED', 'PREVIEW', 'Saved preview']);
  assert.ok(marked.every(item => item.payload.metadata?.azpr?.panel === 'manual'), 'With terminalPanel: manual every notice says so, where the panel reads it.');
  await sleep(1500);
  assert.ok(!panelOpen(screen()), 'With terminalPanel: manual a run that starts and a preview that arrives leave the panel closed.');
  assert.doesNotMatch(screen(), /AZPR: report or preview ready/, 'Nor does it announce itself.');
  assert.equal(azure.state.threads.length, 0, 'A preview posts nothing.');
  // Asked for, it opens as always, with the newest preview.
  await command('pr-panel', 'The sessions of the review in this conversation');
  await see(panelOpen, 'With terminalPanel: manual /pr-panel did not show the panel.');
  await see(new RegExp(`\\[AZPR\\] Saved preview of review ${review}`), 'The panel opened by hand does not show the saved preview.');
  result.manual = 'terminalPanel: manual reaches the panel with the notices; it opens only with /pr-panel';

  // 9. A TUI that starts in the session holding the report, with the conversation neither on screen nor in a tab:
  // the host has the notices of no session but the one on screen, so the panel reads the conversation's from the
  // server, here after they were delivered. A command typed in that session is answered there, and the panel
  // shows it.
  const kept = (await api('/api/session')).data.filter(session => session.metadata?.azpr?.conversation === origin);
  assert.deepEqual(kept.map(session => session.metadata.azpr.role), ['azpr-review-verifier'], 'The review keeps the session that holds its report.');
  tmux('kill-server');
  // A person talks to the conversation's own model: every notice that waited in its inbox is delivered, so the
  // inbox is empty and what AZPR told the conversation is among its messages. (The host gives each queued notice
  // a turn of that model; only this prompt of the fixture's makes the conversation's model run at all.)
  const asked = requests.length;
  assert.ok(requests.every(request => request.model !== 'chat'), 'Until here the conversation\'s own model was never asked.');
  await api(`/api/session/${origin}/prompt`, { text: 'Thanks. Anything else?' });
  await api(`/api/experimental/session/${origin}/wait`, {});
  const turns = requests.slice(asked);
  assert.ok(turns.length >= 1 && turns.every(request => request.model === 'chat' && request.sessionID === origin), 'Only the conversation\'s own model ran, in the conversation.');
  assert.deepEqual(await inbox(), [], 'The notices were delivered: none waits in the conversation\'s inbox.');
  const told = (await api(`/api/session/${origin}/context`)).data.filter(message => message.type === 'synthetic').length;
  assert.ok(told >= 10, 'They are among the conversation\'s messages.');
  await openTerminal(170, 46, kept[0].id);
  await command('pr-panel', 'The sessions of the review in this conversation');
  // The last thing the conversation was told is the saved preview shown again in step 8, which is about the review.
  await see(new RegExp(`AZPR ${review} · COMPLETE`), 'In the report session the panel does not show what the conversation was told last.');
  await see(new RegExp(`\\[AZPR\\] Saved preview of review ${review}`), 'It does not show the document read from the conversation\'s notices.');
  await see(/○ Verification \(report\) complete ses_/, 'The session on screen is not listed as the one holding the report.');
  const own = async () => (await api(`/api/session/${kept[0].id}/inbox`)).data.map(item => item.payload?.text ?? '');
  // A comment run typed here: its notices arrive in this session, and the panel follows them.
  await command('pr-comment', 'Preview, adjust or publish review comments', '');
  const typedHere = (await see(/AZPR ([a-f0-9]{8}) · PREVIEW/, 'The panel does not show the comment run typed in the review\'s own session.', 120000))[1];
  await see(new RegExp(`\\[AZPR ${typedHere}\\] PREVIEW; source review=${review}`), 'The panel does not name the preview planned from this session.');
  assert.ok((await own()).some(text => text.startsWith(`[AZPR ${typedHere}] PREVIEW; source review=${review}`)), 'The runtime answered in the session the command was typed in.');
  assert.deepEqual(await inbox(), [], 'Nothing more was told to the conversation.');
  assert.equal((await api(`/api/session/${origin}/context`)).data.filter(message => message.type === 'synthetic').length, told);
  assert.equal(azure.state.threads.length, 0, 'A preview posts nothing.');
  result.ownSession = 'started in the report session: the conversation\'s run is read from the server; a command typed there is shown';

  // What the panel must never do: ask a model, or fail to load.
  const conversationTurns = requests.filter(request => request.model === 'chat');
  assert.deepEqual([...new Set(requests.map(request => request.model))].sort(), ['chat', 'functional', 'risk', 'verifier']);
  assert.deepEqual(conversationTurns, turns, 'Only AZPR\'s reviewers, verifier and planner asked a model, and the fixture\'s own prompt the conversation\'s: the panel asked none.');
  const hostLog = await readFile(join(dirs.data, 'opencode', 'log', 'opencode.log'), 'utf8').catch(() => '');
  assert.doesNotMatch(hostLog, /plugin operation failed/, 'The TUI loaded the plugin\'s terminal part without an error.');
  if (native) {
    const cached = await readdir(dirs.cache, { recursive: true });
    assert.ok(cached.some(path => path.endsWith(join('node_modules', 'opencode-azure-devops-pr-review', 'src', 'tui.js'))), 'The TUI loaded the compiled view from the installed package.');
    assert.ok(!cached.some(path => /(^|\/)(@babel|babel-preset-solid)(\/|$)/.test(path)), 'The compiler is a development dependency: installing the package brings none of it.');
    result.package = 'compiled view loaded from the package cache; no compiler installed';
  }
  Object.assign(result, { reviewRun: review, previewRun: preview, providerRequests: requests.length - conversationTurns.length, conversationTurns: conversationTurns.length, azureCalls: azure.state.calls.length });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await diagnose().catch(() => {});
  throw error;
} finally {
  await writeFile(join(fixture, 'screen.txt'), screen()).catch(() => {});
  tmux('kill-server');
  await rm(socketDirectory, { recursive: true, force: true }).catch(() => {});
  release();
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  adoServer.closeAllConnections(); await new Promise(done => adoServer.close(done));
  await writeFile(join(fixture, 'host.log'), logs); await writeFile(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
  console.error('Private TUI panel evidence: ' + fixture);
}
