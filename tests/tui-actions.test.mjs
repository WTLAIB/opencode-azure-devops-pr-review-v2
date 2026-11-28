import test from 'node:test';
import assert from 'node:assert/strict';
import { actionRows, adjustCommand, createActions, planCommand, publishCommand, resetCommand, savedAdjustments, stopCommand } from '../src/tui-actions.mjs';
import { nextOf, stopOf } from '../src/tui-model.mjs';
import { parseCommentRequest } from '../src/output.mjs';

const REVIEW = 'bb6a8570', SESSION = 'ses_conversation0000000000001';
// The word for the review's comments as they were offered; every command hands it back.
const STATE = '0f1e2d3c4b5a', SEEN = `--seen ${STATE}`;
// What a preview offers, as the panel's model hands it on after checking it (`nextOf`).
const offer = (extra = {}, findings = [
  { id: 'F-1', severity: 'medium', summary: 'reserve can leave stock decremented' },
  { id: 'R-2', severity: 'high', summary: 'snapshot returns live state' },
  { id: 'F-3', severity: 'low', summary: 'ordering uses local time' }]) =>
  nextOf({ azpr: { next: { review: REVIEW, state: STATE, target: `review ${REVIEW} (/pr-review) of PR #4 in Project/Repository`, publish: true, adjust: true, posts: 4, findings, ...extra } } }, REVIEW);
// What a run under way offers, as the panel's model hands it on: the run its STARTED notice says can be stopped
// (`stopOf`), and the command that notice names.
const RUN = '36ed1562';
const running = (command = 'pr-review') => ({ stop: stopOf({ azpr: { next: { stop: RUN } } }, RUN), command });

/**
 * The actions with dialogs that answer from a list, in order; every dialog, toast and command is recorded.
 * `clear` gives the dialogs the host's way to close the one that is open, which a dialog's foot needs.
 */
function host(answers, { send, clear = false } = {}) {
  const shown = [], toasts = [], sent = [], log = { cleared: 0 };
  const queue = [...answers];
  const actions = createActions({
    dialog: { select: async options => {
      shown.push(options);
      if (!queue.length) throw new Error(`No answer was scripted for "${options.title}".`);
      const answer = queue.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    }, ...(clear ? { clear() { log.cleared++; } } : {}) },
    toast: options => toasts.push(options),
    send: send ?? (async (sessionID, command) => { sent.push({ sessionID, ...command }); }),
  });
  return { actions, shown, toasts, sent, log, left: () => queue.length, titles: () => shown.map(item => item.title) };
}
const value = (options, title) => options.options.find(option => option.title.startsWith(title)).value;
/** What the server part makes of a command the panel sends: the same parser as for a typed one. */
const parsed = command => parseCommentRequest(command.text);

test('the panel lists what a notice offers, each with its key; the step the others lead to is marked', () => {
  assert.deepEqual(actionRows(undefined), []);
  assert.deepEqual(actionRows(offer()), [
    { id: 'publish', key: 'p', label: 'Post 4 comments…', primary: true },
    { id: 'adjust', key: 'a', label: 'Adjust findings…' }]);
  // Resetting is offered once there is something to reset.
  const adjusted = offer({}, [{ id: 'F-1', severity: 'low', original: 'medium', summary: 'a' }, { id: 'R-2', severity: 'high', excluded: true, summary: 'b' }]);
  assert.deepEqual(actionRows(adjusted).map(row => [row.id, row.key, row.label]), [['publish', 'p', 'Post 4 comments…'], ['adjust', 'a', 'Adjust findings…'], ['reset', 'u', 'Reset adjustments']]);
  // A preview that is held, or whose every finding was left out, cannot be posted; one whose publication started is not adjusted.
  assert.deepEqual(actionRows(offer({ publish: false })).map(row => row.id), ['adjust']);
  assert.deepEqual(actionRows(offer({ adjust: false })).map(row => row.id), ['publish']);
  assert.deepEqual(actionRows(offer({ adjust: false }, [{ id: 'F-1', severity: 'low', original: 'high', summary: 'a' }])).map(row => row.id), ['publish'], 'Nothing is reset once publication started.');
  assert.deepEqual(actionRows(offer({}, [])).map(row => row.id), ['publish'], 'A review without findings has nothing to adjust.');
  assert.equal(actionRows(offer({ posts: 1 }))[0].label, 'Post 1 comment…');
  // A review without a preview yet: one is planned first, and the findings can be adjusted before it; nothing is posted unread.
  assert.deepEqual(actionRows(offer({ plan: true, publish: false, posts: 0 })), [
    { id: 'plan', key: 'c', label: 'Preview comments', primary: true },
    { id: 'adjust', key: 'a', label: 'Adjust findings…' }]);
  assert.deepEqual(actionRows(offer({ plan: true, publish: true })).map(row => row.id), ['plan', 'adjust'], 'Whatever a notice says.');
});

