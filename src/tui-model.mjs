/**
 * What AZPR's terminal panel shows, worked out from what AZPR itself sent: the
 * notices in a conversation, the report queued to a review session, and the
 * sessions' `metadata.azpr`. Nothing here imports OpenTUI or the host: the view
 * (tui-view.jsx, compiled to tui.js) hands it plain data, and so do the tests.
 *
 * The panel never sends a prompt, never reads AZPR's settings file and never
 * decides anything about a review. It only reads texts whose form the runtime
 * owns (attribution.mjs, runtime.mjs) and the one setting meant for it, which
 * the runtime sends along with its notices; tests/tui-model.test.mjs holds
 * that form.
 */

/** The panel's name in the host's `session.panel` slot; names are shared between plugins. */
export const PANEL = 'azpr.panel';

const SESSION = 'ses_[A-Za-z0-9]+';
// `[AZPR <run>] STATUS…` for a run's notices; `[AZPR] …` for a command that answered at once.
const HEAD = /^\[AZPR(?: ([a-f0-9]{8}))?\] ?(?:([A-Z_]+)\b)?/;
const STAGE = new RegExp(`^- (azpr-[a-z-]+)(?: \\[([^\\]]+)\\])?: ([A-Z_]+); session=(${SESSION})`, 'gm');
// The block of a notice that encloses a document: its name (report or comment) and its text.
const DATA = /<azpr_(report|comment)_data>\n([\s\S]*?)\n<\/azpr_\1_data>/;
const REPORT_SESSION = new RegExp(`Report delivery: report queued to session=(${SESSION})\\.`);
// A comment run names the review it acts on: in its STARTED notice and in the head of its receipt.
const ACTS_ON = / It acts on review ([a-f0-9]{8}) /;
const SOURCE_REVIEW = /; source review=([a-f0-9]{8})/;
const RUN_STARTED = /^\[AZPR [a-f0-9]{8}\] STARTED \/pr-(?:review|quick|deep|comment)\b/;
// A run's receipt: its status, then `;`, a line break or the end. Text follows STARTED and PROGRESS, and a run
// also says things that are neither (`[AZPR <run>] Automatic preview skipped: …`).
const RECEIPT = /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/;
const REPORT_HEAD = '# AZPR ';
// `/pr-comment [review] --show` answers at once with a review's saved preview, and names the review.
const SAVED_PREVIEW = /^\[AZPR\] Saved preview of review ([a-f0-9]{8})\b/;
// The summary table of a report or preview, whose cells the runtime writes with numeric character references.
const SUMMARY_TABLE = /^\| Severity \| Summary \| [^|\n]+ \|$/;
const MARKER = /^<!-- azpr-comment:[a-f0-9]{32} -->$/;
// The opening line of a fenced code block: backticks with no further backtick on the line, or tildes.
const FENCE = /^ {0,3}(?:(`{3,})(?!.*`)|(~{3,}))/;

/**
 * What the runtime itself wrote in a notice: everything before the report or preview it encloses.
 * The stage lines and the report session are facts only there; the enclosed text is a model's, and a
 * line in it that looks like one of them is just text.
 */
const ledgerOf = text => text.split(/^<azpr_(?:report|comment)_data>$/m)[0];

/**
 * A block's text as it was before the runtime enclosed it. The runtime writes the block's own closing tag
 * as `&lt;/azpr_NAME_data&gt;` and gives text that already had that form one more level of `&amp;` (see
 * `enclose` in attribution.mjs): one level is taken off here, and nothing else is changed. A finding that
 * quotes the tag is then shown as publication posts it.
 */
export function disclose(name, text) {
  const tag = `/azpr_${name}_data`;
  return text.replace(new RegExp(`&((?:amp;)*)lt;${tag}&((?:amp;)*)gt;`, 'g'), (found, left, right) =>
    (left === '' && right === '' ? `<${tag}>` : left && right ? `&${left.slice(4)}lt;${tag}&${right.slice(4)}gt;` : found));
}

/**
 * The block of a notice that encloses a report or preview, or undefined: also for an empty block, which the
 * receipt of a comment run carries when the run failed or was stopped before it had a preview.
 */
