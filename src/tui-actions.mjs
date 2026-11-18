// What a person can do from AZPR's terminal panel after a review or a comment preview: have the comments
// previewed, post the preview, leave findings out or change a level, undo those adjustments. The panel lists
// these as rows; picking one asks what is needed in the host's own dialogs and then sends the same
// /pr-comment command a person would type, to the session on screen. Nothing else is ever sent from the
// terminal part, and nothing is decided here: the server part takes the command as it takes a typed one,
// with its own checks, its STARTED notice and its receipt.
//
// What is offered comes from the runtime (`previewActions` in comments.mjs), in the metadata of the notice
// that offers it, and is checked before it gets here (`nextOf` in tui-model.mjs): a command is made only of
// a review ID, finding IDs and level names of the checked forms, never of a text.
//
// Nothing here imports anything, so that the order of the dialogs is tested with scripted answers
// (tests/tui-actions.test.mjs); src/tui-view.jsx supplies the dialogs and the sending.

const LEVELS = ['high', 'medium', 'low'];
const APPLY = '\u0000apply', CLOSE = '\u0000close', EXCLUDE = '\u0000exclude';

/** The level the review itself gave a finding. */
const own = finding => finding.original ?? finding.severity;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The rows the panel lists for what a preview offers; none without an offer. `key` works while the panel
 * has the keyboard, `command` is what a person would type instead (shown beside the row where there is room),
 * and a label that ends in "…" asks before anything is sent.
 */
export function actionRows(next) {
  if (!next) return [];
  const adjusted = next.findings.some(finding => finding.excluded || finding.original !== undefined);
  return [
    // A review without a preview yet: one is planned first, so that what is posted was read.
    ...(next.plan ? [{ id: 'plan', key: 'c', label: 'Preview the comments (nothing is posted)', command: '/pr-comment' }] : []),
    ...(next.publish ? [{ id: 'publish', key: 'p', label: `Post the ${plural(next.posts, 'comment')} on the PR…`, command: '/pr-comment --publish' }] : []),
    ...(next.adjust && next.findings.length ? [{ id: 'adjust', key: 'a', label: 'Leave findings out or change a level…', command: '/pr-comment --exclude … --severity …' }] : []),
    ...(next.adjust && adjusted ? [{ id: 'reset', key: 'u', label: 'Undo your adjustments', command: '/pr-comment --reset' }] : []),
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

/** The command that plans a preview of a review's comments; a model runs and nothing is posted. */
export const planCommand = next => ({ name: 'pr-comment', text: next.review });
/** The command that posts a preview. It names its review: what is on screen is what is posted, whatever is current by then. */
export const publishCommand = next => ({ name: 'pr-comment', text: `${next.review} --publish` });
/** The command that undoes a person's adjustments. */
export const resetCommand = next => ({ name: 'pr-comment', text: `${next.review} --reset` });

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
  return { name: 'pr-comment', text: `${next.review} --exclude ${excluded.join(',') || 'none'} --severity ${levels.map(([id, level]) => `${id}=${level}`).join(',') || 'none'}` };
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
 */
export function createActions(host) {
  const { dialog, toast, send } = host;
  let running = false, stopped = false;

  /**
   * Send one command. One that the server part refuses (another command is running, the review is no longer
   * kept) or that does not get there is said with the reason given, as the host says it for a typed command:
   * nothing else would tell. The reason is the server's own text, on one line and cut to what a toast holds.
   */
  async function dispatch(sessionID, command) {
    if (stopped) return false;
    try { await send(sessionID, command); return true; }
    catch (error) {
      const reason = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!stopped) toast({ title: 'AZPR', message: `/${command.name} was not started${reason ? `: ${reason}` : '.'}`, variant: 'error', duration: 10000 });
      return false;
    }
  }

  /** Posting is asked once more, with "no" first: a key pressed twice posts nothing. */
  async function publish(next, sessionID) {
    const answer = await dialog.select({ title: 'Post these comments on the pull request?', options: [
      { title: 'No, post nothing', value: 'keep', description: next.target || undefined },
      { title: `Yes, post ${plural(next.posts, 'comment')}`, value: 'post', description: 'As the PAT owner; what is on the PR already is skipped' }] });
    if (answer !== 'post' || stopped) return;
    await dispatch(sessionID, publishCommand(next));
  }

  /** The findings as a list: picking one says what happens to it, and the first row applies everything at once. */
  async function adjust(next, sessionID) {
    const adjustments = savedAdjustments(next);
    let last;
    for (;;) {
      if (stopped) return;
      const command = adjustCommand(next, adjustments);
      const choice = await dialog.select({ title: 'Adjust the findings before posting', placeholder: 'Search findings', current: last, options: [
        command ? { title: next.plan ? 'Apply, and plan the preview' : 'Apply, and plan the preview again', value: APPLY, description: describeChanges(next, adjustments), category: 'Then' }
          : { title: 'Close: nothing was changed', value: CLOSE, category: 'Then' },
        ...next.findings.map(finding => {
          const level = adjustments.levels.get(finding.id) ?? own(finding);
          return { title: `${finding.id}${finding.summary ? ` — ${finding.summary}` : ''}`, value: finding.id, category: 'Findings',
            footer: adjustments.excluded.has(finding.id) ? 'left out' : level === own(finding) ? level : `${level} (was ${own(finding)})` };
        })] });
      if (choice === undefined || choice === CLOSE || stopped) return;
      if (choice === APPLY) { await dispatch(sessionID, command); return; }
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
    /** Run the action of a row (`plan`, `publish`, `adjust` or `reset`) for what a notice offers, in the session on screen. */
    async run(id, next, sessionID) {
      if (running || stopped || !next || typeof sessionID !== 'string' || !actionRows(next).some(row => row.id === id)) return;
      running = true;
      try {
        if (id === 'plan') await dispatch(sessionID, planCommand(next));
        else if (id === 'publish') await publish(next, sessionID);
        else if (id === 'adjust') await adjust(next, sessionID);
        else if (id === 'reset') await dispatch(sessionID, resetCommand(next));
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