test('a label that ends in "…" asks before anything is sent, and one that does not is sent at once', async () => {
  const adjusted = offer({}, [{ id: 'F-1', severity: 'low', original: 'medium', summary: 'a' }, { id: 'R-2', severity: 'high', summary: 'b' }]);
  const unplanned = offer({ plan: true, publish: false, posts: 0 });
  const seen = [];
  for (const [next, rows] of [[adjusted, actionRows(adjusted)], [unplanned, actionRows(unplanned).filter(row => row.id === 'plan')]]) {
    for (const row of rows) {
      // One answer is there for a dialog: leaving it.
      const h = host([undefined]);
      await h.actions.run(row.id, next, SESSION);
      assert.deepEqual([h.shown.length > 0, h.sent.length > 0], [row.label.endsWith('…'), !row.label.endsWith('…')], row.label);
      seen.push(row.id);
    }
  }
  assert.deepEqual(seen, ['publish', 'adjust', 'reset', 'plan']);
  // Stopping a run asks first as well, and its label says so.
  const stop = host([undefined]);
  await stop.actions.run('stop', running(), SESSION);
  assert.deepEqual([actionRows(running())[0].label.endsWith('…'), stop.shown.length, stop.sent], [true, 1, []]);
});

test('a command names its review and is made only of checked IDs and level names', () => {
  const next = offer();
  assert.deepEqual(publishCommand(next), { name: 'pr-comment', text: `${REVIEW} --publish ${SEEN}` });
  assert.deepEqual(resetCommand(next), { name: 'pr-comment', text: `${REVIEW} --reset ${SEEN}` });
  assert.deepEqual(parsed(publishCommand(next)), { reviewId: REVIEW, publish: true, show: false, seen: STATE });
  assert.deepEqual([planCommand(next), parsed(planCommand(next))], [{ name: 'pr-comment', text: `${REVIEW} ${SEEN}` }, { reviewId: REVIEW, publish: false, show: false, seen: STATE }]);
  assert.deepEqual(parsed(resetCommand(next)), { reviewId: REVIEW, publish: false, show: false, seen: STATE, adjust: { reset: true } });
  // Both lists in full, in the order of the findings: each list of /pr-comment replaces the saved one.
  const command = adjustCommand(next, { excluded: new Set(['F-3', 'F-1']), levels: new Map([['R-2', 'low']]) });
  assert.deepEqual(command, { name: 'pr-comment', text: `${REVIEW} --exclude F-1,F-3 --severity R-2=low ${SEEN}` });
  assert.deepEqual(parsed(command), { reviewId: REVIEW, publish: false, show: false, seen: STATE, adjust: { exclude: ['F-1', 'F-3'], severity: { 'R-2': 'low' } } });
  // An empty list is said as such; a finding that is left out has no level; a level that is the review's own is none.
  assert.equal(adjustCommand(next, { excluded: new Set(['R-2']), levels: new Map([['R-2', 'low'], ['F-1', 'medium']]) }).text, `${REVIEW} --exclude R-2 --severity none ${SEEN}`);
  assert.equal(adjustCommand(next, { excluded: new Set(), levels: new Map([['F-3', 'high']]) }).text, `${REVIEW} --exclude none --severity F-3=high ${SEEN}`);
  assert.equal(adjustCommand(next, { excluded: new Set(), levels: new Map() }), undefined, 'Nothing changed: nothing is sent.');
  assert.equal(adjustCommand(next, { excluded: new Set(), levels: new Map([['F-1', 'medium']]) }), undefined);
  // What a preview was planned with is where a person starts; undoing all of it is --reset.
  const adjusted = offer({}, [{ id: 'F-1', severity: 'low', original: 'medium', summary: 'a' }, { id: 'R-2', severity: 'high', excluded: true, summary: 'b' }, { id: 'F-3', severity: 'low', summary: 'c' }]);
  const saved = savedAdjustments(adjusted);
  assert.deepEqual([[...saved.excluded], [...saved.levels]], [['R-2'], [['F-1', 'low']]]);
  assert.equal(adjustCommand(adjusted, saved), undefined);
  assert.deepEqual(adjustCommand(adjusted, { excluded: new Set(), levels: new Map() }), resetCommand(adjusted));
  assert.equal(adjustCommand(adjusted, { excluded: new Set(['R-2']), levels: new Map() }).text, `${REVIEW} --exclude R-2 --severity none ${SEEN}`);
});

