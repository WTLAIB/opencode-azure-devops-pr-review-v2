import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_RPC, createSetup, isSetupNotice } from '../src/tui-setup.mjs';

const TOKEN = 'tui-setup-token-0123456789abcdefghijklmnopqrstuvwxyz';
const MODELS = [
  { id: 'fixture/fast', name: 'Fast', provider: 'Fixture AI', variants: [] },
  { id: 'fixture/strong', name: 'Strong', provider: 'Fixture AI', variants: ['low', 'high'] },
];

/** A stand-in for the server part: the rows it describes and what it answers, as src/setup.mjs shapes them. */
function server(start = {}) {
  const state = { organization: '', proxy: '', caFile: '', reviewModel: '', quickModel: '', deepModel: '', language: 'en', afterReview: 'preview', token: false, state: 'required', editable: true, ...start };
  const checks = [];
  const status = () => ({ version: 1, state: state.state, problem: state.state === 'required' ? 'there is no settings file yet.' : '', editable: state.editable, fileProblem: state.editable ? '' : 'The settings file is not valid JSON.',
    settingsFile: '/home/user/.config/azpr/settings.json', settingsFileShown: '~/.config/azpr/settings.json', organization: state.organization,
    rows: [
      { id: 'organization', group: 'Azure DevOps', label: 'Organization', kind: 'text', title: 'Azure DevOps organization', description: 'The name in https://dev.azure.com/<organization>.', placeholder: 'my-organization', value: state.organization || 'not set', current: state.organization },
      { id: 'token', group: 'Azure DevOps', label: 'Access token', kind: 'secret', title: 'Personal access token', description: 'Create one at https://dev.azure.com/{organization}/_usersSettings/tokens.', value: state.token ? 'saved in ~/.config/azpr/pat' : 'not set', saved: state.token },
      { id: 'proxy', group: 'Azure DevOps', label: 'Proxy', kind: 'text', title: 'Proxy for Azure DevOps (optional)', description: 'Leave it empty and press Enter to skip.', placeholder: 'http://proxy.example.com:8080', value: state.proxy || 'none', current: state.proxy },
      { id: 'caFile', group: 'Azure DevOps', label: 'CA certificate file', kind: 'text', title: 'CA certificate file (optional)', description: 'Leave it empty and press Enter to skip.', value: state.caFile || 'none', current: state.caFile },
      { id: 'reviewModel', group: 'Models', label: 'Review model', kind: 'model', title: 'Model for /pr-review', value: state.reviewModel || 'not set', current: state.reviewModel },
      { id: 'deepModel', group: 'Models', label: 'Deep model', kind: 'model', title: 'Stronger model for /pr-deep', optional: { label: 'Off', description: '/pr-deep stays off' }, value: state.deepModel || 'off', current: state.deepModel },
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
    return value;
  };
  return {
    state, checks,
    status: async () => status(),
    validate: async ({ changes }) => {
      try {
        const values = Object.fromEntries(Object.entries(changes).map(([id, answer]) => [id, accept(id, answer)]));
        return { ok: true, values, shown: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, id === 'proxy' ? value.replace(/\/\/[^@/]*@/, '//') : value])) };
      } catch (error) { return { ok: false, problem: error.message }; }
    },
    check: async input => {
      checks.push(input);
      const scripted = state.checkAnswers?.shift();
      return scripted ?? { ok: true, organization: input.organization };
    },
    save: async ({ changes = {}, token }) => {
      if (state.saveProblem) return { ok: false, problem: state.saveProblem };
      for (const [id, answer] of Object.entries(changes)) {
        if (id === 'model') { state.reviewModel = answer; state.quickModel = answer; } else state[id] = accept(id, answer);
      }
      if (token !== undefined) state.token = true;
      state.state = state.state === 'required' ? (state.afterSave ?? 'ready') : 'restart';
      return { ok: true, status: status() };
    },
  };
}

