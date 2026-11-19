import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL, buildPanel, conversationOf, createReader, disclose, lookupOutcome, mergeEntries, nextOf, notFound, noticesOf, opensPanel, readable, reportIn, stopOf, syntheticOf, textOf } from '../src/tui-model.mjs';
import { enclose, renderReceipt } from '../src/attribution.mjs';

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
  // A notice is its text, or `{ text, metadata }` where the runtime stored something with it.
  const entry = notice => {
    const text = typeof notice === 'string' ? notice : notice.text;
    return { id: `msg_${String(++sequence).padStart(6, '0')}`, type: 'synthetic', payload: { text, description: text, ...(typeof notice === 'string' ? {} : { metadata: notice.metadata }) }, delivery: 'steer' };
  };
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
    // What a run says besides its start, progress and receipt, as the runtime writes it.
    { id: 'g', text: `[AZPR ${RUN}] Automatic preview skipped: the review has no findings to comment on.` },
    { id: 'h', text: `[AZPR ${RUN}] Automatic publication did not start: the comment step could not be queued.` },
    { id: 'i', text: `[AZPR ${RUN}] Authorization revoked and cancellation requested (2/2 session(s) settled).` },
    { id: 'j', text: `[AZPR ${COMMENT_RUN}] POSTED; source review=${RUN}\nActed on review ${RUN}.` },
    { id: 'k', text: `[AZPR ${RUN}] INCOMPLETE` },
  ]);
  assert.deepEqual(notices.map(notice => [notice.id, notice.kind, notice.run, notice.status]), [
    ['a', 'STARTED', RUN, 'STARTED'], ['b', 'PROGRESS', RUN, 'PROGRESS'], ['c', 'RECEIPT', RUN, 'COMPLETE'], ['d', 'ANSWER', undefined, ''], ['f', 'RECEIPT', COMMENT_RUN, 'ALREADY_PRESENT'],
    ['g', 'NOTE', RUN, ''], ['h', 'NOTE', RUN, ''], ['i', 'NOTE', RUN, ''], ['j', 'RECEIPT', COMMENT_RUN, 'POSTED'], ['k', 'RECEIPT', RUN, 'INCOMPLETE'],
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
  // terminalPanel: manual reaches the panel in the metadata of the runtime's notices: none of them opens it then.
  const manual = { azpr: { panel: 'manual' } };
  for (const text of [started(RUN, 'pr-review'), reviewReceipt(), previewReceipt('## PR Review Summary')]) {
    assert.equal(opensPanel(text, manual), false);
    for (const other of [undefined, null, {}, { azpr: {} }, { azpr: { panel: 'auto' } }, { azpr: 'manual' }, { panel: 'manual' }]) assert.equal(opensPanel(text, other), true, JSON.stringify(other));
  }
});

test('the summary table written for Azure DevOps is made readable, and AZPR\'s comment markers are left out', () => {
  const table = rows => `## PR Review Summary\n\nhigh: 0 · medium: 1 · low: 0\n\n| Severity | Summary | Location |\n| --- | --- | --- |\n${rows}`;
  // Each character the runtime wrote as a reference is shown as itself: escaped, so that Markdown reads none as markup.
  assert.equal(readable(table('| 🟡 medium | F-1 — &#96;reserve&#96; and dispatch&#95;order | head:/a.py:24 |')), table('| 🟡 medium | F-1 — \\`reserve\\` and dispatch\\_order | head:/a.py:24 |'));
  assert.equal(readable(table('| x | a &#124; b &#42;c&#42; &#91;d&#93; &#60;e&#62; f&#92;g &#38; h | y |')), table('| x | a \\| b \\*c\\* \\[d\\] \\<e\\> f\\\\g \\& h | y |'));
  // A file name with double underscores keeps them instead of turning bold, and an entity a finding names stays text.
  assert.equal(readable(table('| x | &#95;&#95;all&#95;&#95; and &#38;lt; | head:/pkg/&#95;&#95;init&#95;&#95;.py:1 |')), table('| x | \\_\\_all\\_\\_ and \\&lt; | head:/pkg/\\_\\_init\\_\\_.py:1 |'));
  assert.equal(readable(table('| x | &#128512; &#9; &#65; | y |')), table('| x | &#128512; &#9; &#65; | y |'), 'References the runtime does not write are left as they are.');
  // The header in another output language, as the runtime writes it.
  assert.equal(readable('| Severity | Summary | 位置 |\n| --- | --- | --- |\n| 🟡 medium | F-1 — &#96;a&#96; | head:/a.py:1 |'), '| Severity | Summary | 位置 |\n| --- | --- | --- |\n| 🟡 medium | F-1 — \\`a\\` | head:/a.py:1 |');
  // A marker as the runtime writes it: a paragraph of its own.
  assert.equal(readable('line\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nInline comments prepared: 0'), 'line\n\n\nInline comments prepared: 0');
  assert.equal(readable('<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->'), '');
  assert.equal(readable('last line\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n'), 'last line\n\n');
  assert.equal(readable('<!-- a comment of the author -->\n&#128512; &#9;'), '<!-- a comment of the author -->\n&#128512; &#9;', 'Other comments are left as they are.');
  assert.equal(readable(undefined), '');
});

test('what a finding quotes is shown as it will be posted: references and markers in it are text', () => {
  // A suggested fix that quotes HTML with character references, and evidence that quotes a marker.
  const code = '**Suggested fix**\n\n```html\n<p>&#60;script&#62; is shown as &#96;text&#96;</p>\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n| Severity | Summary | Location |\n| a | &#96;b&#96; | c |\n```\n\nAfter the block.';
  assert.equal(readable(code), code);
  // A reference in prose, in a code span, in a list and in a table that is not the summary's.
  for (const text of ['Escape it as &#60;b&#62;.', 'Use `&#96;` here.', '- R-1: the cell holds &#124;', '| Finding | Decision |\n| --- | --- |\n| R-1 &#42; | CONFIRMED |', '    &#96;indented code&#96;']) assert.equal(readable(text), text, text);
  // The table ends where its rows end: what follows is not decoded, and neither is a second block of code.
  const after = '| Severity | Summary | Location |\n| --- | --- | --- |\n| 🔴 high | R-1 — &#96;a&#96; | head:/a.ts:1 |\n\nThe reference &#96; stays.\n\n~~~\n&#96;\n~~~';
  assert.equal(readable(after), '| Severity | Summary | Location |\n| --- | --- | --- |\n| 🔴 high | R-1 — \\`a\\` | head:/a.ts:1 |\n\nThe reference &#96; stays.\n\n~~~\n&#96;\n~~~');
  // A line of inline code is not a fence: what follows it is ordinary text again.
  assert.equal(readable('``` not a fence ``` and more\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nend'), '``` not a fence ``` and more\n\n\nend');
  // A code span may run over several lines, never over a blank one: a marker on a line of such a paragraph is the
  // finding's text, as is one that merely follows or precedes other text.
  const span = 'The log shows ``\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n`` between two deliveries.';
  assert.equal(readable(span), span);
  for (const text of ['quoted:\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->', '<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\nfollowed at once', 'a\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nb']) assert.equal(readable(text), text, text);
  // The summary's header inside a paragraph, or without its delimiter row, begins no table of the runtime's.
  for (const text of ['Quoted:\n| Severity | Summary | Location |\n| --- | --- | --- |\n| x | &#96;y&#96; | z |', '| Severity | Summary | Location |\n| x | &#96;y&#96; | z |']) assert.equal(readable(text), text, text);
  // A fence closes only with its own character, at least as long, alone on the line.
  const nested = '````md\n```\n&#96; <!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\n``` not a closing line\n~~~~\n````\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nend';
  assert.equal(readable(nested), '````md\n```\n&#96; <!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\n``` not a closing line\n~~~~\n````\n\n\nend');
  // A whole preview: the marker lines go, the table is readable, the comment's own text is untouched.
  const preview = '## PR Review Summary\n\n| Severity | Summary | Location |\n| --- | --- | --- |\n| 🔴 high | R-1 — &#96;x&#96; | head:/a.ts:1 |\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nInline comments prepared: 1\n\n### R-1 — /a.ts:1-1\n\n```ts\nconst s = "&#96;";\n```\n\n<!-- azpr-comment:975242c36e5459f4d8077a3ffd62d503 -->\n';
  assert.equal(readable(preview), '## PR Review Summary\n\n| Severity | Summary | Location |\n| --- | --- | --- |\n| 🔴 high | R-1 — \\`x\\` | head:/a.ts:1 |\n\n\nInline comments prepared: 1\n\n### R-1 — /a.ts:1-1\n\n```ts\nconst s = "&#96;";\n```\n\n');
});

test('the report queued to a review session is the last text that starts like one', () => {
  assert.equal(reportIn([{ id: 'a', text: '{"prUrl":"…"}' }, { id: 'b', text: queuedReport(RUN, 'first') }, { id: 'c', text: queuedReport(RUN, 'second') }]), queuedReport(RUN, 'second'));
  assert.equal(reportIn([{ id: 'a', text: 'nothing of ours' }]), '');
});

test('a conversation without an AZPR run shows nothing and needs nothing', () => {
  const panel = buildPanel(host(), CONVERSATION);
  assert.deepEqual(panel, { conversation: CONVERSATION, run: undefined, status: '', progress: undefined, rows: [], deleted: 0, markdown: '', documentHead: '', inbox: undefined, notices: undefined, loading: false, needs: [] });
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
  assert.deepEqual(panel.rows.map(row => [row.label, row.state, row.id]), [['Initial F shard 1/2', 'running', F1], ['Initial F shard 2/2', 'finished', F2], ['Initial R', 'running', R1]],
    'A session whose model is not at work has finished what it was asked: the host\'s word for it, idle, would read like a fault.');
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
  assert.equal(second.documentHead, '', 'A report read from its session names its run and status in its own first line.');
  assert.deepEqual([second.inbox, second.loading], [undefined, false]);
  // The inbox was read and holds no report: say so instead of loading for ever.
  const empty = buildPanel(host({ notices, sessions }), CONVERSATION, { known, read });
  assert.deepEqual([empty.markdown, empty.inbox?.sessionID, empty.loading], ['', V, false]);
  // The report session itself is gone, as after its review was evicted.
  const gone = buildPanel(host({ notices }), CONVERSATION, { known: { ...known, [V]: 'missing' }, read });
  assert.deepEqual([gone.rows, gone.deleted, gone.inbox, gone.loading], [[], 4, undefined, false]);
});

test('a receipt that encloses the report needs no session, and a preview after it becomes the document', () => {
  const report = '## PR Review Summary\n\n| Severity | Summary | Location |\n| --- | --- | --- |\n| 🟡 medium | F-1 — &#96;reserve&#96; | head:/a.py:24 |';
  const notices = [started(RUN, 'pr-review'), reviewReceipt({ report })];
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier'), privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional'), privateSession(F2, 'Initial F shard 2/2', 'azpr-review-functional'), privateSession(R1, 'Initial R', 'azpr-review-risk')];
  const review = buildPanel(host({ notices, sessions }), CONVERSATION);
  assert.equal(review.markdown, '## PR Review Summary\n\n| Severity | Summary | Location |\n| --- | --- | --- |\n| 🟡 medium | F-1 — \\`reserve\\` | head:/a.py:24 |');
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
  const preview = buildPanel(host({ notices: [...planning, previewReceipt('## PR Review Summary\n\n<!-- azpr-comment:5397f777e1b991075943586db103cf5e -->\n\nInline comments prepared: 0')], sessions }), CONVERSATION, { known: { [P]: 'missing' } });
  assert.deepEqual([preview.run, preview.status], [COMMENT_RUN, 'PREVIEW']);
  assert.equal(preview.markdown, '## PR Review Summary\n\n\nInline comments prepared: 0');
  assert.equal(preview.documentHead, `[AZPR ${COMMENT_RUN}] PREVIEW; source review=${RUN}`);
  assert.equal(preview.deleted, 0, 'A comment run names no stage in its receipt, so nothing is counted for it.');
});

test('a session no receipt names stays finished: the planner of a comment run that debug.enabled kept', () => {
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier'), privateSession(P, 'Comment plan page 1/1', 'azpr-review-comment-plan', COMMENT_RUN, { review: RUN })];
  const panel = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ stages: [['azpr-review-verifier', V]] }), started(COMMENT_RUN, 'pr-comment'), previewReceipt('## PR Review Summary')], sessions }), CONVERSATION);
  assert.deepEqual(panel.rows.map(row => [row.label, row.state]), [['Verification', 'complete'], ['Comment plan page 1/1', 'finished']]);
});