const blockIn = text => {
  const found = DATA.exec(text);
  return found?.[2].trim() ? found : undefined;
};
const encloses = text => blockIn(text) !== undefined;
/** The report or preview a notice encloses, as it was written, or undefined. */
const enclosedIn = text => {
  const found = blockIn(text);
  return found && disclose(found[1], found[2]);
};

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
    // NOTE: something a run says besides its start, its progress and its receipt; it changes nothing shown.
    const kind = !run ? 'ANSWER' : status === 'STARTED' ? 'STARTED' : status === 'PROGRESS' ? 'PROGRESS' : RECEIPT.test(text) ? 'RECEIPT' : 'NOTE';
    return [{ id, run, kind, status: kind === 'NOTE' ? '' : status, text }];
  });
}

/** The report AZPR queued to a review session, or '' when these entries hold none. */
export const reportIn = entries => entries.map(entry => entry.text).findLast(text => text.startsWith(REPORT_HEAD)) ?? '';

/**
 * A notice that opens the panel by itself in the session on screen: a review or
 * comment run that starts, and a document that arrives: a report, a preview,
 * the table of /pr-check. Progress notices and answers without a document do
 * not, and no notice does with the setting terminalPanel: manual, which the
 * runtime writes into the metadata of every notice it sends (`azpr.panel`).
 */
export const opensPanel = (text, metadata) =>
  typeof text === 'string' && metadata?.azpr?.panel !== 'manual' &&
  (RUN_STARTED.test(text) || (HEAD.test(text) && (encloses(text) || REPORT_SESSION.test(ledgerOf(text)))));

/**
 * The same Markdown, made readable in a terminal. AZPR writes the cells of its
 * summary table with numeric character references so that Azure DevOps shows
 * their characters literally, and marks its comments with HTML comments that
 * Azure DevOps hides. The terminal renderer decodes neither: in that table,
 * show each such character, escaped so that Markdown reads none of them as
 * markup (a file named `__init__.py` keeps its underscores, a backtick stays
 * a backtick, as on the PR), and leave the marker lines out.
 *
 * Only those two things change, and only where the runtime wrote them: a marker
 * that stands alone between blank lines, and a table that begins after a blank
 * line with the summary's header and its delimiter row. A reference or a marker
 * that a finding quotes, in a code block, in a code span that runs over several
 * lines or anywhere else, is its text: the preview shown must be the preview
 * that publication posts.
 */
