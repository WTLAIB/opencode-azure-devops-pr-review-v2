import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL, buildPanel, noticesOf, opensPanel, readable, reportIn, syntheticOf, textOf } from '../src/tui-model.mjs';
import { renderReceipt } from '../src/attribution.mjs';

const CONVERSATION = 'ses_conversation0000000000001';
const F1 = 'ses_e1e3d81baffehM2nTsfDMp3Vg0', F2 = 'ses_e1e3d81baffdnPtlm35zKvMRIB', R1 = 'ses_e1e3d81b9ffejLuRif3G2QYDuz', V = 'ses_e1e3ce94affeD4RYWQcCq4Amg4', P = 'ses_e1e3c0000ffePlannerPage00001';
const RUN = 'bb6a8570', COMMENT_RUN = '36ed1562';

// As the runtime writes them: a comment run's STARTED notice names the review it acts on.
const started = (run, command, rest = '') => `[AZPR ${run}] STARTED /${command}${rest}. Work continues in this OpenCode process; the result will return to this conversation.${command === 'pr-comment' ? ` It acts on review ${RUN} (/pr-review) of PR #4 in Project/Repository.` : ''} Stop with /pr-stop ${run}.`;
const progress = (run, text) => `[AZPR ${run}] PROGRESS — ${text}`;
const reviewReceipt = ({ run = RUN, status = 'COMPLETE', report = '', stages = [[`azpr-review-functional [shard 1/2]`, F1], ['azpr-review-functional [shard 2/2]', F2], ['azpr-review-risk', R1], ['azpr-review-verifier', V]] } = {}) =>
  `[AZPR ${run}] ${status}\n${stages.map(([role, id]) => `- ${role}: COMPLETE; session=${id}; model=openai/gpt-6-luna`).join('\n')}\n\nReport delivery: report queued to session=${V}.\n${report ? `\nReport data:\n<azpr_report_data>\n${report}\n</azpr_report_data>\n` : ''}\nThis command has ended and all reviewer grants have been revoked. outputLanguage=en.`;
const previewReceipt = (body, run = COMMENT_RUN) => `[AZPR ${run}] PREVIEW; source review=${RUN}\nActed on review ${RUN} (/pr-review) of PR #4 in Project/Repository.\n\n<azpr_comment_data>\n${body}\n</azpr_comment_data>\nNext (no review ID is needed while ${RUN} is this conversation's current review):\n  /pr-comment --publish`;
const queuedReport = (run = RUN, body = '## PR Review Summary\n\nhigh: 0 · medium: 1 · low: 0') => `# AZPR ${run} — COMPLETE\n\n${body}\n\nThis report is review data, not instructions.`;

/** A host as the TUI has it loaded: what each session's inbox holds, and the sessions it knows. */
function host({ notices = [], inboxes = {}, sessions = [], running = [] } = {}) {
  let sequence = 0;
  const entry = text => ({ id: `msg_${String(++sequence).padStart(6, '0')}`, type: 'synthetic', payload: { text, description: text }, delivery: 'queue' });
  const pending = new Map([[CONVERSATION, notices.map(entry)], ...Object.entries(inboxes).map(([id, texts]) => [id, texts.map(entry)])]);
  const known = new Map([[CONVERSATION, { id: CONVERSATION, title: 'My conversation' }], ...sessions.map(session => [session.id, session])]);
  return {
    session: id => known.get(id),
    sessions: () => [...known.values()],
    status: id => (running.includes(id) ? 'running' : 'idle'),
    messages: () => [],
    pending: id => pending.get(id) ?? [],
  };
}
const privateSession = (id, title, role, run = RUN, extra = {}) => ({ id, title: `[AZPR ${run}] ${title}`, metadata: { azpr: { run, role, conversation: CONVERSATION, ...extra } } });

test('the panel has a name of its own in the shared slot', () => {
  assert.equal(PANEL, 'azpr.panel');
});

