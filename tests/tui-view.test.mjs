import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

// The compiled view imports what the host provides (@opentui/solid, @opentui/core, solid-js), which a test has
// not. Stand-ins take their place: elements are plain objects that keep their properties and children, a
// signal is a value, an effect runs once, and a component that would be created is noted with its properties.
// That is enough for what draws nothing (the wiring of setup) and for one component a test runs itself: the
// field a token is typed into.
const source = await readFile(new URL('../src/tui.js', import.meta.url), 'utf8');
const imported = {};
for (const [, list, from] of source.matchAll(/^import \{([^}]+)\} from "(@opentui\/solid|@opentui\/core|solid-js)";$/gm)) {
  for (const item of list.split(',')) (imported[from] ??= new Set()).add(item.trim().split(/\s+as\s+/)[0]);
}
const STAND_INS = {
  createElement: 'export function createElement(tag) { return { tag, props: {}, children: [], focused: 0, focus() { this.focused++; } }; }',
  createTextNode: 'export function createTextNode(text) { return { text }; }',
  insertNode: 'export function insertNode(parent, node) { parent.children.push(node); }',
  setProp: 'export function setProp(node, name, value) { node.props[name] = value; return value; }',
  // What is inserted is kept as it is: a function is what the screen would show at that moment.
  insert: 'export function insert(parent, value) { parent.children.push({ shows: value }); }',
  createComponent: 'export function createComponent(component, props) { const created = { component, props }; (globalThis.azprCreated ??= []).push(created); return created; }',
  effect: 'export function effect(run, initial) { run(initial); }',
  memo: 'export function memo(read) { return read; }',
  use: 'export function use(run, node) { run(node); }',
  createSignal: 'export function createSignal(value) { return [() => value, next => { value = typeof next === "function" ? next(value) : next; }]; }',
  createMemo: 'export function createMemo(read) { return read; }',
  createEffect: 'export function createEffect(run) { run(); }',
  onMount: 'export function onMount(run) { (globalThis.azprMounted ??= []).push(run); }',
  onCleanup: 'export function onCleanup(run) { (globalThis.azprCleanups ??= []).push(run); }',
  // What the panel takes from the renderer: a button's number, a text attribute, and a style it hands on.
  MouseButton: 'export const MouseButton = { LEFT: 0, RIGHT: 2 };',
  TextAttributes: 'export const TextAttributes = { BOLD: 1, UNDERLINE: 8 };',
  SyntaxStyle: 'export const SyntaxStyle = { fromStyles: styles => ({ styles, destroy() {} }) };',
};
const stubs = Object.fromEntries(Object.entries(imported).map(([from, names]) => [from, [...names].map(name => STAND_INS[name] ?? `export function ${name}() {}`).join('\n')]));
register(`data:text/javascript,${encodeURIComponent(`
const stubs = ${JSON.stringify(stubs)};
export async function resolve(specifier, context, next) {
  return Object.hasOwn(stubs, specifier) ? { url: 'azpr-stub:' + specifier, shortCircuit: true } : next(specifier, context);
}
export async function load(url, context, next) {
  return url.startsWith('azpr-stub:') ? { format: 'module', shortCircuit: true, source: stubs[url.slice('azpr-stub:'.length)] } : next(url, context);
}`)}`);
const { default: plugin } = await import('../src/tui.js');