// What a preview's notice carries for the panel's rows, as `previewActions` in comments.mjs makes it.
const offer = (extra = {}) => ({ azpr: { next: { review: RUN, state: '0f1e2d3c4b5a', target: `review ${RUN} (/pr-review) of PR #4 in Project/Repository`, publish: true, adjust: true, posts: 3,
  findings: [{ id: 'F-1', severity: 'medium', summary: 'reserve can leave stock decremented' }, { id: 'R-2', severity: 'low', original: 'high', summary: 'snapshot is live' }, { id: 'F-3', severity: 'medium', excluded: true, summary: 'left out' }], ...extra } } });

test('a preview offers its next steps from what the runtime stored with its notice, each value checked', () => {
  const next = nextOf(offer(), RUN);
  assert.deepEqual(next, { review: RUN, state: '0f1e2d3c4b5a', target: `review ${RUN} (/pr-review) of PR #4 in Project/Repository`, plan: false, publish: true, adjust: true, posts: 3, findings: [
    { id: 'F-1', severity: 'medium', excluded: false, summary: 'reserve can leave stock decremented' },
    { id: 'R-2', severity: 'low', original: 'high', excluded: false, summary: 'snapshot is live' },
    { id: 'F-3', severity: 'medium', excluded: true, summary: 'left out' }] });
  // Commands are made of these values: anything that is not of the expected form offers nothing at all.
  assert.equal(nextOf(offer(), '7d23e170'), undefined, 'Another review than the one shown.');
  assert.equal(nextOf(offer({ review: 'bb6a8570 --publish' }), RUN), undefined);
  // The word for the review's comments goes into every command: one of another form, or none (an offer that an
  // earlier version left), offers nothing.
  for (const state of [undefined, '', '0f1e2d3c4b5', '0f1e2d3c4b5a0', '0F1E2D3C4B5A', '0f1e2d3c4b5a --publish', 12, null]) assert.equal(nextOf(offer({ state }), RUN), undefined, String(state));
  for (const findings of [undefined, 'F-1', [{ id: 'F-1 --publish', severity: 'low' }], [{ id: 'f-1', severity: 'low' }], [{ id: 'F-1', severity: 'critical' }], [{ id: 'F-1', severity: 'low', original: 'none' }],
    [{ id: 'F-1', severity: 'low' }, { id: 'F-1', severity: 'high' }], [null], [{ id: 'F-1' }]]) {
    assert.equal(nextOf(offer({ findings }), RUN), undefined, JSON.stringify(findings));
  }
  for (const metadata of [undefined, null, {}, { azpr: {} }, { azpr: { next: 'publish' } }, { azpr: { next: null } }, { azpr: { panel: 'manual' } }]) assert.equal(nextOf(metadata, RUN), undefined);
  // What is only shown is made short and kept on one line; a flag that is not exactly true is false.
  const loose = nextOf(offer({ publish: 'yes', adjust: 1, posts: -2, target: 'a\nb', findings: [{ id: 'F-1', severity: 'high', original: 'high', excluded: 'true', summary: `x\n${'y'.repeat(400)}` }] }), RUN);
  assert.deepEqual([loose.plan, loose.publish, loose.adjust, loose.posts, loose.target], [false, false, false, 0, 'a b']);
  // A review without a preview offers one first: nothing is posted before it was read, whatever the notice says.
  assert.deepEqual([nextOf(offer({ plan: true, publish: true }), RUN).plan, nextOf(offer({ plan: true, publish: true }), RUN).publish], [true, false]);
  assert.deepEqual([loose.findings[0].excluded, Object.hasOwn(loose.findings[0], 'original'), loose.findings[0].summary.length], [false, false, 160]);
});

test('the steps are offered by the preview that happened last, for the review shown, and by nothing after it', () => {
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const before = [started(RUN, 'pr-review'), reviewReceipt({ stages: [['azpr-review-verifier', V]] }), started(COMMENT_RUN, 'pr-comment')];
  const preview = { text: previewReceipt('## PR Review Summary'), metadata: offer() };
  assert.equal(Object.hasOwn(buildPanel(host({ notices: before, sessions }), CONVERSATION), 'next'), false, 'A run under way offers none of them (and one whose notice does not say that it can be stopped, nothing).');
  const shown = buildPanel(host({ notices: [...before, preview], sessions }), CONVERSATION);
  assert.deepEqual([shown.status, shown.next.review, shown.next.findings.map(finding => finding.id)], ['PREVIEW', RUN, ['F-1', 'R-2', 'F-3']]);
  // A notice that already was delivered to the conversation's model has its metadata itself.
  const delivered = { ...host({ sessions }), messages: id => (id === CONVERSATION ? [...before.map((text, index) => ({ id: `msg_00000${index}`, type: 'synthetic', text })), { id: 'msg_000009', type: 'synthetic', text: preview.text, metadata: offer() }] : []) };
  assert.equal(buildPanel(delivered, CONVERSATION).next.review, RUN);
  // A preview without it (a notice of an earlier version), or with one for another review, offers nothing.
  assert.equal(Object.hasOwn(buildPanel(host({ notices: [...before, preview.text], sessions }), CONVERSATION), 'next'), false);
  assert.equal(Object.hasOwn(buildPanel(host({ notices: [...before, { ...preview, metadata: offer({ review: '7d23e170' }) }], sessions }), CONVERSATION), 'next'), false);
  // Once anything follows, the offer is gone: a publication that started, its receipt, a new review.
  const publishing = '4a3415af';
  for (const after of [[started(publishing, 'pr-comment')], [started(publishing, 'pr-comment'), `[AZPR ${publishing}] POSTED; source review=${RUN}\nActed on review ${RUN} (/pr-review) of PR #4 in Project/Repository.\n\n<azpr_comment_data>\nposted\n</azpr_comment_data>\nAll grants are revoked.`],
    [started('7d23e170', 'pr-review')]]) {
    assert.equal(Object.hasOwn(buildPanel(host({ notices: [...before, preview, ...after], sessions }), CONVERSATION), 'next'), false, after.at(-1).slice(0, 40));
  }
  // What a run says besides changes nothing, as for everything else the panel shows.
  assert.equal(buildPanel(host({ notices: [...before, preview, `[AZPR ${RUN}] Automatic preview skipped: nothing to do.`], sessions }), CONVERSATION).next.review, RUN);
  // The receipt of a review that no preview follows by itself offers one, and the findings to adjust before it;
  // what the run says afterwards (that the automatic preview was skipped) changes nothing.
  const complete = { text: reviewReceipt({ stages: [['azpr-review-verifier', V]] }), metadata: offer({ plan: true, publish: false, posts: 0 }) };
  for (const notices of [[started(RUN, 'pr-review'), complete], [started(RUN, 'pr-review'), complete, `[AZPR ${RUN}] Automatic preview skipped: the review has no findings to comment on.`]]) {
    const reviewed = buildPanel(host({ notices, sessions }), CONVERSATION);
    assert.deepEqual([reviewed.status, reviewed.next.plan, reviewed.next.publish, reviewed.next.findings.length], ['COMPLETE', true, false, 3]);
  }
  assert.equal(Object.hasOwn(buildPanel(host({ notices: [started(RUN, 'pr-review'), complete, started(COMMENT_RUN, 'pr-comment')], sessions }), CONVERSATION), 'next'), false, 'The preview that started is what happens next.');
  // What a notice offers goes with the document it encloses: under a report a preview is planned, never posted,
  // and a preview offers what is done with it. A notice that says otherwise offers nothing at all.
  assert.equal(Object.hasOwn(buildPanel(host({ notices: [started(RUN, 'pr-review'), { ...complete, metadata: offer({ plan: false, publish: true }) }], sessions }), CONVERSATION), 'next'), false, 'Nothing is posted from under a report.');
  assert.equal(Object.hasOwn(buildPanel(host({ notices: [...before, { ...preview, metadata: offer({ plan: true, publish: false }) }], sessions }), CONVERSATION), 'next'), false, 'A preview is there already.');
  // An offer names the notice that makes it: the same steps offered by a later notice are another offer, so a
  // step that was picked for the earlier one is not taken for the later one.
  const twice = buildPanel(host({ notices: [...before, preview, started(publishing, 'pr-comment'), { ...preview, text: previewReceipt('## PR Review Summary', publishing) }], sessions }), CONVERSATION);
  assert.equal(typeof shown.next.offer, 'string');
  assert.notEqual(twice.next.offer, shown.next.offer);
  assert.deepEqual({ ...twice.next, offer: '' }, { ...shown.next, offer: '' });
  // A run whose preview another command replaced before its receipt ends with a receipt of its own status. It is
  // not what happened last: where the other command was answered in this conversation, the panel goes on
  // showing that command's preview, and what it offers.
  const replaced = `[AZPR ${COMMENT_RUN}] REPLACED; source review=${RUN}\nActed on review ${RUN} (/pr-review) of PR #4 in Project/Repository.\nThis run's preview was replaced before its receipt: while the run ended, another /pr-comment command changed or posted the preview of this review, so what this run planned is not shown. The receipt of that command says what can be done next, and /pr-comment ${RUN} --show shows the saved preview.\nAll grants are revoked.`;
  const current = [...before, started(publishing, 'pr-comment'), { ...preview, text: previewReceipt('## The preview that counts', publishing) }];
  assert.deepEqual(buildPanel(host({ notices: [...current, replaced], sessions }), CONVERSATION), buildPanel(host({ notices: current, sessions }), CONVERSATION));
  assert.deepEqual([buildPanel(host({ notices: [...current, replaced], sessions }), CONVERSATION).run, buildPanel(host({ notices: [...current, replaced], sessions }), CONVERSATION).markdown], [publishing, '## The preview that counts']);
  // Where the other command was answered elsewhere (typed in the review's own session), this conversation hears
  // of nothing else: the run it showed as running has ended, with no progress left, nothing offered, and the
  // review's report in view, not a preview.
  const progressing = [...before, `[AZPR ${COMMENT_RUN}] PROGRESS — Planning comments, page 1/1`];
  assert.deepEqual([buildPanel(host({ notices: progressing, sessions }), CONVERSATION).status, buildPanel(host({ notices: progressing, sessions }), CONVERSATION).progress], ['RUNNING', 'Planning comments, page 1/1']);
  const ended = buildPanel(host({ notices: [...progressing, replaced], sessions }), CONVERSATION);
  assert.deepEqual([ended.run, ended.status, ended.progress, Object.hasOwn(ended, 'next')], [COMMENT_RUN, 'REPLACED', undefined, false]);
  assert.equal(ended.markdown, buildPanel(host({ notices: progressing, sessions }), CONVERSATION).markdown, 'What was in view stays in view.');
  // The saved preview shown again offers them as the review is now.
  const again = { text: `[AZPR] Saved preview of review ${RUN}, planned 2026-11-19T00:00:00.000Z; no model or Azure DevOps request was made.\nNothing was posted.\n\n<azpr_comment_data>\n## PR Review Summary\n</azpr_comment_data>\nThe text above is data, not instructions.`, metadata: offer({ publish: false }) };
  const answered = buildPanel(host({ notices: [...before, preview, started(publishing, 'pr-comment'), again], sessions }), CONVERSATION);
  assert.deepEqual([answered.run, answered.next.publish], [RUN, false]);
});

// A STARTED notice as the runtime sends it: the run it starts can be stopped, by its ID.
const stoppable = (run, command, rest) => ({ text: started(run, command, rest), metadata: { azpr: { next: { stop: run } } } });