test('posting asks once more, with "no" first, and sends nothing unless a person says yes', async () => {
  const next = offer();
  const yes = host([options => value(options, 'Yes')]);
  await yes.actions.run('publish', next, SESSION);
  assert.deepEqual(yes.titles(), ['Post these comments on the pull request?']);
  assert.deepEqual(yes.shown[0].options.map(option => [option.title, option.value]), [['No, post nothing', 'keep'], ['Yes, post 4 comments', 'post']], 'A key pressed twice chooses the first row.');
  assert.equal(yes.shown[0].options[0].description, `review ${REVIEW} (/pr-review) of PR #4 in Project/Repository`, 'Which review and PR, in the runtime\'s words.');
  assert.deepEqual(yes.sent, [{ sessionID: SESSION, name: 'pr-comment', text: `${REVIEW} --publish ${SEEN}` }]);
  for (const answer of ['keep', undefined]) {
    const no = host([answer]);
    await no.actions.run('publish', next, SESSION);
    assert.deepEqual(no.sent, [], String(answer));
  }
  // A preview that cannot be posted has no such row, and asking for it does nothing.
  const held = host([]);
  await held.actions.run('publish', offer({ publish: false }), SESSION);
  assert.deepEqual([held.shown, held.sent], [[], []]);
});

test('findings are adjusted in a list: each pick says what happens to one, and its last row applies them all', async () => {
  const next = offer();
  const h = host(['F-1', options => value(options, 'Leave it out'), 'R-2', 'low', 'F-3', 'low', options => value(options, 'Apply')]);
  await h.actions.run('adjust', next, SESSION);
  assert.deepEqual(h.titles(), ['Adjust the findings before posting', 'F-1: how is it published?', 'Adjust the findings before posting', 'R-2: how is it published?',
    'Adjust the findings before posting', 'F-3: how is it published?', 'Adjust the findings before posting']);
  // The list: every finding with how it is published now and, once something differs, what applying would do,
  // after them: where the list was read to.
  const [first, , second, , , , last] = h.shown;
  assert.deepEqual(first.options.map(option => [option.title, option.footer]), [['F-1 — reserve can leave stock decremented', 'medium'],
    ['R-2 — snapshot returns live state', 'high'], ['F-3 — ordering uses local time', 'low']], 'Nothing to apply yet: Escape leaves the list.');
  assert.deepEqual([second.current, second.options.at(-1).title, second.options.at(-1).description, second.options[0].footer],
    ['F-1', 'Apply, and plan the preview again', 'F-1 left out', 'left out'], 'The list comes back on the finding that was changed.');
  // The list is searched by its own `search`, which the host draws flat, with a row's category in place of its
  // footer: no row carries a category, so that its level stays in view.
  assert.deepEqual(h.shown.filter((dialog, index) => index % 2 === 0).flatMap(dialog => dialog.options).filter(option => 'category' in option), []);
  assert.deepEqual([last.options.at(-1).description, last.options.slice(0, -1).map(option => option.footer)], ['F-1 left out, R-2 as low', ['left out', 'low (was high)', 'low']],
    'A level that is the review\'s own is no change.');
  assert.deepEqual(h.shown.filter(dialog => 'actions' in dialog), [], 'A host that cannot close a dialog gets no action at its foot.');
  // One finding: its levels, the review's own marked, then leaving it out; the dialog starts on what holds now.
  assert.deepEqual(h.shown[1].options.map(option => [option.title, option.description]), [['As high', undefined], ['As medium', 'The level the review gave it'], ['As low', undefined], ['Leave it out', 'Not posted, and named in no comment']]);
  assert.equal(h.shown[1].current, 'medium');
  assert.deepEqual(h.sent, [{ sessionID: SESSION, name: 'pr-comment', text: `${REVIEW} --exclude F-1 --severity R-2=low ${SEEN}` }]);
  assert.equal(h.left(), 0);
});