const TOKEN = 'tui-view-token-0123456789abcdefghijklmnopqrstuvwxyz';
const ITSELF = Symbol('the component answers itself');
// For the token field: no four characters of it occur in anything the dialogs say.
const SECRET = 'q7Zx9Lm2Vb4Nc6Jh8Gf0Ds1Ap3Ko5Iu7Yt9Rw2Eq4Tz6Xc8';
const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * A terminal UI as the setup part sees it: sessions of two project directories, the dialogs (answered from
 * `answers`, in order; a function is called with the dialog's options), and the RPC of a server part per
 * directory (`server`, whose methods a test replaces).
 */
function tui(answers = [], { state = 'ready', without } = {}) {
  const log = { calls: [], toasts: [], shown: [], invalidated: [], synced: [], unsubscribed: 0, stopped: 0 };
  const queue = [...answers];
  const next = (kind, options) => {
    log.shown.push(`${kind}: ${options.title ?? ''}`);
    if (!queue.length) throw new Error(`No answer was scripted for the ${kind} "${options.title}".`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  };
  const rows = [
    { id: 'organization', group: 'Azure DevOps', label: 'Organization', kind: 'text', title: 'Azure DevOps organization', description: 'The name.', value: 'fixture', current: 'fixture' },
    { id: 'token', group: 'Azure DevOps', label: 'Access token', kind: 'secret', title: 'Personal access token', description: 'Create one.', value: 'saved', saved: true },
  ];
  const status = () => ({ version: 1, state, problem: '', editable: true, fileProblem: '', settingsFile: '/settings.json', settingsFileShown: '/settings.json', organization: 'fixture', rows });
  const server = { status: async () => status(), validate: async () => ({ ok: true, values: {}, shown: {} }), check: async input => ({ ok: true, organization: input.organization }), save: async () => ({ ok: true, status: status() }) };
  const handlers = { listen: [], events: {}, command: null };
  const rpc = { events: { on(name, handler) { handlers.events[name] = handler; return () => { log.unsubscribed++; }; } } };
  for (const method of ['status', 'validate', 'check', 'save']) {
    rpc[method] = async (input, options) => { log.calls.push({ method, directory: options?.location?.directory, ...(input.token ? { token: true } : {}) }); return server[method](input); };
  }
  const screen = { route: { type: 'session', sessionID: 'a' } };
  const context = {
    location: { directory: '/projects/home' },
    ui: {
      router: { current: () => screen.route },
      toast: { show: options => log.toasts.push(options) },
      dialog: {
        select: async options => next('select', options), prompt: async options => next('prompt', options), confirm: async options => next('confirm', options),
        alert: async options => { log.shown.push(`alert: ${options.title}`); },
        // AZPR's own token field: the test answers it through the component that would be drawn, or runs the
        // component itself (ITSELF) and types into it.
        show(render, onClose) {
          const created = render();
          log.shown.push(`secret: ${created.props.options.title ?? ''}`);
          if (!queue.length) throw new Error('No answer was scripted for the token field.');
          const answer = queue.shift();
          Promise.resolve(typeof answer === 'function' ? answer(created, onClose) : answer).then(value => value === ITSELF ? undefined : value === undefined ? onClose() : created.props.done(value));
        },
        clear() { log.cleared = (log.cleared ?? 0) + 1; },
      },
    },
    client: { rpc: definition => { assert.equal(definition.id, 'azpr.setup'); return rpc; } },
    keymap: { layer(factory) { handlers.command = factory().commands[0]; } },
    data: {
      listen(handler) { handlers.listen.push(handler); return () => { log.stopped++; }; },
      session: { get: id => ({ location: { directory: `/projects/${id}` } }) },
      location: {
        default: () => ({ directory: '/projects/default' }),
        model: { list: () => [], sync: async () => {} },
        provider: { list: () => [], sync: async () => {} },
        command: { invalidate: at => log.invalidated.push(at?.directory), sync: async at => { log.synced.push(at?.directory); } },
      },
    },
  };
  for (const path of without ?? []) { const parts = path.split('.'); const last = parts.pop(); delete parts.reduce((object, part) => object[part], context)[last]; }
  const notice = (sessionID, metadata) => handlers.listen.forEach(handler => handler({ details: { type: 'session.inbox.enqueued', data: { sessionID, item: { type: 'synthetic', payload: { metadata } } } } }));
  return { context, log, server, handlers, screen, notice, left: () => queue.length, places: () => log.calls.map(call => `${call.method}@${call.directory}`) };
}

test('the dialogs of one setup talk to one project\'s server part, also when another session comes on screen meanwhile', async t => {
  const ui = tui(['token', TOKEN, undefined]);
  t.after(plugin.setup(ui.context));
  assert.deepEqual([ui.handlers.command.id, ui.handlers.command.palette, ui.handlers.command.slash], ['azpr.setup', true, undefined], 'The palette has the settings; the slash command is the server part\'s.');
  // Azure DevOps takes a moment to answer the check; a session of another project comes on screen meanwhile.
  let answer;
  ui.server.check = () => new Promise(resolve => { answer = resolve; });
  ui.handlers.command.run();
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a', 'check@/projects/a']);
  ui.screen.route = { type: 'session', sessionID: 'b' };
  answer({ ok: true, organization: 'fixture' });
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a', 'check@/projects/a', 'save@/projects/a'], 'What was checked for one project is saved by that project\'s server part.');
  assert.deepEqual(ui.log.calls.at(-1), { method: 'save', directory: '/projects/a', token: true });
  assert.equal(ui.left(), 0);
  // Once that setup has ended, the next one talks to the server part of the session on screen then.
  const again = tui([undefined, undefined]);
  t.after(plugin.setup(again.context));
  again.handlers.command.run();
  await settle();
  again.screen.route = { type: 'session', sessionID: 'b' };
  again.handlers.command.run();
  await settle();
  assert.deepEqual(again.places(), ['status@/projects/a', 'status@/projects/b']);
  // Without a session on screen: the directory this terminal UI works in.
  const home = tui([undefined]);
  home.screen.route = { type: 'home' };
  t.after(plugin.setup(home.context));
  home.handlers.command.run();
  await settle();
  assert.deepEqual(home.places(), ['status@/projects/home']);
});

test('a setup that is open when the terminal part is unloaded saves nothing afterwards', async () => {
  const ui = tui(['token', TOKEN]);
  const stop = plugin.setup(ui.context);
  let answer;
  ui.server.check = () => new Promise(resolve => { answer = resolve; });
  ui.handlers.command.run();
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a', 'check@/projects/a']);
  stop();
  const before = [ui.log.shown.length, ui.log.toasts.length];
  answer({ ok: true, organization: 'fixture' });
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a', 'check@/projects/a'], 'The answer that arrived after the unload leads to no save.');
  assert.deepEqual([ui.log.shown.length, ui.log.toasts.length], before, 'And to no dialog and no toast.');
});

test('/pr-setup opens the dialogs only in the session on screen, and only for the notice the server part marks', async t => {
  const ui = tui([undefined]);
  const stop = plugin.setup(ui.context);
  t.after(stop);
  ui.notice('b', { azpr: { setup: true } });
  ui.notice('a', { azpr: { panel: 'manual' } });
  ui.notice('a', undefined);
  await settle();
  assert.deepEqual(ui.places(), [], 'Another session\'s notice, and a notice that is not setup\'s, open nothing.');
  ui.notice('a', { azpr: { setup: true } });
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a']);
  assert.deepEqual(ui.log.shown, ['select: AZPR settings']);
  stop();
  ui.notice('a', { azpr: { setup: true } });
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a'], 'Nothing opens after the part was unloaded.');
});

test('a first setup that was loaded makes the terminal UI read the commands again, for the project it was loaded in', async t => {
  const ui = tui();
  const stop = plugin.setup(ui.context);
  t.after(stop);
  ui.handlers.events.loaded({});
  await settle();
  assert.deepEqual([ui.log.invalidated, ui.log.synced], [['/projects/a'], ['/projects/a']]);
  stop();
  ui.handlers.events.loaded({});
  await settle();
  assert.deepEqual([ui.log.invalidated, ui.log.synced], [['/projects/a'], ['/projects/a']], 'Not after the part was unloaded.');
  assert.deepEqual([ui.log.unsubscribed, ui.log.stopped], [1, 1], 'The event subscription and the listener are given back.');
});

test('the hint is asked for a little after the terminal UI started, and no timer outlives the part', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = tui([], { state: 'required' });
  const stop = plugin.setup(ui.context);
  assert.deepEqual(ui.places(), []);
  t.mock.timers.tick(1500);
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a']);
  assert.deepEqual(ui.log.toasts, [{ message: 'AZPR is not set up yet. Type /pr-setup to set it up.', variant: 'info', duration: 8000 }]);
  t.mock.timers.tick(6000);
  await settle();
  assert.equal(ui.log.toasts.length, 1, 'Said once.');
  // Unloaded before the timers ran: nothing is asked of the host any more.
  const gone = tui([], { state: 'required' });
  plugin.setup(gone.context)();
  t.mock.timers.tick(10000);
  await settle();
  assert.deepEqual([gone.places(), gone.log.toasts], [[], []]);
});

