/**
 * What AZPR's terminal panel shows, worked out from what AZPR itself sent: the
 * notices in a conversation, the report queued to a review session, and the
 * sessions' `metadata.azpr`. Nothing here imports OpenTUI or the host: the view
 * (tui-view.jsx, compiled to tui.js) hands it plain data, and so do the tests.
 *
 * The panel never sends a prompt, never reads AZPR's settings and never decides
 * anything about a review. It only reads texts whose form the runtime owns
 * (attribution.mjs, runtime.mjs); tests/tui-model.test.mjs holds that form.
 */

/** The panel's name in the host's `session.panel` slot; names are shared between plugins. */
export const PANEL = 'azpr.panel';

const SESSION = 'ses_[A-Za-z0-9]+';
// `[AZPR <run>] STATUS…` for a run's notices; `[AZPR] …` for a command that answered at once.
const HEAD = /^\[AZPR(?: ([a-f0-9]{8}))?\] ?(?:([A-Z_]+)\b)?/;
const STAGE = new RegExp(`^- (azpr-[a-z-]+)(?: \\[([^\\]]+)\\])?: ([A-Z_]+); session=(${SESSION})`, 'gm');
const DATA = /<(azpr_(?:report|comment)_data)>\n([\s\S]*?)\n<\/\1>/;
const REPORT_SESSION = new RegExp(`Report delivery: report queued to session=(${SESSION})\\.`);
// A comment run names the review it acts on: in its STARTED notice and in the head of its receipt.
const ACTS_ON = / It acts on review ([a-f0-9]{8}) /;
const SOURCE_REVIEW = /; source review=([a-f0-9]{8})/;
const RUN_STARTED = /^\[AZPR [a-f0-9]{8}\] STARTED \/pr-(?:review|quick|deep|comment)\b/;
const REPORT_HEAD = '# AZPR ';

/** The text of a delivered message, or of a notice that still waits in a session's inbox. */
export const textOf = entry =>
  typeof entry?.text === 'string' ? entry.text : typeof entry?.payload?.text === 'string' ? entry.payload.text : typeof entry?.description === 'string' ? entry.description : '';

/**
 * A session's synthetic entries, oldest first: delivered messages and what its
 * inbox still holds. AZPR queues its notices without waking the session, so
 * most of them are in the inbox; the host shows both as messages for the
 * session on screen, and only the inbox for others once it was read.
 */
export function syntheticOf(messages, pending) {
  const entries = new Map();
  for (const entry of [...(messages ?? []), ...(pending ?? [])]) {
    if (entry?.type === 'synthetic' && typeof entry.id === 'string') entries.set(entry.id, textOf(entry));
  }
  // Message and inbox IDs sort by creation time.
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, text]) => ({ id, text }));
}

/** AZPR's notices among a session's synthetic entries. */
export function noticesOf(entries) {
  return entries.flatMap(({ id, text }) => {
    const head = HEAD.exec(text);
    if (!head) return [];
    const [, run, status = ''] = head;
    const kind = !run ? 'ANSWER' : status === 'STARTED' ? 'STARTED' : status === 'PROGRESS' ? 'PROGRESS' : 'RECEIPT';
    return [{ id, run, kind, status, text }];
  });
}

/** The report AZPR queued to a review session, or '' when these entries hold none. */
export const reportIn = entries => entries.map(entry => entry.text).findLast(text => text.startsWith(REPORT_HEAD)) ?? '';

/**
 * A notice that opens the panel by itself in the session on screen: a review or
 * comment run that starts, and a report or preview that arrives. Progress
 * notices and commands without a document, such as /pr-check, do not.
 */
export const opensPanel = text =>
  typeof text === 'string' && (RUN_STARTED.test(text) || (HEAD.test(text) && (DATA.test(text) || REPORT_SESSION.test(text))));

/**
 * The same Markdown, made readable in a terminal. AZPR writes table cells with
 * numeric character references so that Azure DevOps shows their characters
 * literally, and marks its comments with HTML comments that Azure DevOps hides.
 * The terminal renderer decodes neither: show the characters, escaped where
 * Markdown would read them as markup, and leave the markers out.
 */
export const readable = markdown =>
  String(markdown ?? '')
    .replace(/^<!-- azpr-comment:[a-f0-9]{32} -->\n?/gm, '')
    .replace(/&#(\d{2,3});/g, (reference, code) => {
      const character = String.fromCharCode(Number(code));
      if (character === '`' || character === '_' || character === '&') return character;
      return /[|*[\]\\<>]/.test(character) ? `\\${character}` : reference;
    });

const short = title => String(title).replace(/^\[AZPR [a-f0-9]{8}\] /, '');

/**
 * What the panel shows for the session on screen.
 *
 * `source` reads the host's data as the TUI has it loaded:
 *   session(id) → { id, title, metadata, … } | undefined, sessions() → those the TUI knows,
 *   status(id) → 'running' | 'idle', messages(id) and pending(id) → entries of that session.
 * `known` says which sessions were looked up and are gone ('missing'); `read`
 * names the inboxes read so far, as `<session>:<notice that named it>`;
 * `titles` keeps the names of sessions seen while they existed.
 *
 * The result lists in `needs` the sessions to load before more can be shown,
 * and in `inbox` the report session whose inbox holds the document.
 */