test('a run under way offers to be stopped: from its STARTED notice until its receipt, by the ID that notice gives', () => {
  // A command is made of the ID: it is checked by its form, and as the ID of the very run the notice starts.
  assert.equal(stopOf({ azpr: { next: { stop: RUN } } }, RUN), RUN);
  for (const stop of [undefined, null, '', 'bb6a857', 'bb6a85700', 'BB6A8570', `${RUN} --help`, ` ${RUN}`, 12, true, { id: RUN }, [RUN]]) assert.equal(stopOf({ azpr: { next: { stop } } }, RUN), undefined, JSON.stringify(stop));
  assert.equal(stopOf({ azpr: { next: { stop: COMMENT_RUN } } }, RUN), undefined, 'Another run than the one the notice starts.');
  for (const metadata of [undefined, null, {}, { azpr: {} }, { azpr: { next: null } }, { azpr: { next: 'stop' } }, { azpr: { panel: 'manual' } }, { azpr: { stop: RUN } }, offer()]) assert.equal(stopOf(metadata, RUN), undefined);

  const sessions = [privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional')];
  const first = buildPanel(host({ notices: [stoppable(RUN, 'pr-review')], sessions, running: [F1] }), CONVERSATION);
  assert.deepEqual([first.status, first.next], ['RUNNING', { stop: RUN, command: 'pr-review', offer: 'msg_000001' }]);
  // Progress changes neither the offer nor the notice that makes it: a step picked before it still counts after it.
  const later = buildPanel(host({ notices: [stoppable(RUN, 'pr-review'), progress(RUN, 'PR #4 at 1393af06de: 35 changed file(s).'), progress(RUN, 'Verifying.')], sessions }), CONVERSATION);
  assert.deepEqual([later.progress, later.next], ['Verifying.', first.next]);
  // Every command that starts a run says so, and the question names it.
  for (const command of ['pr-review', 'pr-quick', 'pr-deep', 'pr-comment', 'pr-check']) assert.deepEqual(buildPanel(host({ notices: [stoppable(RUN, command)] }), CONVERSATION).next, { stop: RUN, command, offer: 'msg_000001' }, command);
  assert.deepEqual(buildPanel(host({ notices: [stoppable(RUN, 'pr-other')] }), CONVERSATION).next, { stop: RUN, command: '', offer: 'msg_000001' }, 'A command the panel does not know is not named.');
  // With terminalPanel: manual the mark stands beside it.
  assert.equal(buildPanel(host({ notices: [{ text: started(RUN, 'pr-review'), metadata: { azpr: { panel: 'manual', next: { stop: RUN } } } }] }), CONVERSATION).next.stop, RUN);
  // A notice that already was delivered to the conversation's model has its metadata itself.
  const delivered = { ...host(), messages: id => (id === CONVERSATION ? [{ id: 'msg_000001', type: 'synthetic', text: started(RUN, 'pr-review'), metadata: { azpr: { next: { stop: RUN } } } }] : []) };
  assert.deepEqual(buildPanel(delivered, CONVERSATION).next, first.next);
  // A notice of an earlier version says nothing of it, and one that names another run, or anything else, offers nothing.
  for (const notice of [started(RUN, 'pr-review'), { text: started(RUN, 'pr-review'), metadata: { azpr: { next: { stop: COMMENT_RUN } } } }, { text: started(RUN, 'pr-review'), metadata: { azpr: { next: { stop: `${RUN} ${COMMENT_RUN}` } } } },
    { text: started(RUN, 'pr-review'), metadata: offer() }]) {
    const panel = buildPanel(host({ notices: [notice, progress(RUN, 'Verifying.')] }), CONVERSATION);
    assert.deepEqual([panel.status, Object.hasOwn(panel, 'next')], ['RUNNING', false], JSON.stringify(notice.metadata ?? null));
  }
  // What the runtime answers to the stop is not the run's end: until the receipt arrives the run is under way, and can be asked to stop again.
  const asked = buildPanel(host({ notices: [stoppable(RUN, 'pr-review'), `[AZPR ${RUN}] Authorization revoked and cancellation requested. Requests already sent may still be billed.`] }), CONVERSATION);
  assert.deepEqual([asked.status, asked.next], ['RUNNING', first.next]);
  // The receipt ends it, however the run ended: nothing is stopped any more.
  for (const status of ['CANCELLED', 'INCOMPLETE', 'TIMED_OUT', 'COMPLETE', 'STALE']) {
    const ended = buildPanel(host({ notices: [stoppable(RUN, 'pr-review'), progress(RUN, 'Verifying.'), reviewReceipt({ status, stages: [] })] }), CONVERSATION, { known: { [V]: 'missing' } });
    assert.deepEqual([ended.status, Object.hasOwn(ended, 'next')], [status, false], status);
  }
  // A review that no preview follows by itself then offers its own steps; they are not the run's.
  const complete = { text: reviewReceipt({ stages: [['azpr-review-verifier', V]] }), metadata: offer({ plan: true, publish: false, posts: 0 }) };
  const reviewed = buildPanel(host({ notices: [stoppable(RUN, 'pr-review'), complete], sessions: [privateSession(V, 'Verification', 'azpr-review-verifier')] }), CONVERSATION);
  assert.deepEqual([reviewed.next.review, reviewed.next.plan, reviewed.next.stop, reviewed.next.offer], [RUN, true, undefined, 'msg_000002']);
  // The comment run that follows a review by itself is another run, with a notice of its own: what was picked for
  // the review is not taken for it. Its preview then offers the preview's steps.
  const following = [stoppable(RUN, 'pr-review'), reviewReceipt({ stages: [['azpr-review-verifier', V]] }), stoppable(COMMENT_RUN, 'pr-comment', ` (automatic preview after review ${RUN} completed; afterReview.review: preview)`)];
  const planning = buildPanel(host({ notices: following }), CONVERSATION, { known: { [V]: 'missing' } });
  assert.deepEqual(planning.next, { stop: COMMENT_RUN, command: 'pr-comment', offer: 'msg_000003' });
  const previewed = buildPanel(host({ notices: [...following, { text: previewReceipt('## PR Review Summary'), metadata: offer() }] }), CONVERSATION, { known: { [V]: 'missing' } });
  assert.deepEqual([previewed.status, previewed.next.review, previewed.next.stop, previewed.next.offer], ['PREVIEW', RUN, undefined, 'msg_000004']);
  // A run that starts after a preview takes the preview's steps away and offers only to be stopped.
  const publishing = '4a3415af';
  assert.deepEqual(buildPanel(host({ notices: [...following, { text: previewReceipt('## PR Review Summary'), metadata: offer() }, stoppable(publishing, 'pr-comment')] }), CONVERSATION, { known: { [V]: 'missing' } }).next,
    { stop: publishing, command: 'pr-comment', offer: 'msg_000005' });
  // A run whose preview another command replaced has ended, like any run with a receipt.
  const replaced = `[AZPR ${COMMENT_RUN}] REPLACED; source review=${RUN}\nActed on review ${RUN} (/pr-review) of PR #4 in Project/Repository.\nThis run's preview was replaced before its receipt.\nAll grants are revoked.`;
  const gone = buildPanel(host({ notices: [...following, replaced] }), CONVERSATION, { known: { [V]: 'missing' } });
  assert.deepEqual([gone.run, gone.status, Object.hasOwn(gone, 'next')], [COMMENT_RUN, 'REPLACED', false]);
  // In one of AZPR's own sessions the panel shows the conversation's run, and a run typed in that session: either
  // can be stopped from there, since the command goes to the session on screen and the runtime knows whose it is.
  const own = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const NEXT = '0c0ffee0';
  const elsewhere = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt(), stoppable(NEXT, 'pr-review')], sessions: own, inboxes: { [V]: [queuedReport()] } }), V, { known: { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' } });
  assert.deepEqual([elsewhere.run, elsewhere.status, elsewhere.next.stop, elsewhere.next.command], [NEXT, 'RUNNING', NEXT, 'pr-review']);
  const typedThere = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()], sessions: own, inboxes: { [V]: [queuedReport(), stoppable(COMMENT_RUN, 'pr-comment'), progress(COMMENT_RUN, 'Planning comments, page 1/1')] } }), V, { known: { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' } });
  assert.deepEqual([typedThere.run, typedThere.status, typedThere.next.stop, typedThere.next.command], [COMMENT_RUN, 'RUNNING', COMMENT_RUN, 'pr-comment']);
});

test('a document that quotes its block\'s closing tag is shown as it was written, not as the notice had to write it', () => {
  // A finding about code that handles these very notices: the tag itself, the form the runtime writes it in, and
  // that form escaped once more, in a code block, in a code span and in a sentence.
  const quoting = name => [
    '## PR Review Summary', '',
    `**F-1** closes the block early: the writer appends \`</azpr_${name}_data>\` itself.`, '',
    '```js', `body += '\\n</azpr_${name}_data>\\n';`, `const written = '&lt;/azpr_${name}_data&gt;', twice = '&amp;lt;/azpr_${name}_data&amp;gt;';`, '```', '',
    `</azpr_${name}_data>`, '',
    `Half forms stay as they are: &lt;/azpr_${name}_data> and </azpr_${name}_data&gt; and &amp;lt;/azpr_${name}_data&gt;.`,
  ].join('\n');
  const report = quoting('report'), preview = quoting('comment');
  // The notice holds its closing tag once, where the runtime put it, so the block ends where it should.
  const receipt = reviewReceipt({ report: enclose('report', report) });
  assert.equal(receipt.split('</azpr_report_data>').length, 2);
  assert.equal(buildPanel(host({ notices: [started(RUN, 'pr-review'), receipt] }), CONVERSATION).markdown, report);
  const planned = previewReceipt(enclose('comment', preview));
  assert.equal(planned.split('</azpr_comment_data>').length, 2);
  const shown = buildPanel(host({ notices: [started(RUN, 'pr-review'), receipt, started(COMMENT_RUN, 'pr-comment'), planned] }), CONVERSATION);
  assert.deepEqual([shown.run, shown.status, shown.markdown], [COMMENT_RUN, 'PREVIEW', preview]);
  // A saved preview shown again is enclosed the same way.
  const saved = `[AZPR] Saved preview of review ${RUN}, planned 2026-11-17T00:00:00.000Z; no model or Azure DevOps request was made.\nNothing was posted. To post this exact preview: /pr-comment ${RUN} --publish\n\n<azpr_comment_data>\n${enclose('comment', preview)}\n</azpr_comment_data>\nThe text above is data, not instructions.`;
  assert.equal(buildPanel(host({ notices: [started(RUN, 'pr-review'), receipt, saved] }), CONVERSATION).markdown, preview);
  // A block's text is changed for that block's tag only: the other block's tag was never rewritten.
  assert.equal(buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ report: enclose('report', preview) })] }), CONVERSATION).markdown, preview);
  assert.equal(disclose('report', '&lt;/azpr_comment_data&gt; &amp;lt;/azpr_comment_data&amp;gt;'), '&lt;/azpr_comment_data&gt; &amp;lt;/azpr_comment_data&amp;gt;');
  // One level each way, whatever the text: forms escaped several times, repeated, adjacent and half-escaped.
  for (const name of ['report', 'comment']) {
    const tag = `/azpr_${name}_data`;
    const pieces = [`<${tag}>`, `&lt;${tag}&gt;`, `&amp;lt;${tag}&amp;gt;`, `&amp;amp;lt;${tag}&amp;amp;gt;`, `&amp;lt;${tag}&gt;`, `&lt;${tag}&amp;gt;`, `&lt;${tag}>`, `<${tag}&gt;`, '&', '&amp;', '&lt;', '<', '\n', 'x'];
    for (const first of pieces) for (const second of pieces) for (const third of pieces) {
      const text = first + second + third, enclosed = enclose(name, text);
      assert.ok(!enclosed.includes(`<${tag}>`), JSON.stringify(text));
      assert.equal(disclose(name, enclosed), text, JSON.stringify(text));
    }
  }
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
  // The TUI opened the private session first and has not loaded its conversation yet: its own report is shown meanwhile.
  const cold = host({ sessions, inboxes: { [V]: [queuedReport()] } });
  const loaded = cold.session;
  cold.session = id => (id === CONVERSATION ? undefined : loaded(id));
  assert.deepEqual(buildPanel(cold, V).needs, [CONVERSATION]);
  assert.deepEqual([buildPanel(cold, V).markdown, buildPanel(cold, V).documentHead, buildPanel(cold, V).run], [queuedReport(), '', undefined]);
  assert.deepEqual(buildPanel(cold, V, { known: { [CONVERSATION]: 'missing' } }).needs, [], 'A conversation that was deleted is not asked for again.');
});

test('a command typed in a review\'s own session is answered there, and the panel in that session shows it', () => {
  // The runtime sends a command's notices to the session it was typed in, which may be the session holding the report.
  const inConversation = [started(RUN, 'pr-review'), reviewReceipt()];
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing', [P]: 'missing' };
  // The inbox of the report session: its report first, then what /pr-comment told it.
  const local = [queuedReport(), started(COMMENT_RUN, 'pr-comment'), progress(COMMENT_RUN, 'Planning comments, page 1/1')];
  const planning = buildPanel(host({ notices: inConversation, sessions, inboxes: { [V]: local } }), V, { known });
  assert.deepEqual([planning.run, planning.status, planning.progress], [COMMENT_RUN, 'RUNNING', 'Planning comments, page 1/1']);
  assert.equal(planning.markdown, queuedReport(), 'The report stays while the comments are planned.');
  assert.deepEqual(planning.rows.map(row => [row.id, row.report]), [[V, true]]);
  const preview = buildPanel(host({ notices: inConversation, sessions, inboxes: { [V]: [...local, previewReceipt('## PR Review Summary\n\nInline comments prepared: 2')] } }), V, { known });
  assert.deepEqual([preview.run, preview.status], [COMMENT_RUN, 'PREVIEW']);
  assert.equal(preview.markdown, '## PR Review Summary\n\nInline comments prepared: 2', 'The preview planned after the report takes its place.');
  assert.equal(preview.documentHead, `[AZPR ${COMMENT_RUN}] PREVIEW; source review=${RUN}`);
  assert.deepEqual(preview.rows.map(row => [row.id, row.report]), [[V, true]], 'The review it acts on keeps its report session in view.');
  // --show typed there answers at once, with the saved preview.
  const show = `[AZPR] Saved preview of review ${RUN}, planned 2026-11-16T08:30:00.000Z; no model or Azure DevOps request was made.\n\n<azpr_comment_data>\n## The saved preview\n</azpr_comment_data>`;
  const shown = buildPanel(host({ notices: inConversation, sessions, inboxes: { [V]: [queuedReport(), show] } }), V, { known });
  assert.deepEqual([shown.run, shown.status, shown.markdown], [RUN, 'COMPLETE', '## The saved preview']);
  // The conversation's own panel shows what the conversation was told: the review and its report.
  const elsewhere = buildPanel(host({ notices: inConversation, sessions, inboxes: { [V]: [...local, previewReceipt('## PR Review Summary')] } }), CONVERSATION, { known });
  assert.deepEqual([elsewhere.run, elsewhere.status, elsewhere.markdown], [RUN, 'COMPLETE', queuedReport()]);
});