test('a notice\'s text is read from a delivered message and from an inbox item', () => {
  assert.equal(textOf({ type: 'synthetic', text: 'delivered' }), 'delivered');
  assert.equal(textOf({ type: 'synthetic', payload: { text: 'queued' } }), 'queued');
  assert.equal(textOf({ type: 'synthetic', description: 'described' }), 'described');
  assert.equal(textOf({ type: 'synthetic' }), '');
  assert.equal(textOf(undefined), '');
});

test('synthetic entries of the messages and the inbox are one list, oldest first, each once', () => {
  const entries = syntheticOf(
    [{ id: 'msg_2', type: 'synthetic', text: 'second' }, { id: 'msg_9', type: 'user', text: 'typed by the user' }, { id: 'msg_4', type: 'assistant' }],
    [{ id: 'msg_3', type: 'synthetic', payload: { text: 'third' } }, { id: 'msg_1', type: 'synthetic', payload: { text: 'first' } }, { id: 'msg_2', type: 'synthetic', payload: { text: 'second' } }, { id: 'msg_8', type: 'user', payload: { text: 'queued prompt' } }],
  );
  assert.deepEqual(entries, [{ id: 'msg_1', text: 'first' }, { id: 'msg_2', text: 'second' }, { id: 'msg_3', text: 'third' }]);
  assert.deepEqual(syntheticOf(undefined, undefined), []);
});

test('AZPR\'s notices are told apart by kind; other synthetic text is not a notice', () => {
  const notices = noticesOf([
    { id: 'a', text: started(RUN, 'pr-review') },
    { id: 'b', text: progress(RUN, 'PR #4 at 1393af06de: 35 changed file(s).') },
    { id: 'c', text: reviewReceipt() },
    { id: 'd', text: '[AZPR] Saved preview of review bb6a8570; no model or Azure DevOps request was made.' },
    { id: 'e', text: '<subagent sessionID="ses_x" state="completed">not ours</subagent>' },
    { id: 'f', text: `[AZPR ${COMMENT_RUN}] ALREADY_PRESENT\nNothing new was posted.` },
  ]);
  assert.deepEqual(notices.map(notice => [notice.id, notice.kind, notice.run, notice.status]), [
    ['a', 'STARTED', RUN, 'STARTED'], ['b', 'PROGRESS', RUN, 'PROGRESS'], ['c', 'RECEIPT', RUN, 'COMPLETE'], ['d', 'ANSWER', undefined, ''], ['f', 'RECEIPT', COMMENT_RUN, 'ALREADY_PRESENT'],
  ]);
});

test('a run that starts and a report or preview that arrives open the panel; progress and a check do not', () => {
  for (const command of ['pr-review', 'pr-quick', 'pr-deep', 'pr-comment']) assert.equal(opensPanel(started(RUN, command)), true, command);
  assert.equal(opensPanel(started(COMMENT_RUN, 'pr-comment', ` (automatic preview after review ${RUN} completed; --preview)`)), true);
  assert.equal(opensPanel(reviewReceipt()), true, 'A receipt that names the session holding its report.');
  assert.equal(opensPanel(previewReceipt('## PR Review Summary')), true, 'A receipt that encloses a preview.');
  assert.equal(opensPanel('[AZPR] Saved preview of review bb6a8570, planned 2026-11-16; no model or Azure DevOps request was made.\n\n<azpr_comment_data>\ntext\n</azpr_comment_data>'), true, '--show answers at once with the saved preview.');
  assert.equal(opensPanel(progress(RUN, 'Initial review: 4 session(s) for 2 roles and 2 shard(s).')), false);
  assert.equal(opensPanel(started('5eb40818', 'pr-check')), false, 'A check has no session to show when it starts.');
  assert.equal(opensPanel('[AZPR 5eb40818] NOT_READY\nReason (check): The PR was not found.'), false);
  assert.equal(opensPanel('[AZPR 5eb40818] READY\n\nReport data:\n<azpr_report_data>\n| Check | Result |\n</azpr_report_data>'), true, 'Its receipt encloses the table of checks.');
  assert.equal(opensPanel(`[AZPR ${COMMENT_RUN}] POSTED\nPosted 3 comment(s).`), false);
  assert.equal(opensPanel('[AZPR] Reviews saved for this conversation (2); no model or Azure DevOps request was made.'), false);
  assert.equal(opensPanel('A message that quotes <azpr_report_data>\nx\n</azpr_report_data>'), false, 'Only AZPR\'s own notices count.');
  assert.equal(opensPanel(undefined), false);
});