test('leaving the list, or a finding, sends nothing; a finding that was left out can be published after all', async () => {
  for (const answers of [[undefined], ['F-1', undefined, undefined], ['F-1', 'low', undefined]]) {
    const h = host(answers);
    await h.actions.run('adjust', offer(), SESSION);
    assert.deepEqual([h.sent, h.left()], [[], 0]);
  }
  const adjusted = offer({}, [{ id: 'F-1', severity: 'medium', excluded: true, summary: 'a' }, { id: 'R-2', severity: 'low', original: 'high', summary: 'b' }]);
  const h = host(['F-1', 'high', 'R-2', 'high', options => value(options, 'Apply')]);
  await h.actions.run('adjust', adjusted, SESSION);
  assert.equal(h.shown[1].current, h.shown[1].options.at(-1).value, 'A finding that is left out starts on that row.');
  assert.equal(h.shown.at(-1).options.at(-1).description, 'F-1 published as high, R-2 as high');
  assert.deepEqual(h.sent, [{ sessionID: SESSION, name: 'pr-comment', text: `${REVIEW} --exclude none --severity F-1=high ${SEEN}` }]);
  // Everything back as the review had it: that is --reset.
  const back = host(['F-1', 'medium', 'R-2', 'high', options => value(options, 'Apply')]);
  await back.actions.run('adjust', adjusted, SESSION);
  assert.deepEqual(back.sent.map(command => command.text), [`${REVIEW} --reset ${SEEN}`]);
  // Previewing the comments of a review asks nothing either: a model plans them and nothing is posted.
  const plan = host([options => value(options, 'Apply')]);
  const unplanned = offer({ plan: true, publish: false, posts: 0 });
  await plan.actions.run('plan', unplanned, SESSION);
  assert.deepEqual([plan.shown.length, plan.sent.map(command => command.text)], [0, [`${REVIEW} ${SEEN}`]]);
  await plan.actions.run('publish', unplanned, SESSION);
  assert.equal(plan.sent.length, 1, 'Nothing is posted before a preview.');
  // Adjusted before the first preview, the row that applies it says so.
  const early = host(['F-1', 'low', options => value(options, 'Apply')]);
  await early.actions.run('adjust', unplanned, SESSION);
  assert.equal(early.shown.at(-1).options.at(-1).title, 'Apply, and plan the preview');
  assert.deepEqual(early.sent.map(command => command.text), [`${REVIEW} --exclude none --severity F-1=low ${SEEN}`]);
  const undo = host([]);
  await undo.actions.run('reset', adjusted, SESSION);
  assert.deepEqual([undo.shown.length, undo.sent.map(command => command.text)], [0, [`${REVIEW} --reset ${SEEN}`]], 'Resetting asks nothing: it posts nothing and can be done again.');
});

test('the adjustments are applied from the foot of the list, which stays in view: with its key or a click', async () => {
  // As OpenCode shows it: an action at a dialog's foot does not close the dialog, so the action closes it, and
  // the dialog then answers nothing.
  const trigger = options => { options.actions[0].onTrigger(); return undefined; };
  const h = host(['R-2', options => value(options, 'Leave it out'), trigger], { clear: true });
  await h.actions.run('adjust', offer(), SESSION);
  const [first, last] = h.shown.filter(dialog => dialog.title === 'Adjust the findings before posting');
  assert.equal('actions' in first, false, 'Nothing to apply yet.');
  assert.deepEqual(last.actions.map(({ onTrigger, ...action }) => action), [{ bind: 'ctrl+s', title: 'apply', side: 'right', selection: 'none' }]);
  assert.equal(last.options.at(-1).title, 'Apply, and plan the preview again', 'The row is there as well.');
  assert.deepEqual([h.sent, h.log.cleared, h.left()], [[{ sessionID: SESSION, name: 'pr-comment', text: `${REVIEW} --exclude R-2 --severity none ${SEEN}` }], 1, 0]);
  // A dialog that never answers once it was closed changes nothing: the foot's answer is the one that counts.
  const silent = host(['R-2', 'low', options => { options.actions[0].onTrigger(); return new Promise(() => {}); }], { clear: true });
  await silent.actions.run('adjust', offer(), SESSION);
  assert.deepEqual(silent.sent.map(command => command.text), [`${REVIEW} --exclude none --severity R-2=low ${SEEN}`]);
  // The row still applies where the foot is there, and leaving the list still sends nothing.
  const row = host(['F-3', 'high', options => value(options, 'Apply')], { clear: true });
  await row.actions.run('adjust', offer(), SESSION);
  assert.deepEqual([row.sent.map(command => command.text), row.log.cleared], [[`${REVIEW} --exclude none --severity F-3=high ${SEEN}`], 0]);
  const left = host(['F-3', 'high', undefined], { clear: true });
  await left.actions.run('adjust', offer(), SESSION);
  assert.deepEqual([left.sent, left.log.cleared], [[], 0]);
  // The foot acts once, and only while its list is the dialog that is open: `clear` closes whatever dialog is
  // open at that moment, which later is another one.
  let foot;
  const twice = host(['F-3', 'high', options => { foot = options.actions[0].onTrigger; foot(); foot(); }], { clear: true });
  await twice.actions.run('adjust', offer(), SESSION);
  foot();
  assert.deepEqual([twice.sent.length, twice.log.cleared], [1, 1]);
  const gone = host(['F-3', 'high', options => { foot = options.actions[0].onTrigger; return undefined; }], { clear: true });
  await gone.actions.run('adjust', offer(), SESSION);
  foot();
  await Promise.resolve();
  assert.deepEqual([gone.sent, gone.log.cleared], [[], 0], 'The list was left: its foot does nothing any more.');
  const picked = host(['F-3', 'high', options => { foot = options.actions[0].onTrigger; return 'R-2'; }, () => { foot(); return 'low'; }, undefined], { clear: true });
  await picked.actions.run('adjust', offer(), SESSION);
  assert.deepEqual([picked.sent, picked.log.cleared], [[], 0], 'Another dialog is open by then: the dialog of one finding.');
});

