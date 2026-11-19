// What a person can do from AZPR's terminal panel. After a review or a comment preview: have the comments
// previewed, post the preview, leave findings out or change a level, reset those adjustments. While a run is
// under way: stop it. The panel lists these in one row at its foot; picking one asks what is needed in the
// host's own dialogs and then sends the same command a person would type, /pr-comment or /pr-stop, to the
// session on screen. Nothing else is ever sent from the terminal part, and nothing is decided here: the server
// part takes the command as it takes a typed one, with its own checks, its notices and its receipt.
//
// What is offered comes from the runtime, in the metadata of the notice that offers it (`previewActions` in
// comments.mjs for a review or a preview; the run's ID with its STARTED notice), and is checked before it gets
// here (`nextOf` and `stopOf` in tui-model.mjs): a command is made only of a review ID, finding IDs, level
// names and the word for the review's comments, or of a run ID, all of the checked forms, never of a text.
// Every /pr-comment command hands that word back (`--seen`): a notice shows what its own conversation was
// told, and the runtime refuses a command whose review was planned or adjusted since, from wherever. /pr-stop
// names its run, and a run that has ended is not stopped.
//
// Nothing here imports anything, so that the order of the dialogs is tested with scripted answers
// (tests/tui-actions.test.mjs); src/tui-view.jsx supplies the dialogs and the sending.

const LEVELS = ['high', 'medium', 'low'];
const APPLY = '\u0000apply', EXCLUDE = '\u0000exclude';
// The key that applies the adjustments from the list of findings, at the foot of that dialog. Letters go to the
// dialog's search line, so it is a chord; OpenCode binds nothing to this one.
const APPLY_KEY = 'ctrl+s';
// Said when a person's answer comes back for something the panel no longer offers.
const CHANGED = 'Nothing was sent: what the panel showed has changed since. Read it again, then pick.';

/** The level the review itself gave a finding. */
const own = finding => finding.original ?? finding.severity;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * What the panel lists for what a notice offers, in the order it is shown; nothing without an offer. `key`
 * picks one while the panel has the keyboard. A label that ends in "…" asks before anything is sent; one that
 * does not is sent at once. `primary` marks the step the others lead to.
 */
export function actionRows(next) {
  if (!next) return [];
  // A run under way offers one thing. It is asked about first, and it is not the step anything leads to.
  if (next.stop) return [{ id: 'stop', key: 's', label: 'Stop this run…' }];
  const adjusted = next.findings.some(finding => finding.excluded || finding.original !== undefined);
  return [
    // A review without a preview yet: one is planned first, so that what is posted was read. A model runs,
    // and nothing is posted.
    ...(next.plan ? [{ id: 'plan', key: 'c', label: 'Preview comments', primary: true }] : []),
    ...(next.publish ? [{ id: 'publish', key: 'p', label: `Post ${plural(next.posts, 'comment')}…`, primary: true }] : []),
    ...(next.adjust && next.findings.length ? [{ id: 'adjust', key: 'a', label: 'Adjust findings…' }] : []),
    // Both lists are cleared at once, which is more than the last step undone.
    ...(next.adjust && adjusted ? [{ id: 'reset', key: 'u', label: 'Reset adjustments' }] : []),
  ];
}

/** The adjustments a preview was planned with: the findings left out, and the levels that differ from the review's. */
export function savedAdjustments(next) {
  return {
    excluded: new Set(next.findings.filter(finding => finding.excluded).map(finding => finding.id)),
    levels: new Map(next.findings.filter(finding => !finding.excluded && finding.original !== undefined).map(finding => [finding.id, finding.severity])),
  };
}

const sameAdjustments = (a, b) => a.excluded.size === b.excluded.size && [...a.excluded].every(id => b.excluded.has(id)) &&
  a.levels.size === b.levels.size && [...a.levels].every(([id, level]) => b.levels.get(id) === level);

/** What every command ends with: the word for the review's comments as they were offered. */
const seen = next => `--seen ${next.state}`;
/** The command that plans a preview of a review's comments; a model runs and nothing is posted. */
export const planCommand = next => ({ name: 'pr-comment', text: `${next.review} ${seen(next)}` });
/**
 * The command that posts a preview. It names its review and the preview that was shown: what is on screen is
 * what is posted, whatever is current by then and whatever was planned since.
 */
export const publishCommand = next => ({ name: 'pr-comment', text: `${next.review} --publish ${seen(next)}` });
/** The command that clears a person's adjustments. */
export const resetCommand = next => ({ name: 'pr-comment', text: `${next.review} --reset ${seen(next)}` });
/** The command that stops the run under way. It names the run, so it stops no other one. */
export const stopCommand = next => ({ name: 'pr-stop', text: next.stop });