test('on a host without the dialogs or the RPC the setup part stays out of the way', () => {
  for (const missing of ['ui.dialog.show', 'ui.dialog.select', 'ui.toast.show', 'client.rpc', 'keymap.layer', 'data.listen', 'data.location.model.list']) {
    const ui = tui([], { without: [missing] });
    const stop = plugin.setup(ui.context);
    assert.equal(typeof stop, 'function', missing);
    stop();
    assert.equal(ui.handlers.command, null, missing);
    assert.deepEqual([ui.handlers.listen.length, ui.log.calls.length], [0, 0], missing);
  }
});

/** The token field as it would be mounted: its keys and pastes, and every text it shows at this moment. */
function mount(created) {
  globalThis.azprMounted = [];
  globalThis.azprCleanups = [];
  const root = created.component(created.props);
  const all = [];
  (function walk(node) { all.push(node); for (const child of node.children ?? []) walk(child); })(root);
  const box = all.find(node => node.props?.onKeyDown);
  const mounted = globalThis.azprMounted, cleanups = globalThis.azprCleanups;
  mounted.forEach(run => run());
  const shown = () => all.flatMap(node => node.text !== undefined ? [node.text] : node.shows === undefined ? []
    : [typeof node.shows === 'function' ? node.shows() : node.shows]).filter(text => typeof text === 'string');
  return {
    box, shown,
    type: text => { for (const character of text) box.props.onKeyDown({ name: character, sequence: character, preventDefault() {} }); },
    key: event => box.props.onKeyDown({ preventDefault() {}, ...event }),
    paste: text => box.props.onPaste({ bytes: new TextEncoder().encode(text), preventDefault() {} }),
    unmount: () => cleanups.forEach(run => run()),
  };
}
/** Whether a text shows any four characters of the token in a row. */
const leaks = (text, token = SECRET) => { for (let at = 0; at + 4 <= token.length; at++) if (text.includes(token.slice(at, at + 4))) return true; return false; };