test('an answer for what the panel no longer offers sends nothing, and says so', async () => {
  const CHANGED = 'Nothing was sent: what the panel showed has changed since. Read it again, then pick.';
  const adjusted = offer({}, [{ id: 'F-1', severity: 'low', original: 'medium', summary: 'a' }]);
  // The preview was planned again, another session came on screen or the panel was closed while the question was open.
  let offered = true;
  const post = host([options => { offered = false; return value(options, 'Yes'); }]);
  await post.actions.run('publish', offer(), SESSION, () => offered);
  assert.deepEqual([post.sent, post.toasts.map(toast => [toast.variant, toast.message])], [[], [['warning', CHANGED]]]);
  // While the list of findings is open: the finding that was picked is not asked about, the action has ended
  // (another one can run), and nothing is applied.
  offered = true;
  const open = host([() => { offered = false; return 'F-1'; }, 'high', options => value(options, 'Apply')]);
  await open.actions.run('adjust', offer(), SESSION, () => offered);
  assert.deepEqual([open.titles(), open.sent, open.left(), open.toasts.map(toast => toast.message), open.actions.running],
    [['Adjust the findings before posting'], [], 2, [CHANGED], false]);
  // While the question about one finding is open: the list is not shown again, and nothing is applied.
  offered = true;
  const list = host(['F-1', () => { offered = false; return 'high'; }, options => value(options, 'Apply')]);
  await list.actions.run('adjust', offer(), SESSION, () => offered);
  assert.deepEqual([list.sent, list.left(), list.toasts.map(toast => toast.message)], [[], 1, [CHANGED]]);
  // Right before it is sent, also from the foot of the list.
  offered = true;
  const foot = host(['F-1', 'high', options => { offered = false; options.actions[0].onTrigger(); }], { clear: true });
  await foot.actions.run('adjust', offer(), SESSION, () => offered);
  assert.deepEqual([foot.sent, foot.toasts.map(toast => toast.message)], [[], [CHANGED]]);
  // What asks nothing is checked as well: a key can be pressed in the moment the offer goes.
  for (const [id, next] of [['reset', adjusted], ['plan', offer({ plan: true, publish: false, posts: 0 })]]) {
    const gone = host([]);
    await gone.actions.run(id, next, SESSION, () => false);
    assert.deepEqual([gone.sent, gone.toasts.map(toast => toast.message)], [[], [CHANGED]], id);
  }
  // While it is still offered, it is sent; after the part was unloaded nothing is said either.
  const kept = host([options => value(options, 'Yes')]);
  await kept.actions.run('publish', offer(), SESSION, () => true);
  assert.equal(kept.sent.length, 1);
  const unloaded = host([options => { unloaded.actions.stop(); return value(options, 'Yes'); }]);
  await unloaded.actions.run('publish', offer(), SESSION, () => false);
  assert.deepEqual([unloaded.sent, unloaded.toasts], [[], []]);
});

test('a command that was refused or did not get there is said with its reason; one action runs at a time', async () => {
  // As the host says it for a typed command: the server part's own words, on one line and no longer than a toast holds.
  const refused = host([options => value(options, 'Yes')], { send: async () => { throw new Error('[AZPR] A review/comment command is already running\nfor this conversation or PR.'); } });
  await refused.actions.run('publish', offer(), SESSION);
  assert.deepEqual(refused.toasts.map(toast => [toast.variant, toast.message]), [['error', '/pr-comment was not started: [AZPR] A review/comment command is already running for this conversation or PR.']]);
  const long = host([], { send: async () => { throw new Error('x'.repeat(2000)); } });
  await long.actions.run('reset', offer({}, [{ id: 'F-1', severity: 'low', original: 'high', summary: 'a' }]), SESSION);
  assert.equal(long.toasts[0].message.length, '/pr-comment was not started: '.length + 300);
  const silent = host([], { send: async () => { throw undefined; } });
  await silent.actions.run('reset', offer({}, [{ id: 'F-1', severity: 'low', original: 'high', summary: 'a' }]), SESSION);
  assert.equal(silent.toasts[0].message, '/pr-comment was not started.');
  // A dialog the host cannot show: nothing was sent.
  const broken = host([() => { throw new Error('no dialog'); }]);
  await broken.actions.run('publish', offer(), SESSION);
  assert.deepEqual([broken.sent, broken.toasts.map(toast => toast.message)], [[], ['That could not be done here. Type the command in the conversation instead.']]);
  // While one is open, another is not started: a row clicked twice asks once.
  let release;
  const waiting = host([() => new Promise(resolve => { release = resolve; })]);
  const open = waiting.actions.run('publish', offer(), SESSION);
  await Promise.resolve();
  assert.equal(waiting.actions.running, true);
  await waiting.actions.run('adjust', offer(), SESSION);
  await waiting.actions.run('publish', offer(), SESSION);
  assert.equal(waiting.shown.length, 1);
  release('keep');
  await open;
  assert.deepEqual([waiting.actions.running, waiting.sent], [false, []]);
  // What is not offered, or has no session to go to, is not done.
  const none = host([]);
  await none.actions.run('reset', offer(), SESSION);
  await none.actions.run('publish', offer(), undefined);
  await none.actions.run('delete', offer(), SESSION);
  await none.actions.run('publish', undefined, SESSION);
  assert.deepEqual([none.shown, none.sent], [[], []]);
});

