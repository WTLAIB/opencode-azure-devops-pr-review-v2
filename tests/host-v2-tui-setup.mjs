import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for setup in the terminal UI. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-tui-setup.mjs /absolute/path/opencode [--native [--package SPEC]]
 * The real TUI runs in a detached tmux session (tmux is required): the fixture reads its screen and
 * drives its keyboard. AZPR starts without usable settings. Checked on the screen and on disk: the TUI
 * says once how to set AZPR up; /pr-setup opens the dialogs; the organization is taken from a PR URL;
 * the proxy question can be skipped; the token is pasted into a field that never shows it, a refused
 * one is asked again with the reason, and an unreachable Azure DevOps offers the proxy before the same
 * token is checked again; the model is picked from the host's list; the token file and the settings
 * file are written owner-only; and /pr-check then answers READY without a restart. /pr-setup then
 * lists the settings: one is changed, which waits for a restart and says so, and after the restart
 * it is in use. The token is searched for in everything the fixture's OpenCode wrote.
 * With --native the package is installed by OpenCode's plugin manager and starts without any settings
 * file; from source the installer leaves a settings file with placeholders. --package SPEC installs a
 * published package (an npm version or a public Git commit) instead of the one packed from this checkout.
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
const fixture = await mkdtemp(join(root, '.local/host-v2-setup-'));
const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'tmp', 'home', 'work'].map(name => [name, join(fixture, name)]));
await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
const WRONG_TOKEN = 'wrong-token-that-azure-devops-refuses-0123456789';
const requests = [];
let child, logs = '';
// Setup asks no model: whatever reaches the provider is recorded and answered like an ordinary conversation.
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  let model; try { model = JSON.parse(body).model; } catch { model = 'unreadable'; }
  requests.push({ model, sessionID: request.headers['x-opencode-session-id'] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
  emit({ id: 'setup', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'The conversation\'s own model was asked.' }, finish_reason: null }] });
  emit({ id: 'setup', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  response.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const files = ['/src/orders/reserve.ts'];
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 321, files, sources: Object.fromEntries(files.map(path => [path, 'fixture code\nsecond line\n'])) });
// While this is set Azure DevOps cannot be reached: every connection is dropped before anything is answered
// (the runtime's fetch tries a dropped connection again by itself, so one dropped request would go unnoticed).
let unreachable = false;
const adoServer = createServer((request, response) => {
  if (unreachable) { request.socket.destroy(); return; }
  azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); });
});
adoServer.listen(0, '127.0.0.1'); await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;
const prUrl = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321';
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options }); assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}${result.stdout}`); return result.stdout; };
// Two models that can call tools, under a provider with a name: the model dialog lists them under it.
const config = { update: 'disable', snapshots: false, warming: false, model: 'fixture/chat',
  providers: { fixture: { name: 'Fixture AI', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: { chat: { name: 'Chat Small', limit: { context: 64000, output: 4000 } }, reviewer: { name: 'Review Strong', limit: { context: 64000, output: 4000 } } } } } };
await writeFile(join(dirs.config, 'opencode.json'), JSON.stringify(config));
if (native) {
  let spec = published;
  if (!spec) {
    // As published: npm's own packing, installed through OpenCode's plugin manager from an isolated Git commit.
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', fixture], { cwd: root }))[0];
    assert.ok(['src/tui.js', 'src/tui-model.mjs', 'src/tui-setup.mjs'].every(path => packed.files.some(file => file.path === path)), 'The package carries the terminal part.');
    run('tar', ['-xzf', join(fixture, packed.filename), '-C', fixture]);
    const packageDirectory = join(fixture, 'package');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=AZPR fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Native package fixture']]) run('git', args, { cwd: packageDirectory });
    spec = `git+file://${packageDirectory}#${run('git', ['rev-parse', 'HEAD'], { cwd: packageDirectory }).trim()}`;
  }
  assert.match(run(binary, ['plugin', 'add', spec], { cwd: dirs.work, env }), /installed and added/);
} else {
  // The installer leaves a settings file of placeholders beside the plugin: AZPR cannot use it yet.
  run('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config]);
}
// Where setup writes: the package keeps its settings in the user's configuration, a source installation beside itself.
const settingsFile = native ? join(fixture, 'xdg-config', 'azpr', 'settings.json') : join(dirs.config, 'plugins', 'azpr-v2', 'settings.json');
// The token file is named for its organization: the default PAT file is the same for every settings file a person has.
const tokenFile = join(fixture, 'xdg-config', 'azpr', 'pat-fixture');

// ------------------------------------------------------------------ the terminal
// A Unix socket's path is limited to about a hundred bytes, which a checkout in a long directory exceeds
// (as on a CI runner), and a long TMPDIR too.
const socketRoot = [tmpdir(), '/tmp'].find(directory => Buffer.byteLength(join(directory, 'azpr-tui-XXXXXX', 's')) < 100);
assert.ok(socketRoot, 'No temporary directory with a path short enough for tmux\'s socket.');
const socketDirectory = await mkdtemp(join(socketRoot, 'azpr-tui-'));
const socket = join(socketDirectory, 's'), tmuxConfig = join(fixture, 'tmux.conf');
await writeFile(tmuxConfig, ['set -g default-terminal "tmux-256color"', 'set -as terminal-features ",*:RGB"', 'set -g escape-time 0', 'set -g mouse off', 'set -g status off', 'set -g history-limit 0'].join('\n') + '\n');
const tmux = (...args) => spawnSync('tmux', ['-S', socket, '-f', tmuxConfig, ...args], { encoding: 'utf8', env, timeout: 15000 });
// Every screen the fixture looked at, to search for the token afterwards.
const screens = [];
const screen = () => { const shown = tmux('capture-pane', '-p', '-t', 'azpr').stdout ?? ''; screens.push(shown); return shown; };
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
/**
 * A sentence as a dialog or a toast shows it: it may be broken after any word, and the rest of the row and the
 * start of the next one then belong to whatever is beside the dialog.
 */
const wrapped = text => new RegExp(text.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?: |[^\\n]*\\n[^\\n]{0,140}?)'));
const type = text => tmux('send-keys', '-t', 'azpr', '-l', '--', text);
const key = name => tmux('send-keys', '-t', 'azpr', name);
/** Paste as a terminal does, in one piece: what a person does with a token. */
const paste = text => { tmux('set-buffer', '--', text); tmux('paste-buffer', '-p', '-t', 'azpr'); };
const escape = async () => { key('Escape'); await sleep(500); };
/** Type a server command the way a person does: wait for its suggestion, then send it with the space after its name. */
async function command(name, suggestion, text = '') {
  key('C-u');
  type(`/${name}`);
  await see(shown => shown.includes(suggestion), `The TUI did not suggest /${name}.`);
  key('C-u');
  type(`/${name} ${text}`.trimEnd() + ' ');
  await sleep(400);
  key('Enter');
}

const result = { status: 'PASS', installation: published ? `native ${published}` : native ? 'native' : 'source' };
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
  const origin = (await api('/api/session', { title: 'Setup fixture', location: { directory: dirs.work } })).data.id;
  const listed = async () => (await api('/api/plugin')).data.find(plugin => plugin.id === 'azpr');
  const loaded = async () => { for (let attempt = 0; attempt < 100 && !(await listed()); attempt++) await sleep(200); return listed(); };
  assert.deepEqual((await loaded())?.features, { server: true, tui: true });
  const commands = async () => (await api('/api/command')).data.filter(item => item.name.startsWith('pr-')).map(item => `${item.name}: ${item.description}`);
  for (let attempt = 0; attempt < 50 && (await commands()).length < 7; attempt++) await sleep(200);
  // Without usable settings every review command only says that AZPR is not ready here, and where to find out why.
  assert.deepEqual((await commands()).filter(line => !line.startsWith('pr-setup')).map(line => line.split(': ')[1]), Array(6).fill('AZPR is not ready here; run /pr-setup to see what it needs'));
  const status = async () => (await api(`/api/rpc/azpr.setup/status?location=${encodeURIComponent(JSON.stringify({ directory: dirs.work }))}`, { input: {} }).catch(() => api('/api/rpc/azpr.setup/status', { input: {} }))).output;
  const first = await status();
  assert.deepEqual([first.state, first.editable, first.settingsFile], ['required', true, settingsFile]);
  assert.match(first.problem, native ? /^there is no settings file yet\.$/ : /^models\.review\.functional: select an actual provider\/model ID/);

  /** The TUI in a terminal of this size, showing the fixture's conversation. */
  const openTerminal = async (width, height) => {
    const started = tmux('new-session', '-d', '-s', 'azpr', '-x', String(width), '-y', String(height), '-c', dirs.work, binary, '--server', url, '--session', origin);
    assert.equal(started.status, 0, `tmux could not start the TUI: ${started.stderr || started.error?.message || 'no message'}`);
    await see(/ctrl\+p\s+commands/, 'The TUI did not start.');
  };
  await openTerminal(150, 44);

  // 1. The TUI says once how to set AZPR up, and /pr-setup opens the first dialog.
  await see(wrapped('AZPR is not set up yet. Type /pr-setup'), 'The TUI did not say that AZPR needs setup.', 30000);
  await command('pr-setup', 'Set up AZPR: organization, token, model');
  await see(/Azure DevOps organization/, '/pr-setup did not open the organization dialog.');
  result.hint = 'the TUI said that AZPR is not set up; /pr-setup opened the dialogs';

  // 2. The organization from a PR URL; the proxy question, which a direct connection skips.
  type('not an organization!');
  key('Enter');
  await see(wrapped('Use your Azure DevOps organization name'), 'An answer that names no organization was not refused in the dialog.');
  key('C-u');
  type(prUrl);
  key('Enter');
  await see(/Proxy for Azure DevOps \(optional\)/, 'The proxy was not asked for after the organization.');
  await see(wrapped('Leave it empty and press Enter to skip'), 'The proxy dialog does not say that it can be skipped.');
  key('Enter');

  // 3. The token: never on the screen; a refused one is asked again with the reason.
  await see(/Personal access token/, 'The token was not asked for after the proxy.');
  await see(shown => /dev\.azure\.com\/fixture\//.test(shown) && /_usersSettings\/tokens/.test(shown), 'The token dialog does not say where to create one for this organization.');
  await see(/Paste the token here; it is not shown/, 'The token field is not the one that hides what is typed.');
  paste(WRONG_TOKEN);
  await see(new RegExp(`•{16} +\\(${WRONG_TOKEN.length} characters, hidden\\)`), 'A pasted token is not shown as bullets and a count.');
  key('Enter');
  await see(wrapped('Azure DevOps did not accept this token for the organization "fixture"'), 'A token Azure DevOps refuses was not reported in the token dialog.');
  await see(/Paste the token here; it is not shown/, 'The token is not asked for again after it was refused.');

  // 4. Azure DevOps cannot be reached: the reason, then the proxy once more, then the same token again.
  unreachable = true;
  paste(FAKE_PAT);
  await see(new RegExp(`\\(${FAKE_PAT.length} characters, hidden\\)`), 'The second token was not taken.');
  key('Enter');
  await see(/The token could not be checked/, 'A check that could not reach Azure DevOps was not reported.');
  await see(wrapped('Azure DevOps could not be reached'), 'The reason is not shown.');
  unreachable = false;
  key('Enter');
  await see(/What now\?/, 'No choice was offered after the failed check.');
  await see(/Set a proxy and try again/, 'Setting a proxy is not offered after Azure DevOps could not be reached.');
  key('Enter');
  await see(/Proxy for Azure DevOps \(optional\)/, 'The proxy dialog did not open from the failed check.');
  key('Enter');

  // 5. The model from the host's list, the summary, and the end.
  await see(/Model for \/pr-review/, 'The model was not asked for after the token was accepted.');
  await see(/Fixture AI/, 'The models are not listed under their provider.');
  type('strong');
  await see(shown => /Review Strong +fixture\/reviewer/.test(shown) && !/Chat Small +fixture\/chat/.test(shown), 'Typing does not filter the model list.');
  key('Enter');
  // The host gives this model variants: the model's own default is the first choice.
  await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
  await see(/● Default/, 'The model\'s own default is not the preselected variant.');
  key('Enter');
  await see(/Save AZPR's settings\?/, 'No summary was shown before saving.');
  await see(/Organization: fixture[\s\S]*Proxy: none[\s\S]*Token: the one just entered[\s\S]*Model: fixture\/reviewer/, 'The summary does not show what will be saved.');
  key('Enter');
  await see(/AZPR is set up/, 'The setup did not end with its result.');
  await see(/\/pr-check <PR URL>/, 'The result does not say what to do next: the settings were not loaded.');
  key('Enter');
  result.dialogs = 'organization from a PR URL; proxy skipped; token hidden, refused once, then checked again after an unreachable Azure DevOps; model picked by typing';

  // 6. On disk: the token alone in an owner-only file, complete owner-only settings that name it.
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual([saved.azure.organization, saved.azure.pat, saved.azure.patFile, saved.azure.proxy, saved.models.review, saved.models.quick],
    ['fixture', '', tokenFile, '', { functional: 'fixture/reviewer', risk: 'fixture/reviewer', verifier: 'fixture/reviewer', rater: '' }, { reviewer: 'fixture/reviewer' }]);
  assert.equal(await readFile(tokenFile, 'utf8'), FAKE_PAT);
  assert.deepEqual([(await stat(tokenFile)).mode & 0o777, (await stat(settingsFile)).mode & 0o777, (await stat(dirname(tokenFile))).mode & 0o777], [0o600, 0o600, 0o700]);
  assert.deepEqual((await readdir(dirname(tokenFile))).filter(name => /\.tmp$|\.lock$/.test(name)), []);
  // Azure DevOps was asked whether a token works twice: the refused one and the accepted one. The dropped requests never arrived.
  assert.deepEqual(azure.state.calls.map(call => call.route), ['access', 'access']);
  result.files = 'token file and settings file owner-only; two access checks';

  // 7. No restart: the review commands are the real ones now, and /pr-check reads the PR with the saved token.
  assert.equal((await status()).state, 'ready');
  assert.ok((await commands()).every(line => !line.includes('not ready here')), 'The commands that only said that AZPR is not ready are gone.');
  await command('pr-check', 'Azure DevOps PR access check', prUrl);
  await see(/AZPR [a-f0-9]{8} · READY/, 'After a first setup /pr-check did not answer READY without a restart.', 90000);
  assert.ok(azure.callsTo('pr').length >= 1, 'The check read the pull request with the saved token.');
  result.loaded = '/pr-check READY without a restart';

  // 8. /pr-setup again: the settings as a list, over the panel that shows the check. One is changed; it waits for
  // a restart and says so.
  await command('pr-setup', 'Set up AZPR: organization, token, model');
  await see(/AZPR settings/, '/pr-setup did not list the settings once AZPR was set up.');
  await see(/Organization +fixture/, 'The list does not show the organization.');
  await see(/Access token +saved\b/, 'The list does not show that a token is saved.');
  await see(/Review model for \/pr-review +fixture\/reviewer/, 'The list does not show the review model and what it is for.');
  await see(/Deep model for \/pr-deep +off/, 'The list does not show the deep model and what it is for.');
  // The deep model's dialog says what makes a model one, where there is room for it: a stronger model, or a higher
  // variant of the same one. Leaving the dialog saves nothing.
  type('deep');
  await see(shown => /Deep model for \/pr-deep +off/.test(shown) && !/Organization +fixture/.test(shown), 'Typing does not filter the settings.');
  key('Enter');
  await see(/Model for \/pr-deep/, 'The deep model dialog did not open.');
  await see(/Stronger than the review model, or a higher variant/, 'The dialog does not say what makes a deep model one.');
  await see(/\/pr-deep stays off/, 'Switching /pr-deep off is not offered first.');
  type('strong');
  await see(shown => /Review Strong +fixture\/reviewer/.test(shown) && !/Stronger than the review model/.test(shown), 'Typing does not filter the models.');
  key('Enter');
  await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
  await see(/A higher variant reasons longer/, 'The variant dialog does not say what a higher variant does.');
  await escape();
  await see(/Deep model for \/pr-deep +off/, 'Leaving the variant dialog did not return to the list unchanged.');
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')).models.deep, { functional: '', risk: '', verifier: '', rater: '' });
  type('language');
  await see(shown => /Output language +en/.test(shown) && !/Organization +fixture/.test(shown), 'Typing does not filter the settings.');
  key('Enter');
  await see(/Language of reports and comments/, 'The language dialog did not open.');
  type('繁體');
  await see(shown => /繁體中文/.test(shown) && !/Deutsch/.test(shown), 'Typing does not filter the languages.');
  key('Enter');
  await see(wrapped('Saved. It takes effect after the OpenCode service restarts'), 'A change to settings that are in use does not name the restart.');
  await see(/AZPR settings · restart needed/, 'The list does not say that a restart is needed.');
  await see(/Output language +zh-TW/, 'The list does not show the new value.');
  // The settings file: where it is, and which section of the README describes every setting.
  type('Settings file');
  await sleep(400);
  key('Enter');
  await see(wrapped('Each one is described in the README\'s section "All settings and defaults"'), 'The settings file dialog does not name the README\'s section.');
  // The address is longer than the dialog is wide, so it is wrapped: its start and its end are on the screen.
  await see(shown => /\(https:\/\/github\.com\//.test(shown) && /settings-and-defaults\)\./.test(shown), 'It does not give the section\'s address.');
  key('Enter');
  await see(/AZPR settings · restart needed/, 'The list did not return after the settings file dialog.');
  await escape();
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).outputLanguage, 'zh-TW');
  assert.equal((await status()).state, 'restart');
  result.list = 'settings listed with their values and what the models are for; the deep model\'s dialogs say what makes one; a change saved at once, marked as waiting for a restart; the settings file names the README\'s section';

  // 9. After the restart the change is in use: no hint, and /pr-check is READY again.
  tmux('kill-server');
  await stopServer();
  url = await serve();
  assert.deepEqual((await loaded())?.features, { server: true, tui: true });
  for (let attempt = 0; attempt < 50 && (await status().catch(() => ({}))).state !== 'ready'; attempt++) await sleep(200);
  assert.equal((await status()).state, 'ready');
  await openTerminal(150, 44);
  await sleep(8000);
  assert.ok(!wrapped('AZPR is not set up yet').test(screen()), 'The hint is for an AZPR without usable settings only.');
  await command('pr-check', 'Azure DevOps PR access check', prUrl);
  await see(/AZPR [a-f0-9]{8} · READY/, 'After the restart /pr-check did not answer READY.', 90000);
  result.restart = 'after a restart the changed settings are in use; no hint';

  // What setup must never do: ask a model, fail to load, or leave the token anywhere but in its file.
  assert.deepEqual(requests, [], 'Setup asked no model.');
  const hostLog = await readFile(join(dirs.data, 'opencode', 'log', 'opencode.log'), 'utf8').catch(() => '');
  assert.doesNotMatch(hostLog, /plugin operation failed/, 'The TUI loaded the plugin\'s terminal part without an error.');
  for (const token of [FAKE_PAT, WRONG_TOKEN]) {
    assert.ok(!screens.some(shown => shown.includes(token)), 'A token was on the screen.');
    assert.ok(!logs.includes(token) && !hostLog.includes(token), 'A token is in a log.');
    const told = JSON.stringify([(await api(`/api/session/${origin}/inbox`)).data, (await api(`/api/session/${origin}/context`)).data]);
    assert.ok(!told.includes(token), 'A token is in the conversation.');
  }
  const holders = run('grep', ['-rlF', '--', FAKE_PAT, dirs.config, dirs.data, dirs.cache, dirs.state, dirs.home, join(fixture, 'xdg-config')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(holders, [tokenFile], 'Of everything this OpenCode wrote, only the token file holds the token.');
  assert.equal(spawnSync('grep', ['-rlF', '--', WRONG_TOKEN, dirs.config, dirs.data, dirs.cache, dirs.state, dirs.home, join(fixture, 'xdg-config')], { encoding: 'utf8' }).stdout, '', 'A refused token is kept nowhere.');
  if (native) {
    const cached = await readdir(dirs.cache, { recursive: true });
    assert.ok(cached.some(path => path.endsWith(join('node_modules', 'opencode-azure-devops-pr-review', 'src', 'tui-setup.mjs'))), 'The package brought what setup asks.');
    result.package = 'the terminal part loaded from the package cache';
  }
  Object.assign(result, { providerRequests: requests.length, azureCalls: azure.state.calls.length });
  console.log(JSON.stringify(result, null, 2));
} finally {
  // Never the token: a screen that held one would have failed above, and is not kept either way.
  await writeFile(join(fixture, 'screen.txt'), (screens.at(-1) ?? '').replaceAll(FAKE_PAT, '<token>').replaceAll(WRONG_TOKEN, '<token>')).catch(() => {});
  tmux('kill-server');
  await rm(socketDirectory, { recursive: true, force: true }).catch(() => {});
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref(); await stopped; clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  adoServer.closeAllConnections(); await new Promise(done => adoServer.close(done));
  await writeFile(join(fixture, 'host.log'), logs.replaceAll(FAKE_PAT, '<token>').replaceAll(WRONG_TOKEN, '<token>'));
  console.error('Private TUI setup evidence: ' + fixture);
}
