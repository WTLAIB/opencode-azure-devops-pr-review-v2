// AZPR's setup in OpenCode's terminal UI: what is asked, in which order, and what is done with the answers.
//
// The server part (src/setup.mjs) knows every setting: it describes each as a row (what it is called, its
// value, how it is asked), checks an answer, asks Azure DevOps whether a token works, and is the only one to
// write the settings file and the token file. This part only asks, with the host's own dialogs, and hands
// the answers to the server part over the plugin's RPC. It reads no file, writes none and makes no request
// to Azure DevOps. A token it was given is passed on once and kept nowhere: not in a toast, a dialog text,
// a log or a store.
//
// This module imports nothing, so that the order of its questions is tested with answers a test gives
// (tests/tui-setup.test.mjs); src/tui-view.jsx supplies the dialogs, the masked token field, the host's
// model list and the RPC.

/**
 * The RPC between the two parts. The schemas are deliberately loose: the server part checks every value
 * itself and answers in its own words, so a refused input is never quoted by the host's schema error.
 */
const anyObject = Object.freeze({ type: 'object' });
export const SETUP_RPC = Object.freeze({
  id: 'azpr.setup',
  methods: Object.freeze({
    /** What is set, as rows, and whether AZPR can run (`state`: required, ready or restart). */
    status: Object.freeze({ input: anyObject, output: anyObject }),
    /** Whether answers can be used, and their saved form, without saving anything. */
    validate: Object.freeze({ input: anyObject, output: anyObject }),
    /** Whether Azure DevOps accepts a token (the one given, else the saved one) for an organization. */
    check: Object.freeze({ input: anyObject, output: anyObject }),
    /** Save answers; the server part writes the files. */
    save: Object.freeze({ input: anyObject, output: anyObject }),
  }),
  events: Object.freeze({
    /**
     * A first setup was loaded: the review commands are the real ones now. OpenCode 2.3.0 announces a change
     * of commands that a plugin makes after it was loaded without saying where, and its clients then keep
     * the list they have; the terminal part reads the commands again when it hears this.
     */
    loaded: Object.freeze({ schema: anyObject }),
  }),
});

/** Whether a notice is the server part's answer to /pr-setup without options: the terminal part then asks. */
export const isSetupNotice = metadata => metadata !== null && typeof metadata === 'object' && metadata.azpr !== null &&
  typeof metadata.azpr === 'object' && metadata.azpr.setup === true;

const NOT_SET_UP = 'AZPR is not set up yet. Type /pr-setup to set it up.';
const CANCELLED = 'AZPR setup: left before the end; nothing was saved.';
const STOPPED = 'AZPR setup stopped: the OpenCode server did not answer as expected. What was saved before stays; run /pr-setup again.';
const UNAVAILABLE = 'AZPR setup is not available: this OpenCode server did not answer for AZPR. Restart the OpenCode service and try again; /pr-setup --help shows the options.';
const text = value => typeof value === 'string' ? value : '';
const rowOf = (status, id) => (Array.isArray(status?.rows) ? status.rows : []).find(row => row?.id === id);
const withProblem = (problem, description) => problem ? `${problem}\n\n${description}` : description;
// A model as settings name it: provider/model, optionally with #variant.
const baseModel = value => text(value).split('#')[0];
const variantOf = value => text(value).includes('#') ? text(value).slice(text(value).indexOf('#') + 1) : '';

/**
 * @param {object} host
 * @param {(method: string, input?: object) => Promise<any>} host.call the server part's RPC
 * @param {{prompt: Function, select: Function, confirm: Function, alert: Function}} host.dialog the host's dialogs
 * @param {(options: {title: string, description: string, problem?: string, optional?: boolean}) => Promise<string | undefined>} host.secret a field that shows nothing of what is typed
 * @param {(options: {title?: string, message: string, variant?: string, duration?: number}) => void} host.toast
 * @param {() => Promise<Array<{id: string, name: string, provider: string, variants: string[]}>>} host.models models the host offers that can call tools
 * @param {() => void} [host.loaded] told when a first setup was loaded, so that the commands are read again
 * @param {() => (() => void)} [host.pin] called when a setup opens: from then until the function it returns
 *   is called, `call`, `models` and `loaded` must reach the same server part, whatever is on screen meanwhile
 */