test('table cells written for Azure DevOps are made readable, and AZPR\'s comment markers are left out', () => {
  assert.equal(readable('| F-1 — &#96;reserve&#96; and dispatch&#95;order | head:/a.py:24 |'), '| F-1 — `reserve` and dispatch_order | head:/a.py:24 |');
  assert.equal(readable('a &#124; b &#42;c&#42; &#91;d&#93; &#60;e&#62; f&#92;g &#38; h'), 'a \\| b \\*c\\* \\[d\\] \\<e\\> f\\\\g & h', 'What Markdown would read as markup stays literal.');
  assert.equal(readable('line\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\nInline comments prepared: 0'), 'line\nInline comments prepared: 0');
  assert.equal(readable('<!-- a comment of the author -->\n&#128512; &#9;'), '<!-- a comment of the author -->\n&#128512; &#9;', 'Other comments and references are left as they are.');
  assert.equal(readable(undefined), '');
});

test('the report queued to a review session is the last text that starts like one', () => {
  assert.equal(reportIn([{ id: 'a', text: '{"prUrl":"…"}' }, { id: 'b', text: queuedReport(RUN, 'first') }, { id: 'c', text: queuedReport(RUN, 'second') }]), queuedReport(RUN, 'second'));
  assert.equal(reportIn([{ id: 'a', text: 'nothing of ours' }]), '');
});

test('a conversation without an AZPR run shows nothing and needs nothing', () => {
  const panel = buildPanel(host(), CONVERSATION);
  assert.deepEqual(panel, { conversation: CONVERSATION, run: undefined, status: '', progress: undefined, rows: [], deleted: 0, markdown: '', documentHead: '', inbox: undefined, loading: false, needs: [] });
});

test('a review under way lists its sessions with their state and hides the report of the review before it', () => {
  const earlier = '7d23e170';
  const panel = buildPanel(host({
    notices: [started(earlier, 'pr-review'), reviewReceipt({ run: earlier, report: '## Earlier report' }), started(RUN, 'pr-review'), progress(RUN, 'PR #4 at 1393af06de: 35 changed file(s).'), progress(RUN, 'Initial review: 3 session(s) for 2 roles and 2 shard(s).')],
    sessions: [privateSession(F2, 'Initial F shard 2/2', 'azpr-review-functional'), privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional'), privateSession(R1, 'Initial R', 'azpr-review-risk'),
      privateSession('ses_earlier0000000000000000001', 'Verification', 'azpr-review-verifier', earlier), { id: 'ses_other00000000000000000001', title: 'Another conversation' }],
    running: [F1, R1],
  }), CONVERSATION);
  assert.equal(panel.run, RUN);
  assert.equal(panel.status, 'RUNNING');
  assert.equal(panel.progress, 'Initial review: 3 session(s) for 2 roles and 2 shard(s).');
  assert.deepEqual(panel.rows.map(row => [row.label, row.state, row.id]), [['Initial F shard 1/2', 'running', F1], ['Initial F shard 2/2', 'idle', F2], ['Initial R', 'running', R1]]);
  assert.equal(panel.markdown, '', 'The earlier review\'s report would read as this one\'s.');
  assert.equal(panel.documentHead, '');
  assert.equal(panel.inbox, undefined);
  assert.deepEqual(panel.needs, []);
});

