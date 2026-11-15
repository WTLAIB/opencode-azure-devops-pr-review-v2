/**
 * Durable private state: completed reviews (with plans and publication
 * ledgers), their comment data, undelivered receipts, the reviewer sessions
 * kept from unfinished runs and publication attempts per PR.
 *
 * Reviews survive an OpenCode restart so /pr-comment works afterwards in the
 * original conversation. The newest `limit` reviews are kept; older ones and
 * orphaned data are removed. Several OpenCode processes may share this
 * directory, so cleanup only touches clearly stale or evicted entries.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

export const REVIEW_LIMIT = 20;
const RECEIPT_LIMIT = 50;
const STALE_DATA_MS = 24 * 60 * 60 * 1000;
const FORMAT = 1;
const ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Marks a record of sessions that should be gone and could not be deleted. Run and review IDs are hexadecimal.
const RETRY = 'retry';

export function stateRoot(env = process.env) {
  const base = isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
  return join(base, 'opencode', 'azpr-v2');
}

const checksum = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };

/**
 * Plain JSON form of a review; Sets and Maps become arrays. `closingSessions`
 * (sessions whose deletion was asked for and never answered) is written only
 * when there are any.
 */
export function serializeReview(review) {
  const { data, reportSessions, closingSessions, publication, ...rest } = review;
  return { ...rest, reportSessions: [...(reportSessions ?? [])], ...(closingSessions?.size ? { closingSessions: [...closingSessions] } : {}),
    publication: [...(publication ?? new Map())], dataDirectory: review.dataDirectory ?? null };
}

export function deserializeReview(value) {
  return { ...value, reportSessions: new Set(value.reportSessions ?? []), ...(value.closingSessions ? { closingSessions: new Set(value.closingSessions) } : {}),
    publication: new Map(value.publication ?? []) };
}

/**
 * Writes of saved reviews, one at a time per review and in the order asked,
 * so two writes of one record never overlap and an earlier write never lands
 * after a later one. `write(id, action)` queues an action (a save or a
 * removal) and returns its result; a failed action does not stop the next.
 * `latest(id, save)` asks for a save that reads the review only when it
 * starts: a request joins such a save while it waits in the queue, and once it
 * has started, so has already read the review, the next request gets a save of
 * its own after it. Either way a request is carried by a save that starts
 * after it, and the record ends with the latest state asked for.
 */
export function createReviewWrites() {
  const tails = new Map(), waiting = new Map();
  function write(id, action) {
    const result = (tails.get(id) ?? Promise.resolve()).then(action);
    const settled = result.then(() => {}, () => {});
    tails.set(id, settled);
    void settled.then(() => { if (tails.get(id) === settled) tails.delete(id); });
    return result;
  }
  function latest(id, save) {
    if (!waiting.has(id)) waiting.set(id, write(id, () => { waiting.delete(id); return save(); }));
    return waiting.get(id);
  }
  return { write, latest };
}

async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * `onRemove(review)` runs before an evicted or removed review's files are
 * deleted, to delete its reviewer sessions: the review's record is what names
 * them, so it stays until they are dealt with, and a process that ends
 * meanwhile finds the review again. When it returns false (sessions that are
 * still there could not be put on record elsewhere) the review stays for a
 * later attempt; its errors are ignored.
 */