test('the token field takes keys and pastes itself and draws only bullets and a count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let field, closed = 0;
  const ui = tui(['token', (created, onClose) => { field = mount(created); field.close = () => { closed++; onClose(); }; return ITSELF; }, undefined]);
  t.after(plugin.setup(ui.context));
  ui.handlers.command.run();
  await settle();
  assert.deepEqual(ui.log.shown, ['select: AZPR settings', 'secret: Personal access token']);
  // Mounted: the field takes the keyboard a moment later, and again when it is clicked.
  assert.equal(field.box.focused, 0);
  t.mock.timers.tick(1);
  assert.equal(field.box.focused, 1);
  field.box.props.onMouseDown();
  assert.equal(field.box.focused, 2);
  assert.deepEqual(field.shown().filter(text => /token here|hidden/.test(text)), ['Paste the token here; it is not shown']);
  assert.ok(field.shown().some(text => text.includes('Leave it empty to keep the saved token')), 'The description is the server part\'s, with what the dialog adds.');

  // Typed characters, a paste with blanks and line breaks around and inside it, and keys that are no characters.
  field.type(SECRET.slice(0, 5));
  field.paste(`  ${SECRET.slice(5, 30)}\r\n ${SECRET.slice(30)}\n`);
  for (const event of [{ name: 'up', sequence: '\x1b[A' }, { name: 'tab', sequence: '\t' }, { name: 'c', ctrl: true, sequence: '\x03' }, { name: 'v', meta: true, sequence: 'v' },
    { name: 'f5', sequence: '\x1b[15~' }, { name: 'escape', sequence: '\x1b' }, { name: 'delete', sequence: '\x7f' }, {}, undefined]) field.key(event);
  field.type('é');
  assert.deepEqual(field.shown().filter(text => /hidden/.test(text)), [`${'•'.repeat(16)}  (${SECRET.length} characters, hidden)`], 'One key removed a character and one added one: the count is the token\'s.');
  assert.ok(!field.shown().some(text => leaks(text)), 'Nothing the field shows holds any part of what was entered.');
  assert.equal(ui.places().length, 1, 'Nothing was sent while typing.');
  // Backspace removes the last character; ctrl+u everything; an empty field does not save unless the token may be kept.
  field.key({ name: 'backspace' });
  field.type(SECRET.at(-1));
  field.key({ name: 'u', ctrl: true });
  assert.deepEqual(field.shown().filter(text => /token here|hidden/.test(text)), ['Paste the token here; it is not shown']);
  field.paste(SECRET);
  field.key({ name: 'return' });
  await settle();
  assert.deepEqual(ui.places(), ['status@/projects/a', 'check@/projects/a', 'save@/projects/a'], 'Enter hands the token to the server part, once.');
  assert.deepEqual(ui.log.calls.at(-1), { method: 'save', directory: '/projects/a', token: true });
  assert.ok(ui.log.cleared >= 1, 'The dialog is closed.');
  assert.ok(!JSON.stringify([ui.log.toasts, ui.log.shown]).includes(SECRET.slice(0, 8)), 'No toast and no dialog title holds it.');
  // Unmounted, the field has forgotten the value: a late Enter hands nothing on.
  field.unmount();
  field.key({ name: 'return' });
  await settle();
  assert.equal(ui.log.calls.filter(call => call.method === 'check').length, 1);
});