export function buildPanel(source, sessionID, { known = {}, read = {}, titles = new Map() } = {}) {
  const needs = new Set();
  const entriesOf = id => syntheticOf(source.messages(id), source.pending(id));
  const self = source.session(sessionID);
  // In one of AZPR's own sessions the notices are in the conversation that started the run.
  const conversation = self?.metadata?.azpr?.conversation ?? sessionID;
  if (conversation !== sessionID && !source.session(conversation) && known[conversation] !== 'missing') needs.add(conversation);
  const notices = noticesOf(entriesOf(conversation));
  const run = notices.findLast(notice => notice.run)?.run;
  const begins = notices.findIndex(notice => notice.run === run);
  const ofRun = notices.filter(notice => notice.run === run);
  const receipt = ofRun.findLast(notice => notice.kind === 'RECEIPT');
  const progress = ofRun.findLast(notice => notice.kind === 'PROGRESS');
  const status = receipt ? receipt.status : run ? 'RUNNING' : '';
  // A comment run belongs with the review it acts on: that review's sessions and report stay in view.
  // Any other run stands alone, so a review under way never shows the report of the review before it.
  const reviewRun = SOURCE_REVIEW.exec(receipt?.text.split('\n')[0] ?? '')?.[1] ?? ACTS_ON.exec(ofRun.find(notice => notice.kind === 'STARTED')?.text ?? '')?.[1] ?? run;
  const review = reviewRun === run ? receipt : notices.findLast(notice => notice.kind === 'RECEIPT' && notice.run === reviewRun);
  const reportSession = REPORT_SESSION.exec(review?.text ?? '')?.[1];

  // The document is the newest report or preview of these runs, or of a command that answered at once after
  // them (--show): enclosed in the notice, or queued to the review's report session.
  let document;
  notices.forEach((notice, index) => {
    const ours = notice.kind === 'RECEIPT' ? notice.run === run || notice.run === reviewRun : notice.kind === 'ANSWER' && index > begins;
    if (!ours) return;
    const head = notice.text.split('\n')[0];
    const enclosed = DATA.exec(notice.text);
    const queued = REPORT_SESSION.exec(notice.text)?.[1];
    if (enclosed) document = { head, markdown: enclosed[2], token: notice.id };
    else if (queued) document = { head, session: queued, token: notice.id };
  });
  const own = conversation === sessionID ? '' : reportIn(entriesOf(sessionID));
  const markdown = readable(own || (document?.markdown ?? (document?.session ? reportIn(entriesOf(document.session)) : '')));
  // A queued report waits in its session's inbox, which the host loads only for the session on screen.
  const inbox = !markdown && document?.session && known[document.session] !== 'missing' ? { sessionID: document.session, token: document.token } : undefined;
  const loading = inbox !== undefined && !read[`${inbox.sessionID}:${inbox.token}`];

  // Candidates: what the host lists for these runs, what their receipts name, and the report session.
  const stages = new Map();
  for (const notice of new Set([review, receipt])) {
    if (notice) for (const [, role, label, state, id] of notice.text.matchAll(STAGE)) stages.set(id, { role, label, state });
  }
  const runs = new Set([run, reviewRun]);
  const candidates = new Set(stages.keys());
  if (reportSession) candidates.add(reportSession);
  for (const session of source.sessions()) {
    const azpr = session?.metadata?.azpr;
    if (azpr?.conversation === conversation && azpr.run !== undefined && runs.has(azpr.run)) candidates.add(session.id);
  }
  const rows = [];
  let deleted = 0;
  for (const id of candidates) {
    const info = source.session(id);
    if (!info) {
      // A finished run names every stage in its receipt; what was deleted since is counted, not listed.
      if (known[id] === 'missing') deleted += stages.has(id) ? 1 : 0;
      else needs.add(id);
      continue;
    }
    if (info.title) titles.set(id, short(info.title));
    const stage = stages.get(id);
    rows.push({
      id,
      label: titles.get(id) ?? (stage ? `${stage.role}${stage.label ? ` ${stage.label}` : ''}` : info.metadata?.azpr?.role ?? id),
      state: source.status(id) === 'running' ? 'running' : stage ? stage.state.toLowerCase() : 'idle',
      report: id === reportSession,
      current: info.metadata?.azpr?.run === run,
    });
  }
  // The report first, then the run under way or last ended, then by name ("shard 2/12" before "shard 10/12").
  rows.sort((a, b) => Number(b.report) - Number(a.report) || Number(b.current) - Number(a.current) || a.label.localeCompare(b.label, 'en', { numeric: true }));
  return {
    conversation,
    run,
    status,
    progress: status === 'RUNNING' ? progress?.text.replace(/^\[AZPR [a-f0-9]{8}\] PROGRESS — /, '') : undefined,
    rows,
    deleted,
    markdown,
    documentHead: own ? '' : document?.head ?? '',
    inbox,
    loading,
    needs: [...needs],
  };
}
