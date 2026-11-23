import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_RPC, createSetup, isSetupNotice } from '../src/tui-setup.mjs';

const TOKEN = 'tui-setup-token-0123456789abcdefghijklmnopqrstuvwxyz';
const MODELS = [
  { id: 'fixture/fast', name: 'Fast', provider: 'Fixture AI', variants: [] },
  { id: 'fixture/strong', name: 'Strong', provider: 'Fixture AI', variants: ['low', 'high'] },
];
// What the server part says of settings of an earlier version: what their update changes, line by line, and the word that names it.
const UPDATE = Object.freeze({ word: '0123456789ab', lines: Object.freeze(['This version reviews with a list of reviewer models per mode.',
  '/pr-review: functional fixture/fast, risk fixture/strong, verifier fixture/strong -> 2 passes: fixture/fast, fixture/strong. The verifier model is no longer used.',
  'Every other setting stays as it is, also one that is not a setting of this version: the settings check then names it.']) });
const OUTDATED = 'settings.json is from AZPR 0.4.x (settings version 2): run /pr-setup to see what changes and to update the file.';

// A mode's models as the server part keeps, takes and shows them: a list with one entry per pass; as text MODEL*N
// for passes in a row and commas between entries, where a model alone is the mode's usual number of passes; and
// in a row's few words each model without its provider, with its number of passes.
const USUAL = Object.freeze({ reviewModel: 2, quickModel: 1, deepModel: 2 }), MOST = 4;
const runs = list => list.reduce((all, model) => { if (all.at(-1)?.[0] === model) all.at(-1)[1]++; else all.push([model, 1]); return all; }, []);
const listText = list => runs(list).map(([model, count]) => `${model}*${count}`).join(',');
const listShown = (list, empty) => list.length ? runs(list).map(([model, count]) => `${model.slice(model.indexOf('/') + 1)}${count > 1 ? ` ×${count}` : ''}`).join(' + ') : empty;
function listOf(id, answer, optional) {
  if (answer === '' || answer === 'off') { if (!optional) throw new Error('The model: select an actual provider/model ID.'); return []; }
  const entries = answer.split(',');
  const list = entries.flatMap(entry => { const [model, count] = entry.split('*'); return Array(count === undefined ? (entries.length === 1 ? USUAL[id] : 1) : Number(count)).fill(model); });
  if (!list.length || list.length > MOST) throw new Error(`These models take at most ${MOST} passes in all.`);
  return list;
}

/** A stand-in for the server part: the rows it describes and what it answers, as src/setup.mjs shapes them. */
function server(start = {}) {
  const state = { organization: '', proxy: '', caFile: '', reviewModel: [], quickModel: [], deepModel: [], language: 'en', afterReview: 'preview', token: false, state: 'required', editable: true, word: UPDATE.word, ...start };
  const checks = [];
  const optional = { quickModel: { label: 'Off', description: '/pr-quick stays off' }, deepModel: { label: 'Off', description: '/pr-deep stays off' } };
  const models = (id, label, command, more = {}) => ({ id, group: 'Models', label, kind: 'model', title: `Model for /pr-${command}`, hint: `for /pr-${command}`, ...more, ...(optional[id] ? { optional: optional[id] } : {}),
    value: listShown(state[id], optional[id] ? 'off' : 'not set'), current: listText(state[id]), entries: [...state[id]], usual: USUAL[id], most: MOST });
  const status = () => ({ version: 1, state: state.state, problem: state.problem ?? (state.state === 'required' ? 'there is no settings file yet.' : ''), editable: state.editable,
    fileProblem: state.editable ? '' : state.state === 'migrate' ? OUTDATED : 'The settings file is not valid JSON.',
    // Settings of an earlier version come with what their update changes and the word that confirms it.
    ...(state.state === 'migrate' ? { migration: { lines: [...UPDATE.lines], word: state.word } } : {}),
    settingsFile: '/home/user/.config/azpr/settings.json', settingsFileShown: '~/.config/azpr/settings.json', organization: state.organization,
    settingsReference: 'the README\'s section "All settings and defaults" (https://github.com/owner/repository#all-settings-and-defaults)',
    rows: [
      { id: 'organization', group: 'Azure DevOps', label: 'Organization', kind: 'text', title: 'Azure DevOps organization', description: 'The name in https://dev.azure.com/<organization>.', placeholder: 'my-organization', value: state.organization || 'not set', current: state.organization },
      { id: 'token', group: 'Azure DevOps', label: 'Access token', kind: 'secret', title: 'Personal access token', description: 'Create one at https://dev.azure.com/{organization}/_usersSettings/tokens.', value: state.token ? 'saved in ~/.config/azpr/pat' : 'not set', saved: state.token, bound: state.bound ?? state.token },
      { id: 'proxy', group: 'Azure DevOps', label: 'Proxy', kind: 'text', title: 'Proxy for Azure DevOps (optional)', description: 'Leave it empty and press Enter to skip.', placeholder: 'http://proxy.example.com:8080', value: state.proxy || 'none', current: state.proxy },
      { id: 'caFile', group: 'Azure DevOps', label: 'CA certificate file', kind: 'text', title: 'CA certificate file (optional)', description: 'Leave it empty and press Enter to skip.', value: state.caFile || 'none', current: state.caFile },
      models('reviewModel', 'Review models', 'review'),
      models('quickModel', 'Quick models', 'quick'),
      models('deepModel', 'Deep models', 'deep', { prompt: 'Stronger than the review model, or a higher variant', variantPrompt: 'A higher variant reasons longer' }),
      { id: 'language', group: 'Reviews', label: 'Output language', kind: 'choice', title: 'Language of reports and comments', value: state.language, current: state.language,
        choices: [{ value: 'en', label: 'English' }, { value: 'zh-TW', label: '繁體中文' }], other: { label: 'Another language', title: 'Language of reports and comments', description: 'A language tag.', placeholder: 'pt-BR' } },
      { id: 'afterReview', group: 'Reviews', label: 'After a review', kind: 'choice', title: 'After a completed review', value: state.afterReview, current: state.afterReview,
        choices: [{ value: 'preview', label: 'Show a comment preview' }, { value: 'none', label: 'Only the review' },
          { value: 'publish', label: 'Post the comments', confirm: { title: 'Post comments without a preview?', keep: 'No, keep the current setting', accept: 'Yes, post them after every review', message: 'Under your name' } }] },
    ] });
  const accept = (id, answer) => {
    const value = String(answer).trim();
    if (id === 'organization') {
      const name = /^https:\/\/dev\.azure\.com\/([^/]+)/.exec(value)?.[1] ?? value;
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) throw new Error('Use your Azure DevOps organization name.');
      return name;
    }
    if (id === 'proxy' && value && !/^https?:\/\//.test(value)) throw new Error('azure.proxy must be empty or a proxy URL.');
    if (id === 'language' && !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(value)) throw new Error('outputLanguage must be a language tag.');
    if (Object.hasOwn(USUAL, id)) return listOf(id, value, Boolean(optional[id]));
    return value;
  };
  return {
    state, checks,
    status: async () => status(),
    validate: async ({ changes }) => {
      try {
        const values = Object.fromEntries(Object.entries(changes).map(([id, answer]) => [id, accept(id, answer)]));
        const shown = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, id === 'proxy' ? value.replace(/\/\/[^@/]*@/, '//') : Array.isArray(value) ? listShown(value, 'off') : value]));
        // Like the server part: a proxy with a user name and password does not come back, only how it may be shown,
        // and a list of models comes back as its text.
        if (/\/\/[^@/]*@/.test(values.proxy ?? '')) delete values.proxy;
        for (const [id, value] of Object.entries(values)) if (Array.isArray(value)) values[id] = listText(value);
        return { ok: true, values, shown };
      } catch (error) { return { ok: false, problem: error.message }; }
    },
    check: async input => {
      checks.push(input);
      const scripted = state.checkAnswers?.shift();
      return scripted ?? { ok: true, organization: input.organization };
    },
    save: async ({ changes, token, organization, migrate }) => {
      if (state.saveProblem) return { ok: false, problem: state.saveProblem };
      if (migrate !== undefined) {
        // Like the server part: the update of earlier settings is saved by itself, for the word of the file as it is.
        if (changes !== undefined || token !== undefined || organization !== undefined) return { ok: false, problem: 'The update of the settings is saved by itself, before anything else is changed.' };
        if (state.state !== 'migrate' || migrate !== state.word) return { ok: false, problem: 'The settings file changed since the update was shown, or OpenCode was restarted since, so nothing was saved. Run /pr-setup again to see the update as it is now.' };
        Object.assign(state, { state: state.afterSave ?? 'ready', editable: true });
        // A file that had a fault keeps it: the answer says what the updated file still lacks.
        return { ok: true, status: status(), ...(state.remaining === undefined ? {} : { remaining: state.remaining }) };
      }
      // Until then no setting of theirs is changed.
      if (state.state === 'migrate') return { ok: false, problem: OUTDATED };
      try {
        for (const [id, answer] of Object.entries(changes ?? {})) {
          // The one model of a first setup: the usual passes of /pr-review and of /pr-quick.
          if (id === 'model') Object.assign(state, { reviewModel: accept('reviewModel', answer), quickModel: accept('quickModel', answer) });
          else state[id] = accept(id, answer);
        }
      } catch (error) { return { ok: false, problem: error.message }; }
      if (token !== undefined) state.token = true;
      state.state = state.state === 'required' ? (state.afterSave ?? 'ready') : 'restart';
      return { ok: true, status: status(), ...(state.saveNote ? { note: state.saveNote } : {}) };
    },
  };
}