test('the token field keeps at most what a token can be, and an empty one is given only where a saved token may be kept', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answers = [];
  const open = async (optional, drive) => {
    let field;
    const done = value => answers.push(value);
    // The component as the dialog creates it, with properties of the test's own.
    const ui = tui(['token', created => { field = mount({ component: created.component, props: { context: created.props.context, options: { title: 'Personal access token', description: 'Create one.', optional }, done } }); return undefined; }, undefined]);
    t.after(plugin.setup(ui.context));
    ui.handlers.command.run();
    await settle();
    drive(field);
    field.unmount();
  };
  await open(false, field => { field.key({ name: 'enter' }); field.key({ name: 'kpenter' }); });
  assert.deepEqual(answers, [], 'A token that is required is not given empty.');
  await open(true, field => field.key({ name: 'return' }));
  assert.deepEqual(answers, [''], 'Empty keeps the saved token.');
  await open(false, field => {
    field.paste('x'.repeat(5000));
    assert.deepEqual(field.shown().filter(text => /hidden/.test(text)), [`${'•'.repeat(16)}  (2048 characters, hidden)`]);
    field.key({ name: 'return' });
  });
  assert.equal(answers.at(-1).length, 2048);
});

// ------------------------------------------------------------------------------------------- the panel's rows
const REVIEW = 'bb6a8570', RUN = '36ed1562', CONVERSATION = 'ses_conversation0000000000001';
const previewNotice = { text: `[AZPR ${RUN}] PREVIEW; source review=${REVIEW}\nActed on review ${REVIEW} (/pr-review) of PR #4 in Project/Repository.\n\n<azpr_comment_data>\n## PR Review Summary\n</azpr_comment_data>\nNext (no review ID is needed while ${REVIEW} is this conversation's current review):\n  /pr-comment --publish`,
  metadata: { azpr: { next: { review: REVIEW, target: `review ${REVIEW} (/pr-review) of PR #4 in Project/Repository`, publish: true, adjust: true, posts: 2,
    findings: [{ id: 'F-1', severity: 'medium', summary: 'a defect' }, { id: 'R-2', severity: 'low', original: 'high', summary: 'another' }] } } } };

/**
 * A terminal UI as the panel part sees it: one conversation on screen whose inbox holds a run's notices.
 * `arrive` adds a notice afterwards, `screen.panel` is the panel the host shows (none once it was closed), and
 * `focused` says whether the panel has the keyboard.
 */