/** Setup with dialogs that answer from a list, in order; every dialog, toast and RPC call is recorded. */
function host(fake, answers, { models = MODELS } = {}) {
  const calls = [], shown = [], toasts = [], loaded = [];
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
    models: async () => models,
    loaded: () => loaded.push(shown.length),
  });
  const said = () => JSON.stringify([shown, toasts]);
  return { setup, calls, shown, toasts, said, loaded, left: () => queue.length, titles: () => shown.map(item => `${item.kind}: ${item.title}`) };
}
const methods = h => h.calls.map(call => call.method);

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
  assert.deepEqual(h.titles(), ['prompt: Azure DevOps organization', 'prompt: Proxy for Azure DevOps (optional)', 'secret: Personal access token', 'select: Model for /pr-review',
    'confirm: Save AZPR\'s settings?', 'alert: AZPR is set up']);
  assert.deepEqual(methods(h), ['status', 'validate', 'validate', 'check', 'save']);
  // The proxy is asked before anything is sent to Azure DevOps, and "none" is what the check is told.
  assert.deepEqual(fake.checks, [{ organization: 'fixture', token: TOKEN, proxy: '' }]);
  assert.deepEqual(h.calls.at(-1).input, { changes: { organization: 'fixture', proxy: '', model: 'fixture/fast' }, token: TOKEN });
  assert.equal(h.shown[2].description, 'Create one at https://dev.azure.com/fixture/_usersSettings/tokens.', 'The token dialog names the organization just given.');
  assert.match(h.shown[4].message, /^Organization: fixture\nProxy: none\nToken: the one just entered, in a file only you can read\nModel: fixture\/fast \(reviewers, verifier and \/pr-quick\)\n/);
  assert.match(h.shown.at(-1).message, /\/pr-check <PR URL>\n\/pr-review <PR URL>/);
  assert.deepEqual(h.loaded, [5], 'The commands are read again once the first setup is loaded, before its result is shown.');
  assert.ok(!h.said().includes(TOKEN), 'The token is in no dialog and no toast.');
  assert.equal(h.left(), 0);
  assert.deepEqual([fake.state.organization, fake.state.reviewModel, fake.state.quickModel, fake.state.token], ['fixture', 'fixture/fast', 'fixture/fast', true]);
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

const ready = (more = {}) => server({ state: 'ready', organization: 'fixture', token: true, reviewModel: 'fixture/fast', quickModel: 'fixture/fast', ...more });

test('with settings in place, the settings are one list: grouped rows with their values, and the file they are in', async () => {
  const h = host(ready(), [undefined]);
  await h.setup.open();
  assert.deepEqual(methods(h), ['status']);
  const list = h.shown[0];
  assert.deepEqual([list.kind, list.title, list.placeholder], ['select', 'AZPR settings', 'Search settings']);
  assert.deepEqual(list.options.map(option => [option.category, option.title, option.footer]), [
    ['Azure DevOps', 'Organization', 'fixture'], ['Azure DevOps', 'Access token', 'saved in ~/.config/azpr/pat'], ['Azure DevOps', 'Proxy', 'none'], ['Azure DevOps', 'CA certificate file', 'none'],
    ['Models', 'Review model', 'fixture/fast'], ['Models', 'Deep model', 'off'], ['Reviews', 'Output language', 'en'], ['Reviews', 'After a review', 'preview'],
    ['More', 'Settings file', '~/.config/azpr/settings.json']]);
  assert.equal(h.toasts.length, 0, 'Leaving the list is no cancelled setup.');
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
  assert.match(h.shown[5].message, /^\/home\/user\/\.config\/azpr\/settings\.json\n/);
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
  assert.deepEqual(h.calls.filter(call => call.method === 'save').map(call => call.input), [{ changes: { language: 'pt-BR' } }, { changes: { afterReview: 'publish' } }, { changes: { afterReview: 'none' } }]);
  assert.equal(fake.state.afterReview, 'none');
  // A language outside the list is the row's current value: the list marks "Another language" and shows the tag there.
  const again = host(ready({ language: 'pt-BR' }), ['language', undefined, undefined]);
  await again.setup.open();
  assert.deepEqual(again.shown[1].options.at(-1), { title: 'Another language', value: again.shown[1].current, description: 'pt-BR' });
});

