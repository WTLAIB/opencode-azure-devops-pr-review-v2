/**
 * Deterministic Azure DevOps access through the Azure DevOps Services REST API.
 *
 * Every call pins api-version 7.1, the latest released version of each
 * resource AZPR uses (pull requests, iterations, iteration changes, commits,
 * threads and items). The runtime and the reviewers' AZPR tools share this client, so PR
 * identity, commit SHAs, the changed-file inventory, version rechecks, file
 * reads, existing threads and comment creation are code paths with verifiable
 * results. The organization and its PAT come from AZPR's own settings; the PAT
 * is sent only to that organization's REST endpoint and never logged.
 */
import { Buffer } from 'node:buffer';

export const API_VERSION = '7.1';
export const DEFAULT_BASE_URL = 'https://dev.azure.com';
export const MARKER_PATTERN = /<!-- azpr-comment:([a-f0-9]{32}) -->/g;
const READ_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60000;
const CHANGE_PAGE = 2000;           // The maximum $top of iteration changes.
const MAX_CHANGE_PAGES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // default of azure.archiveMegabytes
const FILE_CACHE_CHARACTERS = 64 * 1024 * 1024;
const DESCRIPTION_LIMIT = 8000;
const COMMIT_LIMIT = 100;           // Commits of a PR shown to reviewers.
const COMMIT_MESSAGE_LIMIT = 600;

export class AzureError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: string, status?: number, code?: string, transient?: boolean, uncertain?: boolean, retryAfterMs?: number, cause?: unknown}} [details]
   */
  constructor(message, { kind = 'unexpected', status, code, transient = false, uncertain = false, retryAfterMs, cause } = {}) {
    super(message);
    this.name = 'AzureError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (code) this.code = code;
    this.transient = transient;
    this.uncertain = uncertain;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
export const normalizePath = path => (path.startsWith('/') ? path : '/' + path);
export const isCommitSha = sha;

/**
 * Parse an Azure DevOps Services PR URL. Only cloud URLs are supported; the
 * REST client always talks to dev.azure.com/<organization>.
 */
export function parsePullRequestUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('[AZPR] The first argument must be an absolute HTTPS Azure DevOps PR URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('[AZPR] Use an HTTPS Azure DevOps PR URL without credentials or a custom port.');
  }
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('[AZPR] The PR URL path is not valid percent-encoding.'); }
  let organization;
  if (url.hostname.toLowerCase() === 'dev.azure.com') organization = parts.shift();
  else if (/^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname)) {
    organization = url.hostname.split('.')[0];
    if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift();
  } else {
    throw new Error('[AZPR] Only dev.azure.com and <organization>.visualstudio.com PR URLs are supported.');
  }
  const [project, gitMarker, repository, pullMarker, id, ...rest] = parts;
  if (!text(organization) || !text(project) || gitMarker !== '_git' || !text(repository) ||
      pullMarker?.toLowerCase() !== 'pullrequest' || !/^[1-9][0-9]*$/.test(id ?? '') || rest.length ||
      [organization, project, repository].some(value => /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('[AZPR] Use a PR URL shaped like https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>.');
  }
  return { organization, project, repository, pullRequestId: Number(id), url: url.href };
}

/** Lowercase identity used for locks and comment fingerprints. */
export function targetKey(target) {
  return JSON.stringify([target.organization, target.project, target.repository, target.pullRequestId]
    .map(value => typeof value === 'string' ? value.toLowerCase() : value));
}

/**
 * A REST base URL other than dev.azure.com is accepted only for loopback test
 * servers, so a mistaken override can never send the PAT to another host.
 */
export function restBaseUrl(override) {
  if (override === undefined || override === null || override === '') return DEFAULT_BASE_URL;
  let url;
  try { url = new URL(override); } catch { throw new Error('[AZPR] The Azure DevOps test base URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('[AZPR] An Azure DevOps base URL override must be a loopback test server.');
  }
  return url.href.replace(/\/+$/, '');
}

const CHANGE_FLAGS = [[1, 'add'], [2, 'edit'], [4, 'encoding'], [8, 'rename'], [16, 'delete'], [32, 'undelete'],
  [64, 'branch'], [128, 'merge'], [256, 'lock'], [512, 'rollback'], [1024, 'sourceRename'], [2048, 'targetRename'], [4096, 'property']];
/** VersionControlChangeType as a list of names (REST returns "edit" or "rename, edit"). */
export function changeTypes(value) {
  if (typeof value === 'number') return CHANGE_FLAGS.filter(([bit]) => value & bit).map(([, name]) => name);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean).map(name => name.toLowerCase());
  return [];
}
const PR_STATUS = { 0: 'notSet', 1: 'active', 2: 'abandoned', 3: 'completed' };
export const prStatus = value => typeof value === 'number' ? PR_STATUS[value] ?? 'unknown'
  : typeof value === 'string' ? value.toLowerCase() : 'unknown';