/**
 * Setup with dialogs that answer from a list, in order; every dialog, toast and RPC call is recorded.
 * `models` is what the host offers, or a function that says it each time it is asked.
 */
function host(fake, answers, { models = MODELS } = {}) {
  const calls = [], shown = [], toasts = [], loaded = [], pins = [];
  const queue = [...answers];
  const next = (kind, options) => {
    shown.push({ kind, ...options });
    if (!queue.length) throw new Error(`No answer was scripted for the ${kind} "${options.title}".`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  };
  const setup = createSetup({
    call: async (method, input) => { calls.push({ method, input }); return fake[method](input); },
    dialog: { prompt: async options => next('prompt', options), select: async options => next('select', options), confirm: async options => next('confirm', options),
      alert: async options => { shown.push({ kind: 'alert', ...options }); } },
    secret: async options => next('secret', options),
    toast: options => toasts.push(options),
    models: async () => (typeof models === 'function' ? models() : models),
    loaded: () => loaded.push(shown.length),
    // How many calls had been made when the place was fixed, and when it was let go.
    pin: () => { pins.push(`pin@${calls.length}`); return () => pins.push(`release@${calls.length}`); },
  });
  const said = () => JSON.stringify([shown, toasts]);
  return { setup, calls, shown, toasts, said, loaded, pins, left: () => queue.length, titles: () => shown.map(item => `${item.kind}: ${item.title}`) };
}
const methods = h => h.calls.map(call => call.method);
/** What was saved, in order: the input of every save. */
const saves = h => h.calls.filter(call => call.method === 'save').map(call => call.input);

test('the RPC of setup has four methods with schemas that never quote a refused input', () => {
  assert.equal(SETUP_RPC.id, 'azpr.setup');
  assert.deepEqual(Object.keys(SETUP_RPC.methods), ['status', 'validate', 'check', 'save']);
  for (const method of Object.values(SETUP_RPC.methods)) assert.deepEqual(method, { input: { type: 'object' }, output: { type: 'object' } });
  assert.deepEqual(SETUP_RPC.events, { loaded: { schema: { type: 'object' } } });
  assert.equal(isSetupNotice({ azpr: { setup: true } }), true);
  for (const metadata of [undefined, null, {}, { azpr: null }, { azpr: {} }, { azpr: { setup: 'true' } }, { azpr: { panel: 'manual' } }, 'setup']) assert.equal(isSetupNotice(metadata), false);
});

test('a first setup asks for the organization, the proxy, the token and a model, checks the token, and saves once', async () => {
  const fake = server();
  const h = host(fake, ['https://dev.azure.com/fixture/project/_git/repo/pullrequest/7', '', TOKEN, 'fixture/fast', true]);
  await h.setup.open();
  // One model is asked for, and nothing about its passes: the server part gives it the usual ones of each mode.
  assert.deepEqual(h.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token', 'select: Model for /pr-review',
    'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.deepEqual(methods(h), ['status', 'validate', 'validate', 'check', 'save']);
  // The proxy is asked before anything is sent to Azure DevOps, and "none" is what the check is told.
  assert.deepEqual(fake.checks, [{ organization: 'fixture', token: TOKEN, proxy: '' }]);
  assert.deepEqual(h.calls.at(-1).input, { changes: { organization: 'fixture', proxy: '', model: 'fixture/fast' }, token: TOKEN });
  assert.equal(h.shown[2].description, 'Create one at https://dev.azure.com/fixture/_usersSettings/tokens.', 'The token dialog names the organization just given.');
  // The summary says what the one model becomes, before anything is saved.
  assert.equal(h.shown[4].message, 'Organization: fixture\nProxy: none\nToken: the one just entered, in a file only you can read\nModel: fixture/fast (two passes of /pr-review, one of /pr-quick)\n\n' +
    'Other settings keep their values (the defaults in a new file); /pr-setup changes them later.');
  assert.deepEqual(h.shown[4].label, { confirm: 'Save', cancel: 'Leave' });
  assert.match(h.shown.at(-1).message, /\/pr-check <PR URL>\n\/pr-review <PR URL>/);
  assert.deepEqual(h.loaded, [5], 'The commands are read again once the first setup is loaded, before its result is shown.');
  assert.ok(!h.said().includes(TOKEN), 'The token is in no dialog and no toast.');
  assert.equal(h.left(), 0);
  assert.deepEqual([fake.state.organization, fake.state.reviewModel, fake.state.quickModel, fake.state.deepModel, fake.state.token], ['fixture', ['fixture/fast', 'fixture/fast'], ['fixture/fast'], [], true]);
  // The model list is the host's, without "Off": a review needs a model. A model with variants is asked for
  // its variant, and travels with it, as one model.
  assert.deepEqual(h.shown[3].options, [{ title: 'Fast', value: 'fixture/fast', description: 'fixture/fast', category: 'Fixture AI' }, { title: 'Strong', value: 'fixture/strong', description: 'fixture/strong', category: 'Fixture AI' }]);
  assert.deepEqual([h.shown[3].current, h.shown[3].placeholder], [undefined, 'Search models']);
  const varied = server();
  const v = host(varied, ['fixture', '', TOKEN, 'fixture/strong', 'high', true]);
  await v.setup.open();
  assert.deepEqual(v.titles().slice(3), ['select: Model for /pr-review', 'select: Variant of fixture/strong', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.match(v.shown[5].message, /\nModel: fixture\/strong#high \(two passes of \/pr-review, one of \/pr-quick\)\n/);
  assert.deepEqual(v.calls.at(-1).input, { changes: { organization: 'fixture', proxy: '', model: 'fixture/strong#high' }, token: TOKEN });
  assert.deepEqual([varied.state.reviewModel, varied.state.quickModel], [['fixture/strong#high', 'fixture/strong#high'], ['fixture/strong#high']]);
});

test('a proxy is followed by the CA file question; both are used for the check and saved, and credentials are not shown', async () => {
  const fake = server();
  const h = host(fake, ['fixture', 'http://user:secret@proxy.example:8080', '/etc/ssl/company.pem', TOKEN, 'fixture/fast', true]);
  await h.setup.open();
  assert.deepEqual(h.titles().slice(0, 4), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'prompt: CA certificate file (optional)', 'secret: Personal access token']);
  assert.deepEqual(fake.checks, [{ organization: 'fixture', token: TOKEN, proxy: 'http://user:secret@proxy.example:8080', caFile: '/etc/ssl/company.pem' }]);
  assert.deepEqual(h.calls.at(-1).input.changes, { organization: 'fixture', proxy: 'http://user:secret@proxy.example:8080', caFile: '/etc/ssl/company.pem', model: 'fixture/fast' });
  const summary = h.shown.find(item => item.kind === 'confirm').message;
  assert.match(summary, /Proxy: http:\/\/proxy\.example:8080\nCA certificate file: \/etc\/ssl\/company\.pem/);
  assert.ok(!summary.includes('secret'), 'The summary shows the proxy without its user name and password.');
  // The server part sent nothing back for that proxy: what is checked and saved is what was typed.
  assert.ok(!JSON.stringify(h.shown).includes('user:secret'), 'No dialog shows them either, beyond the field they were typed into.');
});

test('leaving a first setup at any step saves nothing and says so', async () => {
  const full = ['fixture', 'http://proxy.example:8080', '/etc/ssl/company.pem', TOKEN, 'fixture/fast', true];
  for (let step = 0; step < full.length; step++) {
    const fake = server();
    // Escape closes a dialog: undefined; "Leave" in the last one: false.
    const h = host(fake, [...full.slice(0, step), step === full.length - 1 ? false : undefined]);
    await h.setup.open();
    assert.ok(!methods(h).includes('save'), `step ${step}`);
    assert.equal(fake.state.organization, '', `step ${step}`);
    assert.deepEqual(h.toasts.at(-1), { message: 'AZPR setup: left before the end; nothing was saved.', variant: 'info' }, `step ${step}`);
    assert.equal(h.setup.running, false);
  }
  // So does leaving the variant of the model that was picked.
  const h = host(server(), ['fixture', '', TOKEN, 'fixture/strong', undefined]);
  await h.setup.open();
  assert.deepEqual([methods(h).includes('save'), h.titles().at(-1), h.toasts.at(-1)], [false, 'select: Variant of fixture/strong', { message: 'AZPR setup: left before the end; nothing was saved.', variant: 'info' }]);
});

test('an answer the server part refuses is asked again with its reason and the text that was typed', async () => {
  const fake = server();
  const h = host(fake, ['not a name!', 'fixture', 'proxy.example:8080', '', TOKEN, 'fixture/fast', true]);
  await h.setup.open();
  assert.equal(h.shown[1].description, 'Use your Azure DevOps organization name.\n\nThe name in https://dev.azure.com/<organization>.');
  assert.equal(h.shown[1].value, 'not a name!');
  assert.equal(h.shown[3].description, 'azure.proxy must be empty or a proxy URL.\n\nLeave it empty and press Enter to skip.');
  assert.equal(h.shown[3].value, 'proxy.example:8080');
  assert.equal(fake.state.organization, 'fixture');
});

test('a token Azure DevOps refuses is asked again with the reason; an unknown organization goes back to the organization', async () => {
  const fake = server({ checkAnswers: [{ ok: false, fix: 'token', problem: 'Azure DevOps did not accept this token (HTTP 401).' },
    { ok: false, fix: 'organization', problem: 'Azure DevOps knows no organization named "fixtur" (HTTP 404).' }] });
  const second = 'second-token-0123456789abcdefghijklmnopqrstuvwxyz';
  const h = host(fake, ['fixtur', '', 'wrong-token-0123456789abcdefghij', TOKEN, 'fixture', second, 'fixture/fast', true]);
  await h.setup.open();
  assert.deepEqual(h.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token', 'secret: Personal access token',
    'prompt: Azure DevOps organization', 'secret: Personal access token', 'select: Model for /pr-review', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.equal(h.shown[3].problem, 'Azure DevOps did not accept this token (HTTP 401).');
  assert.match(h.shown[4].description, /^Azure DevOps knows no organization named "fixtur" \(HTTP 404\)\.\n\n/);
  assert.equal(h.shown[4].value, 'fixtur');
  assert.deepEqual(fake.checks.map(check => [check.organization, check.token]), [['fixtur', 'wrong-token-0123456789abcdefghij'], ['fixtur', TOKEN], ['fixture', second]]);
  assert.deepEqual(h.calls.at(-1).input, { changes: { organization: 'fixture', proxy: '', model: 'fixture/fast' }, token: second });
  for (const token of [TOKEN, second, 'wrong-token-0123456789abcdefghij']) assert.ok(!h.said().includes(token));
});

test('when Azure DevOps cannot be reached the reason is shown, a proxy can be set, and the same token is checked again', async () => {
  const unreachable = { ok: false, fix: 'proxy', problem: 'Azure DevOps could not be reached (ECONNREFUSED). This network may need a proxy.' };
  const fake = server({ checkAnswers: [unreachable, { ok: false, fix: 'caFile', problem: 'The TLS certificate of the connection was not accepted.' }] });
  const h = host(fake, ['fixture', '', TOKEN, 'repair', 'http://proxy.example:8080', 'repair', '/etc/ssl/company.pem', 'fixture/fast', true]);
  await h.setup.open();
  assert.deepEqual(h.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token',
    'alert: The token could not be checked', 'select: What now?', 'prompt: Proxy for Azure DevOps (optional)',
    'alert: The token could not be checked', 'select: What now?', 'prompt: CA certificate file (optional)',
    'select: Model for /pr-review', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.equal(h.shown[3].message, unreachable.problem);
  assert.deepEqual(h.shown[4].options.map(option => option.title), ['Set a proxy and try again', 'Try again', 'Save the token without checking it']);
  assert.deepEqual(h.shown[7].options.map(option => option.title), ['Set the CA certificate file and try again', 'Try again', 'Save the token without checking it']);
  // The token was typed once and is checked three times: without a proxy, with it, and with the CA file too.
  assert.deepEqual(fake.checks, [{ organization: 'fixture', token: TOKEN, proxy: '' }, { organization: 'fixture', token: TOKEN, proxy: 'http://proxy.example:8080' },
    { organization: 'fixture', token: TOKEN, proxy: 'http://proxy.example:8080', caFile: '/etc/ssl/company.pem' }]);
  assert.deepEqual(h.calls.at(-1).input, { changes: { organization: 'fixture', proxy: 'http://proxy.example:8080', caFile: '/etc/ssl/company.pem', model: 'fixture/fast' }, token: TOKEN });
});

test('a token can be saved unchecked, tried again, or the setup left, when the check cannot run', async () => {
  const failure = { ok: false, fix: '', problem: 'Azure DevOps answered with an error (HTTP 503). Try again in a moment.' };
  const unchecked = host(server({ checkAnswers: [failure, failure] }), ['fixture', '', TOKEN, 'again', 'unchecked', 'fixture/fast', true]);
  await unchecked.setup.open();
  assert.deepEqual(unchecked.shown[4].options.map(option => option.title), ['Try again', 'Save the token without checking it']);
  assert.deepEqual(unchecked.calls.at(-1).input, { changes: { organization: 'fixture', proxy: '', model: 'fixture/fast' }, token: TOKEN });
  const left = host(server({ checkAnswers: [failure] }), ['fixture', '', TOKEN, undefined]);
  await left.setup.open();
  assert.ok(!methods(left).includes('save'));
});

test('a first setup that the server part cannot load says so and names the restart', async () => {
  const fake = server({ afterSave: 'required' });
  const h = host(fake, ['fixture', '', TOKEN, 'fixture/fast', true]);
  await h.setup.open();
  assert.match(h.shown.at(-1).message, /^The settings are saved, but AZPR could not load them: there is no settings file yet\.\n\nRestart the OpenCode service \(opencode service restart\)/);
  assert.deepEqual(h.loaded, [], 'Nothing was loaded: the commands are as they were.');
  const refused = host(server({ saveProblem: 'The settings could not be saved; nothing was changed.' }), ['fixture', '', TOKEN, 'fixture/fast', true]);
  await refused.setup.open();
  assert.deepEqual(refused.toasts.at(-1), { title: 'AZPR setup', message: 'The settings could not be saved; nothing was changed.', variant: 'error', duration: 10000 });
  assert.ok(!refused.shown.some(item => item.title === 'AZPR is set up'));
});

// SOURCE? This test fails against src/tui-setup.mjs as it is (2026-11-23), and is left failing on purpose.
// Expected: where the settings already name review models (setup is required again because their token file is
// gone, say), the first setup's model dialog starts on the first of them and its variant dialog on that
// model's variant, as the list's dialog does (askModel passes `start: row.entries[0]`) and as 0.4.6 did.
// Seen: firstSetup calls `askOneModel(rows('reviewModel'), { off: false })` (src/tui-setup.mjs:252), whose
// `start` defaults to `row.current`. That is the list as text now ("fixture/fast*2"), not a model: the model
// dialog marks no row ("fixture/fast*2" is no option's value), and for a model with a variant the variant
// dialog is given "high*2". Enter then takes the first model of the host's list and its default variant.
test('a first setup over settings that already name review models starts its model dialogs on the first of them', async () => {
  // No variant, and a variant: the settings as the server part describes them, with their list as text.
  const plain = host(server({ organization: 'fixture', reviewModel: ['fixture/fast', 'fixture/fast'], quickModel: ['fixture/fast'] }), ['fixture', '', TOKEN, 'fixture/fast', true]);
  await plain.setup.open();
  const varied = host(server({ organization: 'fixture', reviewModel: ['fixture/strong#high', 'fixture/strong#high', 'fixture/fast'] }), ['fixture', '', TOKEN, 'fixture/strong', 'high', true]);
  await varied.setup.open();
  const dialog = (h, title) => h.shown.find(item => item.title === title);
  assert.deepEqual([dialog(plain, 'Model for /pr-review').current, dialog(varied, 'Model for /pr-review').current, dialog(varied, 'Variant of fixture/strong').current], ['fixture/fast', 'fixture/strong', 'high']);
});

const ready = (more = {}) => server({ state: 'ready', organization: 'fixture', token: true, reviewModel: ['fixture/fast', 'fixture/fast'], quickModel: ['fixture/fast'], ...more });

test('with settings in place, the settings are one list: grouped rows with their values, and the file they are in', async () => {
  const h = host(ready(), [undefined]);
  await h.setup.open();
  assert.deepEqual(methods(h), ['status']);
  const list = h.shown[0];
  assert.deepEqual([list.kind, list.title, list.placeholder], ['select', 'AZPR settings', 'Search settings']);
  // A mode's models are one row: the list has room for a few words, so each model stands without its provider, with its number of passes.
  assert.deepEqual(list.options.map(option => [option.category, option.title, option.footer]), [
    ['Azure DevOps', 'Organization', 'fixture'], ['Azure DevOps', 'Access token', 'saved in ~/.config/azpr/pat'], ['Azure DevOps', 'Proxy', 'none'], ['Azure DevOps', 'CA certificate file', 'none'],
    ['Models', 'Review models', 'fast ×2'], ['Models', 'Quick models', 'fast'], ['Models', 'Deep models', 'off'], ['Reviews', 'Output language', 'en'], ['Reviews', 'After a review', 'preview'],
    ['More', 'Settings file', '~/.config/azpr/settings.json']]);
  // A row whose name does not say what it is for carries a few words, which the list shows between name and value.
  assert.deepEqual(list.options.map(option => option.description), [undefined, undefined, undefined, undefined, 'for /pr-review', 'for /pr-quick', 'for /pr-deep', undefined, undefined, undefined]);
  assert.equal(h.toasts.length, 0, 'Leaving the list is no cancelled setup.');
  const mixed = host(ready({ reviewModel: ['fixture/fast', 'fixture/strong#high', 'fixture/strong#high'], deepModel: ['fixture/strong#high'] }), [undefined]);
  await mixed.setup.open();
  assert.deepEqual(mixed.shown[0].options.filter(option => option.category === 'Models').map(option => option.footer), ['fast + strong#high ×2', 'fast', 'strong#high']);
});

test('a choice is saved at once, the list returns on that row with the new value, and a change names the restart', async () => {
  const fake = ready();
  const h = host(fake, ['language', 'zh-TW', '@restart', '@file', undefined]);
  await h.setup.open();
  // The list returns on the changed row, which may be far from its top: its title says that a restart is pending.
  assert.deepEqual(h.titles(), ['select: AZPR settings', 'select: Language of reports and comments', 'select: AZPR settings · restart needed', 'alert: Restart needed',
    'select: AZPR settings · restart needed', 'alert: Settings file', 'select: AZPR settings · restart needed']);
  assert.equal(h.shown[1].current, 'en');
  assert.deepEqual(h.calls.at(-1), { method: 'save', input: { changes: { language: 'zh-TW' } } });
  assert.equal(h.shown[2].current, 'language');
  assert.deepEqual(h.shown[2].options[0], { title: 'Restart needed', value: '@restart', footer: 'opencode service restart', category: 'Status' });
  assert.equal(h.shown[2].options.find(option => option.value === 'language').footer, 'zh-TW');
  assert.deepEqual(h.toasts, [{ message: 'AZPR: Saved. It takes effect after the OpenCode service restarts: opencode service restart', variant: 'success', duration: 8000 }]);
  assert.deepEqual(h.loaded, [], 'A change to settings that are in use loads nothing.');
  assert.match(h.shown[3].message, /opencode service restart/);
  assert.equal(h.shown[5].message, '/home/user/.config/azpr/settings.json\n\nSettings that are not in this list are changed in this file. Each one is described in the README\'s section "All settings and defaults" (https://github.com/owner/repository#all-settings-and-defaults).',
    'The README is long: its section is named, with its address.');
});

test('a language that is not listed is typed; posting without a preview is confirmed with the safe answer first', async () => {
  const fake = ready();
  const h = host(fake, ['language', options => options.options.at(-1).value, 'pt-BR', 'afterReview', 'publish', 'keep', 'afterReview', 'publish', undefined, 'afterReview', 'publish', 'accept', 'afterReview', 'none', undefined]);
  await h.setup.open();
  assert.equal(fake.state.language, 'pt-BR');
  assert.deepEqual(h.shown[2], { kind: 'prompt', title: 'Language of reports and comments', description: 'A language tag.', placeholder: 'pt-BR', value: 'en' });
  const confirmations = h.shown.filter(item => item.title === 'Post comments without a preview?');
  assert.equal(confirmations.length, 3);
  assert.deepEqual(confirmations[0].options, [{ title: 'No, keep the current setting', value: 'keep', description: 'Under your name' }, { title: 'Yes, post them after every review', value: 'accept' }]);
  assert.equal(confirmations[0].current, undefined, 'Nothing is preselected but the first row: the safe one.');
  // Kept, closed with Escape, then accepted; a choice that is not dangerous asks nothing more.
  assert.deepEqual(saves(h), [{ changes: { language: 'pt-BR' } }, { changes: { afterReview: 'publish' } }, { changes: { afterReview: 'none' } }]);
  assert.equal(fake.state.afterReview, 'none');
  // A language outside the list is the row's current value: the list marks "Another language" and shows the tag there.
  const again = host(ready({ language: 'pt-BR' }), ['language', undefined, undefined]);
  await again.setup.open();
  assert.deepEqual(again.shown[1].options.at(-1), { title: 'Another language', value: again.shown[1].current, description: 'pt-BR' });
});

test('a mode\'s models start with a model from the host\'s list and its variant, followed by its passes; a row that may be off offers that first', async () => {
  const fake = ready({ deepModel: ['fixture/strong#high', 'fixture/strong#high'] });
  const h = host(fake, ['reviewModel', 'fixture/strong', 'high', 'done', 'deepModel', '', 'reviewModel', 'fixture/strong', '', 'done', 'reviewModel', 'fixture/strong', undefined,
    'reviewModel', 'fixture/strong', 'low', undefined, undefined]);
  await h.setup.open();
  assert.equal(h.left(), 0);
  assert.deepEqual(h.shown[1].options, [{ title: 'Fast', value: 'fixture/fast', description: 'fixture/fast', category: 'Fixture AI' }, { title: 'Strong', value: 'fixture/strong', description: 'fixture/strong', category: 'Fixture AI' }]);
  // The dialog starts on the model of the first pass.
  assert.deepEqual([h.shown[1].title, h.shown[1].current, h.shown[1].placeholder], ['Model for /pr-review', 'fixture/fast', 'Search models']);
  assert.deepEqual(h.shown[2].options.map(option => option.value), ['', 'low', 'high']);
  assert.equal(h.shown[2].title, 'Variant of fixture/strong');
  // Then the passes: one model named for /pr-review is two of them, and the first row takes them as they are.
  assert.deepEqual([h.shown[3].kind, h.shown[3].title, h.shown[3].options[0]], ['select', 'Model for /pr-review: 2 passes', { title: 'Use these 2 passes', value: 'done', description: 'strong#high, strong#high' }]);
  const deep = h.shown.find(item => item.title === 'Model for /pr-deep');
  assert.equal(deep.placeholder, 'Stronger than the review model, or a higher variant', 'What makes a deep model one is said where there is room: in the search line.');
  assert.deepEqual(deep.options[0], { title: 'Off', value: '', description: '/pr-deep stays off', category: 'Off' });
  assert.equal(deep.current, 'fixture/strong', 'The current model is marked without its variant.');
  // What is saved is the list as text, with every model's number of passes; "off" is the empty answer, and asks nothing about passes.
  assert.deepEqual(saves(h).map(input => input.changes), [{ reviewModel: 'fixture/strong#high*2' }, { deepModel: '' }, { reviewModel: 'fixture/strong*2' }]);
  assert.deepEqual([fake.state.reviewModel, fake.state.deepModel], [['fixture/strong', 'fixture/strong'], []]);
  assert.equal(h.shown.filter(item => / pass(?:es)?$/.test(item.title ?? '')).some(item => item.title.startsWith('Model for /pr-deep')), false);
  // The variant dialog starts on the variant in use, and leaving it, or the passes after it, changes nothing.
  const variants = h.shown.filter(item => item.title === 'Variant of fixture/strong');
  assert.deepEqual(variants.map(item => item.current), ['', 'high', '', '']);
  assert.deepEqual(h.titles().slice(-8), ['select: AZPR settings · restart needed', 'select: Model for /pr-review', 'select: Variant of fixture/strong',
    'select: AZPR settings · restart needed', 'select: Model for /pr-review', 'select: Variant of fixture/strong', 'select: Model for /pr-review: 2 passes', 'select: AZPR settings · restart needed']);
  assert.equal(saves(h).length, 3);
  const none = host(ready(), ['reviewModel', undefined], { models: [] });
  await none.setup.open();
  assert.deepEqual(none.titles(), ['select: AZPR settings', 'alert: No model available', 'select: AZPR settings']);
  // Without any model, a row that may be off can still be switched off.
  const off = host(ready({ deepModel: ['fixture/strong'] }), ['deepModel', '', undefined], { models: [] });
  await off.setup.open();
  assert.deepEqual(off.titles(), ['select: AZPR settings', 'select: Model for /pr-deep', 'select: AZPR settings · restart needed']);
  assert.deepEqual(off.shown[1].options, [{ title: 'Off', value: '', description: '/pr-deep stays off', category: 'Off' }]);
  assert.deepEqual(off.calls.at(-1), { method: 'save', input: { changes: { deepModel: '' } } });
  // A row that is off starts on "Off".
  const started = host(ready(), ['deepModel', undefined, 'quickModel', undefined, undefined]);
  await started.setup.open();
  assert.deepEqual([started.shown[1].current, started.shown[3].current, started.shown[3].options[0]], ['', 'fixture/fast', { title: 'Off', value: '', description: '/pr-quick stays off', category: 'Off' }]);
  // The deep model's variant is asked with what a higher one does: another way to a stronger /pr-deep than another model.
  const higher = host(ready({ reviewModel: ['fixture/strong', 'fixture/strong'] }), ['deepModel', 'fixture/strong', 'high', 'done', undefined]);
  await higher.setup.open();
  assert.deepEqual(higher.titles().slice(1, 4), ['select: Model for /pr-deep', 'select: Variant of fixture/strong', 'select: Model for /pr-deep: 2 passes']);
  assert.equal(higher.shown[2].placeholder, 'A higher variant reasons longer');
  assert.equal(Object.hasOwn(h.shown[2], 'placeholder'), false, 'The variants of a review model are listed as before.');
  assert.deepEqual(higher.calls.at(-1), { method: 'save', input: { changes: { deepModel: 'fixture/strong#high*2' } } });
  // A server part that names no section (an earlier version's) leaves the README as a whole.
  const plain = ready();
  const status = plain.status;
  plain.status = async () => { const { settingsReference, ...rest } = await status(); return rest; };
  const earlier = host(plain, ['@file', undefined]);
  await earlier.setup.open();
  assert.match(earlier.shown[1].message, /Each one is described in the README\.$/);
});

test('a mode\'s passes are set in a list after its first model: use them, add one of the same or of another model, take the last away, between one pass and the most there may be', async () => {
  /** The dialogs about passes, in order. */
  const passes = h => h.shown.filter(item => / pass(?:es)?$/.test(item.title ?? ''));
  // /pr-review: one model becomes the two passes that are usual there, and the first row accepts them.
  const usual = host(ready(), ['reviewModel', 'fixture/fast', 'done', undefined]);
  await usual.setup.open();
  assert.deepEqual(usual.titles().slice(0, 3), ['select: AZPR settings', 'select: Model for /pr-review', 'select: Model for /pr-review: 2 passes']);
  assert.deepEqual(passes(usual)[0].options, [{ title: 'Use these 2 passes', value: 'done', description: 'fast, fast' }, { title: 'Add a pass of the same model', value: 'same', description: 'fast once more' },
    { title: 'Add a pass of another model', value: 'other', description: 'Different models find different defects' }, { title: 'Take the last pass away', value: 'less', description: 'Without fast' }]);
  assert.equal(passes(usual)[0].current, undefined, 'Nothing is preselected but the first row.');
  assert.deepEqual(saves(usual), [{ changes: { reviewModel: 'fixture/fast*2' } }], 'One save for the whole list, as text.');
  // /pr-quick: one pass is usual, and from one pass nothing can be taken away.
  const quick = host(ready(), ['quickModel', 'fixture/strong', 'low', 'done', undefined]);
  await quick.setup.open();
  assert.equal(passes(quick)[0].title, 'Model for /pr-quick: 1 pass');
  assert.deepEqual(passes(quick)[0].options.map(option => [option.title, option.value, option.description]), [['Use this pass', 'done', 'strong#low'], ['Add a pass of the same model', 'same', 'strong#low once more'],
    ['Add a pass of another model', 'other', 'Different models find different defects']]);
  assert.deepEqual(saves(quick), [{ changes: { quickModel: 'fixture/strong#low*1' } }]);
  // One review pass instead of two: the last one is taken away, and the text says "one", not "the usual".
  const single = host(ready(), ['reviewModel', 'fixture/fast', 'less', 'done', undefined]);
  await single.setup.open();
  assert.deepEqual(passes(single).map(item => [item.title, item.options.map(option => option.value)]), [['Model for /pr-review: 2 passes', ['done', 'same', 'other', 'less']], ['Model for /pr-review: 1 pass', ['done', 'same', 'other']]]);
  assert.deepEqual(saves(single), [{ changes: { reviewModel: 'fixture/fast*1' } }]);
  // The same model once more, up to the most there may be: then only fewer can be chosen.
  const most = host(ready(), ['reviewModel', 'fixture/fast', 'same', 'same', 'done', undefined]);
  await most.setup.open();
  assert.deepEqual(passes(most).map(item => [item.title, item.options.map(option => option.value)]),
    [['Model for /pr-review: 2 passes', ['done', 'same', 'other', 'less']], ['Model for /pr-review: 3 passes', ['done', 'same', 'other', 'less']], ['Model for /pr-review: 4 passes', ['done', 'less']]]);
  assert.deepEqual(passes(most).at(-1).options[0], { title: 'Use these 4 passes', value: 'done', description: 'fast, fast, fast, fast' });
  assert.deepEqual(saves(most), [{ changes: { reviewModel: 'fixture/fast*4' } }]);
  // Another model for a pass is picked like the first one, with its variant, but is never "Off", also where the
  // row may be off; what the row says to look for stays in the search line.
  const mixed = host(ready(), ['deepModel', 'fixture/fast', 'less', 'other', 'fixture/strong', 'high', 'done', undefined]);
  await mixed.setup.open();
  assert.deepEqual(mixed.titles().slice(1, 7), ['select: Model for /pr-deep', 'select: Model for /pr-deep: 2 passes', 'select: Model for /pr-deep: 1 pass', 'select: Model of pass 2', 'select: Variant of fixture/strong', 'select: Model for /pr-deep: 2 passes']);
  const another = mixed.shown.find(item => item.title === 'Model of pass 2');
  assert.deepEqual([another.options.map(option => option.value), another.current, another.placeholder], [['fixture/fast', 'fixture/strong'], undefined, 'Stronger than the review model, or a higher variant']);
  assert.equal(mixed.shown.find(item => item.title === 'Variant of fixture/strong').placeholder, 'A higher variant reasons longer');
  // The passes are named in their order, and what can be added or taken away is the last one.
  assert.deepEqual(passes(mixed).at(-1).options.map(option => [option.value, option.description]), [['done', 'fast, strong#high'], ['same', 'strong#high once more'], ['other', 'Different models find different defects'], ['less', 'Without strong#high']]);
  assert.deepEqual(saves(mixed), [{ changes: { deepModel: 'fixture/fast*1,fixture/strong#high*1' } }]);
  // Two passes of one model and one of another; and a model that comes back after another one.
  const three = host(ready(), ['reviewModel', 'fixture/fast', 'other', 'fixture/strong', '', 'done', undefined]);
  await three.setup.open();
  assert.deepEqual([passes(three).at(-1).title, saves(three)], ['Model for /pr-review: 3 passes', [{ changes: { reviewModel: 'fixture/fast*2,fixture/strong*1' } }]]);
  const back = host(ready(), ['reviewModel', 'fixture/fast', 'less', 'other', 'fixture/strong', '', 'other', 'fixture/fast', 'same', 'done', undefined]);
  await back.setup.open();
  assert.deepEqual([passes(back).at(-1).options[0].description, passes(back).at(-1).options.map(option => option.value), saves(back)],
    ['fast, strong, fast, fast', ['done', 'less'], [{ changes: { reviewModel: 'fixture/fast*1,fixture/strong*1,fixture/fast*2' } }]]);
  // Leaving the dialog of another model, or of its variant, adds no pass; leaving the passes saves nothing and returns to the list.
  const left = host(ready(), ['reviewModel', 'fixture/fast', 'other', undefined, 'other', 'fixture/strong', undefined, undefined, undefined]);
  await left.setup.open();
  assert.deepEqual([left.left(), passes(left).map(item => item.title), saves(left), left.titles().at(-1)], [0, Array(3).fill('Model for /pr-review: 2 passes'), [], 'select: AZPR settings']);
  // Without a model to add (OpenCode offers none any more), that is said, and the passes are as they were.
  let offered = MODELS;
  const gone = host(ready(), ['reviewModel', 'fixture/fast', () => { offered = []; return 'other'; }, 'done', undefined], { models: () => offered });
  await gone.setup.open();
  assert.deepEqual([gone.titles().slice(2, 5), saves(gone)], [['select: Model for /pr-review: 2 passes', 'alert: No model available', 'select: Model for /pr-review: 2 passes'], [{ changes: { reviewModel: 'fixture/fast*2' } }]]);
  // The numbers are the server part's. Where it gives none (an earlier one), or numbers that make no sense, a
  // model is one pass, or its usual passes, and nothing is offered beyond them.
  const numbers = async change => {
    const fake = ready(), status = fake.status;
    fake.status = async () => { const answer = await status(); return { ...answer, rows: answer.rows.map(row => row.id === 'reviewModel' ? change(row) : row) }; };
    const h = host(fake, ['reviewModel', 'fixture/fast', 'done', undefined]);
    await h.setup.open();
    return [passes(h)[0].title, passes(h)[0].options.map(option => option.value), h.shown[1].current, saves(h)[0].changes.reviewModel];
  };
  assert.deepEqual(await numbers(({ entries, usual, most, ...row }) => row), ['Model for /pr-review: 1 pass', ['done'], undefined, 'fixture/fast*1']);
  assert.deepEqual(await numbers(row => ({ ...row, usual: 0, most: -1, entries: 'fixture/fast' })), ['Model for /pr-review: 1 pass', ['done'], undefined, 'fixture/fast*1']);
  assert.deepEqual(await numbers(row => ({ ...row, usual: 3, most: 2, entries: [] })), ['Model for /pr-review: 3 passes', ['done', 'less'], undefined, 'fixture/fast*3']);
  assert.deepEqual(await numbers(row => ({ ...row, usual: 1.5, most: '4' })), ['Model for /pr-review: 1 pass', ['done'], 'fixture/fast', 'fixture/fast*1'], 'Saved passes beyond the most there may be: the usual ones.');
  // Opening a row and taking what it shows changes nothing: the saved first model, picked again with its variant,
  // starts from the saved passes. Another model, or the same model with another variant, starts from its usual passes.
  const savedList = ['fixture/strong#high', 'fixture/fast', 'fixture/strong#high'];
  const pickedAgain = host(ready({ reviewModel: savedList }), ['reviewModel', 'fixture/strong', 'high', 'done', undefined]);
  await pickedAgain.setup.open();
  assert.deepEqual([pickedAgain.shown[1].current, passes(pickedAgain)[0].title, passes(pickedAgain)[0].options[0].description, saves(pickedAgain)],
    ['fixture/strong', 'Model for /pr-review: 3 passes', 'strong#high, fast, strong#high', [{ changes: { reviewModel: 'fixture/strong#high*1,fixture/fast*1,fixture/strong#high*1' } }]]);
  const otherVariant = host(ready({ reviewModel: savedList }), ['reviewModel', 'fixture/strong', 'low', 'done', undefined]);
  await otherVariant.setup.open();
  assert.deepEqual([passes(otherVariant)[0].title, saves(otherVariant)], ['Model for /pr-review: 2 passes', [{ changes: { reviewModel: 'fixture/strong#low*2' } }]]);
  const otherModel = host(ready({ reviewModel: savedList }), ['reviewModel', 'fixture/fast', 'done', undefined]);
  await otherModel.setup.open();
  assert.deepEqual([passes(otherModel)[0].title, saves(otherModel)], ['Model for /pr-review: 2 passes', [{ changes: { reviewModel: 'fixture/fast*2' } }]]);
});

test('a new token is checked for the saved organization before it is saved; an empty one keeps the saved token', async () => {
  const fake = ready({ checkAnswers: [{ ok: false, fix: 'token', problem: 'Azure DevOps did not accept this token (HTTP 401).' }] });
  const h = host(fake, ['token', 'wrong-token-0123456789abcdefghij', TOKEN, 'token', '', undefined]);
  await h.setup.open();
  assert.equal(h.shown[1].optional, true);
  assert.equal(h.shown[1].description, 'Create one at https://dev.azure.com/fixture/_usersSettings/tokens. Leave it empty to keep the saved token.');
  assert.equal(h.shown[2].problem, 'Azure DevOps did not accept this token (HTTP 401).');
  // Checked with the saved network settings (none are sent), and only the accepted token is saved.
  assert.deepEqual(fake.checks, [{ organization: 'fixture', token: 'wrong-token-0123456789abcdefghij' }, { organization: 'fixture', token: TOKEN }, { organization: 'fixture' }]);
  assert.deepEqual(saves(h), [{ token: TOKEN, organization: 'fixture' }],
    'The token is saved for the organization it was checked for; the server part refuses it when the settings name another by then.');
  assert.ok(!h.said().includes(TOKEN));
  // Without an organization there is nothing to check a token for.
  const bare = host(server({ state: 'ready', reviewModel: ['fixture/fast', 'fixture/fast'] }), ['token', undefined]);
  await bare.setup.open();
  assert.deepEqual(bare.shown[1], { kind: 'alert', title: 'Personal access token', message: 'Set the organization first: a token is checked for it.' });
});

test('a saved token that cannot be checked is kept as it is, and nothing is saved for it', async () => {
  const fake = ready({ checkAnswers: [{ ok: false, fix: '', problem: 'Azure DevOps answered with an error (HTTP 503). Try again in a moment.' }] });
  const h = host(fake, ['token', '', 'unchecked', undefined]);
  await h.setup.open();
  assert.deepEqual(h.titles(), ['select: AZPR settings', 'secret: Personal access token', 'alert: The token could not be checked', 'select: What now?', 'select: AZPR settings']);
  assert.deepEqual(h.shown[3].options.map(option => option.title), ['Try again', 'Keep the saved token without checking it']);
  assert.deepEqual(methods(h), ['status', 'check'], 'No token was entered, so there is none to save.');
});

test('another organization needs a token of its own: both are saved together, or neither', async () => {
  const fake = ready();
  const h = host(fake, ['organization', 'other-org', TOKEN, undefined]);
  await h.setup.open();
  assert.deepEqual(h.titles(), ['select: AZPR settings', 'prompt: Azure DevOps organization', 'secret: Personal access token', 'select: AZPR settings · restart needed']);
  assert.deepEqual([h.shown[2].optional, h.shown[2].problem, h.shown[2].description],
    [false, 'The saved token was saved for fixture. Enter a token of other-org; without one the organization stays fixture.', 'Create one at https://dev.azure.com/other-org/_usersSettings/tokens.']);
  assert.deepEqual(fake.checks, [{ organization: 'other-org', token: TOKEN }], 'The token is checked for the new organization.');
  assert.deepEqual(saves(h), [{ changes: { organization: 'other-org' }, token: TOKEN }]);
  assert.ok(!h.said().includes(TOKEN));
  // The token of the earlier organization stays in its file, and the server part says where: that is shown until read.
  const noted = host(ready({ saveNote: 'The token of "fixture" is still in ~/.config/azpr/pat. Delete that file if you no longer need it.' }), ['organization', 'other-org', TOKEN, undefined]);
  await noted.setup.open();
  assert.deepEqual(noted.shown.at(-2), { kind: 'alert', title: 'An earlier token is still on disk', message: 'The token of "fixture" is still in ~/.config/azpr/pat. Delete that file if you no longer need it.' });
  const first = host(server({ saveNote: 'The token of "earlier" is still in ~/.config/azpr/pat. Delete that file if you no longer need it.' }), ['fixture', '', TOKEN, 'fixture/fast', true]);
  await first.setup.open();
  assert.match(first.shown.at(-1).message, /^Check access to a pull request[\s\S]*\n\nThe token of "earlier" is still in ~\/\.config\/azpr\/pat\. Delete that file if you no longer need it\.$/);
  // Leaving the token dialog leaves the organization as it was.
  const left = host(ready(), ['organization', 'other-org', undefined, undefined]);
  await left.setup.open();
  assert.deepEqual(methods(left), ['status', 'validate']);
  // An organization Azure DevOps does not know is reported, and nothing is saved.
  const unknown = host(ready({ checkAnswers: [{ ok: false, fix: 'organization', problem: 'Azure DevOps knows no organization named "nope" (HTTP 404).' }] }), ['organization', 'nope', TOKEN, undefined]);
  await unknown.setup.open();
  assert.deepEqual(unknown.shown.at(-2), { kind: 'alert', title: 'Azure DevOps organization', message: 'Azure DevOps knows no organization named "nope" (HTTP 404).' });
  assert.deepEqual(methods(unknown), ['status', 'validate', 'check']);
  // The same organization in other letters, or an organization where no token is saved, asks for none.
  const same = host(ready(), ['organization', 'FIXTURE', undefined]);
  await same.setup.open();
  assert.deepEqual(same.calls.at(-1), { method: 'save', input: { changes: { organization: 'FIXTURE' } } });
  const bare = host(ready({ token: false }), ['organization', 'other-org', undefined]);
  await bare.setup.open();
  assert.deepEqual(bare.calls.at(-1), { method: 'save', input: { changes: { organization: 'other-org' } } });
  // Nor does a token that was saved without an organization become the organization's when one is named.
  const unowned = host(ready({ organization: '', token: false, bound: true }), ['organization', 'other-org', TOKEN, undefined]);
  await unowned.setup.open();
  assert.equal(unowned.shown[2].problem, 'The token these settings name was saved without an organization. Enter a token of other-org; without one the organization is not saved.');
  assert.deepEqual(unowned.calls.at(-1), { method: 'save', input: { changes: { organization: 'other-org' }, token: TOKEN } });
  // A token the settings name but that cannot be used at the moment is still the earlier organization's: a new one is asked for.
  const unusable = host(ready({ token: false, bound: true }), ['organization', 'other-org', TOKEN, undefined]);
  await unusable.setup.open();
  assert.deepEqual(unusable.calls.at(-1), { method: 'save', input: { changes: { organization: 'other-org' }, token: TOKEN } });
});

test('a setup talks to one server part from its first question to its save, also when it fails or is left', async () => {
  // The place is fixed before the first call and let go after the last one.
  const h = host(server(), ['fixture', '', TOKEN, 'fixture/fast', true]);
  await h.setup.open();
  assert.deepEqual(h.pins, ['pin@0', `release@${h.calls.length}`]);
  assert.equal(methods(h).at(-1), 'save');
  const left = host(server(), ['fixture', undefined]);
  await left.setup.open();
  assert.deepEqual(left.pins, ['pin@0', `release@${left.calls.length}`]);
  const failing = host({ ...server(), validate: async () => { throw new Error('connection lost'); } }, ['fixture']);
  await failing.setup.open();
  assert.deepEqual(failing.pins, ['pin@0', 'release@2']);
  // The hint asks one question outside any setup: nothing is fixed for it, and a second open while one runs fixes nothing either.
  const hinting = host(server(), []);
  await hinting.setup.hint();
  assert.deepEqual(hinting.pins, []);
  let release;
  const busy = host(ready(), [() => new Promise(resolve => { release = resolve; })]);
  const first = busy.setup.open();
  await new Promise(resolve => setImmediate(resolve));
  await busy.setup.open();
  assert.deepEqual(busy.pins, ['pin@0']);
  release(undefined);
  await first;
  assert.deepEqual(busy.pins, ['pin@0', 'release@1']);
});

test('a setup that is stopped ends at its next step: nothing more is asked, shown or saved', async () => {
  const fake = server();
  let answer;
  fake.check = () => new Promise(resolve => { answer = resolve; });
  const h = host(fake, ['fixture', '', TOKEN]);
  const open = h.setup.open();
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(methods(h), ['status', 'validate', 'validate', 'check']);
  // The terminal part is unloaded while Azure DevOps is asked; the answer arrives afterwards.
  h.setup.stop();
  const toasts = h.toasts.length;
  answer({ ok: true, organization: 'fixture' });
  await open;
  assert.deepEqual(methods(h), ['status', 'validate', 'validate', 'check'], 'The token that was being checked is not saved.');
  assert.deepEqual(h.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token'], 'No further dialog opens.');
  assert.equal(h.toasts.length, toasts, 'And nothing more is said.');
  assert.deepEqual([h.setup.running, h.pins], [false, ['pin@0', 'release@4']]);
  await h.setup.open();
  await h.setup.hint();
  assert.equal(h.calls.length, 4, 'Neither a setup nor the hint starts afterwards.');
  // Nor is a list of passes saved that was being put together: the answer that arrives afterwards ends the setup.
  let choose;
  const listing = ready(), l = host(listing, ['reviewModel', 'fixture/fast', () => new Promise(resolve => { choose = resolve; })]);
  const opened = l.setup.open();
  for (let turn = 0; turn < 10 && !choose; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(l.titles().at(-1), 'select: Model for /pr-review: 2 passes');
  l.setup.stop();
  choose('done');
  await opened;
  assert.deepEqual([methods(l), l.toasts, listing.state.state, l.setup.running], [['status'], [], 'ready', false]);
});

test('from the list, a failed check lets the proxy be changed and saved before the token is checked again', async () => {
  const fake = ready({ checkAnswers: [{ ok: false, fix: 'proxy', problem: 'Azure DevOps could not be reached (ETIMEDOUT). This network may need a proxy.' }] });
  const h = host(fake, ['token', TOKEN, 'repair', 'http://proxy.example:8080', undefined]);
  await h.setup.open();
  assert.deepEqual(methods(h), ['status', 'check', 'validate', 'save', 'check', 'save']);
  assert.deepEqual(h.calls[3].input, { changes: { proxy: 'http://proxy.example:8080' } });
  assert.deepEqual(h.calls[5].input, { token: TOKEN, organization: 'fixture' });
  assert.equal(h.shown.at(-1).options.find(option => option.value === 'proxy').footer, 'http://proxy.example:8080');
});

test('a server part that does not answer, or a settings file that cannot be changed, is only reported', async () => {
  const silent = host({ status: async () => { throw new Error('rpc.unavailable'); } }, []);
  await silent.setup.open();
  assert.equal(silent.shown.length, 0);
  assert.match(silent.toasts[0].message, /^AZPR setup is not available: this OpenCode server did not answer for AZPR\./);
  const broken = host(server({ editable: false }), []);
  await broken.setup.open();
  assert.deepEqual(broken.titles(), ['alert: AZPR\'s settings file needs repair']);
  assert.match(broken.shown[0].message, /^The settings file is not valid JSON\.\n\n\/home\/user\/\.config\/azpr\/settings\.json\n\nRepair it by hand/);
  assert.deepEqual(methods(broken), ['status']);
  // A call that fails ends the setup with a fixed sentence; setup can be opened again afterwards.
  const failing = host({ ...server(), validate: async () => { throw new Error('connection lost'); } }, ['fixture', 'fixture']);
  await failing.setup.open();
  assert.deepEqual(failing.toasts.at(-1), { title: 'AZPR setup', message: 'AZPR setup stopped: the OpenCode server did not answer as expected. What was saved before stays; run /pr-setup again.', variant: 'error', duration: 10000 },
    'What the error says is the host\'s text and is not shown: it might hold an answer.');
  assert.equal(failing.setup.running, false);
});

// ------------------------------------------------------------------ settings of an earlier version
const outdated = (more = {}) => server({ state: 'migrate', editable: false, problem: OUTDATED, organization: 'fixture', token: true, reviewModel: ['fixture/fast', 'fixture/strong'], quickModel: ['fixture/fast'], ...more });
const UPDATE_DIALOGS = ['alert: AZPR\'s settings are from an earlier version', 'select: Update AZPR\'s settings file?'];

test('settings of an earlier version: what their update changes is shown, then asked in a list whose first row keeps the file, and the update is saved once, alone', async () => {
  // Kept: by the first row, and by Escape. Nothing is saved, and that is said.
  for (const answer of ['keep', undefined]) {
    const fake = outdated(), h = host(fake, [answer]);
    await h.setup.open();
    assert.deepEqual(h.titles(), UPDATE_DIALOGS, 'Neither the first setup, nor the list of settings, nor the notice of a file that needs repair.');
    assert.equal(h.shown[0].message, `- ${UPDATE.lines[0]}\n- ${UPDATE.lines[1]}\n- ${UPDATE.lines[2]}\n\nNothing is changed until you confirm in the next step.`);
    assert.deepEqual(h.shown[1].options, [{ title: 'Not now', value: 'keep', description: 'The file stays as it is; reviews do not run until it is updated' },
      { title: 'Update the settings file', value: 'update', description: '~/.config/azpr/settings.json' }]);
    assert.equal(h.shown[1].current, undefined, 'Nothing is preselected but the first row: the one that keeps the file.');
    assert.deepEqual(methods(h), ['status']);
    assert.deepEqual(h.toasts, [{ message: 'AZPR setup: the settings file was left as it is.', variant: 'info' }]);
    assert.deepEqual([fake.state.state, h.loaded, h.setup.running, h.pins], ['migrate', [], false, ['pin@0', 'release@1']]);
  }
  // Asked for: one save, of the update alone, under the word the server part showed with it. The settings are
  // loaded at once, so the commands are read again before the result is shown.
  const fake = outdated(), h = host(fake, ['update']);
  await h.setup.open();
  assert.deepEqual(h.titles(), [...UPDATE_DIALOGS, 'alert: AZPR\'s settings are updated']);
  assert.deepEqual(h.calls, [{ method: 'status', input: {} }, { method: 'save', input: { migrate: UPDATE.word } }], 'No setting, token or organization travels with it.');
  assert.equal(h.shown.at(-1).message, 'Reviews run again:\n\n/pr-check <PR URL>\n/pr-review <PR URL>\n\n/pr-setup shows the models of each mode and changes them.');
  assert.deepEqual([fake.state.state, h.loaded, h.toasts, h.pins, h.left()], ['ready', [2], [], ['pin@0', 'release@2'], 0]);
  // Opened again, setup is the list of the settings as the update left them.
  const again = host(fake, [undefined]);
  await again.setup.open();
  assert.deepEqual([again.titles(), again.shown[0].options.find(option => option.value === 'reviewModel').footer], [['select: AZPR settings'], 'fast + strong']);
  // Saved where the settings are in use, or by a server part that did not make them usable: they wait for the restart.
  const waiting = host(outdated({ afterSave: 'restart', problem: '' }), ['update']);
  await waiting.setup.open();
  assert.equal(waiting.shown.at(-1).message, 'The settings file is updated.\n\nRestart the OpenCode service (opencode service restart), then run /pr-check <PR URL>.');
  assert.deepEqual([waiting.shown.at(-1).title, waiting.loaded], ['AZPR\'s settings are updated', []], 'Nothing was loaded: the commands are as they were.');
  // Saved, but what it leaves cannot be used yet: the reason is the server part's.
  const unusable = host(outdated({ afterSave: 'required', problem: 'azure.patFile could not be used (not found).' }), ['update']);
  await unusable.setup.open();
  assert.equal(unusable.shown.at(-1).message, 'The settings file is updated, but AZPR could not load it: azure.patFile could not be used (not found).\n\nSet that right, then restart the OpenCode service (opencode service restart) and run /pr-check <PR URL>.');
  assert.deepEqual(unusable.loaded, []);
  // A file whose lines the server part did not send as text shows what it has, and still asks before anything is saved.
  const odd = outdated(), status = odd.status;
  odd.status = async () => ({ ...(await status()), migration: { lines: ['One line.', 7, null, { text: 'x' }], word: UPDATE.word } });
  const partial = host(odd, ['keep']);
  await partial.setup.open();
  assert.deepEqual([partial.titles(), partial.shown[0].message, methods(partial)], [UPDATE_DIALOGS, '- One line.\n\nNothing is changed until you confirm in the next step.', ['status']]);
});

test('an update of settings that had a fault says what is still missing and where it is set; run again, /pr-setup is the first setup of the updated file', async () => {
  // No model was ever chosen in these settings: the update changes their layout, and the server part's answer
  // says what the updated file still lacks. Nothing was loaded, so the commands are not read again.
  const NO_MODEL = 'models.review.reviewers[0]: select an actual provider/model ID from opencode models; do not use a display name or placeholder.';
  const faulty = outdated({ afterSave: 'required', problem: NO_MODEL, remaining: NO_MODEL, reviewModel: [], quickModel: [], organization: '', token: false });
  const incomplete = host(faulty, ['update']);
  await incomplete.setup.open();
  assert.deepEqual(incomplete.titles(), [...UPDATE_DIALOGS, 'alert: AZPR\'s settings are updated']);
  assert.equal(incomplete.shown.at(-1).message, `The settings file has the layout of this version now. It still cannot be used:\n\n${NO_MODEL}\n\nSet that right with /pr-setup or in the settings file.`);
  assert.deepEqual([saves(incomplete), incomplete.loaded, incomplete.toasts, faulty.state.state, incomplete.setup.running, incomplete.pins], [[{ migrate: UPDATE.word }], [], [], 'required', false, ['pin@0', 'release@2']]);
  // Run again, /pr-setup asks what a first setup asks, on the updated file, and what it saves is loaded.
  faulty.state.afterSave = undefined;
  const completed = host(faulty, ['fixture', '', TOKEN, 'fixture/strong', 'high', true]);
  await completed.setup.open();
  assert.deepEqual(completed.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token', 'select: Model for /pr-review',
    'select: Variant of fixture/strong', 'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.deepEqual(saves(completed), [{ changes: { organization: 'fixture', proxy: '', model: 'fixture/strong#high' }, token: TOKEN }]);
  assert.deepEqual([faulty.state.state, faulty.state.reviewModel, faulty.state.quickModel, completed.loaded.length], ['ready', ['fixture/strong#high', 'fixture/strong#high'], ['fixture/strong#high'], 1]);
  // Where the settings are in use, the updated file waits for a restart; what it lacks is said all the same, first.
  const inUse = host(outdated({ afterSave: 'restart', problem: '', remaining: 'outputLanguage must be a language tag.' }), ['update']);
  await inUse.setup.open();
  assert.equal(inUse.shown.at(-1).message, 'The settings file has the layout of this version now. It still cannot be used:\n\noutputLanguage must be a language tag.\n\nSet that right with /pr-setup or in the settings file.');
  assert.deepEqual(inUse.loaded, []);
  // Settings that were loaded lack nothing: whatever else the answer holds, the result is that reviews run again.
  const loadedAll = host(outdated({ remaining: 'An answer that cannot be true of settings in use.' }), ['update']);
  await loadedAll.setup.open();
  assert.deepEqual([loadedAll.shown.at(-1).message, loadedAll.loaded], ['Reviews run again:\n\n/pr-check <PR URL>\n/pr-review <PR URL>\n\n/pr-setup shows the models of each mode and changes them.', [2]]);
  // What is missing is the server part's text: anything else it sends in its place is not shown.
  for (const remaining of [7, ['x'], { problem: 'x' }, '']) {
    const wordless = host(outdated({ afterSave: 'restart', problem: '', remaining }), ['update']);
    await wordless.setup.open();
    assert.equal(wordless.shown.at(-1).message, 'The settings file is updated.\n\nRestart the OpenCode service (opencode service restart), then run /pr-check <PR URL>.', JSON.stringify(remaining));
  }
});

test('an update the server part refuses is said and nothing else is asked; a setup that is stopped asks nothing and saves nothing', async () => {
  // The file changed while the question was open: the word names the file that was shown, and the server part refuses it.
  const stale = outdated();
  const refused = host(stale, [() => { stale.state.word = 'ffffffffffff'; return 'update'; }]);
  await refused.setup.open();
  assert.deepEqual(refused.titles(), UPDATE_DIALOGS, 'No further dialog opens: /pr-setup shows the update again when it is run again.');
  assert.deepEqual(refused.calls.at(-1), { method: 'save', input: { migrate: UPDATE.word } });
  assert.deepEqual(refused.toasts, [{ title: 'AZPR setup', message: 'The settings file changed since the update was shown, or OpenCode was restarted since, so nothing was saved. Run /pr-setup again to see the update as it is now.', variant: 'error', duration: 10000 }]);
  assert.deepEqual([methods(refused), stale.state.state, refused.loaded, refused.setup.running], [['status', 'save'], 'migrate', [], false]);
  // Any other refusal is said in the server part's words, and one without words in the terminal part's own.
  const locked = host(outdated({ saveProblem: 'Another setup is active, or its lock was left behind. No settings changed.' }), ['update']);
  await locked.setup.open();
  assert.deepEqual([locked.titles(), locked.toasts], [UPDATE_DIALOGS, [{ title: 'AZPR setup', message: 'Another setup is active, or its lock was left behind. No settings changed.', variant: 'error', duration: 10000 }]]);
  const wordless = outdated();
  wordless.save = async () => ({ ok: false });
  const silent = host(wordless, ['update']);
  await silent.setup.open();
  assert.deepEqual([silent.titles(), silent.toasts], [UPDATE_DIALOGS, [{ title: 'AZPR setup', message: 'The settings could not be saved.', variant: 'error', duration: 10000 }]]);
  // A server part that fails to answer the save ends the setup with the fixed sentence.
  const lost = outdated();
  lost.save = async () => { throw new Error('connection lost: host detail'); };
  const failing = host(lost, ['update']);
  await failing.setup.open();
  assert.deepEqual([failing.titles(), failing.toasts.at(-1).message, failing.setup.running], [UPDATE_DIALOGS, 'AZPR setup stopped: the OpenCode server did not answer as expected. What was saved before stays; run /pr-setup again.', false]);

  // The terminal part is unloaded while the question is open: the answer that arrives afterwards saves nothing.
  const fake = outdated();
  let answer;
  const h = host(fake, [() => new Promise(resolve => { answer = resolve; })]);
  const open = h.setup.open();
  for (let turn = 0; turn < 10 && !answer; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.titles(), UPDATE_DIALOGS);
  h.setup.stop();
  answer('update');
  await open;
  assert.deepEqual([methods(h), fake.state.state, h.toasts, h.loaded, h.setup.running, h.pins], [['status'], 'migrate', [], [], false, ['pin@0', 'release@1']]);
  // Unloaded while the server part saves: what it answers is followed by no dialog, and the commands are not read again.
  const saving = outdated(), save = saving.save;
  let done;
  saving.save = input => new Promise(resolve => { done = () => resolve(save(input)); });
  const g = host(saving, ['update']);
  const opened = g.setup.open();
  for (let turn = 0; turn < 10 && !done; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(methods(g), ['status', 'save']);
  g.setup.stop();
  done();
  await opened;
  assert.deepEqual([g.titles(), methods(g), g.loaded, g.toasts, g.setup.running], [UPDATE_DIALOGS, ['status', 'save'], [], [], false]);
  // Unloaded before it was opened: nothing is asked at all, also not the hint.
  const never = host(outdated(), ['update']);
  never.setup.stop();
  await never.setup.open();
  await never.setup.hint();
  assert.deepEqual([never.calls, never.shown, never.toasts, never.pins], [[], [], [], []]);
});

test('only one setup is open at a time, and the hint is given once and only when AZPR has no usable settings', async () => {
  const fake = ready();
  let release;
  const h = host(fake, [() => new Promise(resolve => { release = resolve; })]);
  const first = h.setup.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.setup.running, true);
  await h.setup.open();
  assert.deepEqual(methods(h), ['status'], 'The second call did nothing.');
  release(undefined);
  await first;
  assert.equal(h.setup.running, false);

  const missing = host(server(), []);
  await missing.setup.hint();
  await missing.setup.hint();
  assert.deepEqual(missing.toasts, [{ message: 'AZPR is not set up yet. Type /pr-setup to set it up.', variant: 'info', duration: 8000 }]);
  // Settings of an earlier version are set up, but not usable: the hint says what /pr-setup is for then, once.
  const earlier = host(outdated(), []);
  await earlier.setup.hint();
  await earlier.setup.hint();
  assert.deepEqual(earlier.toasts, [{ message: 'AZPR\'s settings are from an earlier version. Type /pr-setup to see what changes and update them.', variant: 'info', duration: 8000 }]);
  assert.deepEqual([methods(earlier), earlier.shown, earlier.pins], [['status'], [], []], 'The hint asks once, opens nothing and saves nothing.');
  const set = host(ready(), []);
  await set.setup.hint();
  assert.deepEqual(set.toasts, []);
  // Settings that wait for a restart are usable: no hint is due for them.
  const waiting = host(ready({ state: 'restart' }), []);
  await waiting.setup.hint();
  assert.deepEqual(waiting.toasts, []);
  // A server part that is still loading is asked again later: nothing is said, and nothing is remembered.
  let answers = 0;
  const late = host({ status: async () => { if (answers++ === 0) throw new Error('rpc.unavailable'); return (await server().status()); } }, []);
  await late.setup.hint();
  assert.deepEqual(late.toasts, []);
  await late.setup.hint();
  assert.equal(late.toasts.length, 1);
});
