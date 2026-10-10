/**
 * Durable private state: completed reviews (with plans and publication
 * ledgers), their comment data, undelivered receipts and the reviewer
 * sessions kept from unfinished runs.
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

export function stateRoot(env = process.env) {
  const base = isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
  return join(base, 'opencode', 'azpr-v2');
}

const checksum = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };

/** Plain JSON form of a review; Sets and Maps become arrays. */
export function serializeReview(review) {
  const { data, reportSessions, publication, ...rest } = review;
  return { ...rest, reportSessions: [...(reportSessions ?? [])], publication: [...(publication ?? new Map())],
    dataDirectory: review.dataDirectory ?? null };
}

export function deserializeReview(value) {
  return { ...value, reportSessions: new Set(value.reportSessions ?? []), publication: new Map(value.publication ?? []) };
}

async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * `onRemove(review)` runs after an evicted or removed review's files are
 * deleted (for example to delete its reviewer sessions); its errors are ignored.
 */
export async function createReviewStore({ root = stateRoot(), limit = REVIEW_LIMIT, now = () => Date.now(), onRemove } = {}) {
  const dirs = { reviews: join(root, 'reviews'), data: join(root, 'data'), receipts: join(root, 'receipts'), sessions: join(root, 'sessions') };
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

  async function removeReview(review) {
    await rm(join(dirs.reviews, `${review.id}.json`), { force: true });
    if (review.dataDirectory && inside(dirs.data, review.dataDirectory)) await rm(review.dataDirectory, { recursive: true, force: true });
    try { await onRemove?.(review); } catch { /* Cleanup never fails an eviction. */ }
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
    /** Remove the oldest reviews on disk beyond the limit; returns evicted IDs. */
    async enforceLimit() {
      const reviews = await listReviews();
      const evicted = reviews.slice(0, Math.max(0, reviews.length - limit));
      for (const review of evicted) await removeReview(review);
      return evicted.map(review => review.id);
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
     * Remember reviewer sessions kept from a run that left no saved review.
     * The newest `limit` runs keep theirs; returns the session IDs of older
     * runs, whose records are removed, for the caller to delete.
     */
    async keepSessions(runId, sessionIDs) {
      await writeAtomic(join(dirs.sessions, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${runId}.json`), JSON.stringify(sessionIDs));
      const files = (await readdir(dirs.sessions)).filter(name => name.endsWith('.json')).sort();
      const released = [];
      for (const old of files.slice(0, Math.max(0, files.length - limit))) {
        try {
          const ids = JSON.parse(await readFile(join(dirs.sessions, old), 'utf8'));
          if (Array.isArray(ids)) released.push(...ids.filter(id => typeof id === 'string'));
        } catch { /* An unreadable record releases nothing. */ }
        await rm(join(dirs.sessions, old), { force: true });
      }
      return released;
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