/**
 * The command that saves `adjustments` for a preview's review, or undefined when they are the saved ones.
 * Each list of /pr-comment replaces the saved one, so both are always given in full, in the order of the
 * findings; a finding that is left out has no level.
 */
export function adjustCommand(next, adjustments) {
  // As they would be saved: only findings of this preview, no level for one that is left out, and no level that
  // is the review's own.
  const excluded = next.findings.filter(finding => adjustments.excluded.has(finding.id)).map(finding => finding.id);
  const levels = next.findings.filter(finding => !adjustments.excluded.has(finding.id) && adjustments.levels.has(finding.id) && adjustments.levels.get(finding.id) !== own(finding))
    .map(finding => [finding.id, adjustments.levels.get(finding.id)]);
  if (sameAdjustments({ excluded: new Set(excluded), levels: new Map(levels) }, savedAdjustments(next))) return undefined;
  if (!excluded.length && !levels.length) return resetCommand(next);
  return { name: 'pr-comment', text: `${next.review} --exclude ${excluded.join(',') || 'none'} --severity ${levels.map(([id, level]) => `${id}=${level}`).join(',') || 'none'} ${seen(next)}` };
}

/** What changes, in a few words, for the row that applies it. */
function describeChanges(next, adjustments) {
  const saved = savedAdjustments(next), parts = [];
  for (const finding of next.findings) {
    const out = adjustments.excluded.has(finding.id), was = saved.excluded.has(finding.id);
    const level = out ? undefined : adjustments.levels.get(finding.id) ?? own(finding), before = was ? undefined : saved.levels.get(finding.id) ?? own(finding);
    if (out && !was) parts.push(`${finding.id} left out`);
    else if (!out && was) parts.push(`${finding.id} published${level === own(finding) ? '' : ` as ${level}`}`);
    else if (!out && level !== before) parts.push(`${finding.id} as ${level}`);
  }
  return parts.length > 4 ? `${parts.slice(0, 4).join(', ')} and ${parts.length - 4} more` : parts.join(', ');
}

/**
 * The panel's actions. `host.dialog` is the host's dialogs, `host.toast` its toasts and `host.send(sessionID,
 * command)` sends one command, `{ name, text }`, to a session and resolves when the server took it.
 * One action runs at a time; after `stop()` nothing is asked or sent, whatever answer arrives.
 *
 * An action is for what the panel offered when it was picked. `still()`, which the panel gives with each one,
 * says whether that is still so: the same panel, open in the same session, showing the same notice's offer. A
 * dialog can stay open for any time, and a preview can be planned again meanwhile: an answer that comes back
 * for something else is said, and nothing is sent.
 */