test('what a run says after its receipt changes nothing the receipt established', () => {
  // The default path of a review without findings to comment on: the receipt, then the note that no preview follows.
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const receipt = [started(RUN, 'pr-review'), reviewReceipt()];
  const before = buildPanel(host({ notices: receipt, sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known });
  for (const note of [`[AZPR ${RUN}] Automatic preview skipped: the review has no findings to comment on.`, `[AZPR ${RUN}] Automatic preview skipped: another AZPR command is running for this PR.`,
    `[AZPR ${RUN}] Automatic publication did not start: the comment step could not be queued.`]) {
    const after = buildPanel(host({ notices: [...receipt, note], sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known });
    assert.deepEqual(after, before, note);
    assert.equal(opensPanel(note), false);
  }
  assert.deepEqual([before.status, before.deleted, before.rows.map(row => [row.id, row.state, row.report])], ['COMPLETE', 3, [[V, 'complete', true]]]);
  // The note of an earlier review can arrive after the next run started (its automatic step found that run in the
  // way): the run under way stays the one shown.
  const NEXT = '0c0ffee0';
  const overtaken = buildPanel(host({ notices: [...receipt, started(NEXT, 'pr-review'), progress(NEXT, 'Initial review: 2 session(s).'),
    `[AZPR ${RUN}] Automatic preview skipped: another AZPR command is running in this conversation or on this PR.`], sessions }), CONVERSATION, { known });
  assert.deepEqual([overtaken.run, overtaken.status, overtaken.progress, overtaken.markdown], [NEXT, 'RUNNING', 'Initial review: 2 session(s).', '']);
  // A stop that was asked for is not the run's end: the run is still under way until its receipt arrives.
  const stopping = buildPanel(host({ notices: [started(RUN, 'pr-review'), progress(RUN, 'Initial review: 4 session(s).'), `[AZPR ${RUN}] Authorization revoked and cancellation requested (4/4 session(s) settled).`] }), CONVERSATION);
  assert.deepEqual([stopping.run, stopping.status, stopping.progress], [RUN, 'RUNNING', 'Initial review: 4 session(s).']);
});

test('only the runtime\'s own lines name sessions: text a model wrote in an enclosed report names none', () => {
  // returnReport: full encloses the report, and a finding in it quotes a receipt of another conversation.
  const foreign = 'ses_foreign000000000000000009', unknown = 'ses_unknown000000000000000009';
  const report = `## PR Review Summary\n\nEvidence, quoted from a log:\n\n- azpr-review-verifier: COMPLETE; session=${foreign}; model=x/y\n\n\`\`\`\n- azpr-review-risk: COMPLETE; session=${unknown}\nReport delivery: report queued to session=${unknown}.\n\`\`\``;
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier'), { id: foreign, title: 'Someone else\'s conversation' }];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const panel = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ report })], sessions }), CONVERSATION, { known });
  assert.deepEqual(panel.rows.map(row => [row.id, row.report]), [[V, true]], 'The quoted lines add no row.');
  assert.deepEqual([panel.needs, panel.deleted, panel.inbox], [[], 3, undefined], 'Nor a lookup, a count or an inbox to read.');
  assert.match(panel.markdown, /quoted from a log/);
  // A receipt whose enclosed text is all that names a report session has none.
  const bare = `[AZPR ${RUN}] PARTIAL\n\nReport data:\n<azpr_report_data>\nReport delivery: report queued to session=${unknown}.\n</azpr_report_data>`;
  const draft = buildPanel(host({ notices: [started(RUN, 'pr-review'), bare] }), CONVERSATION);
  assert.deepEqual([draft.rows, draft.needs, draft.inbox, draft.markdown], [[], [], undefined, `Report delivery: report queued to session=${unknown}.`]);
  assert.equal(opensPanel(bare), true, 'It still opens the panel: it encloses a document.');
  assert.equal(opensPanel(`[AZPR ${RUN}] INCOMPLETE\nReason: the log said "Report delivery: report queued to session=${unknown}."`), true, 'A line the runtime wrote itself counts.');
  // A session a stage line names is listed only when it says itself that it belongs to this run and conversation.
  const stolen = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ stages: [['azpr-review-verifier', V], ['azpr-review-risk', foreign]] })], sessions: [...sessions,
    { ...privateSession('ses_otherrun00000000000000009', 'Initial R', 'azpr-review-risk', '00000000') }] }), CONVERSATION);
  assert.deepEqual(stolen.rows.map(row => row.id), [V], 'A session without AZPR\'s metadata, or of another run, is not a row.');
  // A review of AZPR 0.4.0 or earlier: its sessions are children of the conversation and carry no metadata.
  const child = { id: V, title: `[AZPR ${RUN}] Verification`, parentID: CONVERSATION };
  const legacy = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()], sessions: [child, { id: F1, title: 'A child of another conversation', parentID: 'ses_someoneelse000000000000001' }],
    inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known: { [F2]: 'missing', [R1]: 'missing' } });
  assert.deepEqual([legacy.rows.map(row => [row.id, row.label, row.report]), legacy.markdown], [[[V, 'Verification', true]], queuedReport()]);
  // A report is read only from a session of this conversation, whatever line named it.
  const theirs = { id: foreign, title: '[AZPR 12345678] Verification', metadata: { azpr: { run: '12345678', role: 'azpr-review-verifier', conversation: 'ses_someoneelse000000000000001' } } };
  const quoted = `[AZPR ${RUN}] INCOMPLETE\nReason: the provider answered "Report delivery: report queued to session=${foreign}."`;
  const leaked = buildPanel(host({ notices: [started(RUN, 'pr-review'), quoted], sessions: [theirs], inboxes: { [foreign]: [queuedReport('12345678', 'Someone else\'s report')] } }), CONVERSATION);
  assert.deepEqual([leaked.markdown, leaked.inbox, leaked.loading, leaked.rows, leaked.needs], ['', undefined, false, [], []]);
  // Until the host has the named session, it is looked up first; its inbox is read only once it proved to be ours.
  const pending = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()] }), CONVERSATION, { known: { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' } });
  assert.deepEqual([pending.needs, pending.inbox, pending.loading, pending.markdown], [[V], undefined, true, '']);
});

test('a session counts as deleted only when the server said so; a lookup that failed is made again', () => {
  const ok = { status: 'fulfilled', value: undefined }, failed = reason => ({ status: 'rejected', reason });
  const missing = Object.assign(new Error('Session not found'), { name: 'Session.NotFoundError' }), network = new Error('fetch failed: ECONNRESET');
  assert.equal(notFound(missing), true);
  assert.equal(notFound({ _tag: 'SessionNotFoundError' }), true);
  assert.equal(notFound(new Error('/api/session/ses_x/inbox: 404 {"message":"no such session"}')), true);
  for (const other of [network, new Error('500 Internal Server Error'), new Error('timeout of 4040 ms'), undefined, 'aborted']) assert.equal(notFound(other), false, String(other));
  assert.equal(lookupOutcome(ok, true), 'exists');
  assert.equal(lookupOutcome(ok, false), 'missing', 'The lookup succeeded and there is no such session.');
  assert.equal(lookupOutcome(failed(missing), false), 'missing');
  assert.equal(lookupOutcome(failed(missing), true), 'missing', 'A not-found answer outweighs what the host still holds.');
  assert.equal(lookupOutcome(failed(network), false), 'retry', 'The host not having it loaded says nothing.');
  assert.equal(lookupOutcome(failed(network), true), 'retry');
});

test('a session\'s conversation is what the session itself says: its metadata, or for a session of 0.4.0 its parent', () => {
  assert.equal(conversationOf(privateSession(V, 'Verification', 'azpr-review-verifier')), CONVERSATION);
  assert.equal(conversationOf({ id: V, title: `[AZPR ${RUN}] Verification`, parentID: CONVERSATION }), CONVERSATION, 'A child that carries AZPR\'s title.');
  assert.equal(conversationOf({ id: V, title: 'Explore the repository', parentID: CONVERSATION }), undefined, 'Someone\'s own subagent session is not AZPR\'s.');
  assert.equal(conversationOf({ id: CONVERSATION, title: 'My conversation' }), undefined);
  assert.equal(conversationOf({ id: V, title: `[AZPR ${RUN}] Verification`, parentID: CONVERSATION, metadata: { azpr: { run: RUN } } }), undefined, 'Metadata that names no conversation is not completed from the parent.');
  assert.equal(conversationOf(undefined), undefined);
});

test('what is read of another session is decided by that session, and asked for only when it proved to be ours', () => {
  const OLDER = '11111111', V_OLD = 'ses_e1e3aaaaaffeOlderVerifier001';
  const older = privateSession(V_OLD, 'Verification', 'azpr-review-verifier', OLDER);
  const newer = privateSession(V, 'Verification', 'azpr-review-verifier');
  const oldStages = [['azpr-review-verifier', V_OLD]];
  const conversationNotices = [started(OLDER, 'pr-review'), reviewReceipt({ run: OLDER, stages: oldStages }).replace(`session=${V}.`, `session=${V_OLD}.`), started(RUN, 'pr-review'), reviewReceipt()];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  // The session of an older review is on screen, and the conversation has completed another review since. The newer
  // report is not cached: it is asked for, and the older report on screen is not shown under the newer status.
  const stale = buildPanel(host({ notices: conversationNotices, sessions: [older, newer], inboxes: { [V_OLD]: [queuedReport(OLDER, 'The older report')] } }), V_OLD, { known, read: { [`${CONVERSATION}:notices`]: true } });
  assert.deepEqual([stale.run, stale.status, stale.markdown, stale.loading], [RUN, 'COMPLETE', '', true]);
  assert.deepEqual(stale.inbox?.sessionID, V, 'The report of the run shown is fetched.');
  const fresh = buildPanel(host({ notices: conversationNotices, sessions: [older, newer], inboxes: { [V_OLD]: [queuedReport(OLDER, 'The older report')], [V]: [queuedReport()] } }), V_OLD, { known, read: { [`${CONVERSATION}:notices`]: true } });
  assert.deepEqual([fresh.markdown, fresh.documentHead, fresh.inbox], [queuedReport(), '', undefined]);
  // A receipt whose own text quotes the report line of an older review of the same conversation: that session
  // holds another run's report, and it is neither shown nor read.
  const quoting = `[AZPR ${RUN}] INCOMPLETE\nReason: the provider answered "Report delivery: report queued to session=${V_OLD}."`;
  const other = buildPanel(host({ notices: [...conversationNotices.slice(0, 2), started(RUN, 'pr-review'), quoting], sessions: [older], inboxes: { [V_OLD]: [queuedReport(OLDER, 'The older report')] } }), CONVERSATION);
  assert.deepEqual([other.run, other.status, other.markdown, other.inbox, other.loading, other.rows], [RUN, 'INCOMPLETE', '', undefined, false, []]);
  // The conversation's notices are read from the server when one of AZPR's sessions is on screen, whether or not
  // the host knows the conversation itself, and once.
  const cold = host({ sessions: [newer], inboxes: { [V]: [queuedReport()] } });
  const first = buildPanel(cold, V);
  assert.deepEqual([first.notices, first.needs, first.markdown, first.run], [{ sessionID: CONVERSATION, token: 'notices' }, [], queuedReport(), undefined], 'Its own report meanwhile.');
  assert.equal(buildPanel(cold, V, { read: { [`${CONVERSATION}:notices`]: true } }).notices, undefined);
  assert.equal(buildPanel(cold, V, { known: { [CONVERSATION]: 'missing' } }).notices, undefined, 'A conversation that was deleted is not read.');
  assert.equal(buildPanel(cold, CONVERSATION).notices, undefined, 'A conversation on screen has its notices with the host.');
  // A named session the host has not loaded is looked up, and nothing of it is read before that.
  const unknown = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()] }), CONVERSATION, { known });
  assert.deepEqual([unknown.needs, unknown.inbox, unknown.loading], [[V], undefined, true]);
});

