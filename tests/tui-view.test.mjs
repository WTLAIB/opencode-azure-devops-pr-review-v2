import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

// The compiled view imports what the host provides (@opentui/solid, @opentui/core, solid-js), which a test has
// not. Each name it imports is a function that does nothing here, which is enough for what draws nothing: the
// wiring of setup (which server part it talks to, when its dialogs open, what it leaves behind). A component
// that would be created is noted with its properties, so that a test can answer the token field.
const source = await readFile(new URL('../src/tui.js', import.meta.url), 'utf8');
const imported = {};
for (const [, list, from] of source.matchAll(/^import \{([^}]+)\} from "(@opentui\/solid|@opentui\/core|solid-js)";$/gm)) {
  for (const item of list.split(',')) (imported[from] ??= new Set()).add(item.trim().split(/\s+as\s+/)[0]);
}
const stubs = Object.fromEntries(Object.entries(imported).map(([from, names]) => [from, [...names].map(name => name === 'createComponent'
  ? 'export function createComponent(component, props) { (globalThis.azprCreated ??= []).push({ component, props }); }'
  : `export function ${name}() {}`).join('\n')]));
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
        // AZPR's own token field: the test answers it through the component that would be drawn.
        show(render, onClose) {
          render();
          const { props } = globalThis.azprCreated.at(-1);
          Promise.resolve(next('secret', props.options)).then(answer => answer === undefined ? onClose() : props.done(answer));
        },
        clear() {},
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