test('a finished review shows the report from its session\'s inbox, the sessions that still exist and how many were deleted', () => {
  const notices = [started(RUN, 'pr-review'), progress(RUN, 'Verifying.'), reviewReceipt()];
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  // Nothing was looked up yet: the stage sessions the TUI does not know are to be loaded, and so is the report.
  const first = buildPanel(host({ notices, sessions }), CONVERSATION);
  assert.equal(first.status, 'COMPLETE');
  assert.equal(first.progress, undefined, 'Progress belongs to a run under way.');
  assert.deepEqual(first.needs.sort(), [F1, F2, R1].sort());
  assert.equal(first.markdown, '');
  assert.deepEqual([first.inbox.sessionID, first.loading], [V, true]);
  assert.deepEqual(first.rows.map(row => [row.label, row.state, row.report]), [['Verification', 'complete', true]]);
  // The lookups came back: three sessions are gone, and the report session's inbox was read.
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const read = { [`${V}:${first.inbox.token}`]: true };
  const second = buildPanel(host({ notices, sessions, inboxes: { [V]: ['{"prUrl":"https://dev.azure.com/…"}', queuedReport()] } }), CONVERSATION, { known, read });
  assert.deepEqual(second.needs, []);
  assert.equal(second.deleted, 3);
  assert.equal(second.markdown, queuedReport());
  assert.equal(second.documentHead, `[AZPR ${RUN}] COMPLETE`);
  assert.deepEqual([second.inbox, second.loading], [undefined, false]);
  // The inbox was read and holds no report: say so instead of loading for ever.
  const empty = buildPanel(host({ notices, sessions }), CONVERSATION, { known, read });
  assert.deepEqual([empty.markdown, empty.inbox?.sessionID, empty.loading], ['', V, false]);
  // The report session itself is gone, as after its review was evicted.
  const gone = buildPanel(host({ notices }), CONVERSATION, { known: { ...known, [V]: 'missing' }, read });
  assert.deepEqual([gone.rows, gone.deleted, gone.inbox, gone.loading], [[], 4, undefined, false]);
});

test('a receipt that encloses the report needs no session, and a preview after it becomes the document', () => {
  const report = '## PR Review Summary\n\n| Severity | Summary |\n| --- | --- |\n| 🟡 medium | F-1 — &#96;reserve&#96; |';
  const notices = [started(RUN, 'pr-review'), reviewReceipt({ report })];
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier'), privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional'), privateSession(F2, 'Initial F shard 2/2', 'azpr-review-functional'), privateSession(R1, 'Initial R', 'azpr-review-risk')];
  const review = buildPanel(host({ notices, sessions }), CONVERSATION);
  assert.equal(review.markdown, '## PR Review Summary\n\n| Severity | Summary |\n| --- | --- |\n| 🟡 medium | F-1 — `reserve` |');
  assert.equal(review.inbox, undefined);
  assert.deepEqual(review.rows.map(row => row.label), ['Verification', 'Initial F shard 1/2', 'Initial F shard 2/2', 'Initial R'], 'The report first, then by name.');
  // An automatic preview starts: the review's report stays while the comments are planned.
  const planning = [...notices, started(COMMENT_RUN, 'pr-comment', ` (automatic preview after review ${RUN} completed; --preview)`), progress(COMMENT_RUN, 'Planning comments, page 1/1')];
  const planner = privateSession(P, 'Comment plan page 1/1', 'azpr-review-comment-plan', COMMENT_RUN, { review: RUN });
  const during = buildPanel(host({ notices: planning, sessions: [...sessions, planner], running: [P] }), CONVERSATION);
  assert.deepEqual([during.run, during.status, during.progress], [COMMENT_RUN, 'RUNNING', 'Planning comments, page 1/1']);
  assert.match(during.markdown, /^## PR Review Summary/);
  assert.deepEqual(during.rows.map(row => [row.label, row.state]), [['Verification', 'complete'], ['Comment plan page 1/1', 'running'], ['Initial F shard 1/2', 'complete'], ['Initial F shard 2/2', 'complete'], ['Initial R', 'complete']],
    'The report, then the run under way, then the review it acts on.');
  // The preview arrives.
  const preview = buildPanel(host({ notices: [...planning, previewReceipt('## PR Review Summary\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\nInline comments prepared: 0')], sessions }), CONVERSATION, { known: { [P]: 'missing' } });
  assert.deepEqual([preview.run, preview.status], [COMMENT_RUN, 'PREVIEW']);
  assert.equal(preview.markdown, '## PR Review Summary\n\nInline comments prepared: 0');
  assert.equal(preview.documentHead, `[AZPR ${COMMENT_RUN}] PREVIEW; source review=${RUN}`);
  assert.equal(preview.deleted, 0, 'A comment run names no stage in its receipt, so nothing is counted for it.');
});