test('after the terminal part was unloaded nothing is asked or sent, whatever answer arrives', async () => {
  let release;
  const h = host([() => new Promise(resolve => { release = resolve; })]);
  const open = h.actions.run('publish', offer(), SESSION);
  await Promise.resolve();
  h.actions.stop();
  release('post');
  await open;
  assert.deepEqual([h.sent, h.toasts], [[], []], 'The answer came after the part was unloaded.');
  await h.actions.run('reset', offer({}, [{ id: 'F-1', severity: 'low', original: 'high', summary: 'a' }]), SESSION);
  assert.deepEqual(h.sent, []);
  // An adjustment that is open ends at its next step.
  const list = host(['F-1', () => { list.actions.stop(); return 'low'; }, options => value(options, 'Apply')]);
  await list.actions.run('adjust', offer(), SESSION);
  assert.deepEqual([list.sent, list.left()], [[], 1]);
});

test('a run under way offers one step: stopping it, asked first with "no" first, as /pr-stop with the run\'s ID', async () => {
  const next = running();
  assert.equal(next.stop, RUN);
  assert.deepEqual(actionRows(next), [{ id: 'stop', key: 's', label: 'Stop this run…' }], 'Alone in the row, and not the step anything leads to.');
  assert.deepEqual(stopCommand(next), { name: 'pr-stop', text: RUN }, 'The command names its run and nothing else: it stops no other one.');
  const yes = host([options => value(options, 'Yes')]);
  await yes.actions.run('stop', next, SESSION);
  assert.deepEqual(yes.titles(), ['Stop this run?']);
  assert.deepEqual(yes.shown[0].options.map(option => [option.title, option.value, option.description]),
    [['No, let it run', 'keep', `AZPR ${RUN} (/pr-review)`], ['Yes, stop it', 'stop', 'Sent requests may still be billed']], 'A key pressed twice chooses the first row: the run goes on.');
  assert.deepEqual(yes.sent, [{ sessionID: SESSION, name: 'pr-stop', text: RUN }]);
  assert.deepEqual(yes.toasts, []);
  for (const answer of ['keep', undefined]) {
    const no = host([answer]);
    await no.actions.run('stop', next, SESSION);
    assert.deepEqual([no.sent, no.toasts], [[], []], String(answer));
  }
  // Which run it is, in the runtime's words; a STARTED notice whose command the panel does not know names only the run.
  const comment = host(['keep']);
  await comment.actions.run('stop', running('pr-comment'), SESSION);
  assert.equal(comment.shown[0].options[0].description, `AZPR ${RUN} (/pr-comment)`);
  const unnamed = host(['keep']);
  await unnamed.actions.run('stop', running(''), SESSION);
  assert.equal(unnamed.shown[0].options[0].description, `AZPR ${RUN}`);
  // A run under way offers nothing else, and a review or a preview does not offer stopping.
  const other = host([]);
  for (const id of ['plan', 'publish', 'adjust', 'reset']) await other.actions.run(id, next, SESSION);
  await other.actions.run('stop', offer(), SESSION);
  await other.actions.run('stop', offer({ plan: true, publish: false, posts: 0 }), SESSION);
  assert.deepEqual([other.shown, other.sent], [[], []]);
});