function panelTui(notices, answers = [], { without, focused = true } = {}) {
  const log = { sent: [], shown: [], toasts: [] };
  const queue = [...answers], layers = [], slots = {};
  const entry = (notice, index) => ({ id: `msg_${String(index).padStart(6, '0')}`, type: 'synthetic', delivery: 'steer',
    payload: { text: notice.text, description: notice.text, ...(notice.metadata ? { metadata: notice.metadata } : {}) } });
  const entries = notices.map(entry);
  const arrive = notice => { entries.push(entry(notice, entries.length)); };
  const screen = { panel: { name: 'azpr.panel', sessionID: CONVERSATION } };
  const context = {
    // Colours that say which token they are.
    theme: { text: { base: 'base', muted: 'muted' }, markdown: { link: 'link', text: 'text' }, border: { base: 'rule' } },
    renderer: { idle: async () => {}, nativeScene: {} },
    ui: {
      slot(claim) { slots[claim.append] = claim.render; return () => {}; },
      panel: { open: () => true, close() {}, current: () => screen.panel },
      router: { navigate() {}, current: () => ({ type: 'session', sessionID: CONVERSATION }) },
      toast: { show: options => log.toasts.push(options) },
      dialog: { select: async options => {
        log.shown.push(options);
        if (!queue.length) throw new Error(`No answer was scripted for "${options.title}".`);
        const answer = queue.shift();
        return typeof answer === 'function' ? answer(options) : answer;
      } },
    },
    keymap: { layer(factory) { layers.push(factory); }, dispatch() {}, mode: { current: () => 'base' } },
    client: { session: { inbox: { list: async () => [] }, list: async () => ({ data: [] }), command: async input => { log.sent.push(input); } } },
    data: {
      listen: () => () => {},
      session: { get: id => (id === CONVERSATION ? { id, title: 'A conversation' } : undefined), list: () => [{ id: CONVERSATION, title: 'A conversation' }], status: () => 'idle', sync: async () => {},
        message: { list: () => [] }, pending: { list: id => (id === CONVERSATION ? entries : []) } },
    },
  };
  for (const path of without ?? []) { const parts = path.split('.'); const last = parts.pop(); delete parts.reduce((object, part) => object[part], context)[last]; }
  const stop = plugin.setup(context);
  // The panel as the host would draw it in the conversation: its keys, and the rows of what can be done next.
  const input = { name: 'azpr.panel', sessionID: CONVERSATION, width: 96, presentation: 'panel', focused, focus() {}, close() {} };
  globalThis.azprMounted = [];
  globalThis.azprCleanups = [];
  const shown = slots['session.panel'](input).props.children;
  const root = shown.component(shown.props);
  const commands = layers.flatMap(factory => factory().commands ?? []);
  const command = id => commands.find(item => item.id === id);
  // The rows are drawn by <For>, whose child draws one of them: a row is clicked like the session rows.
  const all = [];
  (function walk(node) { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children ?? []) walk(child.shows ?? child); })(root);
  const lists = () => all.filter(node => typeof node.props?.children === 'function' && Array.isArray(node.props.each)).map(node => ({ each: node.props.each, draw: node.props.children }));
  const sections = all.filter(node => node.component && Object.getOwnPropertyDescriptor(node.props, 'children')?.get).flatMap(node => { const inner = []; (function walk(child) { if (!child || typeof child !== 'object') return; inner.push(child); for (const next of child.children ?? []) walk(next.shows ?? next); })(node.props.when ? node.props.children : undefined); return inner; });
  const rowLists = [...lists(), ...sections.filter(node => typeof node.props?.children === 'function' && Array.isArray(node.props.each)).map(node => ({ each: node.props.each, draw: node.props.children }))];
  const rows = rowLists.flatMap(list => list.each.filter(item => item && typeof item === 'object' && 'key' in item).map(item => {
    const created = list.draw(item);
    return { item, element: created.component(created.props) };
  }));
  // What the panel registered for the moment it is no longer drawn.
  const cleanups = globalThis.azprCleanups;
  return { context, log, stop, command, rows, arrive, screen, all: [...all, ...sections], undraw: () => cleanups.forEach(run => run()), left: () => queue.length };
}