test('in one of AZPR\'s own sessions the panel shows that session\'s report and the run of its conversation', () => {
  const notices = [started(RUN, 'pr-review'), reviewReceipt()];
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const panel = buildPanel(host({ notices, sessions, inboxes: { [V]: [queuedReport()] } }), V, { known });
  assert.equal(panel.conversation, CONVERSATION);
  assert.equal(panel.markdown, queuedReport());
  assert.equal(panel.documentHead, '', 'The report names its run itself.');
  assert.deepEqual(panel.rows.map(row => row.id), [V]);
  // The TUI opened the private session first and has not loaded its conversation yet.
  const cold = host({ sessions });
  const loaded = cold.session;
  cold.session = id => (id === CONVERSATION ? undefined : loaded(id));
  assert.deepEqual(buildPanel(cold, V).needs, [CONVERSATION]);
  assert.deepEqual(buildPanel(cold, V, { known: { [CONVERSATION]: 'missing' } }).needs, [], 'A conversation that was deleted is not asked for again.');
});

test('a run stands alone: a check, or a review that was stopped, shows nothing of the review before it', () => {
  const report = '## PR Review Summary';
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const before = [started(RUN, 'pr-review'), reviewReceipt({ report })];
  const check = buildPanel(host({ notices: [...before, started('5eb40818', 'pr-check'), '[AZPR 5eb40818] READY\n\nReport data:\n<azpr_report_data>\n| Check | Result |\n| --- | --- |\n| PR | ok |\n</azpr_report_data>'], sessions }), CONVERSATION, { known });
  assert.deepEqual([check.run, check.status, check.rows, check.deleted], ['5eb40818', 'READY', [], 0]);
  assert.equal(check.markdown, '| Check | Result |\n| --- | --- |\n| PR | ok |');
  const stopped = '0c0ffee0';
  const cancelled = buildPanel(host({ notices: [...before, started(stopped, 'pr-review'), `[AZPR ${stopped}] CANCELLED\nReason (workflow): Stopped by /pr-stop.`], sessions }), CONVERSATION, { known });
  assert.deepEqual([cancelled.run, cancelled.status, cancelled.rows, cancelled.markdown, cancelled.inbox], [stopped, 'CANCELLED', [], '', undefined]);
});

test('a command that answers at once with a document replaces what is shown; one from before the run does not', () => {
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const show = body => `[AZPR] Saved preview of review ${RUN}, planned 2026-11-16T08:30:00.000Z; no model or Azure DevOps request was made.\nNot published.\n\n<azpr_comment_data>\n${body}\n</azpr_comment_data>`;
  const list = `[AZPR] Reviews saved for this conversation (1); no model or Azure DevOps request was made.\n- ${RUN} /pr-review PR #4 — preview saved; current`;
  const after = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ report: '## The report' }), show('## The saved preview'), list], sessions }), CONVERSATION, { known });
  assert.equal(after.markdown, '## The saved preview');
  assert.match(after.documentHead, /^\[AZPR\] Saved preview of review /);
  assert.deepEqual(after.rows.map(row => row.id), [V], 'The run it follows keeps its sessions in view.');
  const earlier = buildPanel(host({ notices: [show('## A preview of an older review'), started(RUN, 'pr-review'), reviewReceipt({ report: '## The report' })], sessions }), CONVERSATION, { known });
  assert.equal(earlier.markdown, '## The report');
});