test('a run that ended while the question was open is not stopped, and a stop that was refused is said', async () => {
  const CHANGED = 'Nothing was sent: what the panel showed has changed since. Read it again, then pick.';
  // The run's receipt arrived, another run started, or the panel was closed, while the question was open.
  let offered = true;
  const ended = host([options => { offered = false; return value(options, 'Yes'); }]);
  await ended.actions.run('stop', running(), SESSION, () => offered);
  assert.deepEqual([ended.sent, ended.toasts.map(toast => [toast.variant, toast.message])], [[], [['warning', CHANGED]]]);
  // Still under way: sent, and nothing is said.
  const kept = host([options => value(options, 'Yes')]);
  await kept.actions.run('stop', running(), SESSION, () => true);
  assert.deepEqual([kept.sent.map(command => `/${command.name} ${command.text}`), kept.toasts], [[`/pr-stop ${RUN}`], []]);
  // The server part refused it, as for a session that is being deleted: its own words, on one line.
  const refused = host([options => value(options, 'Yes')], { send: async () => { throw new Error('[AZPR] This reviewer session is being deleted:\nits run has ended.'); } });
  await refused.actions.run('stop', running(), SESSION);
  assert.deepEqual(refused.toasts.map(toast => [toast.variant, toast.message]), [['error', '/pr-stop was not started: [AZPR] This reviewer session is being deleted: its run has ended.']]);
  // One action at a time: while the question is open, another pick asks nothing.
  let release;
  const waiting = host([() => new Promise(resolve => { release = resolve; })]);
  const open = waiting.actions.run('stop', running(), SESSION);
  await Promise.resolve();
  await waiting.actions.run('stop', running(), SESSION);
  assert.deepEqual([waiting.actions.running, waiting.shown.length], [true, 1]);
  // Unloaded while the question was open: nothing is sent or said, whatever the answer.
  waiting.actions.stop();
  release('stop');
  await open;
  assert.deepEqual([waiting.sent, waiting.toasts], [[], []]);
});

test('what is typed into a question answers by the beginning of a row: a step\'s key pressed once more leaves no row to take', async () => {
  // The host's search finds a letter anywhere in a title and lists the best match first; "s" is in "Yes, stop it"
  // and not in "No, let it run". The key that opened the question, pressed again, is typed into it.
  const titles = (dialog, query) => dialog.search(query, dialog.options).map(option => option.title);
  const stop = host(['keep']);
  await stop.actions.run('stop', running(), SESSION);
  const asked = stop.shown[0];
  assert.deepEqual(titles(asked, ''), ['No, let it run', 'Yes, stop it'], 'Nothing typed: every row, the one that keeps the run first.');
  for (const stray of ['s', 'ss', 'sss', 't', 'o', 'e', 'x', '  s  ']) assert.deepEqual(titles(asked, stray), [], JSON.stringify(stray));
  assert.deepEqual([titles(asked, 'y'), titles(asked, 'YES'), titles(asked, 'yes, stop'), titles(asked, ' y ')], [['Yes, stop it'], ['Yes, stop it'], ['Yes, stop it'], ['Yes, stop it']], 'Typing the answer finds it.');
  assert.deepEqual([titles(asked, 'n'), titles(asked, 'No, let')], [['No, let it run'], ['No, let it run']]);
  assert.deepEqual(titles(asked, undefined), ['No, let it run', 'Yes, stop it']);
  assert.ok(asked.search('', asked.options).every((option, index) => option === asked.options[index]), 'The rows themselves, in the order they are listed.');
  // The same for posting, whose key is in both rows: neither is found by it.
  const post = host(['keep']);
  await post.actions.run('publish', offer(), SESSION);
  const posting = post.shown[0];
  assert.deepEqual(titles(posting, ''), ['No, post nothing', 'Yes, post 4 comments']);
  for (const stray of ['p', 'pp', 'o', 's']) assert.deepEqual(titles(posting, stray), [], stray);
  assert.deepEqual([titles(posting, 'y'), titles(posting, 'n')], [['Yes, post 4 comments'], ['No, post nothing']]);
  // A finding's levels are searched as the host searches; the list of findings has a search of its own (below).
  const list = host(['F-1', undefined, undefined]);
  await list.actions.run('adjust', offer(), SESSION);
  assert.equal(typeof list.shown[0].search, 'function');
  assert.equal('search' in list.shown[1], false);
});