export async function createReviewStore({ root = stateRoot(), limit = REVIEW_LIMIT, now = () => Date.now(), onRemove } = {}) {
  const dirs = { reviews: join(root, 'reviews'), data: join(root, 'data'), receipts: join(root, 'receipts'), sessions: join(root, 'sessions'), attempts: join(root, 'attempts') };
  for (const directory of [root, ...Object.values(dirs)]) await mkdir(directory, { recursive: true, mode: 0o700 });

  async function readReview(file) {
    try {
      const envelope = JSON.parse(await readFile(join(dirs.reviews, file), 'utf8'));
      if (envelope?.format !== FORMAT || typeof envelope.body !== 'string' || checksum(envelope.body) !== envelope.sha256) return null;
      const review = deserializeReview(JSON.parse(envelope.body));
      return typeof review.id === 'string' && typeof review.origin === 'string' ? review : null;
    } catch { return null; }
  }

  async function listReviews() {
    const files = (await readdir(dirs.reviews).catch(() => [])).filter(name => /^[a-f0-9]{8}\.json$/.test(name));
    const reviews = (await Promise.all(files.map(readReview))).filter(Boolean);
    return reviews.sort((a, b) => String(a.completedAt ?? '').localeCompare(String(b.completedAt ?? '')));
  }

  // One record of sessions per key: written, replaced in its place, or removed by an empty list.
  async function recordSessions(key, sessionIDs) {
    const own = (await readdir(dirs.sessions)).filter(name => name.endsWith(`-${key}.json`)).sort();
    const record = own.at(-1) ?? `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${key}.json`;
    for (const other of own.slice(0, -1)) await rm(join(dirs.sessions, other), { force: true });
    if (sessionIDs.length) await writeAtomic(join(dirs.sessions, record), JSON.stringify(sessionIDs));
    else await rm(join(dirs.sessions, record), { force: true });
  }

  // A record's name ends with its ID; the ID of a record of sessions still to be deleted starts with RETRY.
  const idOf = name => name.slice(name.lastIndexOf('-') + 1, -'.json'.length);
  const isRetry = name => idOf(name).startsWith(RETRY);

  /** Remove a review and its data, after `onRemove`; false when `onRemove` kept it. */
  async function removeReview(review) {
    let settled = true;
    try { settled = (await onRemove?.(review)) !== false; } catch { /* Cleanup never fails an eviction. */ }
    if (!settled) return false;
    await rm(join(dirs.reviews, `${review.id}.json`), { force: true });
    if (review.dataDirectory && inside(dirs.data, review.dataDirectory)) await rm(review.dataDirectory, { recursive: true, force: true });
    return true;
  }

  return {
    root, dirs,
    /** Saved reviews, oldest first; reviews beyond the limit are evicted. */
    async load() {
      const reviews = await listReviews();
      const evicted = reviews.slice(0, Math.max(0, reviews.length - limit));
      for (const review of evicted) await removeReview(review);
      return reviews.slice(evicted.length);
    },
    async save(review) {
      const body = JSON.stringify(serializeReview(review));
      await writeAtomic(join(dirs.reviews, `${review.id}.json`), JSON.stringify({ format: FORMAT, sha256: checksum(body), body }));
    },
    /**
     * Remove the oldest reviews on disk beyond the limit; returns evicted IDs.
     * `inUse(id)` names reviews a command is working on, which stay.
     */
    async enforceLimit(inUse = () => false) {
      const reviews = await listReviews();
      const evicted = [];
      for (const review of reviews.slice(0, Math.max(0, reviews.length - limit))) {
        if (!inUse(review.id) && await removeReview(review)) evicted.push(review.id);
      }
      return evicted;
    },
    remove: removeReview,
    /** Delete stale unreferenced data and legacy temporary directories. */
    async sweep() {
      const referenced = new Set((await listReviews()).map(review => review.dataDirectory).filter(Boolean));
      const removed = [];
      for (const name of await readdir(dirs.data).catch(() => [])) {
        const path = join(dirs.data, name);
        try {
          if (referenced.has(path) || now() - (await stat(path)).mtimeMs < STALE_DATA_MS) continue;
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        } catch { /* Another process may own or remove it. */ }
      }
      // Earlier versions kept comment data under the system temporary directory.
      for (const name of await readdir(tmpdir()).catch(() => [])) {
        if (!name.startsWith('azpr-comment-data-')) continue;
        const path = join(tmpdir(), name);
        try {
          const info = await lstat(path);
          if (!info.isDirectory() || info.uid !== process.getuid?.() || now() - info.mtimeMs < STALE_DATA_MS) continue;
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        } catch { /* Not ours or already gone. */ }
      }
      return removed;
    },
    /**
     * Remember the reviewer sessions a run that left no saved review keeps
     * on purpose, such as the one holding its draft; the newest `limit` runs
     * keep theirs. A run has one record: a later call replaces its earlier
     * one and keeps its place in the order, and an empty list removes it.
     */
    keepSessions: (runId, sessionIDs) => recordSessions(runId, sessionIDs),
    /**
     * Remember sessions that are still to be deleted, under the ID of the
     * run or review they belonged to: those a cleanup is about to delete,
     * then those it could not delete. They are due at every pass
     * (`expiredSessions`) and do not count against the limit. One record per
     * ID, replaced by a later call and removed by an empty list.
     */
    retrySessions: (id, sessionIDs) => recordSessions(`${RETRY}${id}`, sessionIDs),
    /**
     * The sessions that are due to go, one entry per run or review, as
     * { runId, sessionIDs, kept }: those still to be deleted, due at every
     * pass, and the kept sessions of runs beyond the newest `limit` (`kept`),
     * oldest first. A run with both has one entry, so that what is left of it
     * is recorded once. `inUse(runId)` names runs whose command has not
     * ended: their own cleanup deals with their sessions, so both of their
     * records are left out, whatever their age. The records stay: the caller
     * deletes the sessions, records what is left (`retrySessions`) and only
     * then removes a kept record (`keepSessions`). An unreadable record
     * names nothing and is removed.
     */
    async expiredSessions(inUse = () => false) {
      const files = (await readdir(dirs.sessions)).filter(name => name.endsWith('.json')).sort();
      const kept = files.filter(name => !isRetry(name)), due = new Map();
      for (const name of [...files.filter(isRetry), ...kept.slice(0, Math.max(0, kept.length - limit))]) {
        const retry = isRetry(name), runId = retry ? idOf(name).slice(RETRY.length) : idOf(name);
        if (inUse(runId)) continue;
        let ids;
        try { ids = JSON.parse(await readFile(join(dirs.sessions, name), 'utf8')); } catch { ids = null; }
        if (!Array.isArray(ids)) { await rm(join(dirs.sessions, name), { force: true }); continue; }
        const entry = due.get(runId) ?? { runId, sessionIDs: [], kept: false };
        for (const id of ids) if (typeof id === 'string' && !entry.sessionIDs.includes(id)) entry.sessionIDs.push(id);
        if (!retry) entry.kept = true;
        due.set(runId, entry);
      }
      return [...due.values()];
    },
    /** Every session the records name, as { kept, due }: kept on purpose by an unfinished run, and still to be deleted. */
    async recordedSessions() {
      const kept = [], due = [];
      for (const name of (await readdir(dirs.sessions).catch(() => [])).filter(file => file.endsWith('.json'))) {
        try {
          const ids = JSON.parse(await readFile(join(dirs.sessions, name), 'utf8'));
          if (Array.isArray(ids)) (isRetry(name) ? due : kept).push(...ids.filter(id => typeof id === 'string'));
        } catch { /* An unreadable record names nothing. */ }
      }
      return { kept, due };
    },
    /**
     * Thread-creation attempts of one PR, keyed by comment marker and shared by
     * every review: an attempt is recorded before its request is sent and its
     * outcome after; the thread of an item found on the PR is recorded as
     * created too, so a comment deleted there is recognized. Writes re-read the
     * file and throw on failure, so a caller can refuse to send what it could
     * not record. This is not a lock between processes: two processes
     * publishing the same PR at once can both send. Entries older than 90 days
     * are dropped.
     */
    async attempts(prKey) {
      const file = join(dirs.attempts, `${checksum(prKey).slice(0, 32)}.json`);
      const read = async () => {
        let raw;
        try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The publication attempt record is not valid JSON.');
        return Object.fromEntries(Object.entries(value).filter(([, entry]) => now() - Date.parse(entry?.at) < ATTEMPT_RETENTION_MS));
      };
      let entries = await read();
      const update = async change => {
        const current = await read();
        change(current);
        await writeAtomic(file, JSON.stringify(current));
        entries = current;
      };
      return {
        get: marker => entries[marker],
        set: (marker, entry) => update(current => { current[marker] = entry; }),
        remove: markers => update(current => { for (const marker of markers) delete current[marker]; }),
      };
    },
    /** Last-resort receipt file when the conversation notice cannot be queued. */
    async writeReceipt(runId, text) {
      const file = join(dirs.receipts, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${runId}.md`);
      await writeFile(file, text, { mode: 0o600 });
      const files = (await readdir(dirs.receipts)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - RECEIPT_LIMIT))) await rm(join(dirs.receipts, old), { force: true });
      return file;
    },
  };
}