/** The newest iteration; iterations are numbered from 1 per push. */
export function latestIteration(iterations) {
  return (Array.isArray(iterations) ? iterations : []).filter(item => Number.isInteger(item?.id))
    .reduce((latest, item) => (!latest || item.id > latest.id ? item : latest), null);
}

/**
 * Head and base as Azure DevOps diffs the PR: the latest iteration's source
 * commit against its common (merge-base) commit. The target tip is used only
 * when Azure reports no merge base.
 */
export function prVersions(pr, iterations) {
  const latest = latestIteration(iterations);
  const head = latest?.sourceRefCommit?.commitId ?? pr?.lastMergeSourceCommit?.commitId;
  const mergeBase = latest?.commonRefCommit?.commitId;
  const targetTip = pr?.lastMergeTargetCommit?.commitId ?? latest?.targetRefCommit?.commitId;
  const base = sha(mergeBase) ? mergeBase : targetTip;
  return {
    head: sha(head) ? head.toLowerCase() : null,
    base: sha(base) ? base.toLowerCase() : null,
    baseKind: sha(mergeBase) ? 'merge-base' : 'target',
    iteration: latest?.id ?? null,
    status: prStatus(pr?.status),
  };
}

/** Build the runtime-owned snapshot from the PR, its iterations and the latest iteration's changes. */
export function buildSnapshot({ pr, iterations, changes, complete, commits }, target) {
  if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) throw new AzureError('Azure DevOps returned no pull request object.');
  const prId = Number(pr.pullRequestId);
  if (prId !== target.pullRequestId) throw new AzureError(`Azure DevOps returned PR ${pr.pullRequestId ?? 'unknown'} instead of ${target.pullRequestId}.`);
  const versions = prVersions(pr, iterations);
  if (!versions.head || !versions.base) {
    throw new AzureError('The PR has no source/base commit yet. Wait until Azure DevOps finishes evaluating the PR, then retry.', { kind: 'not-ready' });
  }
  const warnings = [];
  const merged = pr.lastMergeSourceCommit?.commitId;
  if (sha(merged) && merged.toLowerCase() !== versions.head) {
    warnings.push(`Azure DevOps has not finished merging the latest push (merge source ${merged.slice(0, 10)}, latest iteration ${versions.head.slice(0, 10)}); the review uses the latest iteration.`);
  }
  if (versions.baseKind !== 'merge-base') warnings.push('Azure DevOps reported no merge base; BASE is the target branch tip, so target-only differences can appear in comparisons.');
  if (pr.hasMultipleMergeBases === true) warnings.push('The PR has multiple merge bases; BASE is the one Azure DevOps reports for the latest iteration.');
  const repository = pr.repository ?? {};
  const files = new Map();
  for (const entry of Array.isArray(changes) ? changes : []) {
    const item = entry?.item ?? {};
    const raw = text(item.path) ? item.path : text(entry?.originalPath) ? entry.originalPath : null;
    if (!raw || item.isFolder === true || item.gitObjectType === 'tree') continue;
    const path = normalizePath(raw);
    if (files.has(path)) continue;
    const original = text(entry.originalPath) ? normalizePath(entry.originalPath) : text(item.originalPath) ? normalizePath(item.originalPath) : null;
    files.set(path, { path, changeType: changeTypes(entry.changeType), ...(original && original !== path ? { originalPath: original } : {}) });
  }
  const description = typeof pr.description === 'string' ? pr.description : '';
  // The author's account of each commit; a failed read is a warning, not a failed review.
  if (commits === null) warnings.push('The PR commit list could not be read; reviewers see no commit messages.');
  const commitList = (Array.isArray(commits) ? commits : []).slice(0, COMMIT_LIMIT).flatMap(commit => {
    const message = typeof commit?.comment === 'string' ? commit.comment.trim() : '';
    if (!message) return [];
    const shortened = message.length > COMMIT_MESSAGE_LIMIT || commit.commentTruncated === true;
    return [{ id: sha(commit.commitId) ? commit.commitId.slice(0, 12).toLowerCase() : null, message: shortened ? `${message.slice(0, COMMIT_MESSAGE_LIMIT)} […]` : message }];
  });
  return {
    organization: target.organization,
    project: repository.project?.name ?? target.project,
    projectId: repository.project?.id ?? target.project,
    repository: repository.name ?? target.repository,
    repositoryId: repository.id ?? target.repository,
    prId,
    title: typeof pr.title === 'string' ? pr.title : '',
    description: description.length > DESCRIPTION_LIMIT ? description.slice(0, DESCRIPTION_LIMIT) + '\n[description truncated by AZPR]' : description,
    status: versions.status,
    isDraft: pr.isDraft === true,
    sourceRef: pr.sourceRefName ?? '',
    targetRef: pr.targetRefName ?? '',
    head: versions.head,
    base: versions.base,
    baseKind: versions.baseKind,
    iteration: versions.iteration,
    scope: 'pr',
    files: [...files.keys()],
    changes: [...files.values()],
    commits: commitList,
    filesComplete: complete === true,
    snapshotWarnings: warnings,
  };
}