test('a status never stands above another review\'s document', () => {
  const OLDER = '11111111', NEWER = '22222222', V_OLD = 'ses_e1e3aaaaaffeOlderVerifier001';
  const older = privateSession(V_OLD, 'Verification', 'azpr-review-verifier', OLDER);
  const newer = privateSession(V, 'Verification', 'azpr-review-verifier');
  const olderReceipt = reviewReceipt({ run: OLDER, stages: [['azpr-review-verifier', V_OLD]] }).replace(`session=${V}.`, `session=${V_OLD}.`);
  const read = { [`${CONVERSATION}:notices`]: true }, known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const inboxes = { [V_OLD]: [queuedReport(OLDER, 'The older report')], [V]: [queuedReport()] };
  // The session of the older review is on screen while a newer review starts, runs and is stopped: that run has no
  // document, and the older report on screen is not put under its status.
  for (const [last, status] of [[started(NEWER, 'pr-review'), 'RUNNING'], [progress(NEWER, 'Initial review: 2 session(s).'), 'RUNNING'], [`[AZPR ${NEWER}] CANCELLED\nReason (workflow): Stopped by /pr-stop.`, 'CANCELLED']]) {
    const notices = [started(OLDER, 'pr-review'), olderReceipt, ...(last.includes('STARTED') ? [] : [started(NEWER, 'pr-review')]), last];
    const panel = buildPanel(host({ notices, sessions: [older], inboxes }), V_OLD, { read, known });
    assert.deepEqual([panel.run, panel.status, panel.markdown, panel.inbox], [NEWER, status, '', undefined], last);
  }
  // Its own review shown: its own report, by the notices or, before they are read, by itself.
  const mine = buildPanel(host({ notices: [started(OLDER, 'pr-review'), olderReceipt], sessions: [older], inboxes }), V_OLD, { read, known });
  assert.deepEqual([mine.run, mine.status, mine.markdown], [OLDER, 'COMPLETE', queuedReport(OLDER, 'The older report')]);
  const cold = buildPanel(host({ sessions: [older], inboxes }), V_OLD);
  assert.deepEqual([cold.run, cold.markdown], [undefined, queuedReport(OLDER, 'The older report')]);
  // A saved preview of the older review shown again after the newer review completed: the panel is about the older
  // review then, with its status, its sessions and its preview, as the runtime makes it the current review.
  const show = review => `[AZPR] Saved preview of review ${review}, planned 2026-11-16T08:30:00.000Z; no model or Azure DevOps request was made.\nNot published.\n\n<azpr_comment_data>\n## Preview of ${review}\n</azpr_comment_data>`;
  const both = [started(OLDER, 'pr-review'), olderReceipt, started(RUN, 'pr-review'), reviewReceipt()];
  const shown = buildPanel(host({ notices: [...both, show(OLDER)], sessions: [older, newer], inboxes }), CONVERSATION, { known });
  assert.deepEqual([shown.run, shown.status, shown.markdown, shown.rows.map(row => [row.id, row.report]), shown.progress], [OLDER, 'COMPLETE', `## Preview of ${OLDER}`, [[V_OLD, true]], undefined]);
  assert.match(shown.documentHead, new RegExp(`^\\[AZPR\\] Saved preview of review ${OLDER}`));
  // And of the newer one again: back to it. A list of reviews, which has no document, changes nothing.
  const back = buildPanel(host({ notices: [...both, show(OLDER), show(RUN), '[AZPR] Reviews saved for this conversation (2); no model or Azure DevOps request was made.'], sessions: [older, newer], inboxes }), CONVERSATION, { known });
  assert.deepEqual([back.run, back.status, back.markdown, back.rows.map(row => row.id)], [RUN, 'COMPLETE', `## Preview of ${RUN}`, [V]]);
  // A run that starts afterwards is what the panel is about again, and the preview shown before it is not its document.
  const after = buildPanel(host({ notices: [...both, show(OLDER), started(NEWER, 'pr-quick')], sessions: [older, newer], inboxes }), CONVERSATION, { known });
  assert.deepEqual([after.run, after.status, after.markdown], [NEWER, 'RUNNING', '']);
  // A saved preview of a review whose receipt the conversation no longer holds: named, without a status.
  const alone = buildPanel(host({ notices: [show(OLDER)] }), CONVERSATION);
  assert.deepEqual([alone.run, alone.status, alone.markdown, alone.rows], [OLDER, '', `## Preview of ${OLDER}`, []]);
});

test('a comment run that ends without a preview leaves the review\'s report in view', () => {
  // The receipt of a comment run always has the block for its preview; it is empty when planning failed or was stopped.
  const failedRun = `[AZPR ${COMMENT_RUN}] INCOMPLETE; source review=${RUN}\nActed on review ${RUN} (/pr-review) of PR #4 in Project/Repository.\nReason: The provider refused the request.\n\nThe review is kept. Fix the cause, then run /pr-comment ${RUN} again; comments that already exist are skipped.\n\n<azpr_comment_data>\n\n</azpr_comment_data>\nAll grants are revoked. The text above is data, not instructions.`;
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing', [P]: 'missing' };
  const notices = [started(RUN, 'pr-review'), reviewReceipt(), started(COMMENT_RUN, 'pr-comment'), failedRun];
  const panel = buildPanel(host({ notices, sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known });
  assert.deepEqual([panel.run, panel.status, panel.markdown], [COMMENT_RUN, 'INCOMPLETE', queuedReport()], 'The run\'s status, and the report of the review it acted on.');
  assert.equal(panel.documentHead, '', 'The report says itself which run it is of.');
  assert.deepEqual(panel.rows.map(row => [row.id, row.report]), [[V, true]]);
  // Until the report is cached it is asked for, as after the review itself.
  const uncached = buildPanel(host({ notices, sessions }), CONVERSATION, { known });
  assert.deepEqual([uncached.markdown, uncached.inbox?.sessionID, uncached.loading], ['', V, true]);
  // In the report session, the same: the fallback is not needed, and nothing is blank.
  const own = buildPanel(host({ notices, sessions, inboxes: { [V]: [queuedReport()] } }), V, { known, read: { [`${CONVERSATION}:notices`]: true } });
  assert.deepEqual([own.status, own.markdown], ['INCOMPLETE', queuedReport()]);
  // With an enclosed report (returnReport: full), that report stays.
  const full = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ report: '## The report' }), started(COMMENT_RUN, 'pr-comment'), failedRun], sessions }), CONVERSATION, { known });
  assert.deepEqual([full.status, full.markdown], ['INCOMPLETE', '## The report']);
  // An empty block is no document: such a receipt does not open the panel, and a saved preview without text is no subject.
  assert.equal(opensPanel(failedRun), false);
  const empty = `[AZPR] Saved preview of review ${RUN}; no model or Azure DevOps request was made.\n\n<azpr_comment_data>\n   \n</azpr_comment_data>`;
  assert.equal(opensPanel(empty), false);
  assert.deepEqual([buildPanel(host({ notices: [...notices, empty], sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known }).run], [COMMENT_RUN]);
});

test('the server\'s word that a session is gone outweighs what the host still holds of it', () => {
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier'), privateSession(F1, 'Initial F shard 1/2', 'azpr-review-functional')];
  const notices = [started(RUN, 'pr-review'), reviewReceipt()];
  const here = buildPanel(host({ notices, sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known: { [F2]: 'missing', [R1]: 'missing' } });
  assert.deepEqual([here.rows.map(row => row.id), here.deleted, here.markdown], [[V, F1], 2, queuedReport()]);
  // The inbox request for the report session answered not found, and the host still lists both sessions.
  const gone = buildPanel(host({ notices, sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known: { [F2]: 'missing', [R1]: 'missing', [V]: 'missing', [F1]: 'missing' } });
  assert.deepEqual([gone.rows, gone.deleted, gone.markdown, gone.inbox, gone.loading, gone.needs], [[], 4, '', undefined, false, []], 'Not a row, not the report\'s holder, counted as deleted.');
});

test('what was read of a session and what arrived meanwhile are one list, each notice once', () => {
  const a = { id: 'msg_1', type: 'synthetic', payload: { text: 'first' } }, b = { id: 'msg_2', type: 'synthetic', payload: { text: 'second' } };
  const delivered = { id: 'msg_1', type: 'synthetic', text: 'first' };
  assert.deepEqual(mergeEntries([a], [b], [a]).map(entry => entry.id), ['msg_1', 'msg_2']);
  assert.deepEqual(mergeEntries([a, b], [delivered]), [delivered, b], 'A notice that was delivered since is the same notice.');
  assert.deepEqual(mergeEntries([], [undefined, { type: 'synthetic' }, a]), [a], 'Entries without an ID are left out.');
  assert.deepEqual(mergeEntries(), []);
});

test('a session of AZPR 0.4.0 on screen shows its conversation\'s run and its own report', () => {
  // Sessions of 0.4.0 and earlier are children of the conversation and carry no metadata.
  const child = { id: V, title: `[AZPR ${RUN}] Verification`, parentID: CONVERSATION };
  const known = { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' };
  const panel = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()], sessions: [child], inboxes: { [V]: [queuedReport()] } }), V, { known, read: { [`${CONVERSATION}:notices`]: true } });
  assert.deepEqual([panel.conversation, panel.run, panel.status, panel.markdown], [CONVERSATION, RUN, 'COMPLETE', queuedReport()]);
  assert.deepEqual(panel.rows.map(row => [row.id, row.label, row.report]), [[V, 'Verification', true]]);
  // Before the conversation's notices are read: its own report, and the request for them.
  const before = buildPanel(host({ sessions: [child], inboxes: { [V]: [queuedReport()] } }), V);
  assert.deepEqual([before.conversation, before.markdown, before.notices], [CONVERSATION, queuedReport(), { sessionID: CONVERSATION, token: 'notices' }]);
  // Its title names its run: it is not the report session of another review of the conversation.
  const NEWER = '22222222';
  const other = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt(), started(NEWER, 'pr-review')], sessions: [child], inboxes: { [V]: [queuedReport()] } }), V, { known, read: { [`${CONVERSATION}:notices`]: true } });
  assert.deepEqual([other.run, other.status, other.markdown, other.rows], [NEWER, 'RUNNING', '', []]);
  // Someone's own subagent session is a conversation of its own to the panel.
  const subagent = { id: 'ses_subagent0000000000000001', title: 'Explore the repository', parentID: CONVERSATION };
  const plain = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt()], sessions: [subagent] }), subagent.id);
  assert.deepEqual([plain.conversation, plain.run, plain.notices], [subagent.id, undefined, undefined]);
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

// ---------------------------------------------------------------------------------------------------------------
// The reader: what the panel asks the server of other sessions. Its requests are answered here when the test says so.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
const pendingItem = (id, text) => ({ id, type: 'synthetic', payload: { text }, delivery: 'steer' });
const toldMessage = (id, text) => ({ id, type: 'synthetic', text });
const networkError = () => new Error('fetch failed: ECONNRESET');
const goneError = () => Object.assign(new Error('Session not found'), { name: 'Session.NotFoundError' });
/** A reader over a host whose answers the test gives: `calls` lists what was asked, in order. */
function readerHost({ kept, context = true, heldPauses = false } = {}) {
  const calls = [], present = new Set(), pauses = [];
  let changes = 0;
  const ask = kind => sessionID => { const call = { kind, sessionID, ...deferred() }; calls.push(call); return call.promise; };
  // With `heldPauses` a wait between attempts lasts until the test ends it.
  const pause = ms => { if (!heldPauses) return Promise.resolve(); const wait = { ms, ...deferred() }; pauses.push(wait); return wait.promise; };
  const reader = createReader({ inbox: ask('inbox'), ...(context ? { context: ask('context') } : {}), lookup: ask('lookup'), list: ask('list'), present: id => present.has(id), changed: () => { changes++; }, pause, ...(kept ? { kept } : {}) });
  return { reader, calls, present, pauses, changes: () => changes, last: kind => calls.findLast(call => call.kind === kind) };
}