export function createActions(host) {
  const { dialog, toast, send } = host;
  let running = false, stopped = false;
  const changed = () => { if (!stopped) toast({ title: 'AZPR', message: CHANGED, variant: 'warning', duration: 8000 }); };

  /**
   * Send one command. One that the server part refuses (another command is running, the review is no longer
   * kept) or that does not get there is said with the reason given, as the host says it for a typed command:
   * nothing else would tell. The reason is the server's own text, on one line and cut to what a toast holds.
   */
  async function dispatch(sessionID, command, still) {
    if (stopped) return false;
    if (!still()) { changed(); return false; }
    try { await send(sessionID, command); return true; }
    catch (error) {
      const reason = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!stopped) toast({ title: 'AZPR', message: `/${command.name} was not started${reason ? `: ${reason}` : '.'}`, variant: 'error', duration: 10000 });
      return false;
    }
  }

  /** Posting is asked once more, with "no" first: a key pressed twice posts nothing. */
  async function publish(next, sessionID, still) {
    const answer = await dialog.select({ title: 'Post these comments on the pull request?', options: [
      { title: 'No, post nothing', value: 'keep', description: next.target || undefined },
      { title: `Yes, post ${plural(next.posts, 'comment')}`, value: 'post', description: 'As the PAT owner; what is on the PR already is skipped' }] });
    if (answer !== 'post' || stopped) return;
    await dispatch(sessionID, publishCommand(next), still);
  }

  /** Stopping is asked once more, with "no" first: the run goes on unless a person says otherwise. */
  async function stopRun(next, sessionID, still) {
    const answer = await dialog.select({ title: 'Stop this run?', options: [
      { title: 'No, let it run', value: 'keep', description: `AZPR ${next.stop}${next.command ? ` (/${next.command})` : ''}` },
      { title: 'Yes, stop it', value: 'stop', description: 'Sent requests may still be billed' }] });
    if (answer !== 'stop' || stopped) return;
    await dispatch(sessionID, stopCommand(next), still);
  }

  /**
   * The findings as a list: picking one says what happens to it. Once something differs from what is saved, it is
   * applied at once from the foot of the dialog, which stays in view however long the list is (clicked there, or
   * with its key), and from the list's last row, for a host that draws no such foot. Escape leaves everything as
   * it was.
   */
  async function adjust(next, sessionID, still) {
    const adjustments = savedAdjustments(next);
    let last;
    for (;;) {
      if (stopped) return;
      if (!still()) return changed();
      const command = adjustCommand(next, adjustments);
      // The foot's action does not close the dialog, so it is closed here; its answer is this promise's, since
      // a dialog that is closed answers nothing. It acts once, and only while this list is the dialog that is
      // open: `clear` closes whatever dialog is open at that moment.
      let apply, listed = true;
      const applied = new Promise(resolve => { apply = resolve; });
      const foot = command && typeof dialog.clear === 'function'
        ? [{ bind: APPLY_KEY, title: 'apply', side: 'right', selection: 'none', onTrigger: () => { if (!listed) return; listed = false; apply(APPLY); dialog.clear(); } }] : undefined;
      const choice = await Promise.race([applied, dialog.select({ title: 'Adjust the findings before posting', placeholder: 'Search findings', current: last, options: [
        ...next.findings.map(finding => {
          const level = adjustments.levels.get(finding.id) ?? own(finding);
          return { title: `${finding.id}${finding.summary ? ` — ${finding.summary}` : ''}`, value: finding.id, category: 'Findings',
            footer: adjustments.excluded.has(finding.id) ? 'left out' : level === own(finding) ? level : `${level} (was ${own(finding)})` };
        }),
        ...(command ? [{ title: next.plan ? 'Apply, and plan the preview' : 'Apply, and plan the preview again', value: APPLY, description: describeChanges(next, adjustments), category: 'Then' }] : [])],
        ...(foot ? { actions: foot } : {}) })]);
      listed = false;
      if (choice === undefined || stopped) return;
      // The list was open for any time. What it was opened for may be gone by now: nothing more is asked then,
      // and nothing is applied.
      if (!still()) return changed();
      if (choice === APPLY) { await dispatch(sessionID, command, still); return; }
      const finding = next.findings.find(item => item.id === choice);
      if (!finding) return;
      last = choice;
      const level = adjustments.levels.get(finding.id) ?? own(finding);
      const picked = await dialog.select({ title: `${finding.id}: how is it published?`, current: adjustments.excluded.has(finding.id) ? EXCLUDE : level, options: [
        ...LEVELS.map(name => ({ title: `As ${name}`, value: name, description: name === own(finding) ? 'The level the review gave it' : undefined })),
        { title: 'Leave it out', value: EXCLUDE, description: 'Not posted, and named in no comment' }] });
      if (picked === undefined) continue;
      if (picked === EXCLUDE) { adjustments.excluded.add(finding.id); adjustments.levels.delete(finding.id); continue; }
      if (!LEVELS.includes(picked)) continue;
      adjustments.excluded.delete(finding.id);
      if (picked === own(finding)) adjustments.levels.delete(finding.id); else adjustments.levels.set(finding.id, picked);
    }
  }

  return {
    /**
     * Run one action (`plan`, `publish`, `adjust`, `reset` or `stop`) for what a notice offers, in the session
     * on screen. `still` says whether the panel still offers it there; without one it is taken to.
     */
    async run(id, next, sessionID, still = () => true) {
      if (running || stopped || !next || typeof sessionID !== 'string' || !actionRows(next).some(row => row.id === id)) return;
      running = true;
      try {
        if (id === 'plan') await dispatch(sessionID, planCommand(next), still);
        else if (id === 'publish') await publish(next, sessionID, still);
        else if (id === 'adjust') await adjust(next, sessionID, still);
        else if (id === 'reset') await dispatch(sessionID, resetCommand(next), still);
        else if (id === 'stop') await stopRun(next, sessionID, still);
      } catch {
        // A dialog the host could not show: nothing was sent, and the commands can still be typed.
        if (!stopped) toast({ title: 'AZPR', message: 'That could not be done here. Type the command in the conversation instead.', variant: 'error', duration: 8000 });
      } finally { running = false; }
    },
    get running() { return running; },
    /** The terminal part is being unloaded: an action that is open ends at its next step, and nothing is sent after it. */
    stop() { stopped = true; },
  };
}
