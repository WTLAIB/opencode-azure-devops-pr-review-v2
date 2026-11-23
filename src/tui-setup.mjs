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
    /** What is set, as rows, and whether AZPR can run (`state`: required, migrate, ready or restart). */
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
const NOT_UPDATED = 'AZPR\'s settings are from an earlier version. Type /pr-setup to see what changes and update them.';
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
      // The saved form of the answer, where the server part sends one back: it sends none for a proxy with a
      // user name and password, and what was typed is then what is checked and saved.
      if (result?.ok) return { value: Object.hasOwn(result.values ?? {}, row.id) ? text(result.values[row.id]) : answer, shown: text(result.shown?.[row.id]) };
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
  async function askOneModel(row, { start = row.current, title = row.title, off = Boolean(row.optional) } = {}) {
    const list = await models();
    // A row that may be off can still be switched off when OpenCode offers no model; a row that needs one cannot be answered.
    if (!list.length && !off) {
      await dialog.alert({ title: 'No model available', message: 'OpenCode offers no model that can call tools. Connect a model provider first (/connect), then run /pr-setup again.' });
      return undefined;
    }
    const current = baseModel(start);
    // Where a row says what to look for (the deep model: a stronger one, or a higher variant), the search line says it.
    const picked = await dialog.select({ title, placeholder: text(row.prompt) || 'Search models', current: off && !current ? '' : current || undefined,
      options: [...(off ? [{ title: row.optional.label, value: '', description: row.optional.description, category: 'Off' }] : []),
        ...list.map(model => ({ title: model.name, value: model.id, description: model.id, category: model.provider }))] });
    if (picked === undefined || picked === '') return picked;
    const variants = list.find(model => model.id === picked)?.variants ?? [];
    if (!variants.length) return picked;
    const variant = await dialog.select({ title: `Variant of ${picked}`, ...(text(row.variantPrompt) ? { placeholder: row.variantPrompt } : {}), current: picked === current ? variantOf(start) : '',
      options: [{ title: 'Default', value: '', description: 'The model\'s own default' }, ...variants.map(name => ({ title: name, value: name }))] });
    return variant === undefined ? undefined : variant ? `${picked}#${variant}` : picked;
  }

  // A list of models as the server part takes it as text: MODEL*N for passes in a row, entries separated by commas.
  const passesText = passes => passes.reduce((runs, model) => { if (runs.at(-1)?.[0] === model) runs.at(-1)[1]++; else runs.push([model, 1]); return runs; }, [])
    .map(([model, count]) => `${model}*${count}`).join(',');
  const shortModel = model => text(model).slice(text(model).indexOf('/') + 1);

  /**
   * A mode's review passes: a model, then how often and with which other models it reviews. One model becomes
   * the mode's usual number of passes (`row.usual`); the first row of the second dialog keeps that, and the
   * others add a pass (the same model again, or another one) or take the last one away, between one pass and
   * `row.most`. The answer is the list as text; '' when the row may be off; undefined when left.
   */
  async function askModel(row) {
    const saved = Array.isArray(row.entries) ? row.entries.filter(item => typeof item === 'string' && item) : [];
    const first = await askOneModel(row, { start: saved[0] ?? '' });
    if (first === undefined || first === '') return first;
    const usual = Number.isInteger(row.usual) && row.usual > 0 ? row.usual : 1, most = Number.isInteger(row.most) && row.most >= usual ? row.most : usual;
    // The saved first model picked again: the saved passes are what the first row keeps, so that looking at a
    // row and taking what it shows changes nothing. Another model starts with the mode's usual passes of it.
    let passes = first === saved[0] && saved.length <= most ? [...saved] : Array(usual).fill(first);
    for (;;) {
      // A model keeps its provider where another pass has one of the same name from another provider.
      const named = model => passes.some(other => other !== model && shortModel(other) === shortModel(model)) ? model : shortModel(model);
      const shown = passes.map(named).join(', ');
      const choice = await dialog.select({ title: `${row.title}: ${passes.length} pass${passes.length === 1 ? '' : 'es'}`, options: [
        { title: `Use ${passes.length === 1 ? 'this pass' : `these ${passes.length} passes`}`, value: 'done', description: shown },
        ...(passes.length < most ? [{ title: 'Add a pass of the same model', value: 'same', description: `${named(passes.at(-1))} once more` },
          { title: 'Add a pass of another model', value: 'other', description: 'Different models find different defects' }] : []),
        ...(passes.length > 1 ? [{ title: 'Take the last pass away', value: 'less', description: `Without ${named(passes.at(-1))}` }] : [])] });
      if (choice === undefined) return undefined;
      if (choice === 'done') return passesText(passes);
      if (choice === 'same') passes = [...passes, passes.at(-1)];
      else if (choice === 'less') passes = passes.slice(0, -1);
      else {
        const another = await askOneModel(row, { start: '', title: `Model of pass ${passes.length + 1}`, off: false });
        if (another) passes = [...passes, another];
      }
    }
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
    // One model for a start: the server part gives it the usual passes of /pr-review and of /pr-quick. Where the
    // settings name review models already, the dialog starts on the first of them.
    const reviewRow = rows('reviewModel');
    const model = await askOneModel(reviewRow, { start: Array.isArray(reviewRow?.entries) && typeof reviewRow.entries[0] === 'string' ? reviewRow.entries[0] : '', off: false });
    if (model === undefined) return false;
    const yes = await dialog.confirm({ title: 'Save AZPR\'s settings?', label: { confirm: 'Save', cancel: 'Leave' },
      message: [`Organization: ${answers.organization}`, `Proxy: ${shown.proxy || 'none'}`, ...(answers.caFile ? [`CA certificate file: ${answers.caFile}`] : []),
        `Token: ${token === undefined ? 'the saved one' : 'the one just entered, in a file only you can read'}`,
        `Model: ${model} (two passes of /pr-review, one of /pr-quick)`, '', 'Other settings keep their values (the defaults in a new file); /pr-setup changes them later.'].join('\n') });
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

  /**
   * Settings of an earlier version: what the update changes, then a list whose first row keeps the file as it
   * is. The server part writes the file only for the word that names what was shown here.
   */
  async function update(status) {
    const lines = Array.isArray(status.migration?.lines) ? status.migration.lines.filter(line => typeof line === 'string') : [];
    await dialog.alert({ title: 'AZPR\'s settings are from an earlier version', message: `${lines.map(line => `- ${line}`).join('\n')}\n\nNothing is changed until you confirm in the next step.` });
    const choice = await dialog.select({ title: 'Update AZPR\'s settings file?', options: [
      { title: 'Not now', value: 'keep', description: 'The file stays as it is; reviews do not run until it is updated' },
      { title: 'Update the settings file', value: 'update', description: text(status.settingsFileShown) || text(status.settingsFile) }] });
    if (choice !== 'update') return false;
    const saved = await call('save', { migrate: text(status.migration?.word) });
    if (!saved?.ok) { failed(saved); return true; }
    if (saved.status?.state === 'ready') loaded();
    // A file that had a fault before the update still has it: say what is missing, and where it is set.
    const remaining = text(saved.remaining);
    await dialog.alert({ title: 'AZPR\'s settings are updated', message: saved.status?.state === 'ready'
      ? 'Reviews run again:\n\n/pr-check <PR URL>\n/pr-review <PR URL>\n\n/pr-setup shows the models of each mode and changes them.'
      : remaining ? `The settings file has the layout of this version now. It still cannot be used:\n\n${remaining}\n\nSet that right with /pr-setup or in the settings file.`
        : text(saved.status?.problem) ? `The settings file is updated, but AZPR could not load it: ${saved.status.problem.replace(/\.$/, '')}.\n\nSet that right, then restart the OpenCode service (opencode service restart) and run /pr-check <PR URL>.`
          : 'The settings file is updated.\n\nRestart the OpenCode service (opencode service restart), then run /pr-check <PR URL>.' });
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
        // A row whose name does not say what it is for carries a few words about it, between its name and its value.
        ...rows.map(row => ({ title: row.label, value: row.id, ...(text(row.hint) ? { description: row.hint } : {}), footer: text(row.value), category: row.group })),
        { title: 'Settings file', value: '@file', footer: text(status.settingsFileShown) || text(status.settingsFile), category: 'More' }] });
      if (choice === undefined) return;
      last = choice;
      if (choice === '@restart') {
        await dialog.alert({ title: 'Restart needed', message: 'Settings are read when OpenCode loads AZPR. What was changed takes effect after the OpenCode service restarts:\n\nopencode service restart\n\nUntil then AZPR refuses new reviews.' });
        continue;
      }
      if (choice === '@file') {
        // The README is long: the server part names the section that describes every setting, with its address.
        await dialog.alert({ title: 'Settings file', message: `${text(status.settingsFile)}\n\nSettings that are not in this list are changed in this file. Each one is described in ${text(status.settingsReference) || 'the README'}.` });
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
            problem: previous ? `The saved token was saved for ${previous}. Enter a token of ${answer.value}; without one the organization stays ${previous}.`
              : `The token these settings name was saved without an organization. Enter a token of ${answer.value}; without one the organization is not saved.` });
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
        // Before anything else: settings of an earlier version are neither missing nor in need of repair.
        if (status.state === 'migrate') {
          if (!(await update(status))) toast({ message: 'AZPR setup: the settings file was left as it is.', variant: 'info' });
          return;
        }
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
      if (hinted || !['required', 'migrate'].includes(status?.state)) return;
      hinted = true;
      toast({ message: status.state === 'migrate' ? NOT_UPDATED : NOT_SET_UP, variant: 'info', duration: 8000 });
    },
    get running() { return running; },
    /** The terminal part is being unloaded: a setup that is open ends at its next step, and none opens after it. */
    stop() { stopped = true; },
  };
}