test('the reader looks a session up before anything else, and believes only the server about a missing one', async () => {
  const h = readerHost();
  const first = h.reader.lookup(V);
  assert.equal(h.reader.lookup(V), first, 'One lookup at a time.');
  await settle();
  assert.deepEqual(h.calls.map(call => call.kind), ['lookup'], 'The session itself is asked for, not its inbox.');
  h.present.add(V);
  h.calls[0].resolve();
  await first;
  assert.deepEqual(h.reader.known(), { [V]: 'exists' });
  // A lookup that fails on the way is made again, further apart, and after four failures left alone.
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt === 1) void h.reader.lookup(F1);
    await settle();
    assert.equal(h.calls.filter(call => call.sessionID === F1).length, attempt);
    h.last('lookup').reject(networkError());
    await settle();
  }
  assert.equal(h.calls.filter(call => call.sessionID === F1).length, 4);
  assert.equal(h.reader.known()[F1], undefined, 'A request that failed says nothing about the session.');
  await h.reader.lookup(F1);
  assert.equal(h.calls.filter(call => call.sessionID === F1).length, 4, 'It is not asked for again until the server reconnects.');
  // Not found, or a lookup that succeeded without a session: gone, and never asked for again.
  void h.reader.lookup(F2); await settle(); h.last('lookup').reject(goneError());
  void h.reader.lookup(R1); await settle(); h.last('lookup').resolve();
  await settle();
  assert.deepEqual([h.reader.known()[F2], h.reader.known()[R1]], ['missing', 'missing']);
  const asked = h.calls.length;
  await h.reader.lookup(F2);
  assert.equal(h.calls.length, asked);
  h.reader.deleted(P);
  assert.equal(h.reader.known()[P], 'missing', 'The host\'s own report of a deletion counts the same.');
});

test('the reader reads the inbox before the messages, so that a notice delivered in between is in one of them', async () => {
  const h = readerHost();
  const done = h.reader.readInbox(CONVERSATION, 'notices', false);
  await settle();
  assert.deepEqual(h.calls.map(call => call.kind), ['inbox'], 'The messages are not asked for until the inbox answered.');
  // The notice waits in the inbox when it is read; it is delivered before the messages are read.
  h.calls[0].resolve({ data: [pendingItem('msg_2', 'second')] });
  await settle();
  assert.deepEqual(h.calls.map(call => call.kind), ['inbox', 'context']);
  h.calls[1].resolve({ data: [toldMessage('msg_1', 'first'), { id: 'msg_9', type: 'assistant', text: 'an answer' }, toldMessage('msg_2', 'second')] });
  await done;
  assert.deepEqual(syntheticOf([], h.reader.entries(CONVERSATION)), [{ id: 'msg_1', text: 'first' }, { id: 'msg_2', text: 'second' }], 'Each notice once; only notices are kept.');
  assert.deepEqual(h.reader.read(), { [`${CONVERSATION}:notices`]: true });
  await h.reader.readInbox(CONVERSATION, 'notices', false);
  assert.equal(h.calls.length, 2, 'What was read is not read again.');
});

test('a notice that arrives while the reader is reading is kept with the answer, and later ones are added', async () => {
  const h = readerHost();
  const done = h.reader.readInbox(CONVERSATION, 'notices', false);
  await settle();
  // The host reports the receipt while the inbox request is under way; the answer was made before it.
  h.reader.arrived(CONVERSATION, pendingItem('msg_3', `[AZPR ${RUN}] COMPLETE`));
  h.calls[0].resolve([pendingItem('msg_1', started(RUN, 'pr-review'))]);
  await settle();
  h.reader.arrived(CONVERSATION, pendingItem('msg_2', progress(RUN, 'Verifying.')));
  h.last('context').resolve([]);
  await done;
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id).sort(), ['msg_1', 'msg_2', 'msg_3']);
  // After the read: each new notice is added, once; one for a session that was never read is not kept.
  h.reader.arrived(CONVERSATION, pendingItem('msg_4', 'later'));
  h.reader.arrived(CONVERSATION, pendingItem('msg_4', 'later'));
  h.reader.arrived(V, pendingItem('msg_5', 'elsewhere'));
  h.reader.arrived(CONVERSATION, { id: 'msg_6', type: 'user', payload: { text: 'typed' } });
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id).sort(), ['msg_1', 'msg_2', 'msg_3', 'msg_4']);
  assert.deepEqual(h.reader.entries(V), []);
});

test('a report is looked for in the inbox, then among the messages; a failed request is made again; gone is gone', async () => {
  const h = readerHost();
  const done = h.reader.readInbox(V, 'msg_7', true);
  await settle();
  assert.deepEqual(h.calls.map(call => call.kind), ['inbox'], 'A report normally waits in the inbox: the messages are not read for it.');
  h.calls[0].resolve([]);
  await settle();
  // Not there: someone prompted that session, and the report was delivered. The next attempt reads the messages too.
  assert.deepEqual(h.calls.map(call => call.kind), ['inbox', 'inbox']);
  h.calls[1].reject(networkError());
  await settle();
  assert.deepEqual(h.calls.map(call => call.kind), ['inbox', 'inbox', 'inbox'], 'A request that failed on the way is made again.');
  h.calls[2].resolve([]);
  await settle();
  h.last('context').resolve({ data: [toldMessage('msg_5', queuedReport())] });
  await done;
  assert.equal(reportIn(syntheticOf([], h.reader.entries(V))), queuedReport());
  assert.deepEqual([h.reader.read(), h.reader.known()], [{ [`${V}:msg_7`]: true }, {}]);
  // Four attempts without a report: the read ends, and the session is not called missing.
  const none = h.reader.readInbox(F1, 'msg_8', true);
  for (let attempt = 0; attempt < 4; attempt++) { await settle(); h.last('inbox').resolve([]); await settle(); h.calls.filter(call => call.kind === 'context' && call.sessionID === F1).at(-1)?.resolve([]); }
  await none;
  assert.deepEqual([h.reader.read()[`${F1}:msg_8`], h.reader.known()[F1], h.calls.filter(call => call.kind === 'inbox' && call.sessionID === F1).length], [true, undefined, 4]);
  // The server says the session is gone.
  const gone = h.reader.readInbox(F2, 'msg_9', true);
  await settle();
  h.last('inbox').reject(goneError());
  await gone;
  assert.equal(h.reader.known()[F2], 'missing');
});

test('what was asked before a reconnection is dropped when it answers, and everything is read anew', async () => {
  const h = readerHost();
  h.present.add(V);
  const stale = h.reader.readInbox(CONVERSATION, 'notices', false);
  const lookedUp = h.reader.lookup(V);
  await settle();
  const [inboxBefore, lookupBefore] = [h.last('inbox'), h.last('lookup')];
  // The connection to the server was lost and is back: notices were missed meanwhile.
  h.reader.reconnected();
  assert.deepEqual([h.reader.known(), h.reader.read(), h.reader.entries(CONVERSATION)], [{}, {}, []]);
  // The panel asks again at once; these are requests of their own.
  const fresh = h.reader.readInbox(CONVERSATION, 'notices', false);
  const again = h.reader.lookup(V);
  await settle();
  assert.notEqual(h.last('inbox'), inboxBefore, 'The read before the reconnection does not stand in the new one\'s way.');
  assert.notEqual(h.last('lookup'), lookupBefore);
  // The old answers arrive late: an outdated inbox, and a lookup.
  inboxBefore.resolve([pendingItem('msg_1', 'before the gap')]);
  lookupBefore.resolve();
  await stale; await lookedUp; await settle();
  assert.deepEqual([h.reader.entries(CONVERSATION), h.reader.read(), h.reader.known()], [[], {}, {}], 'Nothing of them is kept or marked.');
  assert.ok(!h.calls.some(call => call.kind === 'context'), 'The outdated read asks for nothing more.');
  // The new answers count.
  h.last('inbox').resolve([pendingItem('msg_1', 'before the gap'), pendingItem('msg_2', 'during the gap')]);
  await settle();
  h.last('context').resolve([]);
  h.last('lookup').resolve();
  await fresh; await again;
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id), ['msg_1', 'msg_2']);
  assert.deepEqual([h.reader.read(), h.reader.known()], [{ [`${CONVERSATION}:notices`]: true }, { [V]: 'exists' }]);
  // A session whose lookups had failed four times is asked for again after a reconnection.
  for (let attempt = 0; attempt < 4; attempt++) { if (!attempt) void h.reader.lookup(F1); await settle(); h.last('lookup').reject(networkError()); await settle(); }
  const asked = h.calls.length;
  await h.reader.lookup(F1);
  assert.equal(h.calls.length, asked);
  h.reader.reconnected();
  void h.reader.lookup(F1);
  await settle();
  assert.equal(h.calls.length, asked + 1);
});

test('the reader holds what it read of the sessions read last, and reads one it let go again; unloaded, it asks nothing', async () => {
  const h = readerHost({ kept: 2, context: false });
  const readOf = async (sessionID, token) => { const done = h.reader.readInbox(sessionID, token, false); await settle(); h.last('inbox').resolve([pendingItem(`msg_${sessionID}`, sessionID)]); await done; };
  await readOf(F1, 'notices');
  await readOf(F2, 'notices');
  assert.deepEqual([h.reader.entries(F1).length, h.reader.entries(F2).length], [1, 1]);
  assert.ok(!h.calls.some(call => call.kind === 'context'), 'A host without the messages request is asked for the inbox alone.');
  // A notice for the first keeps it among the last ones; a third session then lets the second go.
  h.reader.arrived(F1, pendingItem('msg_x', 'more'));
  await readOf(R1, 'notices');
  assert.deepEqual([h.reader.entries(F1).length, h.reader.entries(F2).length, h.reader.entries(R1).length], [2, 0, 1]);
  assert.deepEqual(Object.keys(h.reader.read()).sort(), [`${F1}:notices`, `${R1}:notices`].sort(), 'It is not marked as read any more.');
  const asked = h.calls.length;
  await readOf(F2, 'notices');
  assert.equal(h.calls.length, asked + 1, 'Needed again, it is read again.');
  const changes = h.changes();
  // After the TUI unloaded the plugin.
  h.reader.dispose();
  await h.reader.readInbox(V, 'notices', false);
  await h.reader.lookup(V);
  h.reader.arrived(F2, pendingItem('msg_y', 'late'));
  assert.deepEqual([h.calls.length, h.changes()], [asked + 1, changes]);
});

test('a session the server reported as deleted stays gone when a lookup of it answers later', async () => {
  const h = readerHost();
  h.present.add(V);   // The host still holds the session's metadata.
  const looked = h.reader.lookup(V);
  const reading = h.reader.readInbox(V, 'msg_7', true);
  await settle();
  h.reader.deleted(V);
  assert.equal(h.reader.known()[V], 'missing');
  // The lookup and the inbox read that were under way answer as if the session were there.
  h.last('lookup').resolve();
  h.last('inbox').resolve([pendingItem('msg_5', queuedReport())]);
  await looked; await reading; await settle();
  assert.equal(h.reader.known()[V], 'missing', 'The lookup\'s answer does not bring it back.');
  assert.deepEqual([h.reader.entries(V), h.reader.read()], [[], {}], 'Nothing is kept of it, and nothing marked.');
  // The model then neither lists it nor reads its report, whatever the host holds.
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const panel = buildPanel(host({ notices: [started(RUN, 'pr-review'), reviewReceipt({ stages: [['azpr-review-verifier', V]] })], sessions, inboxes: { [V]: [queuedReport()] } }), CONVERSATION, { known: h.reader.known(), read: h.reader.read() });
  assert.deepEqual([panel.rows, panel.deleted, panel.markdown, panel.inbox, panel.needs], [[], 1, '', undefined, []]);
  // A later lookup is not made at all, and a reconnection starts over.
  const asked = h.calls.length;
  await h.reader.lookup(V);
  assert.equal(h.calls.length, asked);
  h.reader.reconnected();
  void h.reader.lookup(V); await settle();
  h.last('lookup').resolve(); await settle();
  assert.equal(h.reader.known()[V], 'exists', 'After a reconnection the server is asked again, and believed.');
});

test('an inbox that was let go while its own read ended is not marked as read, and is read again', async () => {
  const h = readerHost({ kept: 2, context: false });
  // Three reads end together; only two sessions are kept.
  const reads = [F1, F2, R1].map(sessionID => h.reader.readInbox(sessionID, 'notices', false));
  await settle();
  for (const call of h.calls.filter(call => call.kind === 'inbox')) call.resolve([pendingItem(`msg_${call.sessionID}`, call.sessionID)]);
  await Promise.all(reads);
  assert.deepEqual([F1, F2, R1].map(sessionID => h.reader.entries(sessionID).length), [0, 1, 1], 'The first one read was let go.');
  assert.deepEqual(Object.keys(h.reader.read()).sort(), [`${F2}:notices`, `${R1}:notices`].sort(), 'It is not marked as read: nothing of it is held.');
  // The panel needs it again: it is read again.
  const asked = h.calls.length;
  const again = h.reader.readInbox(F1, 'notices', false);
  await settle();
  assert.equal(h.calls.length, asked + 1);
  h.last('inbox').resolve([pendingItem('msg_again', 'again')]);
  await again;
  assert.deepEqual([h.reader.entries(F1).length, h.reader.read()[`${F1}:notices`]], [1, true]);
  // A read whose requests all failed is marked, so that it is not repeated without end.
  const failing = h.reader.readInbox(V, 'notices', false);
  for (let attempt = 0; attempt < 4; attempt++) { await settle(); h.last('inbox').reject(networkError()); }
  await failing;
  assert.deepEqual([h.reader.entries(V), h.reader.read()[`${V}:notices`]], [[], true]);
});