export const snapshotLabel = snapshot => `${snapshot.organization}/${snapshot.project}/${snapshot.repository}`;

/** Every existing AZPR marker on the PR, mapped to the thread that carries it. */
export function markersInThreads(threads) {
  const found = new Map();
  for (const thread of threads) {
    if (thread?.isDeleted === true) continue;
    for (const comment of Array.isArray(thread?.comments) ? thread.comments : []) {
      if (comment?.isDeleted === true || typeof comment?.content !== 'string') continue;
      for (const match of comment.content.matchAll(MARKER_PATTERN)) {
        if (!found.has(match[0])) found.set(match[0], thread.id);
      }
    }
  }
  return found;
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary content. */
export function isBinary(bytes) {
  const length = Math.min(bytes.length, 8000);
  for (let index = 0; index < length; index++) if (bytes[index] === 0) return true;
  return false;
}

function retryAfterMs(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

const NETWORK_CODES = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/;

/**
 * Azure DevOps REST client. The PAT is turned into the Basic credential once
 * and never appears in a message, record or error.
 * @param {object} options
 * @param {string} options.organization
 * @param {string} options.pat
 * @param {ReturnType<import('./tool-queue.mjs').createToolQueue>} options.queue
 */
export function createAzureClient({ organization, pat, baseUrl = DEFAULT_BASE_URL, maxArchiveBytes = MAX_ARCHIVE_BYTES, queue, retryDelayMs = 1000, onCall, fetch: fetchImpl = globalThis.fetch }) {
  const authorization = 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64');
  const root = `${restBaseUrl(baseUrl === DEFAULT_BASE_URL ? undefined : baseUrl)}/${encodeURIComponent(organization)}`;
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled.')); };
    signal.addEventListener('abort', stop, { once: true });
  });

  function httpFailure(status, body, label, headers) {
    const code = clean(body?.typeKey || String(body?.typeName ?? '').split(',')[0].split('.').at(-1));
    const detail = clean(body?.message);
    const suffix = `${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
    if (status === 203 || status === 401 || (status >= 300 && status < 400)) {
      return new AzureError(`Azure DevOps rejected the PAT for organization "${organization}" (HTTP ${status}). Check that azure.pat in AZPR settings is valid, not expired and created for this organization, then restart OpenCode.`, { kind: 'auth', status });
    }
    if (status === 403) return new AzureError(`Azure DevOps refused ${label} (HTTP 403${suffix}). The PAT needs Code (Read) and Pull Request Threads (Read & write) for this organization.`, { kind: 'permission', status, code });
    if (status === 404) return new AzureError(`Azure DevOps could not find ${label} (HTTP 404${suffix}).`, { kind: 'not-found', status, code });
    if (status === 429) return new AzureError(`Azure DevOps throttled ${label} (HTTP 429${suffix}).`, { kind: 'throttled', status, code, transient: true, retryAfterMs: retryAfterMs(headers?.get?.('retry-after')) });
    if (status >= 500) return new AzureError(`Azure DevOps failed ${label} (HTTP ${status}${suffix}).`, { kind: 'server', status, code, transient: true, retryAfterMs: retryAfterMs(headers?.get?.('retry-after')) });
    if (status === 400) return new AzureError(`Azure DevOps rejected ${label} as invalid (HTTP 400${suffix}).`, { kind: 'bad-request', status, code });
    if (status === 409 || status === 412) return new AzureError(`Azure DevOps reported a conflict for ${label} (HTTP ${status}${suffix}).`, { kind: 'conflict', status, code });
    return new AzureError(`Azure DevOps returned HTTP ${status} for ${label}${suffix}.`, { kind: 'unexpected', status, code });
  }

  async function send({ method, url, body, accept, maxBytes = MAX_FILE_BYTES }, label, signal) {
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'manual', signal,
        headers: { authorization, accept: accept === 'json' ? 'application/json' : 'application/octet-stream',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      const code = error?.cause?.code ?? error?.code;
      throw new AzureError(`Azure DevOps ${label} failed: network error${code ? ` (${clean(code)})` : ''}.`, { kind: 'network', transient: true, cause: error,
        uncertain: method !== 'GET' && !(typeof code === 'string' && /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(code)) });
    }
    const type = response.headers.get('content-type') ?? '';
    if (response.status < 200 || response.status >= 300 || response.status === 203) {
      let detail;
      try { detail = /json/i.test(type) ? await response.json() : (await response.arrayBuffer(), undefined); } catch { detail = undefined; }
      throw httpFailure(response.status, detail, label, response.headers);
    }
    if (accept === 'json') {
      // A sign-in page instead of JSON means the credential was not accepted.
      if (!/json/i.test(type)) { await response.arrayBuffer().catch(() => {}); throw httpFailure(203, undefined, label); }
      try { return await response.json(); }
      catch (error) { throw new AzureError(`Azure DevOps returned unreadable JSON for ${label}.`, { kind: 'network', transient: true, cause: error }); }
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      return { tooLarge: true, size: length };
    }
    // Stop reading once the limit is passed; a missing or wrong length cannot exhaust memory.
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.length > maxBytes ? { tooLarge: true, size: bytes.length } : { bytes };
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return { tooLarge: true, size }; }
      chunks.push(value);
    }
    const joined = Buffer.concat(chunks, size);
    return { bytes: new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength) };
  }

  /**
   * One REST call through the shared queue. Reads retry transient failures
   * (network, timeout, throttling, 5xx) twice; writes are never repeated
   * because publication resolves uncertainty by reading markers back.
   */
  async function request(run, { method = 'GET', path, query = {}, body, accept = 'json', maxBytes, label, record = {} }) {
    const url = new URL(`${root}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    url.searchParams.set('api-version', API_VERSION);
    const retry = method === 'GET';
    for (let attempt = 1; ; attempt++) {
      run.azureCalls = (run.azureCalls ?? 0) + 1;
      const started = performance.now();
      const entry = { method, call: label, ...record, attempt };
      try {
        const value = await queue.run(signal => send({ method, url, body, accept, maxBytes }, label, signal), { signal: run.controller.signal, label: `Azure DevOps ${label}` });
        onCall?.(run, { ...entry, ok: true, durationMs: Math.round(performance.now() - started),
          ...(value?.bytes ? { bytes: value.bytes.length } : value?.tooLarge ? { bytes: value.size, tooLarge: true } : {}) });
        return value;
      } catch (caught) {
        if (run.controller.signal.aborted) throw caught;
        const error = caught instanceof AzureError ? caught : caught?.timeout
          ? new AzureError(`Azure DevOps ${label} did not finish within the per-call timeout.`, { kind: 'timeout', transient: true, uncertain: method !== 'GET', cause: caught })
          : new AzureError(`Azure DevOps ${label} failed: ${clean(caught?.message ?? caught)}`, { kind: 'unexpected', cause: caught });
        const again = retry && error.transient && attempt <= READ_RETRIES;
        onCall?.(run, { ...entry, ok: false, durationMs: Math.round(performance.now() - started), status: error.status, kind: error.kind,
          error: error.message.slice(0, 300), transient: error.transient, willRetry: again });
        if (again) {
          run.azureRetries = (run.azureRetries ?? 0) + 1;
          await pause(Math.max(retryDelayMs * (attempt === 1 ? 1 : 3), error.retryAfterMs ?? 0), run.controller.signal);
          continue;
        }
        if (attempt > 1) error.message = `${error.message.replace(/\.$/, '')} after ${attempt} attempts.`;
        throw error;
      }
    }
  }

  const repo = snapshot => `${encodeURIComponent(snapshot.projectId)}/_apis/git/repositories/${encodeURIComponent(snapshot.repositoryId)}`;
  const pullRequest = snapshot => `${repo(snapshot)}/pullRequests/${snapshot.prId}`;

  async function iterations(run, snapshot) {
    const result = await request(run, { path: `${pullRequest(snapshot)}/iterations`, label: 'PR iterations' });
    if (!Array.isArray(result?.value)) throw new AzureError('Azure DevOps returned no iteration list.');
    return result.value;
  }

  /** All changes of one iteration against its merge base, paged at the API maximum. */
  async function iterationChanges(run, snapshot, iteration) {
    const changes = [];
    let skip = 0;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const result = await request(run, { path: `${pullRequest(snapshot)}/iterations/${iteration}/changes`, query: { $top: CHANGE_PAGE, $skip: skip || undefined },
        label: 'PR changes', record: { skip } });
      const entries = Array.isArray(result?.changeEntries) ? result.changeEntries : null;
      if (!entries) throw new AzureError('Azure DevOps returned no change list.');
      changes.push(...entries);
      const next = Number(result.nextSkip);
      if (!entries.length || !Number.isInteger(next) || next <= skip) return { changes, complete: true };
      skip = next;
    }
    return { changes, complete: false };
  }

  /** The PR's commits with their messages (newest first); null when they cannot be read. */
  async function pullRequestCommits(run, scope) {
    try {
      const result = await request(run, { path: `${pullRequest(scope)}/commits`, query: { $top: COMMIT_LIMIT }, label: 'PR commits' });
      return Array.isArray(result?.value) ? result.value : null;
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      return null;
    }
  }

  /** Exact bytes of one file at a commit, cached per run. */
  async function readFile(run, snapshot, path, version) {
    const normalized = normalizePath(path);
    const key = `${version}\n${normalized}`;
    const cache = run.fileCache ??= { entries: new Map(), characters: 0 };
    if (cache.entries.has(key)) return cache.entries.get(key);
    const pending = (async () => {
      const result = await request(run, { path: `${repo(snapshot)}/items`, accept: 'bytes', label: `file ${normalized}`, record: { path: normalized, version: version.slice(0, 12) },
        query: { path: normalized, 'versionDescriptor.version': version, 'versionDescriptor.versionType': 'commit', download: false } });
      if (result.tooLarge) return { path: normalized, version, tooLarge: true, size: result.size };
      if (isBinary(result.bytes)) return { path: normalized, version, binary: true, size: result.bytes.length };
      const content = new TextDecoder('utf-8').decode(result.bytes);
      return { path: normalized, version, text: content, size: result.bytes.length };
    })();
    cache.entries.set(key, pending);
    pending.then(file => {
      cache.characters += file.text?.length ?? 0;
      if (cache.characters > FILE_CACHE_CHARACTERS) { cache.entries.delete(key); cache.characters -= file.text?.length ?? 0; }
    }, () => cache.entries.delete(key));
    return pending;
  }

  return {
    organization,
    request,
    /** Read the PR, its latest iteration and every changed file into a runtime-owned snapshot. */
    async snapshot(run, target) {
      const pr = await request(run, { path: `${encodeURIComponent(target.project)}/_apis/git/repositories/${encodeURIComponent(target.repository)}/pullRequests/${target.pullRequestId}`, label: 'PR' });
      const scope = { projectId: pr?.repository?.project?.id ?? target.project, repositoryId: pr?.repository?.id ?? target.repository, prId: target.pullRequestId };
      const all = await iterations(run, scope);
      const latest = latestIteration(all);
      const listed = latest ? await iterationChanges(run, scope, latest.id) : { changes: [], complete: true };
      return buildSnapshot({ pr, iterations: all, ...listed, commits: await pullRequestCommits(run, scope) }, target);
    },
    /** Fresh status and versions, used for the final recheck and before posting. */
    async versions(run, snapshot) {
      const [pr, all] = await Promise.all([request(run, { path: pullRequest(snapshot), label: 'PR' }), iterations(run, snapshot)]);
      if (Number(pr?.pullRequestId) !== snapshot.prId) throw new AzureError('The fresh PR read returned a different PR.');
      const now = prVersions(pr, all);
      if (!now.head) throw new AzureError('The fresh PR read has no source commit.');
      return now;
    },
    readFile,
    /** File text at a commit; binary and oversized files are errors here. */
    async fileContent(run, snapshot, path, version) {
      const file = await readFile(run, snapshot, path, version);
      if (file.binary) throw new AzureError(`${file.path} is a binary file at ${version.slice(0, 12)}.`, { kind: 'binary' });
      if (file.tooLarge) throw new AzureError(`${file.path} is larger than ${MAX_FILE_BYTES / 1048576} MB at ${version.slice(0, 12)}.`, { kind: 'too-large' });
      return file.text;
    },
    /** Folder entries at a commit; a recursive listing is read once per run. */
    async listItems(run, snapshot, path, version, recursive = false) {
      const scope = normalizePath(path);
      const read = async () => {
        const result = await request(run, { path: `${repo(snapshot)}/items`, label: `folder ${scope}`, record: { path: scope, version: version.slice(0, 12), ...(recursive ? { recursive: true } : {}) },
          query: { scopePath: scope, recursionLevel: recursive ? 'Full' : 'OneLevel', 'versionDescriptor.version': version, 'versionDescriptor.versionType': 'commit' } });
        if (!Array.isArray(result?.value)) throw new AzureError('Azure DevOps returned no item list.');
        return result.value;
      };
      if (!recursive) return read();
      const cache = run.listCache ??= new Map(), key = `${version}\n${scope}`;
      if (!cache.has(key)) {
        const pending = read();
        cache.set(key, pending);
        pending.catch(() => cache.delete(key));
      }
      return cache.get(key);
    },
    /** The whole repository at a commit as one zip; `tooLarge` above maxArchiveBytes. */
    async archive(run, snapshot, version) {
      const result = await request(run, { path: `${repo(snapshot)}/items`, accept: 'bytes', maxBytes: maxArchiveBytes, label: 'repository archive', record: { version: version.slice(0, 12) },
        query: { scopePath: '/', recursionLevel: 'Full', $format: 'zip', 'versionDescriptor.version': version, 'versionDescriptor.versionType': 'commit' } });
      return result.tooLarge ? { tooLarge: true, size: result.size } : { bytes: result.bytes };
    },
    /** Every thread on the PR (one call; the API returns all of them). */
    async threads(run, snapshot) {
      const result = await request(run, { path: `${pullRequest(snapshot)}/threads`, label: 'PR threads' });
      if (!Array.isArray(result?.value)) throw new AzureError('Azure DevOps returned no thread list; existing comments could not be checked.');
      return result.value;
    },
    /** Create one thread with exactly the saved content. Never retried. */
    async createThread(run, snapshot, item) {
      const body = { comments: [{ parentCommentId: 0, content: item.content, commentType: 1 }], status: 1 };
      if (item.kind !== 'summary') {
        body.threadContext = { filePath: item.path, rightFileStart: { line: item.startLine, offset: item.startOffset },
          rightFileEnd: { line: item.endLine, offset: item.endOffset } };
      }
      const thread = await request(run, { method: 'POST', path: `${pullRequest(snapshot)}/threads`, body, label: 'thread creation',
        record: { kind: item.kind ?? 'inline', ...(item.path ? { path: item.path, startLine: item.startLine, endLine: item.endLine } : {}), contentCharacters: item.content.length } });
      const threadId = Number(thread?.id);
      if (!Number.isSafeInteger(threadId) || threadId < 1) {
        throw new AzureError('Thread creation returned no thread ID; the comment may or may not exist.', { uncertain: true });
      }
      const returned = Array.isArray(thread.comments) ? thread.comments[0]?.content : undefined;
      return { threadId, contentMatches: returned === undefined ? null : returned === item.content };
    },
  };
}