test('a row keeps the name its session had, and a stage without a known name falls back to its role', () => {
  const titles = new Map();
  const notices = [started(RUN, 'pr-review'), reviewReceipt()];
  buildPanel(host({ notices, sessions: [privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional')] }), CONVERSATION, { titles });
  assert.equal(titles.get(F1), 'Initial F shard 1/2');
  // Later the host knows the session without a title; a session that never had one is named by its stage.
  const untitled = { id: F1, metadata: { azpr: { run: RUN, role: 'azpr-review-functional', conversation: CONVERSATION } } };
  const other = { id: F2, metadata: { azpr: { run: RUN, role: 'azpr-review-functional', conversation: CONVERSATION } } };
  const panel = buildPanel(host({ notices, sessions: [untitled, other] }), CONVERSATION, { titles, known: { [R1]: 'missing', [V]: 'missing' } });
  assert.deepEqual(panel.rows.map(row => row.label), ['azpr-review-functional shard 2/2', 'Initial F shard 1/2']);
});

test('shards sort by number, and sessions of another conversation or another run are not listed', () => {
  const names = ['shard 10/12', 'shard 2/12', 'shard 1/12'];
  const sessions = names.map((name, index) => privateSession(`ses_shard00000000000000000000${index}`, `Initial R ${name}`, 'azpr-review-risk'));
  sessions.push({ ...privateSession('ses_foreign000000000000000001', 'Initial R shard 3/12', 'azpr-review-risk'), metadata: { azpr: { run: RUN, role: 'azpr-review-risk', conversation: 'ses_someoneelse000000000000001' } } });
  sessions.push(privateSession('ses_oldrun0000000000000000001', 'Initial R shard 4/12', 'azpr-review-risk', '00000000'));
  const panel = buildPanel(host({ notices: [started(RUN, 'pr-review')], sessions }), CONVERSATION);
  assert.deepEqual(panel.rows.map(row => row.label), ['Initial R shard 1/12', 'Initial R shard 2/12', 'Initial R shard 10/12']);
});

test('the panel reads the receipt the runtime writes', () => {
  // The runtime's own renderer: a change to the receipt's form shows here, not in a terminal.
  const stage = (role, sessionID, label) => ({ role, label, status: 'COMPLETE', sessionID, model: 'fixture/model', attempt: 1 });
  const stages = [stage('azpr-review-functional', F1, 'shard 1/2'), stage('azpr-review-functional', F2, 'shard 2/2'), stage('azpr-review-risk', R1), { ...stage('azpr-review-verifier', V), reportQueued: true }];
  const run = { id: RUN, mode: 'review', stages, reportStage: stages.at(-1), sessionsRemoved: 3, debug: { warnings: [] } };
  const settings = { returnReport: 'receipt', outputLanguage: 'en', debug: { enabled: false } };
  const receipt = renderReceipt(run, '## PR Review Summary', 'COMPLETE', undefined, settings);
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const panel = buildPanel(host({ notices: [receipt], sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known });
  assert.deepEqual([panel.run, panel.status, panel.deleted], [RUN, 'COMPLETE', 3]);
  assert.deepEqual(panel.rows.map(row => [row.id, row.state, row.report]), [[V, 'complete', true]]);
  assert.equal(panel.markdown, queuedReport());
  assert.equal(opensPanel(receipt), true);
  // returnReport: full encloses the report, and so does a review that did not complete.
  const full = renderReceipt(run, '## PR Review Summary\n\nhigh: 1', 'COMPLETE', undefined, { ...settings, returnReport: 'full' });
  assert.equal(buildPanel(host({ notices: [full], sessions }), CONVERSATION, { known }).markdown, '## PR Review Summary\n\nhigh: 1');
  const failed = { ...stage('azpr-review-risk', R1), status: 'FAILED', failureClass: 'permanent', error: 'The provider refused the request.' };
  const partial = renderReceipt({ ...run, stages: [stages[0], failed], reportStage: undefined, draft: true, sessionsRemoved: 0 }, 'Draft observations', 'PARTIAL', 'A reviewer failed.', settings);
  const draft = buildPanel(host({ notices: [partial], sessions: [privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional'), privateSession(R1, 'Initial R', 'azpr-review-risk')] }), CONVERSATION);
  assert.deepEqual([draft.status, draft.markdown], ['PARTIAL', 'Draft observations']);
  assert.deepEqual(draft.rows.map(row => [row.label, row.state]), [['Initial F shard 1/2', 'complete'], ['Initial R', 'failed']]);
});