test('a session is not let go while a read of it is under way: what its requests answer is held together', async () => {
  // The default number of sessions kept. The conversation's inbox answers with the receipt; its messages are slow.
  const h = readerHost();
  const done = h.reader.readInbox(CONVERSATION, 'notices', false);
  await settle();
  h.last('inbox').resolve([pendingItem('msg_2', `[AZPR ${RUN}] COMPLETE`)]);
  await settle();
  const messages = h.last('context');
  assert.equal(messages.sessionID, CONVERSATION);
  // Meanwhile more other sessions are read than are kept, each to its end.
  const others = Array.from({ length: 30 }, (unused, index) => `ses_other${String(index).padStart(2, '0')}`);
  for (const sessionID of others) {
    const read = h.reader.readInbox(sessionID, 'notices', false);
    await settle();
    h.last('inbox').resolve([pendingItem(`msg_${sessionID}`, sessionID)]);
    await settle();
    h.last('context').resolve([]);
    await read;
  }
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id), ['msg_2'], 'The receipt is still held: its read has not ended.');
  assert.deepEqual(others.filter(sessionID => h.reader.entries(sessionID).length), others.slice(-24), 'Of the others, the 24 read last are held, beside the one being read.');
  assert.deepEqual(Object.keys(h.reader.read()).sort(), others.slice(-24).map(sessionID => `${sessionID}:notices`), 'What was let go is not marked as read.');
  // A notice the host reports for it meanwhile is kept too, and then the messages answer.
  h.reader.arrived(CONVERSATION, pendingItem('msg_3', `[AZPR ${COMMENT_RUN}] STARTED /pr-comment`));
  messages.resolve([toldMessage('msg_1', started(RUN, 'pr-review'))]);
  await done;
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id).sort(), ['msg_1', 'msg_2', 'msg_3'], 'The start, the receipt and what arrived: nothing of the read was lost.');
  assert.equal(h.reader.read()[`${CONVERSATION}:notices`], true);
  assert.deepEqual(others.filter(sessionID => h.reader.entries(sessionID).length), others.slice(-23), 'Its read has ended: it is one of the 24 read last now.');
  assert.deepEqual(buildPanel({ session: id => ({ id }), sessions: () => [], status: () => 'idle', messages: () => [], pending: id => h.reader.entries(id) }, CONVERSATION).status, 'RUNNING', 'The comment run that started last.');
  // Two reads of one session, one for its notices and one for a report: it is held until both have ended.
  const g = readerHost({ kept: 1 });
  const notices = g.reader.readInbox(V, 'notices', false), report = g.reader.readInbox(V, 'msg_receipt', true);
  await settle();
  const [first, second] = g.calls.filter(call => call.kind === 'inbox');
  second.resolve([pendingItem('msg_5', queuedReport())]);
  await report;
  assert.deepEqual([g.reader.read(), g.reader.entries(V).length], [{ [`${V}:msg_receipt`]: true }, 1]);
  // Another session is read to its end meanwhile. One session is kept: that one, beside the one being read.
  const other = g.reader.readInbox(F1, 'notices', false);
  await settle();
  g.last('inbox').resolve([pendingItem('msg_6', 'another')]);
  await settle();
  g.last('context').resolve([]);
  await other;
  assert.deepEqual([g.reader.entries(V).length, g.reader.entries(F1).length, g.reader.read()[`${F1}:notices`]], [1, 1, true]);
  first.resolve([pendingItem('msg_4', `[AZPR ${RUN}] COMPLETE`)]);
  await settle();
  g.calls.findLast(call => call.kind === 'context' && call.sessionID === V).resolve([]);
  await notices;
  assert.deepEqual([g.reader.entries(V).map(entry => entry.id).sort(), g.reader.read(), g.reader.entries(F1)], [['msg_4', 'msg_5'], { [`${V}:msg_receipt`]: true, [`${V}:notices`]: true }, []],
    'Both reads have ended: it is the one read last, and the other one was let go.');
});

test('what was read last stays held while other reads wait for their answers: the panel reads its conversation once', async () => {
  // As many reads as sessions are kept never get an answer.
  const h = readerHost();
  const slow = Array.from({ length: 24 }, (unused, index) => `ses_slow${String(index).padStart(2, '0')}`);
  for (const sessionID of slow) void h.reader.readInbox(sessionID, 'notices', false);
  await settle();
  // The review's own session is on screen. As the view does whenever the reader changed: work out the panel, and
  // ask for what it says is to be read.
  const session = privateSession(V, 'Verification', 'azpr-review-verifier');
  const source = { session: id => (id === V ? session : undefined), sessions: () => [session], status: () => 'idle', messages: () => [], pending: id => h.reader.entries(id) };
  const refresh = () => {
    const panel = buildPanel(source, V, { known: h.reader.known(), read: h.reader.read() });
    if (panel.notices) void h.reader.readInbox(panel.notices.sessionID, panel.notices.token, false);
    if (panel.inbox) void h.reader.readInbox(panel.inbox.sessionID, panel.inbox.token, true);
    return panel;
  };
  const requests = () => h.calls.filter(call => call.kind !== 'lookup').length;
  assert.deepEqual(refresh().notices, { sessionID: CONVERSATION, token: 'notices' });
  await settle();
  const report = '## PR Review Summary\n\nNo findings.';
  h.calls.findLast(call => call.kind === 'inbox' && call.sessionID === CONVERSATION).resolve([pendingItem('msg_2', reviewReceipt({ report }))]);
  await settle();
  h.calls.findLast(call => call.kind === 'context' && call.sessionID === CONVERSATION).resolve([toldMessage('msg_1', started(RUN, 'pr-review'))]);
  await settle();
  assert.equal(requests(), 26, 'The 24 reads that wait, and the conversation\'s inbox and messages.');
  for (let turn = 0; turn < 5; turn++) {
    const panel = refresh();
    await settle();
    assert.deepEqual([panel.run, panel.status, panel.markdown, panel.notices, panel.inbox], [RUN, 'COMPLETE', report, undefined, undefined], 'The document stays, and nothing more is to be read.');
  }
  assert.equal(requests(), 26, 'No request was made again.');
  assert.deepEqual([h.reader.entries(CONVERSATION).map(entry => entry.id), h.reader.read()], [['msg_1', 'msg_2'], { [`${CONVERSATION}:notices`]: true }]);
  // The same with one session kept and one read that waits: every session read to its end takes the place of the
  // one read before it, never of itself.
  const g = readerHost({ kept: 1 });
  void g.reader.readInbox(R1, 'notices', false);
  for (const sessionID of [F1, F2]) {
    const read = g.reader.readInbox(sessionID, 'notices', false);
    await settle();
    g.calls.findLast(call => call.kind === 'inbox' && call.sessionID === sessionID).resolve([pendingItem(`msg_${sessionID}`, sessionID)]);
    await settle();
    g.calls.findLast(call => call.kind === 'context' && call.sessionID === sessionID).resolve([]);
    await read;
    assert.deepEqual([g.reader.entries(sessionID).length, g.reader.read()], [1, { [`${sessionID}:notices`]: true }]);
  }
  assert.deepEqual(g.reader.entries(F1), []);
});

test('the reader asks the server for a conversation\'s sessions once, page by page, and stops when it is unloaded', async () => {
  const mine = id => privateSession(id, 'Initial R', 'azpr-review-risk');
  const theirs = { ...mine('ses_foreign000000000000000001'), metadata: { azpr: { run: RUN, role: 'azpr-review-risk', conversation: 'ses_someoneelse000000000000001' } } };
  const legacy = { id: 'ses_legacy0000000000000000001', title: `[AZPR ${RUN}] Verification`, parentID: CONVERSATION };
  const h = readerHost();
  const found = h.reader.discover(CONVERSATION);
  await h.reader.discover(CONVERSATION);
  await settle();
  assert.deepEqual(h.calls.map(call => [call.kind, call.sessionID]), [['list', undefined]], 'A conversation is asked for once.');
  h.calls[0].resolve({ data: [mine(F1), theirs, { id: CONVERSATION, title: 'My conversation' }], cursor: 'page-2' });
  await settle();
  assert.deepEqual(h.calls.slice(1).map(call => [call.kind, call.sessionID]).sort(), [['list', 'page-2'], ['lookup', F1]].sort(), 'Its own session is looked up; another conversation\'s is not.');
  h.calls.find(call => call.kind === 'list' && call.sessionID === 'page-2').resolve({ data: [legacy, mine(F2)] });
  await found; await settle();
  assert.deepEqual(h.calls.filter(call => call.kind === 'lookup').map(call => call.sessionID).sort(), [F1, F2, legacy.id].sort(), 'A session of 0.4.0 counts by its parent and title.');
  assert.equal(h.calls.filter(call => call.kind === 'list').length, 2, 'No cursor, no further page.');
  // At most five pages, however many the server offers.
  const many = readerHost();
  const long = many.reader.discover(CONVERSATION);
  for (let page = 1; page <= 5; page++) { await settle(); many.last('list').resolve({ data: [], cursor: `page-${page + 1}` }); }
  await long;
  assert.equal(many.calls.filter(call => call.kind === 'list').length, 5);
  // A list that could not be read is asked for again the next time.
  const failing = readerHost();
  const failed = failing.reader.discover(CONVERSATION);
  await settle(); failing.last('list').reject(networkError());
  await failed;
  void failing.reader.discover(CONVERSATION); await settle();
  assert.equal(failing.calls.filter(call => call.kind === 'list').length, 2);
  // Unloaded while a page is under way: its answer starts nothing.
  const unloading = readerHost();
  const pending = unloading.reader.discover(CONVERSATION);
  await settle();
  unloading.reader.dispose();
  unloading.last('list').resolve({ data: [mine(F1)], cursor: 'page-2' });
  await pending; await settle();
  assert.deepEqual(unloading.calls.map(call => call.kind), ['list'], 'No lookup and no further page after the plugin was unloaded.');
  await unloading.reader.discover('ses_another0000000000000000001');
  assert.equal(unloading.calls.length, 1);
  // A reconnection while a page is under way: the old answer starts nothing, and the conversation is asked for anew.
  const reconnecting = readerHost();
  const before = reconnecting.reader.discover(CONVERSATION);
  await settle();
  const stale = reconnecting.last('list');
  reconnecting.reader.reconnected();
  stale.resolve({ data: [mine(F1)], cursor: 'page-2' });
  await before; await settle();
  assert.deepEqual(reconnecting.calls.map(call => call.kind), ['list']);
  void reconnecting.reader.discover(CONVERSATION); await settle();
  assert.equal(reconnecting.calls.filter(call => call.kind === 'list').length, 2);
});

test('what the inbox answered is held when the messages cannot be read, and the read goes on', async () => {
  const h = readerHost();
  const done = h.reader.readInbox(CONVERSATION, 'notices', false);
  await settle();
  h.last('inbox').resolve([pendingItem('msg_1', `[AZPR ${RUN}] COMPLETE`)]);
  await settle();
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id), ['msg_1'], 'Held as soon as the inbox answered.');
  // The messages cannot be read: the receipt stays, and both are asked for again.
  h.last('context').reject(networkError());
  await settle();
  assert.deepEqual([h.reader.entries(CONVERSATION).map(entry => entry.id), h.reader.read()], [['msg_1'], {}]);
  h.last('inbox').resolve([pendingItem('msg_1', `[AZPR ${RUN}] COMPLETE`)]);
  await settle();
  h.last('context').resolve([toldMessage('msg_0', started(RUN, 'pr-review'))]);
  await done;
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id).sort(), ['msg_0', 'msg_1']);
  assert.deepEqual(h.reader.read(), { [`${CONVERSATION}:notices`]: true });
  // The messages never readable: after four attempts the read ends with what the inbox gave.
  const g = readerHost();
  const never = g.reader.readInbox(CONVERSATION, 'notices', false);
  for (let attempt = 0; attempt < 4; attempt++) { await settle(); g.last('inbox').resolve([pendingItem('msg_1', 'kept')]); await settle(); g.last('context').reject(networkError()); }
  await never;
  assert.deepEqual([g.reader.entries(CONVERSATION).map(entry => entry.id), g.reader.read()[`${CONVERSATION}:notices`], g.calls.filter(call => call.kind === 'inbox').length], [['msg_1'], true, 4]);
});

