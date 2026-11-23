import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for setup in the terminal UI. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-tui-setup.mjs /absolute/path/opencode [--migrate] [--native [--package SPEC]]
 * The real TUI runs in a detached tmux session (tmux is required): the fixture reads its screen and
 * drives its keyboard. It has two runs.
 *
 * Without --migrate, a first setup: AZPR starts without usable settings. Checked on the screen and on
 * disk: the TUI says once how to set AZPR up; /pr-setup opens the dialogs; the organization is taken from
 * a PR URL; the proxy question can be skipped; the token is pasted into a field that never shows it, a
 * refused one is asked again with the reason, and an unreachable Azure DevOps offers the proxy before the
 * same token is checked again; one model is picked from the host's list; the token file and the settings
 * file are written owner-only, the settings with that model twice for /pr-review and once for /pr-quick;
 * and /pr-check then answers READY without a restart. /pr-setup then lists the settings. A model row is a
 * list of passes: its editor asks for one model and then for the passes (a pass is added, of the same
 * model or another one, the last one is taken away, between one pass and four), and saves nothing until
 * the passes are accepted; left with Escape, /pr-deep stays off. The review models and the language are
 * changed, which waits for a restart and says so, and after the restart they are in use. The token is
 * searched for in everything the fixture's OpenCode wrote.
 * From source the installer leaves a settings file with placeholders; with --native the package is
 * installed by OpenCode's plugin manager and starts without any settings file.
 *
 * With --migrate, the update of settings of AZPR 0.4.x: the profile starts with a settings file of
 * version 2 that 0.4.x could use (three review roles, a rater, a quick reviewer, workflow.shardFindings,
 * values that are not the defaults, a PAT file). Checked: nothing rewrites that file by itself (from
 * source the installer carries it over byte for byte); AZPR's commands only say that the settings need an
 * update; the TUI says so once; /pr-setup shows what the update changes (in a terminal tall enough
 * for it: the host cuts a dialog that does not fit), then a list whose first row keeps the file;
 * leaving with Escape and taking that row write nothing; confirming writes the file of this version,
 * complete, which AZPR loads at once: /pr-check answers READY without a restart, with the models the
 * update gave each mode and the values that were not the defaults.
 *
 * Neither run makes a model request. --package SPEC installs a published package (an npm version or a
 * public Git commit) instead of the one packed from this checkout.
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
// What the update of 0.4.x settings must write is said by these, which setup uses for it; the run with
// --migrate compares the file with their result, and with the same content written out here.
import { migrateSettings, withMissingSettings, settingsText } from '../src/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), binary = process.argv[2];
const options = process.argv.slice(3), migrate = options[0] === '--migrate', installation = migrate ? options.slice(1) : options;
const native = installation[0] === '--native';
const published = native && installation[1] === '--package' ? installation[2] : undefined;
assert.ok(binary?.startsWith('/'));
assert.equal(installation.length, native ? (published ? 3 : 1) : 0, 'The options are --migrate, then --native, which alone accepts a following --package SPEC.');
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
// Where setup writes: the package keeps its settings in the user's configuration, a source installation beside itself.
const settingsFile = native ? join(fixture, 'xdg-config', 'azpr', 'settings.json') : join(dirs.config, 'plugins', 'azpr-v2', 'settings.json');
// The token file of a first setup is named for its organization: the default PAT file is the same for every settings file a person has.
const tokenFile = join(fixture, 'xdg-config', 'azpr', 'pat-fixture');