test('a model is picked from the host\'s list with its variant; a row that may be off offers that first', async () => {
  const fake = ready({ deepModel: 'fixture/strong#high' });
  const h = host(fake, ['reviewModel', 'fixture/strong', 'high', 'deepModel', '', 'reviewModel', 'fixture/strong', '', 'reviewModel', 'fixture/strong', undefined, undefined]);
  await h.setup.open();
  assert.deepEqual(h.shown[1].options, [{ title: 'Fast', value: 'fixture/fast', description: 'fixture/fast', category: 'Fixture AI' }, { title: 'Strong', value: 'fixture/strong', description: 'fixture/strong', category: 'Fixture AI' }]);
  assert.deepEqual([h.shown[1].current, h.shown[1].placeholder], ['fixture/fast', 'Search models']);
  assert.deepEqual(h.shown[2].options.map(option => option.value), ['', 'low', 'high']);
  assert.equal(h.shown[2].title, 'Variant of fixture/strong');
  const deep = h.shown.find(item => item.title === 'Stronger model for /pr-deep');
  assert.deepEqual(deep.options[0], { title: 'Off', value: '', description: '/pr-deep stays off', category: 'Off' });
  assert.equal(deep.current, 'fixture/strong', 'The current model is marked without its variant.');
  assert.deepEqual(h.calls.filter(call => call.method === 'save').map(call => call.input.changes), [{ reviewModel: 'fixture/strong#high' }, { deepModel: '' }, { reviewModel: 'fixture/strong' }]);
  // The variant dialog starts on the variant in use, and leaving it changes nothing.
  assert.equal(h.shown.filter(item => item.title === 'Variant of fixture/strong')[1].current, 'high');
  const none = host(ready(), ['reviewModel', undefined], { models: [] });
  await none.setup.open();
  assert.deepEqual(none.titles(), ['select: AZPR settings', 'alert: No model available', 'select: AZPR settings']);
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
  assert.deepEqual(h.calls.filter(call => call.method === 'save').map(call => call.input), [{ token: TOKEN }]);
  assert.ok(!h.said().includes(TOKEN));
  // Without an organization there is nothing to check a token for.
  const bare = host(server({ state: 'ready', reviewModel: 'fixture/fast' }), ['token', undefined]);
  await bare.setup.open();
  assert.deepEqual(bare.shown[1], { kind: 'alert', title: 'Personal access token', message: 'Set the organization first: a token is checked for it.' });
});

test('from the list, a failed check lets the proxy be changed and saved before the token is checked again', async () => {
  const fake = ready({ checkAnswers: [{ ok: false, fix: 'proxy', problem: 'Azure DevOps could not be reached (ETIMEDOUT). This network may need a proxy.' }] });
  const h = host(fake, ['token', TOKEN, 'repair', 'http://proxy.example:8080', undefined]);
  await h.setup.open();
  assert.deepEqual(methods(h), ['status', 'check', 'validate', 'save', 'check', 'save']);
  assert.deepEqual(h.calls[3].input, { changes: { proxy: 'http://proxy.example:8080' } });
  assert.deepEqual(h.calls[5].input, { token: TOKEN });
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
  const set = host(ready(), []);
  await set.setup.hint();
  assert.deepEqual(set.toasts, []);
  // A server part that is still loading is asked again later: nothing is said, and nothing is remembered.
  let answers = 0;
  const late = host({ status: async () => { if (answers++ === 0) throw new Error('rpc.unavailable'); return (await server().status()); } }, []);
  await late.setup.hint();
  assert.deepEqual(late.toasts, []);
  await late.setup.hint();
  assert.equal(late.toasts.length, 1);
});