test('what a preview offers is one row at the panel\'s foot: each sends /pr-comment for the review shown, to the session on screen, after asking', async t => {
  const ui = panelTui([previewNotice], [options => options.options[1].value]);
  t.after(ui.stop);
  assert.deepEqual(ui.rows.map(row => [row.item.id, row.item.key, row.item.label]), [['publish', 'p', 'Post 2 comments…'], ['adjust', 'a', 'Adjust findings…'], ['reset', 'u', 'Reset adjustments']]);
  // One of them: its key in brackets, then its label; the step the others lead to is drawn bold.
  const drawn = element => element.children.map(text => [text.props.fg, text.props.attributes, text.children.map(child => child.text ?? (typeof child.shows === 'function' ? child.shows() : child.shows)).join('')]);
  assert.deepEqual(drawn(ui.rows[0].element), [['link', undefined, '[p]'], ['base', 1, 'Post 2 comments…']]);
  assert.deepEqual(drawn(ui.rows[1].element), [['link', undefined, '[a]'], ['text', 0, 'Adjust findings…']]);
  // They wrap as whole items, under a line that crosses the panel, with an empty row below beside a conversation.
  const row = ui.all.find(node => node.props?.flexWrap === 'wrap');
  assert.deepEqual([row.props.flexDirection, row.props.columnGap], ['row', 3]);
  assert.deepEqual(ui.all.filter(node => Array.isArray(node.props?.border)).map(node => [node.props.border, node.props.borderColor, node.props.height]), [[['top'], 'rule', 1]]);
  for (const id of ['publish', 'adjust', 'reset']) assert.equal(ui.command(`azpr.panel.${id}`).enabled(), true, id);
  assert.deepEqual(['publish', 'adjust', 'reset'].map(id => ui.command(`azpr.panel.${id}`).bind), ['p', 'a', 'u'], 'The keys the rows show.');
  // A click on the first row: the question comes first, with "no" first.
  const publish = ui.rows[0].element;
  publish.props.onMouseUp({ button: 2, stopPropagation() {} });
  await settle();
  assert.equal(ui.log.shown.length, 0, 'Only the left button picks a row.');
  // A click is a button pressed: the host gives a panel the keyboard on mouse down, which the left button stops here.
  let kept = 0;
  publish.props.onMouseDown({ button: 2, stopPropagation() { kept++; } });
  assert.equal(kept, 0);
  publish.props.onMouseDown({ button: 0, stopPropagation() { kept++; } });
  assert.equal(kept, 1, 'The keyboard stays where it was.');
  publish.props.onMouseUp({ button: 0, stopPropagation() {} });
  await settle();
  assert.deepEqual(ui.log.shown.map(dialog => [dialog.title, dialog.options[0].title]), [['Post these comments on the pull request?', 'No, post nothing']]);
  assert.deepEqual(ui.log.sent, [{ sessionID: CONVERSATION, name: 'pr-comment', text: `${REVIEW} --publish` }]);
  // A key that would only type a letter into the prompt is drawn dim: its colour says that it works.
  const prompt = panelTui([previewNotice], [], { focused: false });
  t.after(prompt.stop);
  assert.deepEqual(prompt.rows.map(item => item.element.children[0].props.fg), ['muted', 'muted', 'muted']);
  // The key of a row does what a click on it does.
  const keys = panelTui([previewNotice], ['keep']);
  t.after(keys.stop);
  keys.command('azpr.panel.publish').run();
  await settle();
  keys.command('azpr.panel.reset').run();
  await settle();
  assert.deepEqual(keys.log.sent, [{ sessionID: CONVERSATION, name: 'pr-comment', text: `${REVIEW} --reset` }], 'Posting was declined; resetting asks nothing.');
  assert.equal(keys.left(), 0);
});