// ------------------------------------------------------------------ settings of AZPR 0.4.x (--migrate)
// A settings file as AZPR 0.4.x wrote and used it (version 2): a model per role, the verifier's batch size, and
// the PAT in a file of its own. /pr-review has its three roles and a rater; /pr-deep has only one of its three
// roles, so it was off; /pr-quick has its reviewer and never had a rating. Several values are not the defaults,
// and two settings that have a default are not in the file at all (terminalPanel, workflow.stageIdleSeconds), as
// in a file an earlier 0.4.x left.
const patFile = join(fixture, 'xdg-config', 'azpr', 'pat');
const EARLIER = {
  version: 2,
  models: {
    review: { functional: 'fixture/reviewer', risk: 'fixture/chat', verifier: 'fixture/reviewer', rater: 'fixture/chat' },
    deep: { functional: 'fixture/reviewer', risk: '', verifier: '', rater: '' },
    quick: { reviewer: 'fixture/chat' },
  },
  enabled: true,
  returnReport: 'full',
  debug: { enabled: false, directory: '', keepRuns: 5 },
  outputLanguage: 'zh-TW',
  runTimeoutSeconds: null,
  shell: 'deny',
  progressNotices: false,
  deletePrivateSessions: true,
  afterReview: { quick: 'publish', review: 'none', deep: 'preview' },
  azure: { organization: 'fixture', pat: '', patFile, concurrency: 4, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true },
  workflow: { shardFiles: 12, shardFindings: 15, parallelSessions: 8, repairAttempts: 2, stageRetries: 1 },
};
const earlierText = JSON.stringify(EARLIER, null, 2) + '\n';
// What the update makes of it, written out: the two reviewer roles of /pr-review become its two passes, in their
// order, and the verifier is gone; /pr-deep, which was off, has no pass; the quick reviewer is a list of one; a
// named rater stays, and an empty one stays empty (which now means that the first reviewer model rates);
// workflow.shardFindings is gone. Every other value is where it was. The settings that have a default and were
// not in the file follow the existing ones, at their defaults: setup writes the file complete, so loading it
// adds nothing more.
const UPDATED = {
  version: 3,
  models: {
    review: { reviewers: ['fixture/reviewer', 'fixture/chat'], rater: 'fixture/chat' },
    deep: { reviewers: [], rater: '' },
    quick: { reviewers: ['fixture/chat'], rater: '' },
  },
  enabled: true,
  returnReport: 'full',
  debug: { enabled: false, directory: '', keepRuns: 5 },
  outputLanguage: 'zh-TW',
  runTimeoutSeconds: null,
  shell: 'deny',
  progressNotices: false,
  deletePrivateSessions: true,
  afterReview: { quick: 'publish', review: 'none', deep: 'preview' },
  azure: { organization: 'fixture', pat: '', patFile, concurrency: 4, callTimeoutSeconds: 120, archiveMegabytes: 100, proxy: '', caFile: '', verifyTls: true },
  workflow: { shardFiles: 12, parallelSessions: 8, repairAttempts: 2, stageRetries: 1, stageIdleSeconds: 600 },
  terminalPanel: 'auto',
};
// What a settings file of 0.4.x gets instead of being used, and what the update changes: the words of setup.
const MIGRATION_NEEDED = 'settings.json is from AZPR 0.4.x (settings version 2). This version reviews with a list of reviewer models per mode and has no verifier: run /pr-setup to see what changes and to update the file. Nothing is changed until you confirm.';
const CHANGES = [
  'This version reviews with a list of reviewer models per mode: each entry reviews the changed files on its own, one pass each. There is no verifier any more: the first entry also merges repeated findings and plans the comments, and a rating sets the severities.',
  '/pr-review: functional fixture/reviewer, risk fixture/chat, verifier fixture/reviewer -> 2 passes: fixture/reviewer, fixture/chat. The verifier model is no longer used.',
  '/pr-deep: only some of its three models were set, so it was off and stays off (models.deep.reviewers is empty). Set it afterwards with /pr-setup.',
  '/pr-quick: reviewer fixture/chat -> 1 pass: fixture/chat.',
  'Severity rating of /pr-review: fixture/chat, as before.',
  'Severity rating of /pr-quick: none ran before (no rater was set). From now on the first reviewer model rates the findings from their text alone; "rater": false in the settings file switches that off.',
  'workflow.shardFindings is dropped: it sized the verifier\'s batches.',
  'afterReview is "publish" for /pr-quick: after the update this command posts the comments of the new reviews automatically, as the PAT owner. Reports and comments then say that findings were checked by their reviewer and that no separate verification ran. To read the comments before they are posted, set afterReview to preview for this mode.',
  'Every other setting stays as it is, also one that is not a setting of this version: the settings check then names it.',
];

if (migrate) {
  await mkdir(dirname(patFile), { recursive: true, mode: 0o700 });
  await writeFile(patFile, FAKE_PAT, { mode: 0o600 });
}
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
  // The settings of 0.4.x are where the package keeps its settings: in the user's configuration.
  if (migrate) await writeFile(settingsFile, earlierText, { mode: 0o600 });
} else if (migrate) {
  // The installer carries settings of 0.4.x over as they are, and says that /pr-setup updates them.
  await writeFile(join(fixture, 'settings-0.4.json'), earlierText, { mode: 0o600 });
  const said = run('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config, '--settings', join(fixture, 'settings-0.4.json')]);
  assert.match(said, /^Settings of AZPR 0\.4\.x \(settings version 2\) were kept exactly as they are\. This version does not use them until they are updated: restart OpenCode and run \/pr-setup, which shows what changes and writes the new file after you confirm\.$/m);
  assert.equal(await readFile(settingsFile, 'utf8'), earlierText, 'The installer changed settings of 0.4.x.');
} else {
  // The installer leaves a settings file of placeholders beside the plugin: AZPR cannot use it yet.
  run('/bin/sh', [join(root, 'install.sh'), '--config-dir', dirs.config]);
}

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
 * start of the next one then belong to whatever is beside the dialog. The host also breaks a row inside a word,
 * after a slash or a hyphen (a toast shows "Type /" and then "pr-setup").
 */
const BREAK = '[^\\n]*\\n[^\\n]{0,140}?';
const wrapped = text => new RegExp(text.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[/-](?=.)/g, `$&(?:${BREAK})?`)).join(`(?: |${BREAK})`));
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
// The row of a model dialog that switches a mode off (the check's report behind the dialogs says "stays off" too).
const OFF_ROW = /Off +\/pr-(?:review|quick|deep) stays off/;
/**
 * Pick one row of a list by typing into its search line, as a person does who does not want to count rows. The
 * host's search finds the letters typed anywhere in a row and lists the best match first, which is the row Enter
 * takes: wait until `row` is listed above whatever is left of the `others` (rows the list had), then press Enter.
 */
async function pick(typed, row, others, what) {
  type(typed);
  await see(shown => {
    const lines = shown.split('\n'), at = lines.findIndex(line => row.test(line));
    return at >= 0 && others.every(other => { const below = lines.findIndex(line => other.test(line)); return below < 0 || below > at; });
  }, what);
  key('Enter');
}