test('from the moment a session\'s notices are asked for, each one the host reports is kept, also when no request succeeds', async () => {
  const h = readerHost();
  const done = h.reader.readInbox(CONVERSATION, 'notices', false);
  h.reader.arrived(CONVERSATION, pendingItem('msg_1', started(RUN, 'pr-review')));
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id), ['msg_1'], 'Before any request was answered.');
  // Every request fails; the read ends.
  for (let attempt = 0; attempt < 4; attempt++) { await settle(); h.last('inbox').reject(networkError()); }
  await done;
  assert.equal(h.reader.read()[`${CONVERSATION}:notices`], true);
  // The receipt arrives afterwards: the panel in the review's session still follows its conversation.
  h.reader.arrived(CONVERSATION, pendingItem('msg_2', reviewReceipt()));
  assert.deepEqual(h.reader.entries(CONVERSATION).map(entry => entry.id), ['msg_1', 'msg_2']);
  const sessions = [privateSession(V, 'Verification', 'azpr-review-verifier')];
  const source = host({ sessions, inboxes: { [V]: [queuedReport()] } });
  const pending = source.pending;
  source.pending = id => [...pending(id), ...h.reader.entries(id)];
  const panel = buildPanel(source, V, { known: { [F1]: 'missing', [F2]: 'missing', [R1]: 'missing' }, read: h.reader.read() });
  assert.deepEqual([panel.run, panel.status, panel.markdown], [RUN, 'COMPLETE', queuedReport()]);
  // A session whose notices were never asked for is not followed.
  h.reader.arrived(F1, pendingItem('msg_3', 'elsewhere'));
  assert.deepEqual(h.reader.entries(F1), []);
});

test('a lookup that failed waits for its next attempt, however often the panel asks for the session meanwhile', async () => {
  const h = readerHost({ heldPauses: true });
  const first = h.reader.lookup(V);
  await settle();
  h.last('lookup').reject(networkError());
  await settle();
  assert.deepEqual([h.calls.length, h.pauses.map(wait => wait.ms)], [1, [1000]], 'One attempt, and a wait before the next.');
  // Other lookups end and notices arrive: each refreshes the panel, which asks for the session again.
  for (let refresh = 0; refresh < 10; refresh++) assert.equal(h.reader.lookup(V), first, 'The lookup that is waiting stands for the session.');
  await settle();
  assert.equal(h.calls.length, 1, 'No attempt was started or used up.');
  // The wait is over: the second attempt, and after its failure a longer wait.
  h.pauses[0].resolve();
  await settle();
  assert.equal(h.calls.length, 2);
  h.last('lookup').reject(networkError());
  await settle();
  assert.deepEqual(h.pauses.map(wait => wait.ms), [1000, 2000]);
  for (let refresh = 0; refresh < 10; refresh++) void h.reader.lookup(V);
  await settle();
  assert.equal(h.calls.length, 2);
  // The server is back for the third attempt.
  h.present.add(V);
  h.pauses[1].resolve();
  await settle();
  h.last('lookup').resolve();
  await first;
  assert.deepEqual([h.calls.length, h.reader.known()[V]], [3, 'exists']);
  // A reconnection during a wait: the waiting lookup is dropped, and a new one starts at once.
  void h.reader.lookup(F1); await settle();
  h.last('lookup').reject(networkError()); await settle();
  h.reader.reconnected();
  void h.reader.lookup(F1); await settle();
  assert.equal(h.calls.filter(call => call.sessionID === F1).length, 2);
  h.pauses.at(-1).resolve(); await settle();
  assert.equal(h.calls.filter(call => call.sessionID === F1).length, 2, 'The wait from before the reconnection starts nothing.');
});

/**
 * One random order of events against the reader. A small model of the server answers the reader's requests in
 * an order drawn from the seed; in between notices arrive and are delivered, sessions are deleted, waits end and
 * the server reconnects. After every step what the reader holds is compared with what it was told and with what
 * the server has. With `failures` a quarter of the requests fail on the way.
 */
async function interleaving(seed, { kept, failures }) {
  let state = seed * 7919 + 17;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = list => list[Math.floor(random() * list.length)];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const names = ['ses_a', 'ses_b', 'ses_c', 'ses_d', 'ses_e', 'ses_f'];
  const server = new Map(names.map(id => [id, { inbox: [], told: [], deleted: false }]));
  const requests = [], waits = [], reads = [], trace = [];
  let connection = 0, sequence = 0;
  const ask = kind => sessionID => { const request = { kind, sessionID, connection, ...deferred() }; requests.push(request); return request.promise; };
  // The host still holds a deleted session, and answers that were on their way, until the server reconnects.
  const reader = createReader({ inbox: ask('inbox'), context: ask('context'), lookup: ask('lookup'), list: ask('list'), present: id => !server.get(id).deleted || Boolean(server.get(id).before),
    pause: () => { const wait = deferred(); waits.push(wait); return wait.promise; }, kept });
  // What the reader was told of a session since the read that holds it began: the answers to its requests and
  // the notices the host reported. And the sessions the reader knows to be gone.
  const told = new Map(names.map(id => [id, new Set()])), gone = new Set();
  const busy = id => reads.some(read => read.sessionID === id && !read.ended && read.connection === connection);
  const marked = id => Object.keys(reader.read()).some(key => key.startsWith(`${id}:`));
  const where = () => `seed ${seed}, ${kept} kept${failures ? ', failing requests' : ''}; last: ${trace.slice(-14).join(' | ')}`;
  const check = () => {
    for (const id of names) {
      if (reader.known()[id] === 'missing') gone.add(id);
      const held = reader.entries(id).map(entry => entry.id), truth = server.get(id);
      assert.equal(new Set(held).size, held.length, `Each notice once (${id}). ${where()}`);
      if (gone.has(id)) {
        assert.deepEqual([held, marked(id), reader.known()[id]], [[], false, 'missing'], `Gone stays gone (${id}). ${where()}`);
        continue;
      }
      if (truth.deleted) continue;
      const notices = [...truth.inbox, ...truth.told].filter(item => item.type === 'synthetic');
      assert.deepEqual(held.filter(entry => !notices.some(item => item.id === entry)), [], `Only what the server has (${id}). ${where()}`);
      if (!busy(id) && !marked(id)) { told.get(id).clear(); continue; }
      assert.deepEqual([...told.get(id)].filter(entry => !held.includes(entry)), [], `While ${id} is read or marked as read, all the reader was told of it is held. ${where()}`);
      // No request failed on the way: a session whose notices are marked as read is held whole, and a report
      // that exists was found.
      if (failures) continue;
      if (reader.read()[`${id}:notices`]) assert.deepEqual(notices.map(item => item.id).filter(entry => !held.includes(entry)), [], `Every notice of ${id}. ${where()}`);
      if (reader.read()[`${id}:report`] && notices.some(item => (item.payload?.text ?? item.text).startsWith('# AZPR '))) assert.ok(reportIn(syntheticOf(reader.entries(id), [])), `The report of ${id}. ${where()}`);
    }
  };
  const steps = {
    read() {
      const sessionID = pick(names), report = random() < 0.4, key = `${sessionID}:${report ? 'report' : 'notices'}`;
      trace.push(`read ${key}`);
      if (!busy(sessionID) && !marked(sessionID)) told.get(sessionID).clear();
      // A read of its own, not one that joins a read under way or finds its session read or gone already.
      const own = !reader.read()[key] && !reads.some(read => read.key === key && !read.ended && read.connection === connection) && !gone.has(sessionID);
      const read = { key, sessionID, connection, own, ended: false };
      reads.push(read);
      void reader.readInbox(sessionID, report ? 'report' : 'notices', report).then(() => { read.ended = true; });
    },
    lookup() {
      const sessionID = pick(names);
      trace.push(`lookup ${sessionID}`);
      void reader.lookup(sessionID);
    },
    answer() {
      if (!requests.length) return;
      const [request] = requests.splice(Math.floor(random() * requests.length), 1), truth = server.get(request.sessionID);
      if (request.kind === 'list') return request.resolve({ data: [] });
      // Of a deleted session the server says so, or an answer it gave before the deletion is still on its way.
      if (truth.deleted && (!truth.before || random() < 0.5)) {
        trace.push(`${request.kind} ${request.sessionID}: not found`);
        return request.kind === 'lookup' && random() < 0.5 ? request.resolve(undefined) : request.reject(goneError());
      }
      if (failures && random() < 0.25) {
        trace.push(`${request.kind} ${request.sessionID}: failed`);
        return request.reject(networkError());
      }
      trace.push(`${request.kind} ${request.sessionID}: answered`);
      if (request.kind === 'lookup') return request.resolve({ id: request.sessionID });
      const from = truth.deleted ? truth.before : truth;
      const answer = (request.kind === 'inbox' ? from.inbox : from.told).map(item => ({ ...item }));
      if (!truth.deleted && request.connection === connection && !gone.has(request.sessionID)) for (const item of answer) if (item.type === 'synthetic') told.get(request.sessionID).add(item.id);
      request.resolve(request.kind === 'inbox' ? { data: answer } : answer);
    },
    notice() {
      const sessionID = pick(names), truth = server.get(sessionID);
      if (truth.deleted) return;
      const id = `msg_${String(++sequence).padStart(6, '0')}`;
      const item = pendingItem(id, random() < 0.3 ? queuedReport(RUN, `report ${sequence}`) : progress(RUN, `step ${sequence}`));
      truth.inbox.push(item);
      trace.push(`notice ${sessionID} ${id}`);
      if (busy(sessionID) || marked(sessionID)) told.get(sessionID).add(id);
      reader.arrived(sessionID, { ...item });
    },
    deliver() {
      const sessionID = pick(names), truth = server.get(sessionID);
      if (truth.deleted || !truth.inbox.length) return;
      trace.push(`deliver ${sessionID}`);
      truth.told.push(...truth.inbox.map(item => toldMessage(item.id, item.payload.text)), { id: `msg_${String(++sequence).padStart(6, '0')}`, type: 'assistant', text: 'an answer' });
      truth.inbox = [];
    },
    remove() {
      const sessionID = pick(names), truth = server.get(sessionID);
      if (truth.deleted) return;
      trace.push(`delete ${sessionID}`);
      Object.assign(truth, { deleted: true, before: { inbox: truth.inbox, told: truth.told }, inbox: [], told: [] });
      gone.add(sessionID);
      told.get(sessionID).clear();
      reader.deleted(sessionID);
    },
    reconnect() {
      trace.push('reconnect');
      // What happened while the connection was down was not reported.
      for (let missed = Math.floor(random() * 3); missed > 0; missed--) {
        const truth = server.get(pick(names));
        if (!truth.deleted) truth.inbox.push(pendingItem(`msg_${String(++sequence).padStart(6, '0')}`, progress(RUN, `missed ${sequence}`)));
      }
      connection++;
      gone.clear();
      for (const ids of told.values()) ids.clear();
      // What the server answered before a deletion is not on its way any more.
      for (const truth of server.values()) delete truth.before;
      reader.reconnected();
    },
    resume() {
      if (!waits.length) return;
      trace.push('a wait ends');
      waits.splice(Math.floor(random() * waits.length), 1)[0].resolve();
    },
  };
  const weights = [['read', 22], ['answer', 34], ['notice', 14], ['deliver', 8], ['resume', 12], ['lookup', 4], ['remove', 2], ['reconnect', 2]];
  for (let step = 0; step < 160; step++) {
    let at = random() * 98;
    const open = reads.filter(read => !read.ended);
    steps[weights.find(([, weight]) => (at -= weight) < 0)?.[0] ?? 'answer']();
    await flush();
    check();
    // A read that ended in this step is marked as read, so that the panel does not ask for it again: also when
    // more sessions are being read than are kept. Not one of a session that is gone, nor one from before a reconnection.
    for (const read of open) if (read.ended && read.own && read.connection === connection && !gone.has(read.sessionID) && !server.get(read.sessionID).deleted) assert.equal(reader.read()[read.key], true, `A read that ended is marked (${read.key}). ${where()}`);
  }
  // Everything still asked is answered and every wait ends: then every read has ended.
  for (let round = 0; round < 200 && (requests.length || waits.length); round++) {
    while (requests.length) steps.answer();
    while (waits.length) waits.pop().resolve();
    await flush();
    check();
  }
  assert.deepEqual([requests.length, waits.length, reads.filter(read => !read.ended).length], [0, 0, 0], `Every read ends. ${where()}`);
}

test('whatever the order of answers, notices, deletions and reconnections, the reader holds what it was told', async () => {
  for (const failures of [false, true]) for (const kept of [1, 2, 3]) for (let seed = 1; seed <= 40; seed++) await interleaving(seed, { kept, failures });
});
