import { fakeAzure, FAKE_PAT } from './fake-azure.mjs';
/** Opt-in exact-host fixture for the terminal panel. Fake loopback models and Azure DevOps REST only.
 * node tests/host-v2-tui-panel.mjs /absolute/path/opencode [--native [--package SPEC]]
 * The real TUI runs in a detached tmux session (tmux is required): the fixture reads its screen and
 * drives its keyboard and mouse. A review of six files starts from the TUI: two passes (two models
 * in models.review.reviewers) over two shards, so four reviewer sessions, which are held until the
 * panel was seen with them running under the names the runtime gave them (pass 1/2 shard 1/2 and so
 * on). The second pass files one finding per file and the first pass one more on the last file, so
 * the review goes through every stage of the pipeline: a duplicate check merges that one, and the
 * severity rating (rater: "", the default: the first reviewer model rates) sets every level, which
 * the counts of the report and the preview then show. Checked on the screen: while a run is under way
 * the panel offers to stop it, which asks first and then sends /pr-stop for that run (a first review
 * is stopped that way, with a click and with the key); the panel opens by itself
 * and leaves the keyboard with the prompt; a click on a row opens that session, and the panel is
 * back with the conversation; the report and the comment preview are rendered Markdown, the report
 * read from the session of the last stage (the rating), which is the one session the review keeps;
 * /pr-panel,
 * the panel's one command; a terminal too narrow for two panes is not taken over; after a review or
 * a preview the panel lists what can be done next in one row at its foot, level with the host's
 * status bar, and one that is picked asks first and then sends the command: findings are left out
 * (applied from the foot of their list, with a click and with its key) and the comments posted
 * without typing a command; a click there leaves the keyboard with the prompt, and a preview that
 * is planned again is shown from its beginning. The host is then
 * restarted with terminalPanel: manual: the notices carry the setting, and the panel opens only when
 * asked. The settings file starts without the settings newer versions brought: loading AZPR adds
 * them, and commands start all the same.
 * With --native the package is installed by OpenCode's plugin manager: the compiled view must load
 * from there, and the compiler must not be installed with it (the package ships the compiled view
 * because OpenCode 2.3.x compiles no JSX of an installed package; 2.4.0 and later do, and load the
 * compiled view all the same).
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
// The level the rating gives a finding of the review: every third one low, the others high. The reviewers file
// everything as medium, so a count without a medium finding is the rating's.
const levelOf = id => (Number(id.split('-')[1]) - 1) % 3 === 2 ? 'low' : 'high';
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
// The two reviewer models of models.review.reviewers, one per pass: a request says which model it is for, never
// which role. The first one also checks duplicates, rates and plans the comments, which its payload tells apart.
const FIRST = 'first', SECOND = 'second';
// Shards are made of the sorted paths, and findings are numbered by path: the last file holds the last findings.
const LAST_FILE = [...files].sort().at(-1);
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const users = input.messages.filter(m => m.role === 'user');
    let payload; try { payload = JSON.parse(textOf(users[0]?.content)); } catch { /* an ordinary conversation */ }
    const results = input.messages.filter(m => m.role === 'tool').length;
    const assignment = payload?.assignment;
    requests.push({ model: input.model, sessionID: request.headers['x-opencode-session-id'], files: assignment?.files?.length, stage: assignment?.kind ?? (assignment?.files ? 'review' : undefined), work: payload?.commentWork?.kind, tools: input.tools?.length ?? 0, toolResults: results });
    const fileTool = input.tools?.find(t => t.function.name === (input.model === SECOND ? 'azpr_read_diff' : 'azpr_read_file'))?.function.name;
    let call, final;
    if (assignment?.kind === 'duplicates') {
      // What two sessions reported in one file: the later findings repeat the first one.
      const [kept, ...repeated] = assignment.findingIds;
      final = { status: 'COMPLETE', merged: repeated.map(id => ({ id, mergedInto: kept, reason: 'The same missing guard, reported by the other pass.' })), report: `Duplicates of ${assignment.file} merged.` };
    } else if (assignment?.kind === 'rating') {
      final = { status: 'COMPLETE', ratings: assignment.findingIds.map(id => ({ id, severity: levelOf(id), reason: 'Rated from the finding\'s text.' })), report: 'Levels set from the texts alone.' };
    } else if (assignment?.files) {
      const assigned = assignment.files;
      // A finding counts only where its own session read the file: one read per assigned file, then the answer.
      if (results < assigned.length && fileTool) call = { name: fileTool, arguments: fileTool === 'azpr_read_diff' ? { path: assigned[results] } : { path: assigned[results], version: 'head' } };
      else {
        await held;
        const named = path => path.split('/').at(-1).replace('.ts', '');
        const finding = (id, path, line, summary) => ({ id, summary, evidence: 'HEAD removes `if (!ready) return`, so **a second caller** sees the half-written state.',
          counterevidence: 'No caller re-checks the flag.', location: `head:${path}:${line}`, severity: 'medium', suggestion: 'Restore the guard.' });
        // The second pass files one finding per file. The first pass files one, on the last file of the review and
        // in other words: the one thing two sessions report, which the duplicate check then has to merge.
        const findings = input.model === SECOND ? assigned.map((path, i) => finding(`F-${i + 1}`, path, 1, `\`${named(path)}\` drops the guard before it changes state`))
          : assigned.filter(path => path === LAST_FILE).map(path => finding('F-1', path, 2, `\`${named(path)}\` is written without the guard`));
        final = { status: 'COMPLETE', coverage: { files: assigned, gaps: [] }, findings, report: `Shard ${assignment.shard} reviewed.` };
      }
    } else if (payload?.commentWork?.kind === 'group') {
      // The pass before several planning pages: nothing repeats in this review.
      final = { status: 'READY', groups: [] };
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
// Each file loses a line between BASE and HEAD. A finding counts only where its own session read the file, and a
// diff shows source only where the two versions differ: the pass that reads diffs would otherwise have read nothing.
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const azure = fakeAzure({ org: 'fixture', project: 'project', repo: 'repository', prId: 321, files, base: BASE, head: HEAD,
  sources: Object.fromEntries(files.flatMap(path => [[`${HEAD}:${path}`, 'fixture code\nsecond line\n'], [`${BASE}:${path}`, 'fixture code\nif (!ready) return\nsecond line\n']])) });
const adoServer = createServer((request, response) => { azure.serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
adoServer.listen(0, '127.0.0.1'); await once(adoServer, 'listening');
const azureURL = `http://127.0.0.1:${adoServer.address().port}`;
const settings = JSON.parse(await readFile(join(root, 'config/settings.example.json'), 'utf8'));
// Two passes, each with a model of its own. The rater stays as the example has it ("": the first reviewer model
// rates), so the review runs every stage a default setup runs.
settings.models.review = { ...settings.models.review, reviewers: [`fixture/${FIRST}`, `fixture/${SECOND}`] };
assert.equal(settings.models.review.rater, '');
settings.workflow = { ...settings.workflow, shardFiles: 3, parallelSessions: 4 };
// Each comment step is typed here; debug stays off, as installed, so a run deletes its sessions when it ends.
settings.afterReview = { quick: 'none', review: 'none', deep: 'none' };
settings.azure = { ...settings.azure, organization: 'fixture', pat: FAKE_PAT };
const password = randomUUID();
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: dirs.tmp, OPENCODE_TEST_HOME: dirs.home, OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', AZPR_TEST_AZURE_BASE_URL: azureURL };
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options }); assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}${result.stdout}`); return result.stdout; };
const config = { update: 'disable', snapshots: false, warming: false, model: 'fixture/chat',
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: providerURL, apiKey: 'unused' },
    models: Object.fromEntries([FIRST, SECOND, 'chat'].map(id => [id, { limit: { context: 64000, output: 4000 } }])) } } };
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
// The settings file without some of the settings that have a default, as a version before those settings existed
// would have left it: loading AZPR writes them into it. Without them it is still a file of this layout
// (version 3, a list of reviewer models), which AZPR loads: the reviews below run with it.
const settingsFile = native ? join(fixture, 'xdg-config', 'azpr', 'settings.json') : join(dirs.config, 'plugins', 'azpr-v2', 'settings.json');
const newer = ['terminalPanel', 'deletePrivateSessions', 'progressNotices'];
const older = JSON.parse(await readFile(settingsFile, 'utf8'));
assert.deepEqual([older.version, older.models.review], [3, { reviewers: [`fixture/${FIRST}`, `fixture/${SECOND}`], rater: '' }]);
for (const name of newer) { assert.ok(Object.hasOwn(older, name), name); delete older[name]; }
assert.ok(Object.hasOwn(older.workflow, 'stageIdleSeconds'));
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
 * The left button pressed in the middle of `from` inside the panel, moved in a few steps to the middle of `to`
 * and let go there: a selection where it starts on text, a press that is given up where it starts on a step. Both are looked for from the panel's left edge on, since the
 * conversation beside it can show the same words.
 */
async function dragInPanel(from, to) {
  const lines = (await see(shown => panelOpen(shown) && shown, 'The panel is not open to select text in.')).split('\n');
  const edge = lines.find(line => panelOpen(line)).search(/AZPR [a-f0-9]{8} · /);
  const place = text => {
    const row = lines.findIndex(line => line.indexOf(text, edge) >= 0);
    assert.ok(row >= 0, `"${text}" is not in the panel.\n--- screen ---\n${lines.join('\n')}`);
    return [columns(lines[row].slice(0, lines[row].indexOf(text, edge))) + Math.max(1, Math.floor(columns(text) / 2)), row + 1];
  };
  const [fromColumn, fromRow] = place(from), [toColumn, toRow] = place(to);
  const send = (code, column, row, action) => tmux('send-keys', '-t', 'azpr', '-l', `\x1b[<${code};${column};${row}${action}`);
  send(0, fromColumn, fromRow, 'M');
  for (let step = 1; step <= 4; step++) {
    send(32, Math.round(fromColumn + (toColumn - fromColumn) * step / 4), Math.round(fromRow + (toRow - fromRow) * step / 4), 'M');
    await sleep(50);
  }
  send(0, toColumn, toRow, 'm');
}
/**
 * The left button pressed in the middle of `text` inside the panel and moved one cell on it, with no release:
 * what a terminal reports when the pointer then leaves it with the button down.
 */
async function pressAndHold(text) {
  const lines = (await see(shown => panelOpen(shown) && shown, 'The panel is not open to press a step in.')).split('\n');
  const edge = lines.find(line => panelOpen(line)).search(/AZPR [a-f0-9]{8} · /);
  const row = lines.findIndex(line => line.indexOf(text, edge) >= 0);
  assert.ok(row >= 0, `"${text}" is not in the panel.\n--- screen ---\n${lines.join('\n')}`);
  const column = columns(lines[row].slice(0, lines[row].indexOf(text, edge))) + Math.max(1, Math.floor(columns(text) / 2));
  tmux('send-keys', '-t', 'azpr', '-l', `\x1b[<0;${column};${row + 1}M`);
  await sleep(50);
  tmux('send-keys', '-t', 'azpr', '-l', `\x1b[<32;${column + 1};${row + 1}M`);
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

/** The reviewer sessions of a review here, by the names the runtime gives them: two passes over two shards. */
const REVIEWER_ROWS = ['Review pass 1/2 shard 1/2', 'Review pass 1/2 shard 2/2', 'Review pass 2/2 shard 1/2', 'Review pass 2/2 shard 2/2'];
/** Whether the panel lists exactly those four as running, each with the session it opens. */
const reviewersRunning = shown => JSON.stringify([...shown.matchAll(/● (\S[^\n]*?) running ses_[A-Za-z0-9]+/g)].map(match => match[1]).sort()) === JSON.stringify(REVIEWER_ROWS);
/**
 * A sentence as the panel draws it: it may be broken after any word (and, as the host breaks rows, inside a word
 * after a slash or a hyphen), and the rest of the row and the start of the next one then belong to whatever is
 * beside it (the conversation is on the panel's left).
 */
const BREAK = '[^\\n]*\\n[^\\n]{0,140}?';
const wrapped = text => new RegExp(text.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[/-](?=.)/g, `$&(?:${BREAK})?`)).join(`(?: |${BREAK})`));
/**
 * A receipt's stage lines without what differs from run to run: each stage's role, the name of its session, its
 * status and its model. Reviewer sessions start side by side, so their lines are sorted; the stages after them
 * keep the order they ran in.
 */
const stageLines = receipt => {
  const lines = [...receipt.matchAll(/^- (azpr-[a-z-]+(?: \[[^\]]+\])?: [A-Z_]+); session=ses_[A-Za-z0-9]+; (model=[^;\n]+)/gm)].map(match => `${match[1]}; ${match[2]}`);
  const reviewer = line => /^azpr-review-reviewer[b-d]? /.test(line);
  return [...lines.filter(reviewer).sort(), ...lines.filter(line => !reviewer(line))];
};
const REVIEWER_STAGES = status => [1, 2].flatMap(pass => [1, 2].map(shard => `azpr-review-reviewer${pass === 2 ? 'b' : ''} [pass ${pass}/2 shard ${shard}/2]: ${status}; model=fixture/${pass === 2 ? SECOND : FIRST}`));
// /pr-review's description begins with these words; the command list shows the beginning of it.
const REVIEW_SUGGESTION = 'Azure DevOps PR review; --help for options';
const PR_URL = 'https://dev.azure.com/fixture/project/_git/repository/pullrequest/321';

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

  // 0. A review under way can be stopped from the panel: its foot offers that, and nothing else, for as long as
  // the run has no receipt. Picking it asks first, with "no" first; "yes" sends /pr-stop for that run to the
  // session on screen, which the runtime takes like a typed command.
  await command('pr-review', REVIEW_SUGGESTION, PR_URL);
  const stopped = (await see(/AZPR ([a-f0-9]{8}) · RUNNING/, 'A review that starts did not open the panel.'))[1];
  await see(reviewersRunning, 'The panel does not list the four reviewer sessions of the first review (two passes over two shards) as running.');
  await see(/\[s\] Stop this run…/, 'While a review is under way the panel does not offer to stop it.');
  assert.doesNotMatch(screen(), /\[c\] Preview comments|\[p\] Post \d+ comments?|\[a\] Adjust findings…/, 'A run under way offers only to be stopped.');
  // The step is where the steps of a preview are: on the line of the host's status bar, under a line that crosses the panel.
  const during = screen().split('\n');
  const stopRow = during.findIndex(line => /\[s\] Stop this run…/.test(line));
  assert.match(during[stopRow], /ctrl\+p\s+commands\s+\[s\] Stop this run…/, 'The step is not level with the status bar.');
  assert.match(during[stopRow - 1], /─{40,}/, 'No line separates the step from what is above it.');
  // The start notice names the passes and their models, and says that the run can be stopped, as data: that is
  // what the panel offers.
  const startedNotice = (await queued()).find(item => (item.payload?.text ?? '').startsWith(`[AZPR ${stopped}] STARTED `));
  assert.equal(startedNotice.payload.text, `[AZPR ${stopped}] STARTED /pr-review (2 passes: fixture/${FIRST}, fixture/${SECOND}). Work continues in this OpenCode process; the result will return to this conversation. Stop with /pr-stop ${stopped}.`);
  assert.deepEqual(startedNotice.payload.metadata, { azpr: { next: { stop: stopped } } });
  // A click asks first; Enter alone takes the first row, and the run goes on. The click left the keyboard with the prompt.
  await click('Stop this run…');
  await see(/Stop this run\?/, 'A click on the step did not ask before stopping.');
  await see(new RegExp(`No, let it run\\s+AZPR ${stopped} \\(/pr-review\\)`), 'Letting the run go on is not the first row, or the run is not named.');
  await see(/Yes, stop it\s+Sent requests may still be billed/, 'Stopping is not offered with what it leaves.');
  key('Enter');
  await see(shown => !/Stop this run\?/.test(shown), 'The question did not close.');
  await sleep(1500);
  assert.ok(!(await inbox()).some(text => /cancellation requested|\] CANCELLED/.test(text)), 'Declined: nothing was sent.');
  assert.match(screen(), new RegExp(`AZPR ${stopped} · RUNNING`), 'Declined: the run goes on.');
  type('still-typing');
  await see(/┃\s+still-typing/, 'The click on the step, or its question, took the keyboard from the prompt.');
  key('C-u');
  // With the keyboard, the panel's key does the same; "yes" stops the run.
  await click('Sessions (click one to open it)');
  key('s');
  await see(/Stop this run\?/, 'The key did not ask before stopping.');
  // The key pressed once more is typed into the question. The host's own search would find "s" in "Yes, stop it"
  // alone and select it; the question answers by the beginning of a row instead, so no row is left to take, and
  // Enter does nothing.
  key('s');
  await see(shown => /No results found/.test(shown) && !/Yes, stop it|No, let it run/.test(shown), 'The key pressed once more left a row of the question to take.');
  key('Enter');
  await sleep(1500);
  assert.match(screen(), /Stop this run\?/, 'Enter closed the question although no row was listed.');
  assert.ok(!(await inbox()).some(text => /cancellation requested|\] CANCELLED/.test(text)), 'The key pressed twice and Enter stopped the run.');
  key('BSpace');
  await see(shown => /No, let it run/.test(shown) && /Yes, stop it/.test(shown), 'With nothing typed the question does not list both rows again.');
  type('Yes');
  await sleep(400);
  const answered = Date.now();
  key('Enter');
  await see(new RegExp(`AZPR ${stopped} · CANCELLED`), 'The run that was stopped from the panel did not end as CANCELLED.', 60000);
  result.stopSeconds = Math.round((Date.now() - answered) / 100) / 10;
  await see(shown => !/\[s\] Stop this run…/.test(shown), 'A run that has ended is still offered to be stopped.');
  // Nothing more is coming of that run, and the panel does not say "yet" of it. It was stopped while its four
  // reviewer sessions were at work: no later stage had a session, and none of the four holds a report to keep.
  await see(shown => /4 session\(s\) were deleted when their run ended\./.test(shown) && /This run ended with no report or preview to show\./.test(shown), 'The panel does not say that the stopped run left nothing to show.');
  const afterStop = await inbox();
  assert.ok(afterStop.some(text => text.startsWith(`[AZPR ${stopped}] Authorization revoked and cancellation requested`)), 'The runtime did not take the step like a typed /pr-stop, in the session on screen.');
  const cancelled = afterStop.find(text => text.startsWith(`[AZPR ${stopped}] CANCELLED`));
  assert.ok(cancelled, 'The stopped run has no receipt in the conversation.');
  assert.equal(cancelled.split('\n')[0], `[AZPR ${stopped}] CANCELLED; verification none`);
  assert.deepEqual(stageLines(cancelled), REVIEWER_STAGES('FAILED'));
  assert.match(cancelled, /\nSession notice: 4 reviewer session\(s\) of this run were deleted when it ended; only a session that holds the report or draft is kept \(deletePrivateSessions\)\. debug\.enabled keeps them all\.\n/);
  assert.equal(azure.state.threads.length, 0);
  // The next review starts with the panel closed, as a first one does.
  await click('close');
  await see(shown => !panelOpen(shown), 'The panel did not close.');
  result.stop = 'a run under way is stopped from the panel: asked first with "no" first, by a click and by its key';

  // 1. A review that starts opens the panel by itself, with its sessions running, and the prompt keeps the keyboard.
  await command('pr-review', REVIEW_SUGGESTION, PR_URL);
  const review = (await see(/AZPR ([a-f0-9]{8}) · RUNNING/, 'A review that starts did not open the panel.'))[1];
  assert.notEqual(review, stopped);
  await see(shown => /Sessions \(click one to open it\)/.test(shown) && reviewersRunning(shown), 'The panel does not list the four reviewer sessions as running.');
  type('typed-while-the-panel-opened');
  await see(/┃\s+typed-while-the-panel-opened/, 'The keyboard left the prompt when the panel opened by itself.');
  key('C-u');
  result.opensByItself = 'on STARTED, the four reviewer sessions of two passes over two shards running, the prompt keeps the keyboard';

  // 2. A click on a row opens that session in a tab; back in the conversation the panel is there again.
  await click('Review pass 2/2 shard 1/2');
  // The tab shows the beginning of the session's title, which names the pass; the session's own view has the title
  // in full, over two rows beside the session's first message.
  await see(new RegExp(`^.*Panel fixture.*\\[AZPR ${review}\\] Review pass 2`, 'm'), 'A click on a session row did not open that session in a tab.');
  await see(new RegExp(`\\[AZPR ${review}\\] Review pass 2/2 *\\n[^\\n]*\\bshard 1/2`), 'The session that opened is not the one whose row was clicked.');
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
  await see(/F-1 — `invoice` drops the guard/, 'The summary cell does not show its text literally.');
  // The report waits in the session of the last stage, the severity rating: the one session the review keeps.
  // The other five (four reviewer sessions and the duplicate check) were deleted, and are counted.
  await see(/○ Severity rating \(report\) complete ses_/, 'The session that holds the report is not listed.');
  await see(/5 session\(s\) were deleted when their run ended\./, 'The panel does not say that the sessions of the reviewers and of the duplicate check were deleted.');
  assert.doesNotMatch(screen(), /[●○] (?:Review pass|Duplicate check)/, 'A deleted session is still listed.');
  // No preview follows this review by itself (afterReview is none in this fixture), so the panel offers one, and
  // the findings to adjust before it; nothing can be posted before a preview was read.
  await see(/\[c\] Preview comments\s+\[a\] Adjust findings…/, 'After a review that no preview follows the panel does not offer one, and the findings to adjust before it.');
  assert.doesNotMatch(screen(), /\[p\] Post \d+ comments?/);
  const receipt = (await inbox()).findLast(text => text.startsWith(`[AZPR ${review}] COMPLETE`));
  assert.doesNotMatch(receipt, /<azpr_report_data>/, 'With returnReport: receipt the report is only in its session; the panel read it there.');
  // The receipt states status, coverage and verification apart, and names every stage that ran: the four
  // reviewer sessions by their pass and shard, then the duplicate check and the rating, both with the first model.
  assert.equal(receipt.split('\n')[0], `[AZPR ${review}] COMPLETE; coverage complete, 6/6 file(s) in every pass; verification none`);
  assert.deepEqual(stageLines(receipt), [...REVIEWER_STAGES('COMPLETE'), `azpr-review-dedupe: COMPLETE; model=fixture/${FIRST}`, `azpr-review-rating: COMPLETE; model=fixture/${FIRST}`]);
  assert.match(receipt, /\nSession notice: 5 reviewer session\(s\) of this run were deleted when it ended; only a session that holds the report or draft is kept \(deletePrivateSessions\)\. debug\.enabled keeps them all\.\n/);
  const reportSession = /^- azpr-review-rating: COMPLETE; session=(ses_[A-Za-z0-9]+)/m.exec(receipt)[1];
  assert.ok(receipt.includes(`\nReport delivery: report queued to session=${reportSession}.\n`), 'The report is not queued to the session of the rating.');
  assert.match(screen(), new RegExp(`○ Severity rating \\(report\\) complete ${reportSession.slice(0, 12)}`), 'The row of the report session does not name that session.');
  result.report = 'rendered from the inbox of the session that holds it, the rating\'s; the five deleted sessions counted';

  // 4. A comment preview: its run opens the panel as well, and the preview replaces the report.
  await click('close');
  await see(shown => !panelOpen(shown), 'The panel did not close.');
  await command('pr-comment', 'Preview, adjust or publish review comments', '');
  const preview = (await see(/AZPR ([a-f0-9]{8}) · PREVIEW/, 'The preview did not open the panel.', 120000))[1];
  await see(new RegExp(`\\[AZPR ${preview}\\] PREVIEW; source review=${review}`), 'The panel does not name the preview it shows.');
  // The preview as it would be posted, rendered: its disclosure line comes first, and names the method of this
  // pipeline and the models of both passes (the conversation shows the model names in backticks, the panel draws
  // them as code, so only the panel has the line in these words).
  await see(wrapped(`AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification. Models: fixture/${FIRST}, fixture/${SECOND}`), 'The preview is not shown with its disclosure line.');
  // The levels are the rating's: the reviewers filed every finding as medium, and the finding the duplicate check
  // merged is not counted.
  await see(/high: 4 · medium: 0 · low: 2/, 'The preview\'s summary is not shown, or its levels are not those of the rating.');
  assert.equal(azure.state.threads.length, 0, 'A preview posts nothing.');
  // What the preview offers next, as the receipt names it, is listed in the panel: the summary and four comments
  // can be posted, and the findings adjusted. Nothing was adjusted yet, so there is nothing to undo.
  await see(/\[p\] Post 5 comments…\s+\[a\] Adjust findings…/, 'The panel does not list what the preview offers, posting first.');
  assert.doesNotMatch(screen(), /\[u\] Reset adjustments/);
  // They are one row at the panel's foot: on the line of the host's status bar, under a line that is level with
  // the lower edge of the prompt, with the last row of the screen empty on both sides.
  const foot = screen().split('\n');
  const offered = foot.findIndex(line => /\[p\] Post 5 comments…/.test(line));
  assert.match(foot[offered], /ctrl\+p\s+commands\s+\[p\] Post 5 comments…/, 'The row is not level with the status bar.');
  assert.match(foot[offered - 1], /▀\s+─{40,}/, 'No line separates the row from the preview, level with the lower edge of the prompt.');
  assert.equal(foot.slice(offered + 1).join('').trim(), '', 'Something is drawn under the row.');
  result.preview = 'opens the panel and replaces the report; its next steps are listed';

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
  // With the default setting only a notice that offers a next step carries metadata, and only that offer: the
  // start of a run (it can be stopped), the receipt of the review (no preview follows it by itself here), each
  // preview, and the saved preview shown again.
  for (const item of await queued()) {
    const offers = /^\[AZPR [a-f0-9]{8}\] (?:STARTED \/pr-|PREVIEW;|COMPLETE; coverage complete, 6\/6 file\(s\) in every pass; verification none\n)|^\[AZPR\] Saved preview /.test(item.payload?.text ?? '');
    assert.deepEqual(Object.keys(item.payload?.metadata?.azpr ?? {}), offers ? ['next'] : [], (item.payload?.text ?? '').slice(0, 60));
    assert.equal(item.payload?.metadata === undefined, !offers);
  }
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
  assert.deepEqual(kept.map(session => [session.metadata.azpr.role, session.id]), [['azpr-review-rating', reportSession]], 'The review keeps the session that holds its report: the one of the last stage, the rating.');
  tmux('kill-server');
  // A person talks to the conversation's own model: every notice that waited in its inbox is delivered, so the
  // inbox is empty and what AZPR told the conversation is among its messages. The notices are steered, so the
  // host hands them to that model together with the prompt, in one request (it would give each queued notice a
  // turn of its own); only this prompt of the fixture's makes the conversation's model run at all.
  const asked = requests.length;
  assert.ok(requests.every(request => request.model !== 'chat'), 'Until here the conversation\'s own model was never asked.');
  await api(`/api/session/${origin}/prompt`, { text: 'Thanks. Anything else?' });
  await api(`/api/experimental/session/${origin}/wait`, {});
  const turns = requests.slice(asked);
  assert.ok(turns.every(request => request.model === 'chat' && request.sessionID === origin), 'Only the conversation\'s own model ran, in the conversation.');
  assert.equal(turns.length, 1, 'The prompt and every notice that waited reached the conversation\'s model in one request.');
  assert.deepEqual(await inbox(), [], 'The notices were delivered: none waits in the conversation\'s inbox.');
  const told = (await api(`/api/session/${origin}/context`)).data.filter(message => message.type === 'synthetic').length;
  assert.ok(told >= 10, 'They are among the conversation\'s messages.');
  await openTerminal(170, 46, kept[0].id);
  await command('pr-panel', 'The sessions of the review in this conversation');
  // The last thing the conversation was told is the saved preview shown again in step 8, which is about the review.
  await see(new RegExp(`AZPR ${review} · COMPLETE`), 'In the report session the panel does not show what the conversation was told last.');
  await see(new RegExp(`\\[AZPR\\] Saved preview of review ${review}`), 'It does not show the document read from the conversation\'s notices.');
  await see(/○ Severity rating \(report\) complete ses_/, 'The session on screen is not listed as the one holding the report.');
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

  // 10. What the preview offers is picked instead of typed. The panel is read to its end first, and the prompt
  // has the keyboard, as it has for a person who reads with the mouse: a key of the panel is a letter there.
  await see(/\[p\] Post 5 comments…\s+\[a\] Adjust findings…/, 'The panel does not list what the preview offers next.');
  await click('Sessions (click one to open it)');
  key('End');
  await see(shown => panelOpen(shown) && !/Sessions \(click one to open it\)/.test(shown) && /\[a\] Adjust findings…/.test(shown), 'The row did not stay in its place while the preview scrolled to its end.');
  key('C-x'); key('Left');
  type('p');
  await see(/┃\s+p\s/, 'The prompt did not get the keyboard back.');
  assert.doesNotMatch(screen(), /Post these comments on the pull request\?/, 'A key of the panel acted while the prompt had the keyboard.');
  key('C-u');
  // A click on one of them opens the list of findings: the findings come first, and nothing is to apply yet.
  await click('Adjust findings…');
  await see(/Adjust the findings before posting/, 'A click did not open the list of findings.');
  assert.doesNotMatch(screen(), /Apply, and plan the preview|apply ctrl\+s/, 'Something is to apply before anything was changed.');
  // Typing filters the list; the finding typed in full comes first.
  type('F-1');
  await see(/Findings[^\n]*\n[^\n]*F-1 — `invoice` drops the guard\b[^\n]* high\b/, 'Typing does not filter the findings.');
  key('Enter');
  await see(/F-1: how is it published\?/, 'Picking a finding did not ask what happens to it.');
  // The level the review gave it is the rating's: its reviewer filed it as medium.
  await see(/As high +The level the review gave it/, 'The review\'s own level is not marked, or it is not the level the rating set.');
  type('Leave');
  await sleep(400);
  key('Enter');
  // The list is back: its last row applies the change and says what changes, and so does the foot of the dialog,
  // which stays in view however long the list is. A click there applies it.
  await see(/Apply, and plan the preview again/, 'The list did not come back with the row that applies the change.');
  await see(/F-1 left out/, 'The row that applies the change does not say what changes.');
  await click('apply ctrl+s');
  const adjustedRun = (await see(shown => { const match = /AZPR ([a-f0-9]{8}) · PREVIEW/.exec(shown); return match && match[1] !== typedHere && match; }, 'The adjustment picked in the panel did not plan a new preview.', 120000))[1];
  // The preview that was planned again is shown from its beginning, though the one before it was read to its end.
  await see(/Sessions \(click one to open it\)/, 'The new preview is not shown from its beginning.');
  await see(/Excluded from publication: F-1/, 'The new preview does not say what a person left out.');
  await see(/high: 3 · medium: 0 · low: 2/, 'The new preview still counts the finding that was left out.');
  await see(/\[p\] Post 4 comments…\s+\[a\] Adjust findings…\s+\[u\] Reset adjustments/, 'The row does not count what is left, or does not offer to reset the adjustment.');
  assert.ok((await own()).some(text => text.startsWith(`[AZPR ${adjustedRun}] PREVIEW; source review=${review}`) && /Adjusted by a person: excluded F-1\./.test(text)), 'The runtime took the command as a typed one, in the session on screen.');
  assert.equal(azure.state.threads.length, 0, 'An adjustment posts nothing.');
  // The clicks were buttons pressed: the prompt still has the keyboard.
  type('still-with-the-prompt');
  await see(/┃\s+still-with-the-prompt/, 'A click on the row took the keyboard from the prompt.');
  key('C-u');
  // Text is selected with the mouse, from the preview down to the row, and let go over a step. The release ends
  // the selection and is no click: `Reset adjustments` asks nothing, so a click there would have started a run.
  const toldBefore = (await own()).length;
  await dragInPanel('PR Review Summary', 'Reset adjustments');
  await sleep(2000);
  assert.equal((await own()).length, toldBefore, 'The end of a selection over a step sent that step\'s command.');
  assert.match(screen(), new RegExp(`AZPR ${adjustedRun} · PREVIEW`), 'The end of a selection over a step changed what the panel shows.');
  // The button is pressed on that step and let go after the pointer has left it, as a person does who thinks
  // better of it. OpenTUI sends that release to the step that was pressed: it is not picked either.
  await dragInPanel('Reset adjustments', 'Sessions (click one to open it)');
  await sleep(2000);
  assert.equal((await own()).length, toldBefore, 'A step that was pressed and then left was picked.');
  assert.match(screen(), new RegExp(`AZPR ${adjustedRun} · PREVIEW`), 'A step that was pressed and then left changed what the panel shows.');
  // The button is pressed on that step, moved on it and never let go: the pointer left the terminal there, and
  // the release was lost. OpenTUI 0.9 (OpenCode 2.4.0 and later) ends such a gesture at the next press of the
  // button, wherever that is, with a release it makes up for the step that was pressed, at the place of the
  // last movement. It comes more than a moment after that movement, so it picks nothing. (An earlier OpenTUI
  // sends the step the next press and its release, which is not on the step.)
  await pressAndHold('Reset adjustments');
  await sleep(2500);
  await click('Sessions (click one to open it)');
  await sleep(2000);
  assert.equal((await own()).length, toldBefore, 'A release the host made up for a step that was pressed long before picked that step.');
  assert.match(screen(), new RegExp(`AZPR ${adjustedRun} · PREVIEW`), 'A release the host made up changed what the panel shows.');
  // With the keyboard, the panel's keys do the same: `a` opens the list, and the key at its foot applies.
  await click('Sessions (click one to open it)');
  key('a');
  await see(/Adjust the findings before posting/, 'The key did not open the list of findings.');
  type('F-2');
  await sleep(400);
  key('Enter');
  await see(/F-2: how is it published\?/, 'Picking the second finding did not ask what happens to it.');
  type('Leave');
  await sleep(400);
  key('Enter');
  await see(/apply ctrl\+s/, 'The foot of the list does not offer to apply the change.');
  key('C-s');
  const secondRun = (await see(shown => { const match = /AZPR ([a-f0-9]{8}) · PREVIEW/.exec(shown); return match && match[1] !== adjustedRun && match[1] !== typedHere && match; }, 'The key at the foot of the list did not apply the adjustment.', 120000))[1];
  await see(/Excluded from publication: F-1, F-2/, 'The second adjustment did not keep the first.');
  await see(/\[p\] Post 3 comments…/, 'The row does not count what is left after the second adjustment.');
  assert.ok((await own()).some(text => text.startsWith(`[AZPR ${secondRun}] PREVIEW; source review=${review}`)), 'The second adjustment has no receipt in the session on screen.');
  assert.equal(azure.state.threads.length, 0, 'An adjustment posts nothing.');
  // Posting asks first, with "no" first: Enter alone posts nothing. The key works while the panel has the keyboard.
  await click('Sessions (click one to open it)');
  key('p');
  await see(/Post these comments on the pull request\?/, 'The key did not ask before posting.');
  await see(/No, post nothing/, 'Declining is not offered.');
  key('Enter');
  await see(shown => !/Post these comments on the pull request\?/.test(shown), 'The question did not close.');
  await sleep(1500);
  assert.equal(azure.state.threads.length, 0, 'Declined: nothing was posted.');
  await click('Sessions (click one to open it)');
  key('p');
  await see(/Post these comments on the pull request\?/, 'The key did not ask again.');
  type('Yes');
  await sleep(400);
  key('Enter');
  const postedRun = (await see(shown => { const match = /AZPR ([a-f0-9]{8}) · ([A-Z_]+)/.exec(shown); return match && match[1] !== secondRun && match[2] !== 'RUNNING' && match; }, 'Posting picked in the panel did not end with a receipt.', 120000));
  assert.equal(postedRun[2], 'POSTED', `The publication ended as ${postedRun[2]}.`);
  assert.equal(azure.state.threads.length, 3, 'The summary and the two comments that were not left out are on the PR.');
  await see(shown => !/\[p\] Post \d+ comments?…/.test(shown), 'After posting the panel still offers the preview\'s steps.');
  // `close` acts on a release alone, like a session's row, so it keeps the same watch: pressed, moved on and never
  // let go, it does not close the panel at a press somewhere else. That press is on text that can be selected (the
  // panel's own status), and it is the last thing done in this terminal: an OpenTUI before 0.9 keeps such a
  // gesture for the next press on what cannot be selected.
  await pressAndHold('close');
  await sleep(2500);
  await click(`AZPR ${postedRun[1]} · POSTED`);
  await sleep(2000);
  assert.ok(panelOpen(screen()), 'A release the host made up for "close" closed the panel.');
  result.rows = `${result.rows}; after a preview its next steps are one row at the panel's foot: findings left out from their list (applied with a click and with the key at its foot) and the comments posted without typing; a click leaves the keyboard with the prompt`;

  // What the panel must never do: ask a model, or fail to load.
  const conversationTurns = requests.filter(request => request.model === 'chat');
  assert.deepEqual([...new Set(requests.map(request => request.model))].sort(), ['chat', FIRST, SECOND].sort());
  assert.deepEqual(conversationTurns, turns, 'Only AZPR\'s reviewers, duplicate check, rating and planner asked a model, and the fixture\'s own prompt the conversation\'s: the panel asked none.');
  // Which model each stage asked: the second reviewer model only reviews; the first one also checks the
  // duplicates, rates (without tools) and plans the comments.
  assert.deepEqual([...new Set(requests.filter(request => request.model === SECOND).map(request => request.stage))], ['review']);
  // (A grouping pass before the planning pages runs only where findings could share a page; it is the planner's.)
  assert.deepEqual([...new Set(requests.filter(request => request.model === FIRST).map(request => request.stage ?? request.work))].filter(kind => kind !== 'group').sort(), ['duplicates', 'plan', 'rating', 'review']);
  const ratingRequests = requests.filter(request => request.stage === 'rating');
  assert.deepEqual(ratingRequests.map(request => [request.model, request.tools, request.sessionID]), [[FIRST, 0, reportSession]], 'One rating request, of the first reviewer model, without tools, in the session that then holds the report.');
  assert.equal(requests.filter(request => request.stage === 'duplicates').length, 1, 'One duplicate check: one file holds findings of two sessions.');
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