const result = { status: 'PASS', run: migrate ? 'update of 0.4.x settings' : 'first setup', installation: published ? `native ${published}` : native ? 'native' : 'source' };
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
  // Without usable settings every review command only says that AZPR is not ready here, and where to find out why:
  // also where the settings are those of 0.4.x, which wait for their update.
  assert.deepEqual((await commands()).filter(line => !line.startsWith('pr-setup')).map(line => line.split(': ')[1]), Array(6).fill('AZPR is not ready here; run /pr-setup to see what it needs'));
  const status = async () => (await api(`/api/rpc/azpr.setup/status?location=${encodeURIComponent(JSON.stringify({ directory: dirs.work }))}`, { input: {} }).catch(() => api('/api/rpc/azpr.setup/status', { input: {} }))).output;
  /** What AZPR told the fixture's conversation: the texts of the notices that wait in its inbox. */
  const told = async () => (await api(`/api/session/${origin}/inbox`)).data.map(item => item.payload?.text ?? '');
  /** A row of the settings as setup's RPC describes it. */
  const rowOf = (answer, id) => answer.rows.find(row => row.id === id);
  /** The report a /pr-check receipt encloses: a check has no session to hold it. */
  const checkReport = async () => {
    const receipt = (await told()).findLast(text => /^\[AZPR [a-f0-9]{8}\] READY\n/.test(text));
    assert.ok(receipt, 'The check has no READY receipt in the conversation.');
    return receipt;
  };

  /** The TUI in a terminal of this size, showing the fixture's conversation. */
  const openTerminal = async (width, height) => {
    const started = tmux('new-session', '-d', '-s', 'azpr', '-x', String(width), '-y', String(height), '-c', dirs.work, binary, '--server', url, '--session', origin);
    assert.equal(started.status, 0, `tmux could not start the TUI: ${started.stderr || started.error?.message || 'no message'}`);
    await see(/ctrl\+p\s+commands/, 'The TUI did not start.');
  };

  if (!migrate) {
    const first = await status();
    assert.deepEqual([first.state, first.editable, first.settingsFile], ['required', true, settingsFile]);
    // From source the installer's placeholders are there: the first of them is the first review pass.
    assert.equal(first.problem, native ? 'there is no settings file yet.'
      : 'models.review.reviewers[0]: select an actual provider/model ID from opencode models, optionally with a variant as provider/model#variant; do not use a display name or placeholder.');
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

    // 5. One model from the host's list, the summary, and the end. A first setup asks for one model and no passes:
    // the summary says what that model becomes.
    await see(/Model for \/pr-review/, 'The model was not asked for after the token was accepted.');
    await see(/Fixture AI/, 'The models are not listed under their provider.');
    assert.doesNotMatch(screen(), OFF_ROW, 'A first setup offers to leave /pr-review without a model.');
    type('strong');
    await see(shown => /Review Strong +fixture\/reviewer/.test(shown) && !/Chat Small +fixture\/chat/.test(shown), 'Typing does not filter the model list.');
    key('Enter');
    // The host gives this model variants: the model's own default is the first choice.
    await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
    await see(/● Default/, 'The model\'s own default is not the preselected variant.');
    key('Enter');
    await see(/Save AZPR's settings\?/, 'No summary was shown before saving.');
    assert.doesNotMatch(screen(), /Model for \/pr-review: \d+ pass/, 'A first setup asked for the passes.');
    await see(new RegExp(`Organization: fixture[\\s\\S]*Proxy: none[\\s\\S]*Token: the one just entered[\\s\\S]*${wrapped('Model: fixture/reviewer (two passes of /pr-review, one of /pr-quick)').source}`), 'The summary does not show what will be saved.');
    key('Enter');
    await see(/AZPR is set up/, 'The setup did not end with its result.');
    await see(/\/pr-check <PR URL>/, 'The result does not say what to do next: the settings were not loaded.');
    key('Enter');
    result.dialogs = 'organization from a PR URL; proxy skipped; token hidden, refused once, then checked again after an unreachable Azure DevOps; one model picked by typing';

    // 6. On disk: the token alone in an owner-only file, complete owner-only settings that name it. The settings
    // are the defaults of this version (from source: the installer's file, which has them) with the answers: the
    // organization, the token file, and the one model as two passes of /pr-review and one of /pr-quick. /pr-deep
    // stays off, and the rater of each mode stays "" (the first reviewer model rates).
    const savedText = await readFile(settingsFile, 'utf8');
    const saved = JSON.parse(savedText);
    const example = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
    const expected = { ...example, models: { review: { reviewers: ['fixture/reviewer', 'fixture/reviewer'], rater: '' }, deep: { reviewers: [], rater: '' }, quick: { reviewers: ['fixture/reviewer'], rater: '' } },
      azure: { ...example.azure, organization: 'fixture', pat: '', patFile: tokenFile, proxy: '' } };
    // The package has no settings example beside it to name a schema; the installer's file names its own.
    if (native) delete expected.$schema;
    assert.deepEqual(saved, expected);
    assert.equal(savedText, JSON.stringify(saved, null, 2) + '\n', 'The settings file is not written as setup writes it.');
    assert.equal(await readFile(tokenFile, 'utf8'), FAKE_PAT);
    assert.deepEqual([(await stat(tokenFile)).mode & 0o777, (await stat(settingsFile)).mode & 0o777, (await stat(dirname(tokenFile))).mode & 0o777], [0o600, 0o600, 0o700]);
    assert.deepEqual((await readdir(dirname(tokenFile))).filter(name => /\.tmp$|\.lock$/.test(name)), []);
    // Azure DevOps was asked whether a token works twice: the refused one and the accepted one. The dropped requests never arrived.
    assert.deepEqual(azure.state.calls.map(call => call.route), ['access', 'access']);
    result.files = 'token file and settings file owner-only; the settings hold the model twice for /pr-review and once for /pr-quick; two access checks';

    // 7. No restart: the review commands are the real ones now, and /pr-check reads the PR with the saved token.
    assert.equal((await status()).state, 'ready');
    assert.ok((await commands()).every(line => !line.includes('not ready here')), 'The commands that only said that AZPR is not ready are gone.');
    await command('pr-check', 'Azure DevOps PR access check', prUrl);
    await see(/AZPR [a-f0-9]{8} · READY/, 'After a first setup /pr-check did not answer READY without a restart.', 90000);
    assert.ok(azure.callsTo('pr').length >= 1, 'The check read the pull request with the saved token.');
    // The check names what each mode runs with: the passes of the list, and the model that rates.
    const firstCheck = await checkReport();
    assert.ok(firstCheck.includes('\n| Review models | ok | 2 passes: fixture/reviewer, fixture/reviewer; severity rating by fixture/reviewer (the first reviewer model). |\n'), firstCheck);
    assert.ok(firstCheck.includes('\n| Quick models | ok | 1 pass: fixture/reviewer; severity rating by fixture/reviewer (the first reviewer model). |\n'), firstCheck);
    assert.ok(firstCheck.includes('\n| Deep models | ok | Not set: /pr-deep stays off until models.deep.reviewers names at least one model (stronger models than models.review.reviewers, or more passes). |\n'), firstCheck);
    result.loaded = '/pr-check READY without a restart';

    // 8. /pr-setup again: the settings as a list, over the panel that shows the check. A model row is a list of
    // passes and shows it in a few words: the model without its provider, and how often it reviews.
    await command('pr-setup', 'Set up AZPR: organization, token, model');
    await see(/AZPR settings/, '/pr-setup did not list the settings once AZPR was set up.');
    await see(/Organization +fixture/, 'The list does not show the organization.');
    await see(/Access token +saved\b/, 'The list does not show that a token is saved.');
    await see(/Review models for \/pr-review +reviewer ×2/, 'The list does not show the review models, what they are for and that the model reviews twice.');
    await see(/Quick models for \/pr-quick +reviewer(?! ×)/, 'The list does not show the quick models, what they are for and their one pass.');
    await see(/Deep models for \/pr-deep +off/, 'The list does not show the deep models and what they are for.');
    const listRows = await status();
    assert.deepEqual(['reviewModel', 'quickModel', 'deepModel'].map(id => { const row = rowOf(listRows, id); return [row.label, row.hint, row.value, row.current, row.entries, row.usual, row.most]; }), [
      ['Review models', 'for /pr-review', 'reviewer ×2', 'fixture/reviewer*2', ['fixture/reviewer', 'fixture/reviewer'], 2, 4],
      ['Quick models', 'for /pr-quick', 'reviewer', 'fixture/reviewer*1', ['fixture/reviewer'], 1, 4],
      ['Deep models', 'for /pr-deep', 'off', '', [], 2, 4]]);

    // The deep models' dialogs say what makes a model one, where there is room for it: a stronger model, or a
    // higher variant of the same one. One model is asked for, then the passes: a model named for /pr-deep reviews
    // twice unless the person says otherwise. Leaving that dialog saves nothing: /pr-deep stays off.
    type('deep');
    await see(shown => /Deep models for \/pr-deep +off/.test(shown) && !/Organization +fixture/.test(shown), 'Typing does not filter the settings.');
    key('Enter');
    await see(/Model for \/pr-deep/, 'The deep model dialog did not open.');
    await see(/Stronger than the review model, or a higher variant/, 'The dialog does not say what makes a deep model one.');
    // /pr-deep is off, so the row that switches it off is the one in use: it comes first, under its own heading.
    await see(/● Off +\/pr-deep stays off/, 'Switching /pr-deep off is not offered first, as what is in use.');
    type('strong');
    await see(shown => /Review Strong +fixture\/reviewer/.test(shown) && !/Stronger than the review model/.test(shown), 'Typing does not filter the models.');
    key('Enter');
    await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
    await see(/A higher variant reasons longer/, 'The variant dialog does not say what a higher variant does.');
    key('Enter');
    await see(/Model for \/pr-deep: 2 passes/, 'After the model the passes of /pr-deep were not asked for.');
    await see(/Use these 2 passes +reviewer, reviewer/, 'The first row does not keep the usual two passes of the chosen model.');
    await escape();
    await see(shown => /Deep models for \/pr-deep +off/.test(shown) && !/Model for \/pr-deep/.test(shown), 'Leaving the passes dialog did not return to the list unchanged.');
    assert.equal(await readFile(settingsFile, 'utf8'), savedText, 'Leaving the dialogs of a model row with Escape changed the settings file.');
    assert.equal((await status()).state, 'ready');

    // The language: a change to settings that are in use is saved at once, waits for a restart and says so.
    key('C-u');
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
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).outputLanguage, 'zh-TW');
    assert.equal((await status()).state, 'restart');

    // The review models, edited as a list. The editor asks for one model, the one in use first, then for the
    // passes: its first row keeps what is listed, and the others add a pass of the same model or of another one,
    // or take the last pass away, between one pass and four. Nothing is saved until the first row is taken.
    const beforeEdit = await readFile(settingsFile, 'utf8');
    key('C-u');
    type('Review models');
    await see(shown => /Review models for \/pr-review +reviewer ×2/.test(shown) && !/Organization +fixture/.test(shown), 'Typing does not filter the settings.');
    key('Enter');
    await see(/Model for \/pr-review/, 'The review model dialog did not open.');
    await see(/● Review Strong +fixture\/reviewer/, 'The model in use is not the preselected one.');
    assert.doesNotMatch(screen(), OFF_ROW, '/pr-review can be left without a model.');
    key('Enter');
    await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
    key('Enter');
    await see(/Model for \/pr-review: 2 passes/, 'After the model the passes of /pr-review were not asked for.');
    // The rows, in their order: keeping what is listed comes first, so it is what Enter alone takes.
    const passRows = [/Use these 2 passes +reviewer, reviewer/, /Add a pass of the same model +reviewer once more/, /Add a pass of another model +Different models find/, /Take the last pass away +Without reviewer/];
    const passScreen = (await see(shown => passRows.every(row => row.test(shown)) && shown, 'The passes dialog does not list its four rows with what each does.')).split('\n');
    const passAt = passRows.map(row => passScreen.findIndex(line => row.test(line)));
    assert.deepEqual(passAt, [...passAt].sort((a, b) => a - b), 'The rows of the passes dialog are not in their order, with keeping what is listed first.');
    // One pass less: a single pass is the least, so nothing more can be taken away.
    await pick('Take', /Take the last pass away/, [/Use these 2 passes/, /Add a pass/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model for \/pr-review: 1 pass\b(?!es)/, 'Taking the last pass away did not leave one pass.');
    await see(/Use this pass +reviewer\b(?!,)/, 'The first row does not keep the one pass that is left.');
    assert.doesNotMatch(screen(), /Take the last pass away/, 'The only pass can be taken away.');
    // A pass of another model: its dialog lists the models, without the row that switches a mode off.
    await pick('another', /Add a pass of another model/, [/Use this pass/, /Add a pass of the same model/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model of pass 2/, 'The model of the second pass was not asked for.');
    assert.doesNotMatch(screen(), OFF_ROW, 'The model of a further pass can be "off".');
    await pick('Chat Small', /Chat Small +fixture\/chat/, [/Review Strong +fixture\/reviewer/, /Free +opencode\//], 'Typing does not filter the models of the second pass.');
    await see(/Variant of fixture\/chat/, 'The variants of the second pass\'s model were not offered.');
    key('Enter');
    await see(/Model for \/pr-review: 2 passes/, 'The second pass was not added.');
    await see(/Use these 2 passes +reviewer, chat/, 'The first row does not list both models in the order of the passes.');
    await see(/Add a pass of the same model +chat once more/, 'Another pass of the same model is not offered for the last model.');
    await see(/Take the last pass away +Without chat/, 'Taking the last pass away does not name the model that goes.');
    // Leaving the dialog of a further pass's model adds nothing and keeps the passes chosen so far.
    await pick('another', /Add a pass of another model/, [/Use these 2 passes/, /Add a pass of the same model/, /Take the last pass away/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model of pass 3/, 'The model of the third pass was not asked for.');
    await escape();
    await see(shown => /Model for \/pr-review: 2 passes/.test(shown) && /Use these 2 passes +reviewer, chat(?!,)/.test(shown) && !/Model of pass 3/.test(shown), 'Leaving the model of a further pass did not return to the passes chosen so far.');
    // The same model once more, twice: four passes are the most, so no further pass can be added.
    await pick('same', /Add a pass of the same model/, [/Use these 2 passes/, /Add a pass of another model/, /Take the last pass away/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model for \/pr-review: 3 passes/, 'A pass of the same model was not added.');
    await see(/Use these 3 passes +reviewer, chat, chat/, 'The first row does not list the three passes.');
    await pick('same', /Add a pass of the same model/, [/Use these 3 passes/, /Add a pass of another model/, /Take the last pass away/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model for \/pr-review: 4 passes/, 'A fourth pass was not added.');
    await see(/Use these 4 passes +reviewer, chat, chat, chat/, 'The first row does not list the four passes.');
    assert.doesNotMatch(screen(), /Add a pass/, 'A fifth pass is offered.');
    // Two of them are taken away again, and the settings file has not changed through all of it.
    await pick('Take', /Take the last pass away/, [/Use these 4 passes/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Model for \/pr-review: 3 passes/, 'Taking the last pass away did not leave three passes.');
    await pick('Take', /Take the last pass away/, [/Use these 3 passes/, /Add a pass/], 'Typing does not filter the rows of the passes dialog.');
    await see(/Use these 2 passes +reviewer, chat(?!,)/, 'Taking the last pass away did not leave the two passes of two models.');
    assert.equal(await readFile(settingsFile, 'utf8'), beforeEdit, 'The passes dialog changed the settings file before its first row was taken.');
    // The language's own note is gone by now, so the one that follows is this save's.
    await see(shown => !wrapped('Saved. It takes effect after the OpenCode service restarts').test(shown), 'The note of the earlier save is still shown.', 30000);
    // The first row is the one Enter takes: the list is saved, and waits for the restart like every change.
    key('Enter');
    await see(wrapped('Saved. It takes effect after the OpenCode service restarts'), 'A changed list of models does not name the restart.');
    await see(/Review models for \/pr-review +reviewer \+ chat/, 'The list does not show the two models of the two passes.');
    const editedText = await readFile(settingsFile, 'utf8');
    assert.deepEqual(JSON.parse(editedText), { ...expected, outputLanguage: 'zh-TW', models: { ...expected.models, review: { reviewers: ['fixture/reviewer', 'fixture/chat'], rater: '' } } }, 'The edit changed more than the list of review models, or not that.');
    // The row once more, now that it holds two different models. Its first model picked again: the first row
    // keeps the saved passes, so that looking at a row and taking what it shows changes nothing.
    const reopen = async () => {
      key('C-u');
      type('Review models');
      await see(shown => /Review models for \/pr-review +reviewer \+ chat/.test(shown) && !/Organization +fixture/.test(shown), 'Typing does not filter the settings.');
      key('Enter');
      await see(/Model for \/pr-review/, 'The review model dialog did not open again.');
      await see(/● Review Strong +fixture\/reviewer/, 'The first model of the saved list is not the preselected one.');
    };
    const backInList = shown => /Review models for \/pr-review +reviewer \+ chat/.test(shown) && !/Model for \/pr-review/.test(shown);
    await reopen();
    key('Enter');
    await see(/Variant of fixture\/reviewer/, 'The variants of the chosen model were not offered.');
    key('Enter');
    await see(/Model for \/pr-review: 2 passes/, 'After the model the passes of /pr-review were not asked for.');
    await see(/Use these 2 passes +reviewer, chat(?!,)/, 'The saved first model picked again does not start from the saved passes.');
    key('Enter');
    await see(backInList, 'Taking the saved passes did not return to the list.');
    assert.equal(await readFile(settingsFile, 'utf8'), editedText, 'Taking the passes a row shows changed the settings file.');
    // Another model than the saved first one starts with the usual passes of that model: two for /pr-review.
    await reopen();
    await pick('Chat Small', /Chat Small +fixture\/chat/, [/Review Strong +fixture\/reviewer/, /Free +opencode\//], 'Typing does not filter the models.');
    await see(/Variant of fixture\/chat/, 'The variants of the other model were not offered.');
    key('Enter');
    await see(/Use these 2 passes +chat, chat(?!,)/, 'Another model than the saved first one does not start with its usual two passes.');
    await escape();
    await see(backInList, 'Leaving the passes dialog did not return to the list.');
    assert.equal(await readFile(settingsFile, 'utf8'), editedText, 'Leaving the passes of another model changed the settings file.');
    await escape();
    assert.equal((await status()).state, 'restart');
    result.list = 'settings listed with their values and what the models are for; a model row is edited as a list of passes (a pass added, of the same model and of another one, and taken away, between one and four; saved only when accepted), and left with Escape it saves nothing; changes saved at once, marked as waiting for a restart; the settings file names the README\'s section';

    // 9. After the restart the changes are in use: no hint, and /pr-check is READY again, with the edited passes.
    tmux('kill-server');
    await stopServer();
    url = await serve();
    assert.deepEqual((await loaded())?.features, { server: true, tui: true });
    for (let attempt = 0; attempt < 50 && (await status().catch(() => ({}))).state !== 'ready'; attempt++) await sleep(200);
    assert.equal((await status()).state, 'ready');
    await openTerminal(150, 44);
    await sleep(8000);
    assert.ok(!wrapped('AZPR is not set up yet').test(screen()), 'The hint is for an AZPR without usable settings only.');
    const before = (await told()).length;
    await command('pr-check', 'Azure DevOps PR access check', prUrl);
    await see(/AZPR [a-f0-9]{8} · READY/, 'After the restart /pr-check did not answer READY.', 90000);
    for (let attempt = 0; attempt < 50 && !(await told()).slice(before).some(text => /^\[AZPR [a-f0-9]{8}\] READY\n/.test(text)); attempt++) await sleep(200);
    const secondCheck = (await told()).slice(before).find(text => /^\[AZPR [a-f0-9]{8}\] READY\n/.test(text));
    assert.ok(secondCheck?.includes('\n| Review models | ok | 2 passes: fixture/reviewer, fixture/chat; severity rating by fixture/reviewer (the first reviewer model). |\n'), 'After the restart the check does not name the edited passes.');
    assert.ok(secondCheck.endsWith('outputLanguage=zh-TW.'), 'After the restart the changed language is not in use.');
    result.restart = 'after a restart the changed settings are in use; no hint';
  } else {
    // ---------------------------------------------------------------- the update of settings of 0.4.x
    const settingsDirectory = dirname(settingsFile);
    /** The settings of 0.4.x are still as they were: byte for byte, with nothing a writer leaves beside them. */
    const untouched = async what => {
      assert.equal(await readFile(settingsFile, 'utf8'), earlierText, what);
      assert.deepEqual((await readdir(settingsDirectory)).filter(name => /\.tmp$|\.lock$/.test(name)), [], what);
    };
    // 1. Loading AZPR left the file alone: it adds no setting to a file it does not use (two are not in it).
    await untouched('Loading AZPR changed settings of 0.4.x.');
    const first = await status();
    // Neither missing nor faulty: `migrate`, with what the update changes and the word that confirms it. No row
    // can be edited before; the rows say what the update will make of the file.
    assert.deepEqual([first.state, first.editable, first.settingsFile, first.problem, first.fileProblem], ['migrate', false, settingsFile, MIGRATION_NEEDED, MIGRATION_NEEDED]);
    assert.deepEqual(first.migration.lines, CHANGES);
    assert.match(first.migration.word, /^[a-f0-9]{12}$/);
    assert.deepEqual(['reviewModel', 'quickModel', 'deepModel', 'language'].map(id => rowOf(first, id).value), ['reviewer + chat', 'chat', 'off', 'zh-TW']);
    // A taller terminal than the first setup's: the dialog that shows the update is as long as its lines, and the
    // host draws a dialog from a quarter down the screen and cuts what does not fit.
    await openTerminal(150, 64);

    // The dialog that shows the update has these words as its title; the hint goes on after them.
    const UPDATE_DIALOG = /AZPR's settings are from an earlier version(?!\.)/;
    // 2. The TUI says once that the settings are from an earlier version, and how to update them.
    await see(wrapped('AZPR\'s settings are from an earlier version. Type /pr-setup to see what changes and update them.'), 'The TUI did not say that the settings need an update.', 30000);
    assert.ok(!wrapped('AZPR is not set up yet').test(screen()), 'Settings of 0.4.x are taken for no settings.');
    // A review command only says so: no review, no Azure DevOps request, and nothing about a repair or a restart.
    await command('pr-check', 'AZPR is not ready here; run /pr-setup to see what it needs', prUrl);
    for (let attempt = 0; attempt < 150 && !(await told()).some(text => text.startsWith('[AZPR] SETTINGS UPDATE REQUIRED')); attempt++) await sleep(200);
    assert.deepEqual(await told(), [`[AZPR] SETTINGS UPDATE REQUIRED\nNo review or Azure request was started. Settings: ${settingsFile}\n${MIGRATION_NEEDED}`]);
    assert.deepEqual(azure.state.calls, [], 'A command of an AZPR that waits for its update asked Azure DevOps.');
    await untouched('A review command changed settings of 0.4.x.');
    result.blocked = 'the file of 0.4.x is left as it is; the commands and the TUI say that the settings need an update';

    // 3. /pr-setup: the answer in the conversation says what the update changes and how a client without the
    // terminal UI confirms it; the TUI shows the same lines, and says that nothing is changed yet.
    await command('pr-setup', 'Set up AZPR: organization, token, model');
    await see(UPDATE_DIALOG, '/pr-setup did not show what an update of the settings changes.');
    assert.equal((await told()).at(-1), `[AZPR] SETTINGS UPDATE\nSettings: ${settingsFile}\n\nThese settings are from AZPR 0.4.x. Reviews run again once the file is updated to this version; nothing is changed until you confirm.\n\n` +
      `${CHANGES.map(line => `- ${line}`).join('\n')}\n\nIn OpenCode's terminal UI, /pr-setup alone asks whether to update the file. In other clients, confirm with:\n\n/pr-setup --migrate ${first.migration.word}\n\n` +
      'The word names this very change: when the settings file changes before you confirm, /pr-setup shows the update again. No model request or Azure request is made.');
    for (const line of CHANGES) await see(wrapped(`- ${line}`), `The dialog does not show this change: ${line}`);
    const shownUpdate = (await see(shown => wrapped('Nothing is changed until you confirm in the next step.').test(shown) && shown, 'The dialog does not say that nothing is changed yet.')).split('\n');
    // All of it is on the screen, down to the dialog's own button under its last sentence.
    const lastSentence = shownUpdate.findLastIndex(line => /in the next step\./.test(line));
    assert.ok(shownUpdate.slice(lastSentence + 1, lastSentence + 4).some(line => /^\s+ok(?:\s|$)/.test(line)), 'The dialog that shows the update is cut off at the foot of the screen.');
    await untouched('Showing the update changed settings of 0.4.x.');
    // Left with Escape: nothing is written. (Escape closes the dialog that shows the update; where the question
    // still follows it, a second Escape leaves that one.)
    const QUESTION = /Update AZPR's settings file\?/;
    const LEFT = wrapped('AZPR setup: the settings file was left as it is.');
    await escape();
    if (QUESTION.test(await see(shown => (QUESTION.test(shown) || LEFT.test(shown)) && shown, 'Escape did not close the dialog that shows the update.'))) await escape();
    await see(LEFT, 'Leaving the update with Escape was not acknowledged.');
    await see(shown => !UPDATE_DIALOG.test(shown) && !QUESTION.test(shown), 'Escape did not leave the dialogs of the update.');
    await untouched('Leaving the update with Escape changed settings of 0.4.x.');
    assert.equal((await status()).state, 'migrate');
    // That note is gone before the next one is looked for.
    await see(shown => !LEFT.test(shown), 'The note that the file was left as it is stays on the screen.', 30000);

    // Again, as far as the decision: a list whose first row keeps the file, so Enter alone changes nothing.
    await command('pr-setup', 'Set up AZPR: organization, token, model');
    await see(UPDATE_DIALOG, '/pr-setup did not show the update again.');
    key('Enter');
    await see(QUESTION, 'The update was not asked about after it was shown.');
    const asked = (await see(shown => /Not now/.test(shown) && /Update the settings file/.test(shown) && shown, 'The question does not offer both answers.')).split('\n');
    assert.ok(asked.findIndex(line => /Not now/.test(line)) < asked.findIndex(line => /Update the settings file/.test(line)), 'Keeping the file is not the first row.');
    // (The host cuts a row at the dialog's width: of "… reviews do not run until it is updated" this much is shown.)
    await see(/Not now +The file stays as it is; reviews do not run/, 'Keeping the file does not say what it means.');
    key('Enter');
    await see(LEFT, 'Declining the update was not acknowledged.');
    await see(shown => !QUESTION.test(shown), 'The question did not close.');
    await sleep(1000);
    await untouched('Declining the update changed settings of 0.4.x.');
    const declined = await status();
    assert.deepEqual([declined.state, declined.migration.word], ['migrate', first.migration.word], 'After the update was declined the settings do not wait for it as before.');
    assert.deepEqual((await commands()).filter(line => !line.startsWith('pr-setup')).map(line => line.split(': ')[1]), Array(6).fill('AZPR is not ready here; run /pr-setup to see what it needs'));
    assert.deepEqual(azure.state.calls, [], 'Showing the update asked Azure DevOps.');
    result.declined = 'left with Escape, and with the first row of the question, which keeps the file: nothing was written';

    // 4. Again, and confirmed: the file is written, and AZPR loads it at once.
    await command('pr-setup', 'Set up AZPR: organization, token, model');
    await see(UPDATE_DIALOG, '/pr-setup did not show the update again.');
    key('Enter');
    await see(QUESTION, 'The update was not asked about again.');
    await pick('Update the', /Update the settings file/, [/Not now/], 'Typing does not filter the two answers.');
    await see(/AZPR's settings are updated/, 'The update did not end with its result.');
    await see(shown => /Reviews run again:/.test(shown) && /\/pr-check <PR URL>/.test(shown), 'The result does not say what to do next: the settings were not loaded.');
    key('Enter');
    // On disk: the file of this version, written once and complete, owner-only; the PAT file is as it was.
    const written = await readFile(settingsFile, 'utf8');
    assert.equal(written, settingsText(withMissingSettings(migrateSettings(JSON.parse(earlierText)).settings).settings), 'The file is not what the update of the earlier settings gives, completed with the settings it left out.');
    assert.equal(written, JSON.stringify(UPDATED, null, 2) + '\n', 'The updated file does not hold what is expected of it, in its place.');
    assert.deepEqual(withMissingSettings(JSON.parse(written)).added, [], 'The updated file lacks a setting that has a default.');
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(settingsDirectory)).filter(name => /\.tmp$|\.lock$/.test(name)), []);
    assert.deepEqual([await readFile(patFile, 'utf8'), (await stat(patFile)).mode & 0o777], [FAKE_PAT, 0o600]);
    assert.deepEqual(azure.state.calls, [], 'The update asked Azure DevOps.');
    result.updated = 'confirmed: the file of this version, complete and owner-only; the PAT file as it was';

    // 5. No restart: the review commands are the real ones, and /pr-check reads the PR with the models and the
    // language the update kept.
    const after = await status();
    assert.deepEqual([after.state, after.editable, after.fileProblem, after.migration], ['ready', true, '', undefined]);
    // The values that were not the defaults are the ones in use.
    assert.deepEqual(['language', 'report', 'progress', 'afterReview'].map(id => rowOf(after, id).value), ['zh-TW', 'full', 'off', 'differs by mode']);
    assert.ok((await commands()).every(line => !line.includes('not ready here')), 'The commands that only said that AZPR is not ready are gone.');
    await command('pr-check', 'Azure DevOps PR access check', prUrl);
    await see(/AZPR [a-f0-9]{8} · READY/, 'After the update /pr-check did not answer READY without a restart.', 90000);
    assert.ok(azure.callsTo('pr').length >= 1, 'The check read the pull request with the token of the PAT file.');
    const check = await checkReport();
    assert.ok(check.includes('\n| Review models | ok | 2 passes: fixture/reviewer, fixture/chat; severity rating by fixture/chat. |\n'), check);
    assert.ok(check.includes('\n| Quick models | ok | 1 pass: fixture/chat; severity rating by fixture/chat (the first reviewer model). |\n'), check);
    assert.ok(check.includes('\n| Deep models | ok | Not set: /pr-deep stays off until models.deep.reviewers names at least one model (stronger models than models.review.reviewers, or more passes). |\n'), check);
    assert.ok(check.endsWith('outputLanguage=zh-TW.'), 'The language of the earlier settings is not in use.');
    assert.equal(await readFile(settingsFile, 'utf8'), written, 'Loading the updated settings changed the file again.');
    result.loaded = '/pr-check READY without a restart, with the passes the update made of the earlier roles';

    // 6. /pr-setup now lists the settings, with the models of each mode as the update left them.
    await command('pr-setup', 'Set up AZPR: organization, token, model');
    await see(/AZPR settings/, '/pr-setup did not list the settings once they were updated.');
    assert.doesNotMatch(screen(), /restart needed/, 'The updated settings wait for a restart.');
    await see(/Review models for \/pr-review +reviewer \+ chat/, 'The list does not show the two passes the update made of the reviewer roles.');
    await see(/Quick models for \/pr-quick +chat/, 'The list does not show the quick reviewer as one pass.');
    await see(/Deep models for \/pr-deep +off/, 'The list does not show that /pr-deep stays off.');
    await escape();
    result.list = 'the settings are listed with the models of each mode';
  }

  // What setup must never do: ask a model, fail to load, or leave the token anywhere but in its file.
  assert.deepEqual(requests, [], 'Setup asked no model.');
  const hostLog = await readFile(join(dirs.data, 'opencode', 'log', 'opencode.log'), 'utf8').catch(() => '');
  assert.doesNotMatch(hostLog, /plugin operation failed/, 'The TUI loaded the plugin\'s terminal part without an error.');
  for (const token of [FAKE_PAT, WRONG_TOKEN]) {
    assert.ok(!screens.some(shown => shown.includes(token)), 'A token was on the screen.');
    assert.ok(!logs.includes(token) && !hostLog.includes(token), 'A token is in a log.');
    const conversation = JSON.stringify([(await api(`/api/session/${origin}/inbox`)).data, (await api(`/api/session/${origin}/context`)).data]);
    assert.ok(!conversation.includes(token), 'A token is in the conversation.');
  }
  const holders = run('grep', ['-rlF', '--', FAKE_PAT, dirs.config, dirs.data, dirs.cache, dirs.state, dirs.home, join(fixture, 'xdg-config')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(holders, [migrate ? patFile : tokenFile], 'Of everything this OpenCode wrote, only the token file holds the token.');
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