test('an answer counts only while the panel still shows that offer there: not after another notice, another session or a closed panel', async t => {
  const CHANGED = 'Nothing was sent: what the panel showed has changed since. Read it again, then pick.';
  const later = { ...previewNotice, text: previewNotice.text.replace(RUN, '4a3415af'), metadata: { azpr: { next: { ...previewNotice.metadata.azpr.next, posts: 5 } } } };
  // The preview was planned again while the question was open: what would be posted is not what was read.
  const replanned = panelTui([previewNotice], [options => { replanned.arrive(later); return options.options[1].value; }]);
  t.after(replanned.stop);
  replanned.command('azpr.panel.publish').run();
  await settle();
  assert.deepEqual([replanned.log.sent, replanned.log.toasts.map(toast => toast.message)], [[], [CHANGED]]);
  // The same holds for a run that started meanwhile, which offers nothing.
  const started = panelTui([previewNotice], [options => { started.arrive({ text: `[AZPR 4a3415af] STARTED /pr-comment. It acts on review ${REVIEW} (/pr-review) of PR #4 in Project/Repository. Stop with /pr-stop 4a3415af.` }); return options.options[1].value; }]);
  t.after(started.stop);
  started.command('azpr.panel.publish').run();
  await settle();
  assert.deepEqual([started.log.sent, started.log.toasts.map(toast => toast.message)], [[], [CHANGED]]);
  // The panel was closed, or the host shows another session's: the session the answer was for is not on screen.
  for (const [name, panel] of [['closed', undefined], ['another session', { name: 'azpr.panel', sessionID: 'ses_another00000000000000001' }], ['another plugin', { name: 'other.panel', sessionID: CONVERSATION }]]) {
    const ui = panelTui([previewNotice], [options => { ui.screen.panel = panel; return options.options[1].value; }]);
    t.after(ui.stop);
    ui.command('azpr.panel.publish').run();
    await settle();
    assert.deepEqual([ui.log.sent, ui.log.toasts.map(toast => toast.message)], [[], [CHANGED]], name);
  }
  // The panel is no longer drawn (its session left the screen while the dialog stayed open).
  const gone = panelTui([previewNotice], [options => { gone.undraw(); return options.options[1].value; }]);
  t.after(gone.stop);
  gone.command('azpr.panel.publish').run();
  await settle();
  assert.deepEqual(gone.log.sent, []);
  // Nothing of this happened: the answer is acted on.
  const same = panelTui([previewNotice], [options => options.options[1].value]);
  t.after(same.stop);
  same.command('azpr.panel.publish').run();
  await settle();
  assert.deepEqual([same.log.sent.map(command => command.text), same.log.toasts], [[`${REVIEW} --publish`], []]);
});

test('nothing is offered while a run is under way, for a preview without that data, or on a host that cannot send a command', async t => {
  const started = { text: `[AZPR 4a3415af] STARTED /pr-comment. Work continues in this OpenCode process; the result will return to this conversation. It acts on review ${REVIEW} (/pr-review) of PR #4 in Project/Repository. Stop with /pr-stop 4a3415af.` };
  for (const [name, ui] of [['a run under way', panelTui([previewNotice, started])], ['a preview of an earlier version', panelTui([{ text: previewNotice.text }])],
    ['no command to send', panelTui([previewNotice], [], { without: ['client.session.command'] })], ['no dialog to ask in', panelTui([previewNotice], [], { without: ['ui.dialog.select'] })]]) {
    t.after(ui.stop);
    assert.deepEqual(ui.rows, [], name);
    for (const id of ['publish', 'adjust', 'reset']) {
      assert.equal(ui.command(`azpr.panel.${id}`).enabled(), false, `${name}: ${id}`);
      ui.command(`azpr.panel.${id}`).run();
    }
    await settle();
    assert.deepEqual([ui.log.shown, ui.log.sent], [[], []], name);
  }
  // The panel's other keys are there as before.
  const plain = panelTui([{ text: previewNotice.text }]);
  t.after(plain.stop);
  assert.equal(typeof plain.command('azpr.panel.close').run, 'function');
});

test('an action that is open when the terminal part is unloaded sends nothing afterwards', async () => {
  let answer;
  const ui = panelTui([previewNotice], [() => new Promise(resolve => { answer = resolve; })]);
  ui.command('azpr.panel.publish').run();
  await settle();
  ui.stop();
  answer('post');
  await settle();
  assert.deepEqual(ui.log.sent, []);
});