export function createSetup(host) {
  let running = false, hinted = false, stopped = false;
  // After stop() nothing more is asked of the server part or of the person: a setup that is under way ends
  // at its next step, whatever answer arrives for the step it was waiting on, and saves nothing more.
  const live = run => (...inputs) => {
    if (stopped) throw new Error('AZPR setup was stopped.');
    return run(...inputs);
  };
  const call = live((method, input) => host.call(method, input));
  const dialog = { prompt: live(options => host.dialog.prompt(options)), select: live(options => host.dialog.select(options)),
    confirm: live(options => host.dialog.confirm(options)), alert: live(options => host.dialog.alert(options)) };
  const secret = live(options => host.secret(options));
  const models = live(() => host.models());
  const toast = options => { if (!stopped) host.toast(options); };
  const loaded = () => { if (!stopped) host.loaded?.(); };
  const pin = () => host.pin?.();

  /**
   * A text answer the server part accepts, or undefined when the person left: `value` is its saved form and
   * `shown` how it may be displayed (a proxy without its user name and password).
   */
  async function askText(row, start = row.current ?? '') {
    let problem = '', value = start;
    for (;;) {
      const answer = await dialog.prompt({ title: row.title, description: withProblem(problem, row.description), placeholder: row.placeholder, value });
      if (answer === undefined) return undefined;
      const result = await call('validate', { changes: { [row.id]: answer } });
      if (result?.ok) return { value: text(result.values?.[row.id]), shown: text(result.shown?.[row.id]) };
      problem = text(result?.problem) || 'That value cannot be used.';
      value = answer;
    }
  }

  /** One of a row's choices, or undefined; a choice that needs it is confirmed, with the safe answer first. */
  async function askChoice(row) {
    const choices = Array.isArray(row.choices) ? row.choices : [];
    const listed = choices.some(choice => choice.value === row.current);
    const OTHER = '\u0000other';
    const picked = await dialog.select({ title: row.title, current: listed ? row.current : row.other ? OTHER : undefined,
      options: [...choices.map(choice => ({ title: choice.label, value: choice.value, description: choice.description })),
        ...(row.other ? [{ title: row.other.label, value: OTHER, description: listed ? undefined : text(row.current) }] : [])] });
    if (picked === undefined) return undefined;
    if (picked === OTHER) return (await askText({ ...row, ...row.other }))?.value;
    const confirm = choices.find(choice => choice.value === picked)?.confirm;
    if (confirm && picked !== row.current) {
      const answer = await dialog.select({ title: confirm.title, options: [
        { title: confirm.keep, value: 'keep', description: confirm.message },
        { title: confirm.accept, value: 'accept' }] });
      if (answer !== 'accept') return undefined;
    }
    return picked;
  }

  /** A model of the host's list, with its variant when it has some; '' when the row may be off; undefined when left. */
  async function askModel(row) {
    const list = await models();
    if (!list.length) {
      await dialog.alert({ title: 'No model available', message: 'OpenCode offers no model that can call tools. Connect a model provider first (/connect), then run /pr-setup again.' });
      return undefined;
    }
    const current = baseModel(row.current);
    const picked = await dialog.select({ title: row.title, placeholder: 'Search models', current: row.optional && !current ? '' : current || undefined,
      options: [...(row.optional ? [{ title: row.optional.label, value: '', description: row.optional.description, category: 'Off' }] : []),
        ...list.map(model => ({ title: model.name, value: model.id, description: model.id, category: model.provider }))] });
    if (picked === undefined || picked === '') return picked;
    const variants = list.find(model => model.id === picked)?.variants ?? [];
    if (!variants.length) return picked;
    const variant = await dialog.select({ title: `Variant of ${picked}`, current: picked === current ? variantOf(row.current) : '',
      options: [{ title: 'Default', value: '', description: 'The model\'s own default' }, ...variants.map(name => ({ title: name, value: name }))] });
    return variant === undefined ? undefined : variant ? `${picked}#${variant}` : picked;
  }

  /**
   * Ask for the token and have Azure DevOps check it. Returns `{ token }` (undefined: the saved one was
   * checked and stays), `{ organization: problem }` when Azure DevOps knows no such organization, or
   * undefined when the person left.
   * `network()` gives the proxy and CA file to check with (none: the saved ones); `repair(fix)` lets the
   * person change the proxy or the CA file after a failure and says whether to try again; `problem` is
   * what the dialog says first.
   */
  async function askToken(row, { organization, network, repair, problem = '' }) {
    for (;;) {
      const answer = await secret({ title: row.title, problem, optional: row.saved === true,
        description: text(row.description).replaceAll('{organization}', organization) + (row.saved === true ? ' Leave it empty to keep the saved token.' : '') });
      if (answer === undefined) return undefined;
      const token = answer.trim() || undefined;
      if (token === undefined && row.saved !== true) { problem = 'Paste the token first.'; continue; }
      // The same token is checked again after the network settings were changed.
      for (;;) {
        toast({ message: 'AZPR: asking Azure DevOps whether the token works…', variant: 'info', duration: 2000 });
        const result = await call('check', { organization, ...(token === undefined ? {} : { token }), ...network() });
        if (result?.ok) {
          toast({ message: `AZPR: Azure DevOps accepted the token for ${organization}.`, variant: 'success' });
          return { token };
        }
        const why = text(result?.problem) || 'The token could not be checked.';
        if (result?.fix === 'organization') return { organization: why };
        if (result?.fix === 'token') { problem = why; break; }
        await dialog.alert({ title: 'The token could not be checked', message: why });
        const fixable = result?.fix === 'proxy' || result?.fix === 'caFile';
        const next = await dialog.select({ title: 'What now?', options: [
          ...(fixable ? [{ title: result.fix === 'proxy' ? 'Set a proxy and try again' : 'Set the CA certificate file and try again', value: 'repair' }] : []),
          { title: 'Try again', value: 'again' },
          { title: token === undefined ? 'Keep the saved token without checking it' : 'Save the token without checking it', value: 'unchecked', description: '/pr-check tells later whether it works' }] });
        if (next === undefined) return undefined;
        // Unchecked: the token that was entered is saved as it is, and where none was entered the saved one stays.
        if (next === 'unchecked') return { token, unchecked: true };
        if (next === 'repair' && !(await repair(result.fix))) return undefined;
      }
    }
  }

  const failed = result => toast({ title: 'AZPR setup', message: text(result?.problem) || 'The settings could not be saved.', variant: 'error', duration: 10000 });
  const restartNote = status => status?.state === 'restart'
    ? 'Saved. It takes effect after the OpenCode service restarts: opencode service restart'
    : 'Saved.';

  /** The first setup: what a review cannot run without, and the network settings that could make it fail. */
  async function firstSetup(status) {
    const rows = id => rowOf(status, id);
    const answers = {}, shown = {};
    let problem = '';
    const ask = async (id, row = rows(id)) => {
      const answer = await askText({ ...row, description: withProblem(problem, row.description) }, answers[id] ?? row.current ?? '');
      problem = '';
      if (answer === undefined) return false;
      answers[id] = answer.value;
      shown[id] = answer.shown;
      return true;
    };
    if (!(await ask('organization'))) return false;
    // Asked before anything is sent to Azure DevOps: a network that needs them makes every later step fail.
    if (!(await ask('proxy'))) return false;
    if (answers.proxy !== '' && !(await ask('caFile'))) return false;
    let token;
    for (;;) {
      const answer = await askToken(rows('token'), { organization: answers.organization,
        network: () => ({ proxy: answers.proxy, ...(answers.caFile === undefined ? {} : { caFile: answers.caFile }) }),
        repair: fix => ask(fix) });
      if (answer === undefined) return false;
      if (answer.organization === undefined) { token = answer.token; break; }
      // Azure DevOps knows no such organization: ask for it again, then for the token again.
      problem = answer.organization;
      if (!(await ask('organization'))) return false;
    }
    const model = await askModel(rows('reviewModel'));
    if (model === undefined) return false;
    const yes = await dialog.confirm({ title: 'Save AZPR\'s settings?', label: { confirm: 'Save', cancel: 'Leave' },
      message: [`Organization: ${answers.organization}`, `Proxy: ${shown.proxy || 'none'}`, ...(answers.caFile ? [`CA certificate file: ${answers.caFile}`] : []),
        `Token: ${token === undefined ? 'the saved one' : 'the one just entered, in a file only you can read'}`,
        `Model: ${model} (reviewers, verifier and /pr-quick)`, '', 'Other settings keep their values (the defaults in a new file); /pr-setup changes them later.'].join('\n') });
    if (!yes) return false;
    const saved = await call('save', { changes: { organization: answers.organization, proxy: answers.proxy, ...(answers.caFile === undefined ? {} : { caFile: answers.caFile }), model },
      ...(token === undefined ? {} : { token }) });
    if (!saved?.ok) { failed(saved); return true; }
    if (saved.status?.state === 'ready') loaded();
    await dialog.alert({ title: 'AZPR is set up', message: (saved.status?.state === 'ready'
      ? 'Check access to a pull request, then review it:\n\n/pr-check <PR URL>\n/pr-review <PR URL>\n\n/pr-setup shows and changes these settings.'
      : `The settings are saved${text(saved.status?.problem) ? `, but AZPR could not load them: ${saved.status.problem.replace(/\.$/, '')}` : ''}.\n\nRestart the OpenCode service (opencode service restart), then run /pr-check <PR URL>.`) +
      // What the server part adds: where the token of an earlier organization still is.
      (text(saved.note) ? `\n\n${saved.note}` : '') });
    return true;
  }

  /** The settings as one list; choosing a row changes it, and the list comes back with the new value. */
  async function settingsList(first) {
    let status = first, last;
    /** Change one text row at once (the proxy or the CA file, from the token's check); whether it was changed. */
    const change = async row => {
      const answer = await askText(row);
      if (answer === undefined) return false;
      const saved = await call('save', { changes: { [row.id]: answer.value } });
      if (!saved?.ok) { failed(saved); return false; }
      status = saved.status;
      return true;
    };
    for (;;) {
      const rows = (Array.isArray(status?.rows) ? status.rows : []).filter(row => row && typeof row.id === 'string');
      // The list comes back on the row that was changed, which may be far from its top: the title says what is pending.
      const choice = await dialog.select({ title: status.state === 'restart' ? 'AZPR settings · restart needed' : 'AZPR settings', placeholder: 'Search settings', current: last, options: [
        ...(status.state === 'restart' ? [{ title: 'Restart needed', value: '@restart', footer: 'opencode service restart', category: 'Status' }] : []),
        ...rows.map(row => ({ title: row.label, value: row.id, footer: text(row.value), category: row.group })),
        { title: 'Settings file', value: '@file', footer: text(status.settingsFileShown) || text(status.settingsFile), category: 'More' }] });
      if (choice === undefined) return;
      last = choice;
      if (choice === '@restart') {
        await dialog.alert({ title: 'Restart needed', message: 'Settings are read when OpenCode loads AZPR. What was changed takes effect after the OpenCode service restarts:\n\nopencode service restart\n\nUntil then AZPR refuses new reviews.' });
        continue;
      }
      if (choice === '@file') {
        await dialog.alert({ title: 'Settings file', message: `${text(status.settingsFile)}\n\nSettings that are not in this list are changed in this file; the README lists them all.` });
        continue;
      }
      const row = rows.find(item => item.id === choice);
      const tokenRow = rows.find(item => item.kind === 'secret');
      const repair = fix => change(rows.find(item => item.id === fix));
      let input;
      if (row.kind === 'secret') {
        const organization = text(status.organization);
        if (!organization) { await dialog.alert({ title: row.title, message: 'Set the organization first: a token is checked for it.' }); continue; }
        const answer = await askToken(row, { organization, network: () => ({}), repair });
        if (answer === undefined) continue;
        if (answer.organization !== undefined) { await dialog.alert({ title: row.title, message: answer.organization }); continue; }
        if (answer.token === undefined) continue; // The saved token was checked, or left unchecked: nothing to save.
        // Saved for the organization it was checked for: the server part refuses it when the settings name another by now.
        input = { token: answer.token, organization };
      } else if (row.id === 'organization' && (tokenRow?.bound ?? tokenRow?.saved) === true) {
        const answer = await askText(row);
        if (answer === undefined) continue;
        const previous = text(status.organization);
        if (answer.value.toLowerCase() === previous.toLowerCase()) input = { changes: { organization: answer.value } };
        else {
          // The token these settings name was saved for the organization that is being replaced, whether it can
          // be used at the moment or not: the new one gets its own, checked for it, and both are saved together
          // or not at all.
          const token = await askToken({ ...tokenRow, saved: false }, { organization: answer.value, network: () => ({}), repair,
            problem: `The saved token was saved for ${previous}. Enter a token of ${answer.value}; without one the organization stays ${previous}.` });
          if (token === undefined) continue;
          if (token.organization !== undefined) { await dialog.alert({ title: row.title, message: token.organization }); continue; }
          input = { changes: { organization: answer.value }, token: token.token };
        }
      } else {
        const value = row.kind === 'model' ? await askModel(row) : row.kind === 'choice' ? await askChoice(row) : (await askText(row))?.value;
        if (value === undefined) continue;
        input = { changes: { [row.id]: value } };
      }
      const saved = await call('save', input);
      if (!saved?.ok) { failed(saved); continue; }
      status = saved.status;
      toast({ message: `AZPR: ${restartNote(status)}`, variant: 'success', duration: status?.state === 'restart' ? 8000 : 2500 });
      // What the server part adds: where the token of an earlier organization still is. It stays until it was read.
      if (text(saved.note)) await dialog.alert({ title: 'An earlier token is still on disk', message: saved.note });
    }
  }

  return {
    /** Ask what is missing, or show the settings. One at a time: a second call while one is open does nothing. */
    async open() {
      if (running || stopped) return;
      running = true;
      // One setup talks to one server part, from its first question to its save.
      const release = pin();
      try {
        let status;
        try { status = await call('status', {}); } catch { toast({ title: 'AZPR setup', message: UNAVAILABLE, variant: 'error', duration: 10000 }); return; }
        if (!status || !Array.isArray(status.rows)) { toast({ title: 'AZPR setup', message: text(status?.problem) || UNAVAILABLE, variant: 'error', duration: 10000 }); return; }
        if (status.editable === false) {
          await dialog.alert({ title: 'AZPR\'s settings file needs repair', message: `${text(status.fileProblem) || 'The settings file cannot be changed here.'}\n\n${text(status.settingsFile)}\n\nRepair it by hand, then run /pr-setup again.` });
          return;
        }
        if (status.state === 'required') {
          if (!(await firstSetup(status))) toast({ message: CANCELLED, variant: 'info' });
          return;
        }
        await settingsList(status);
      } catch {
        // What the error says is not shown: it is the host's text, and this part cannot know that it holds no answer.
        toast({ title: 'AZPR setup', message: STOPPED, variant: 'error', duration: 10000 });
      } finally { running = false; release?.(); }
    },
    /** Say once, when AZPR has no usable settings, how to set it up. */
    async hint() {
      if (hinted || stopped) return;
      let status;
      try { status = await call('status', {}); } catch { return; }
      if (hinted || status?.state !== 'required') return;
      hinted = true;
      toast({ message: NOT_SET_UP, variant: 'info', duration: 8000 });
    },
    get running() { return running; },
    /** The terminal part is being unloaded: a setup that is open ends at its next step, and none opens after it. */
    stop() { stopped = true; },
  };
}