test('what is typed into the list of findings: an ID finds that finding alone, words find the rows that hold them, in the order they are listed', async () => {
  // Twelve findings: the host's own search listed F-11, F-10, F-12, F-1 for "F-1", F-11 selected, and Enter took it.
  const findings = Array.from({ length: 12 }, (_, index) => ({ id: `F-${index + 1}`, severity: 'medium',
    summary: index === 10 ? 'token leaks into the log' : index === 2 ? 'the same guard as F-1 is missing' : `check number ${index + 1} is skipped` }));
  const listed = async rows => { const h = host([undefined]); await h.actions.run('adjust', offer({}, rows), SESSION); return h.shown[0]; };
  const list = await listed(findings);
  const ids = (query, dialog = list) => dialog.search(query, dialog.options).map(option => option.value);
  assert.deepEqual(ids(''), findings.map(finding => finding.id), 'Nothing typed: every row, in the order they are listed.');
  assert.ok(list.search('', list.options).every((option, index) => option === list.options[index]), 'The rows themselves.');
  // An ID typed in full: that finding alone, whatever else holds those characters (F-10 to F-12, a summary naming F-1).
  for (const finding of findings) {
    for (const typed of [finding.id, finding.id.toLowerCase(), `  ${finding.id} `]) assert.deepEqual(ids(typed), [finding.id], JSON.stringify(typed));
  }
  // Also where those with a longer ID are listed before it, and for the IDs of reviews of 0.4.x.
  const reversed = await listed([...findings].reverse());
  assert.deepEqual(ids('F-1', reversed), ['F-1']);
  assert.deepEqual(ids('r-2', await listed([{ id: 'F-1', severity: 'medium', summary: 'a' }, { id: 'R-2', severity: 'high', summary: 'b' }, { id: 'R-21', severity: 'low', summary: 'c' }])), ['R-2']);
  // An ID that no row has lists nothing: no other finding stands in for one that is not offered.
  const withoutFirst = await listed(findings.slice(1));
  assert.deepEqual([ids('F-1', withoutFirst), ids('F-13')], [[], []]);
  // Words find the rows that hold all of them, anywhere in the title, in the order they are listed.
  assert.deepEqual(ids('token'), ['F-11']);
  assert.deepEqual(ids('LOG token'), ['F-11']);
  assert.deepEqual(ids('number 1 skipped'), ['F-1', 'F-10', 'F-12']);
  assert.deepEqual(ids('F-2 check'), ['F-2']);
  assert.deepEqual(ids('guard'), ['F-3']);
  assert.deepEqual(ids('F-1 guard'), ['F-3'], 'An ID typed with words is a word: only the summary that names F-1 holds both.');
  assert.deepEqual(ids('F-'), findings.map(finding => finding.id));
  // A word of an ID's form with a longer prefix is taken for an ID too, and finds no title; with another word it is a word.
  const encoded = await listed([{ id: 'F-1', severity: 'medium', summary: 'a' }, { id: 'F-3', severity: 'low', summary: 'invalid UTF-8 input' }]);
  assert.deepEqual([ids('UTF-8', encoded), ids('utf-8 input', encoded)], [[], ['F-3']]);
  assert.deepEqual(ids('nothing like this'), []);
  // Only titles are searched: not the level a row shows beside its title.
  assert.deepEqual(ids('medium'), []);
  // Letters compare in lower case wherever they stand in a word: a Greek sigma typed at the end of what was
  // typed still finds the title that holds it within a word, in either case; a German sharp s in either case; and a
  // word of letters, a hyphen and digits that are not all ASCII is no ID.
  const words = await listed([{ id: 'F-1', severity: 'medium', summary: 'ΣΥΣΤΗΜΑ χωρίς έλεγχο' }, { id: 'F-2', severity: 'low', summary: 'Größe of a sınıf-1 buffer' }]);
  for (const typed of ['ΣΥ', 'ΣΥΣ', 'συς', 'ΣΥΣΤ', 'σύστημα', 'ΧΩΡΊΣ', 'χωρίς', 'GRÖẞE', 'größe', 'sınıf-1']) {
    assert.deepEqual(ids(typed, words), typed === 'σύστημα' ? [] : /[ΣΧσχ]/i.test(typed) ? ['F-1'] : ['F-2'], typed);
  }
  // The step's key pressed once more than meant is typed into the list it opened, which has nothing to apply yet:
  // it lands on a finding, whose levels are asked next.
  assert.deepEqual(ids('a'), ['F-3', 'F-11']);
  // Once something changed, the row that applies it is listed last and found by its own words.
  const changed = host(['F-1', options => value(options, 'Leave it out'), undefined]);
  await changed.actions.run('adjust', offer({}, findings), SESSION);
  const again = changed.shown[2];
  const titles = query => again.search(query, again.options).map(option => option.title);
  assert.equal(titles('').at(-1), 'Apply, and plan the preview again');
  assert.deepEqual(titles('apply'), ['Apply, and plan the preview again']);
  // What the row that applies says beside its title is not searched: "left out" finds no row, so Enter applies nothing.
  assert.deepEqual(titles('left out'), []);
  assert.deepEqual(titles('a'), ['F-3 — the same guard as F-1 is missing', 'F-11 — token leaks into the log', 'Apply, and plan the preview again']);
  assert.equal(again.options[0].footer, 'left out');
});