export function readable(markdown) {
  const lines = String(markdown ?? '').split('\n'), shown = [];
  const blank = index => index < 0 || index >= lines.length || lines[index].trim() === '';
  let fence = null, table = false;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      // A fence ends with at least as many of its own characters and nothing else.
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      shown.push(line);
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) { fence = opened[1] ?? opened[2]; table = false; shown.push(line); continue; }
    // The runtime puts each marker in a paragraph of its own. A line of a longer paragraph may be inside a code
    // span, which can run over several lines but never over a blank one.
    if (MARKER.test(line) && blank(index - 1) && blank(index + 1)) continue;
    if (SUMMARY_TABLE.test(line) && blank(index - 1) && /^\|(?: --- \|)+$/.test(lines[index + 1] ?? '')) { table = true; shown.push(line); continue; }
    table &&= line.startsWith('|');
    // The characters the runtime writes as references (see `cell` in renderReviewSummary), each one literal.
    shown.push(!table ? line : line.replace(/&#(\d{2,3});/g, (reference, code) => {
      const character = String.fromCharCode(Number(code));
      return /[&<>|`*_[\]\\]/.test(character) ? `\\${character}` : reference;
    }));
  }
  return shown.join('\n');
}

/** Whether a failed request says that the session is not there, as opposed to a request that did not get through. */
export const notFound = error => /NotFound|\b404\b/.test(String(error?.name ?? '') + String(error?._tag ?? '') + String(error));

/**
 * What looking a session up established, from the lookup's outcome (as
 * `Promise.allSettled` gives it) and whether the host has the session now:
 * 'exists'; 'missing', only when the server said so, by a not-found answer or
 * a lookup that succeeded and found nothing; otherwise 'retry', since a request
 * that failed says nothing about the session, and the host not having a session
 * loaded is the usual case. The lookup reads the session itself, never what the
 * session holds: whose it is must be known before anything of it is read.
 */
export function lookupOutcome(looked, present) {
  if (looked.status === 'rejected') return notFound(looked.reason) ? 'missing' : 'retry';
  return present ? 'exists' : 'missing';
}

/**
 * What the panel reads of sessions other than the one on screen, and when. It is kept apart from the
 * view so that the order of its requests and their races are tested with delayed answers.
 *
 * The host is asked through the functions given:
 *   inbox(sessionID)   → what waits in that session's inbox (an array, or `{ data }`)
 *   context(sessionID) → that session's messages since the last compaction; optional
 *   lookup(sessionID)  → load the session itself into the host (nothing it holds)
 *   present(sessionID) → whether the host has the session now
 *   list(cursor)       → a page of the server's sessions, `{ data, cursor }`; optional
 *   changed()          → called whenever what the reader holds has changed
 *   pause(ms)          → a wait between attempts
 *
 * The rules it keeps:
 * - A session is looked up before anything it holds is read; the model decides from the session's own
 *   metadata whose it is, and only then names its inbox (see buildPanel).
 * - A session counts as gone only when the server said so (lookupOutcome, notFound), and then it stays
 *   gone until the server reconnects: a lookup that was under way and answers later, from what the host
 *   still holds, does not bring it back.
 * - From the moment a session's notices are asked for, every notice the host reports for it is kept,
 *   whatever becomes of the requests: while they are under way, after they failed, and afterwards.
 * - An inbox is read before the messages: a notice that is delivered between the two reads was still in
 *   the inbox for the first. What the inbox answered is kept also when the messages cannot be read.
 * - A request that failed is made again a few times; then it is left until the server reconnects. One
 *   lookup of a session is under way or waiting for its next attempt at a time, however often it is asked for.
 * - What was asked before a reconnection is out of date when it answers: it is dropped and nothing is
 *   marked as read by it, since notices were missed while the TUI was away.
 * - The entries of the `kept` sessions read last are held; one that was let go is read again when needed.
 *   A session is not let go while a read of it is under way, so more are held for as long as reads last.
 */
export function createReader({ inbox, context, lookup, present, list, changed = () => {}, pause = ms => new Promise(done => setTimeout(done, ms)), kept = 24 }) {
  let connection = 0, disposed = false;
  let known = {}, read = {};
  const fetched = new Map();    // session → entries read from the server or reported since; the session read last comes last
  const failed = new Map();     // session → lookups that failed without an answer about the session
  const looking = new Map();    // session → its lookup under way, or the wait for its next attempt
  const reading = new Set();    // `<session>:<token>` reads under way
  const discovered = new Set(); // conversations whose sessions were asked for from the server
  const listOf = result => (Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []);
  const gone = sessionID => known[sessionID] === 'missing';
  /** Let go of what was read of a session, and of the marks that it was read. */
  const forget = sessionID => {
    fetched.delete(sessionID);
    read = Object.fromEntries(Object.entries(read).filter(([key]) => !key.startsWith(`${sessionID}:`)));
  };
  const mark = (sessionID, value) => {
    // Gone stays gone: nothing that answers later says otherwise.
    if (known[sessionID] === value || gone(sessionID)) return;
    known = { ...known, [sessionID]: value };
    if (value === 'missing') forget(sessionID);
    changed();
  };
  const beingRead = sessionID => { for (const key of reading) if (key.startsWith(`${sessionID}:`)) return true; return false; };
  /**
   * Let go of the sessions read longest ago when more are held than are kept, but of none while a read of it
   * is under way: what a read's requests answer one after the other belongs together, and so does what the
   * host reports meanwhile. Let go in between, a session would be held again with the later answer alone, and
   * its read would end as if it had read everything.
   */
  const letGo = () => {
    let over = fetched.size - kept;
    for (const id of [...fetched.keys()]) {
      if (over <= 0) break;
      if (beingRead(id)) continue;
      forget(id);
      over--;
    }
  };
  const keep = (sessionID, entries) => {
    fetched.delete(sessionID);
    fetched.set(sessionID, entries);
    letGo();
    changed();
  };

  /**
   * Read a session's notices into what is held of it: its inbox and, with `delivered`, its messages.
   * Throws when a request failed; what the other one answered is held all the same.
   */
  async function fetchEntries(sessionID, delivered) {
    const asked = connection;
    const stale = () => asked !== connection || disposed || gone(sessionID);
    if (stale()) return;
    const pending = await inbox(sessionID);
    if (stale()) return;
    // With what is held of this session already: what was read before, and what the host reported meanwhile.
    keep(sessionID, mergeEntries(fetched.get(sessionID) ?? [], listOf(pending)));
    if (!delivered || !context) return;
    const told = await context(sessionID);
    if (stale()) return;
    keep(sessionID, mergeEntries(listOf(told).filter(entry => entry?.type === 'synthetic'), fetched.get(sessionID) ?? []));
  }

  /** Look a session up: one lookup, or the wait for its next attempt, at a time. */
  function lookupSession(sessionID) {
    if (disposed || gone(sessionID) || failed.get(sessionID) >= 4) return Promise.resolve();
    const running = looking.get(sessionID);
    if (running) return running;
    const asked = connection;
    const started = (async () => {
      const [looked] = await Promise.allSettled([Promise.resolve().then(() => lookup(sessionID))]);
      if (asked !== connection || disposed) return;
      const outcome = lookupOutcome(looked, Boolean(present(sessionID)));
      if (outcome !== 'retry') {
        failed.delete(sessionID);
        looking.delete(sessionID);
        return mark(sessionID, outcome);
      }
      const count = (failed.get(sessionID) ?? 0) + 1;
      failed.set(sessionID, count);
      if (count >= 4) return void looking.delete(sessionID);
      // Again, further apart. Until then this lookup stands for the session: asking for it again, as the panel
      // does whenever anything changes, neither shortens the wait nor uses up an attempt.
      await pause(500 * 2 ** count);
      if (asked !== connection || disposed) return;
      looking.delete(sessionID);
      return lookupSession(sessionID);
    })();
    looking.set(sessionID, started);
    return started;
  }

  /**
   * Read the inbox of a session the model named: the one that holds a report (`report`: a report that is
   * not there after a moment is not coming; it is among the messages when someone prompted that session
   * since), or a conversation's, for its notices, pending and delivered.
   */
  function readInbox(sessionID, token, report) {
    const key = `${sessionID}:${token}`;
    if (disposed || gone(sessionID) || read[key] || reading.has(key)) return Promise.resolve();
    reading.add(key);
    // Held from now on, also while it is empty: every notice the host reports for this session is kept.
    if (!fetched.has(sessionID)) keep(sessionID, []);
    const asked = connection;
    const attempt = async (left, delivered) => {
      try {
        await fetchEntries(sessionID, delivered);
        if (asked !== connection) return;
        if (!report || reportIn(syntheticOf(fetched.get(sessionID) ?? [], []))) return;
      } catch (error) {
        if (asked !== connection) return;
        if (notFound(error)) return mark(sessionID, 'missing');
      }
      // A session that was deleted meanwhile has nothing more to read.
      if (left <= 1 || disposed || gone(sessionID)) return;
      await pause(400);
      if (asked !== connection) return;
      return attempt(left - 1, true);
    };
    return attempt(4, !report).finally(() => {
      // A read from before a reconnection says nothing about now: the reconnection started everything anew.
      if (asked !== connection) return;
      reading.delete(key);
      // Marked as read while its session is held: not one that is gone, which has nothing more to read.
      if (fetched.has(sessionID) && !gone(sessionID)) read = { ...read, [key]: true };
      // From now on its session may be let go, when many reads ended together: with this mark, so that it is
      // read again when the panel needs it.
      letGo();
      changed();
    });
  }

  /**
   * Ask the server for the sessions of a conversation, once per conversation and connection: after a restart of
   * the TUI the host has not loaded a run's sessions. Each one that says itself that it is the conversation's is
   * looked up. At most five pages are read.
   */
  function discover(conversation) {
    if (disposed || !list || discovered.has(conversation)) return Promise.resolve();
    discovered.add(conversation);
    const asked = connection;
    const page = async (cursor, left) => {
      const result = await list(cursor);
      if (asked !== connection || disposed) return;
      for (const session of listOf(result)) if (conversationOf(session) === conversation && typeof session.id === 'string') void lookupSession(session.id);
      if (result?.cursor && result.cursor !== cursor && left > 1) return page(result.cursor, left - 1);
    };
    // A list that could not be read is asked for again the next time the panel is shown.
    return page(undefined, 5).catch(() => { if (asked === connection) discovered.delete(conversation); });
  }

  return {
    /** What is held of a session: read from the server or reported since; [] for one that was not read or was let go. */
    entries: sessionID => fetched.get(sessionID) ?? [],
    /** Sessions looked up: 'exists' or 'missing'. */
    known: () => known,
    /** Reads that ended, as `<session>:<token>`. */
    read: () => read,
    lookup: lookupSession,
    readInbox,
    discover,

    /** A notice the host reported for a session: kept when that session's notices were asked for. */
    arrived(sessionID, item) {
      if (disposed || item?.type !== 'synthetic' || typeof item.id !== 'string') return;
      const held = fetched.get(sessionID);
      if (held && !held.some(entry => entry.id === item.id)) keep(sessionID, [...held, item]);
    },

    /** The server said that a session was deleted. */
    deleted(sessionID) {
      if (typeof sessionID === 'string') mark(sessionID, 'missing');
    },

    /** The server is connected again: what was missed meanwhile is read anew, and nothing asked before counts. */
    reconnected() {
      connection++;
      failed.clear();
      looking.clear();
      reading.clear();
      discovered.clear();
      fetched.clear();
      known = {};
      read = {};
      changed();
    },

    /** The TUI unloads the plugin: nothing is asked of the host after this. */
    dispose() {
      disposed = true;
    },
  };
}

const TITLE = /^\[AZPR ([a-f0-9]{8})\] /;
const short = title => String(title).replace(TITLE, '');

/**
 * The conversation one of AZPR's own sessions belongs to, by what the session itself says: AZPR's
 * metadata, or, for a session AZPR 0.4.0 or earlier created (a child of the conversation that carries
 * AZPR's title and no such metadata), its parent. Undefined for any other session, a conversation included.
 */
export function conversationOf(session) {
  const azpr = session?.metadata?.azpr;
  if (azpr) return typeof azpr.conversation === 'string' ? azpr.conversation : undefined;
  return typeof session?.parentID === 'string' && TITLE.test(session.title ?? '') ? session.parentID : undefined;
}

/**
 * Whether a session the host has is this conversation's and, where `run` is given, that run's, by what
 * the session itself says: never by a text that names it. A session of 0.4.0 or earlier has no metadata:
 * it is a child of its conversation, and its title, which AZPR gave it, names its run.
 */
const belongs = (session, conversation, run) => {
  const azpr = session.metadata?.azpr;
  if (azpr) return azpr.conversation === conversation && (run === undefined || azpr.run === run);
  return session.parentID === conversation && (run === undefined || TITLE.exec(session.title ?? '')?.[1] === run);
};

/** Entries of several lists as one, each ID once (a later list's entry wins), for what was read and what arrived meanwhile. */
export const mergeEntries = (...lists) => [...new Map(lists.flat().filter(entry => typeof entry?.id === 'string').map(entry => [entry.id, entry])).values()];

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
 * The result lists in `needs` the sessions to look up before more can be shown,
 * in `inbox` the report session whose inbox holds the document, and in
 * `notices` the conversation whose notices are to be read when the session on
 * screen is one of AZPR's own. Only a session that proved to be this
 * conversation's is named in `inbox`.
 */
export function buildPanel(source, sessionID, { known = {}, read = {}, titles = new Map() } = {}) {
  const needs = new Set();
  const entriesOf = id => syntheticOf(source.messages(id), source.pending(id));
  const self = source.session(sessionID);
  // In one of AZPR's own sessions the notices are in the conversation that started the run, and with them those
  // of commands typed in this session, which the runtime answers here (IDs sort by creation time across sessions).
  const conversation = conversationOf(self) ?? sessionID;
  if (conversation !== sessionID && !source.session(conversation) && known[conversation] !== 'missing') needs.add(conversation);
  // The host holds the notices of the session on screen and of open tabs only: those of the conversation are
  // read from the server, once, whether or not the host knows the conversation itself.
  const notes = conversation !== sessionID && known[conversation] !== 'missing' && !read[`${conversation}:notices`] ? { sessionID: conversation, token: 'notices' } : undefined;
  const entries = conversation === sessionID ? entriesOf(conversation)
    : mergeEntries(entriesOf(conversation), entriesOf(sessionID)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const notices = noticesOf(entries);
  // What the panel is about is what happened last: a run that started, progressed or ended, or a saved preview
  // shown again, which names its review. What a run says besides (a review's note that no preview follows can
  // arrive after the next run started) changes nothing, and neither does an answer without a document.
  const subject = notices.findLast(notice => (notice.run && notice.kind !== 'NOTE') || (notice.kind === 'ANSWER' && SAVED_PREVIEW.test(notice.text) && encloses(notice.text)));
  const answered = subject?.kind === 'ANSWER' ? SAVED_PREVIEW.exec(subject.text)[1] : undefined;
  // A saved preview shown again is about its review: that review's status, sessions and report session.
  const run = answered ?? subject?.run;
  const ofRun = notices.filter(notice => notice.run === run && notice.kind !== 'NOTE');
  const receipt = ofRun.findLast(notice => notice.kind === 'RECEIPT');
  const progress = ofRun.findLast(notice => notice.kind === 'PROGRESS');
  const status = receipt ? receipt.status : run && !answered ? 'RUNNING' : '';
  // A comment run belongs with the review it acts on: that review's sessions and report stay in view.
  // Any other run stands alone, so a review under way never shows the report of the review before it.
  const reviewRun = SOURCE_REVIEW.exec(receipt?.text.split('\n')[0] ?? '')?.[1] ?? ACTS_ON.exec(ofRun.find(notice => notice.kind === 'STARTED')?.text ?? '')?.[1] ?? run;
  const review = reviewRun === run ? receipt : notices.findLast(notice => notice.kind === 'RECEIPT' && notice.run === reviewRun);
  const reportSession = REPORT_SESSION.exec(ledgerOf(review?.text ?? ''))?.[1];

  // The document: the saved preview shown again, or the newest report or preview of the run and of the review it
  // acts on, enclosed in a receipt or queued to the review's report session. A receipt that encloses nothing (a
  // comment run that failed before it had a preview) leaves the document as it was: the review's report.
  let document;
  if (answered) document = { head: subject.text.split('\n')[0], markdown: enclosedIn(subject.text), token: subject.id };
  else for (const notice of notices) {
    if (notice.kind !== 'RECEIPT' || (notice.run !== run && notice.run !== reviewRun)) continue;
    const head = notice.text.split('\n')[0];
    const enclosed = enclosedIn(notice.text);
    const queued = REPORT_SESSION.exec(ledgerOf(notice.text))?.[1];
    if (enclosed !== undefined) document = { head, markdown: enclosed, token: notice.id };
    else if (queued) document = { head, session: queued, run: notice.run, token: notice.id };
  }
  // A queued report is read from the session a receipt names, once that session says itself that it is this
  // conversation's and holds the report of that receipt's run: until the host has it, it is looked up, and a
  // session of someone else's, or of another review, is never read. A session the server said is gone is gone,
  // whatever the host still holds of it.
  const gone = id => known[id] === 'missing';
  const holder = document?.session && !gone(document.session) ? source.session(document.session) : undefined;
  const awaited = Boolean(document?.session) && !holder && !gone(document.session);
  if (awaited) needs.add(document.session);
  const held = holder !== undefined && belongs(holder, conversation, document.run);
  const found = document?.markdown ?? (held ? reportIn(entriesOf(document.session)) : '');
  // In a session that holds a report, that report is shown while the notices name no document, and only when it
  // is the report of the review shown, or nothing is known yet of any run (the notices may not be read yet). A
  // status never stands above another review's report.
  const own = !document && conversation !== sessionID && self && (run === undefined || belongs(self, conversation, reviewRun)) ? reportIn(entriesOf(sessionID)) : '';
  const markdown = readable(found || own);
  // A queued report waits in its session's inbox, which the host loads only for the session on screen.
  const inbox = !found && held ? { sessionID: document.session, token: document.token } : undefined;
  const loading = !markdown && (awaited || (inbox !== undefined && !read[`${inbox.sessionID}:${inbox.token}`]));

  // Candidates: what the host lists for these runs, what their receipts name, and the report session.
  const stages = new Map();
  for (const notice of new Set([review, receipt])) {
    if (notice) for (const [, role, label, state, id] of ledgerOf(notice.text).matchAll(STAGE)) stages.set(id, { role, label, state });
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
    // The server's word that a session is gone outweighs what the host still holds of it.
    const info = gone(id) ? undefined : source.session(id);
    if (!info) {
      // A finished run names every stage in its receipt; what was deleted since is counted, not listed.
      if (gone(id)) deleted += stages.has(id) ? 1 : 0;
      else needs.add(id);
      continue;
    }
    // A session says itself whose it is: one of another conversation or run is not listed, whatever named it.
    const azpr = info.metadata?.azpr;
    if (!belongs(info, conversation) || (azpr && !runs.has(azpr.run))) continue;
    if (info.title) titles.set(id, short(info.title));
    const stage = stages.get(id);
    rows.push({
      id,
      label: titles.get(id) ?? (stage ? `${stage.role}${stage.label ? ` ${stage.label}` : ''}` : azpr?.role ?? id),
      state: source.status(id) === 'running' ? 'running' : stage ? stage.state.toLowerCase() : 'idle',
      report: id === reportSession && belongs(info, conversation, reviewRun),
      current: azpr?.run === run,
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
    // A report read from its session says its run and status in its own first line; an enclosed document is named by
    // the notice that encloses it.
    documentHead: own || document?.session ? '' : document?.head ?? '',
    inbox,
    notices: notes,
    loading,
    needs: [...needs],
  };
}
