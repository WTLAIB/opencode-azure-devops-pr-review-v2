/**
 * Deterministic Azure DevOps access through the user's connected MCP server.
 *
 * The runtime calls the official @azure-devops/mcp tools directly (captured
 * from OpenCode's tool registry), so PR identity, commit SHAs, the changed-file
 * inventory, the final version recheck, existing threads and comment creation
 * are code paths with verifiable results instead of model echoes. The MCP
 * server keeps owning authentication; host permission rules still apply to
 * every call through the private runtime agent.
 */
import { randomUUID } from 'node:crypto';
import { sanitizeNamespace } from './host.mjs';

export const AZURE_TOOLS = Object.freeze({
  pullRequest: 'repo_pull_request',
  threads: 'repo_pull_request_thread',
  threadWrite: 'repo_pull_request_thread_write',
  file: 'repo_file',
});
export const MARKER_PATTERN = /<!-- azpr-comment:([a-f0-9]{32}) -->/g;
const THREAD_PAGE = 100;
const MAX_THREAD_PAGES = 1000;
const DESCRIPTION_LIMIT = 8000;

export class AzureError extends Error {
  constructor(message, { tool, cause, uncertain = false } = {}) {
    super(message);
    this.name = 'AzureError';
    if (tool) this.tool = tool;
    if (cause) this.cause = cause;
    this.uncertain = uncertain;
  }
}

const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export const normalizePath = path => (path.startsWith('/') ? path : '/' + path);

/**
 * Parse an Azure DevOps Services PR URL. Only cloud URLs are supported because
 * the official MCP server targets Azure DevOps Services organizations.
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

// VersionControlChangeType flags returned by azure-devops-node-api.
const CHANGE_FLAGS = [[1, 'add'], [2, 'edit'], [4, 'encoding'], [8, 'rename'], [16, 'delete'], [32, 'undelete'],
  [64, 'branch'], [128, 'merge'], [256, 'lock'], [512, 'rollback'], [1024, 'sourceRename'], [2048, 'targetRename'], [4096, 'property']];
export function changeTypes(value) {
  if (typeof value === 'number') return CHANGE_FLAGS.filter(([bit]) => value & bit).map(([, name]) => name);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean).map(name => name.toLowerCase());
  return [];
}
const PR_STATUS = { 0: 'notSet', 1: 'active', 2: 'abandoned', 3: 'completed' };
export const prStatus = value => typeof value === 'number' ? PR_STATUS[value] ?? 'unknown'
  : typeof value === 'string' ? value.toLowerCase() : 'unknown';

function organizationFromApiUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === 'dev.azure.com') return url.pathname.split('/').filter(Boolean)[0];
    if (/\.visualstudio\.com$/i.test(url.hostname)) return url.hostname.split('.')[0];
  } catch { /* An unexpected URL does not identify the organization. */ }
  return undefined;
}

/** Build the runtime-owned snapshot from one repo_pull_request "get" response. */
export function buildSnapshot(pr, target) {
  if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) throw new AzureError('repo_pull_request returned no pull request object.', { tool: AZURE_TOOLS.pullRequest });
  const prId = Number(pr.pullRequestId);
  if (prId !== target.pullRequestId) throw new AzureError(`The MCP server returned PR ${pr.pullRequestId ?? 'unknown'} instead of ${target.pullRequestId}.`, { tool: AZURE_TOOLS.pullRequest });
  const head = pr.lastMergeSourceCommit?.commitId, base = pr.lastMergeTargetCommit?.commitId;
  if (!sha(head) || !sha(base)) {
    throw new AzureError('The PR metadata has no source/target commit yet. Wait until Azure DevOps finishes evaluating the PR, then retry.', { tool: AZURE_TOOLS.pullRequest });
  }
  const organization = organizationFromApiUrl(pr.url) ?? organizationFromApiUrl(pr.repository?.url);
  if (organization && organization.toLowerCase() !== target.organization.toLowerCase()) {
    throw new AzureError(`The connected MCP server belongs to organization "${organization}", but the PR URL names "${target.organization}". Connect @azure-devops/mcp for that organization.`, { tool: AZURE_TOOLS.pullRequest });
  }
  const repository = pr.repository ?? {};
  const summary = pr.changedFilesSummary;
  const entries = Array.isArray(summary?.changeEntries) ? summary.changeEntries : null;
  const changes = new Map();
  for (const entry of entries ?? []) {
    const item = entry?.item ?? {};
    const raw = text(item.path) ? item.path : text(entry?.originalPath) ? entry.originalPath : null;
    if (!raw || item.isFolder === true || item.gitObjectType === 'tree' || item.gitObjectType === 2) continue;
    const path = normalizePath(raw);
    if (!changes.has(path)) changes.set(path, { path, changeType: changeTypes(entry.changeType),
      ...(text(entry.originalPath) && normalizePath(entry.originalPath) !== path ? { originalPath: normalizePath(entry.originalPath) } : {}) });
  }
  const more = Number(summary?.nextSkip) > 0 || Number(summary?.nextTop) > 0;
  const description = typeof pr.description === 'string' ? pr.description : '';
  return {
    organization: target.organization,
    project: repository.project?.name ?? target.project,
    projectId: repository.project?.id ?? repository.project?.name ?? target.project,
    repository: repository.name ?? target.repository,
    repositoryId: repository.id ?? repository.name ?? target.repository,
    prId,
    title: typeof pr.title === 'string' ? pr.title : '',
    description: description.length > DESCRIPTION_LIMIT ? description.slice(0, DESCRIPTION_LIMIT) + '\n[description truncated by AZPR]' : description,
    status: prStatus(pr.status),
    isDraft: pr.isDraft === true,
    sourceRef: pr.sourceRefName ?? '',
    targetRef: pr.targetRefName ?? '',
    head: head.toLowerCase(),
    base: base.toLowerCase(),
    scope: 'pr',
    files: [...changes.keys()],
    changes: [...changes.values()],
    filesComplete: Boolean(entries) && !more,
  };
}

export const snapshotLabel = snapshot => `${snapshot.organization}/${snapshot.project}/${snapshot.repository}`;

/** Find the one MCP namespace that exposes the Azure DevOps repository tools. */
export function selectAzureServer(tools, preferred = '') {
  const namespaces = new Map();
  for (const tool of tools) {
    if (!tool.namespace) continue;
    if (!namespaces.has(tool.namespace)) namespaces.set(tool.namespace, new Map());
    namespaces.get(tool.namespace).set(tool.name, tool);
  }
  let namespace;
  if (preferred) {
    namespace = sanitizeNamespace(preferred);
    if (!namespaces.get(namespace)?.has(AZURE_TOOLS.pullRequest)) {
      throw new AzureError(`MCP server "${preferred}" does not expose ${AZURE_TOOLS.pullRequest}. Check mcpServer in settings.json and the host MCP status.`);
    }
  } else {
    const candidates = [...namespaces].filter(([, names]) => names.has(AZURE_TOOLS.pullRequest)).map(([name]) => name);
    if (!candidates.length) throw new AzureError('No connected MCP server exposes Azure DevOps repository tools. Connect @azure-devops/mcp with codemode:false.');
    if (candidates.length > 1) throw new AzureError(`Several MCP servers expose Azure DevOps tools (${candidates.join(', ')}). Set "mcpServer" in settings.json to choose one.`);
    namespace = candidates[0];
  }
  const selected = namespaces.get(namespace);
  const missing = Object.values(AZURE_TOOLS).filter(name => !selected.has(name));
  if (missing.length) throw new AzureError(`MCP server "${namespace}" lacks ${missing.join(', ')}. Use @azure-devops/mcp 2.9.0 or later with repository tools enabled.`);
  if ([...selected.values()].some(tool => tool.codemode === true)) {
    throw new AzureError(`MCP server "${namespace}" uses CodeMode. Set codemode:false on that server so reviewers can call its tools directly.`);
  }
  return { namespace, tools: selected };
}

/** Decode an OpenCode MCP executor result: parsed JSON when possible, else text. */
export function decodeToolResult(result) {
  let value = result?.output;
  if (value === undefined || value === null) {
    value = (Array.isArray(result?.content) ? result.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { /* Keep the literal text. */ }
    }
  }
  return value;
}

const errorMessage = error => {
  const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 600) || 'unknown MCP error';
};

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

/**
 * Azure DevOps client bound to captured MCP executors.
 * @param {object} options
 * @param {() => {namespace:string, tools: Map<string, {execute: Function}>}} options.server
 * @param {ReturnType<import('./tool-queue.mjs').createToolQueue>} options.queue
 */
export function createAzureClient({ server, queue, agent }) {
  async function call(run, name, args) {
    const selected = server();
    const tool = selected.tools.get(name);
    if (!tool) throw new AzureError(`MCP tool ${name} is unavailable on server "${selected.namespace}".`, { tool: name });
    if (!run.runtimeSessionID) throw new AzureError('No runtime session is available for Azure DevOps calls.', { tool: name });
    const execution = { sessionID: run.runtimeSessionID, agent, messageID: `azpr-${run.id}`, id: `azpr-${randomUUID()}` };
    run.azureCalls = (run.azureCalls ?? 0) + 1;
    try {
      const result = await queue.run(() => tool.execute(args, execution), { signal: run.controller.signal, label: `${selected.namespace}_${name}` });
      return decodeToolResult(result);
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      throw new AzureError(`${name} failed: ${errorMessage(error)}`, { tool: name, cause: error, uncertain: Boolean(error?.timeout) });
    }
  }

  const scope = snapshot => ({ repositoryId: snapshot.repositoryId, project: snapshot.projectId, pullRequestId: snapshot.prId });

  return {
    call,
    /** Read the PR and its changed files into a runtime-owned snapshot. */
    async snapshot(run, target) {
      const pr = await call(run, AZURE_TOOLS.pullRequest, { action: 'get', repositoryId: target.repository, project: target.project, pullRequestId: target.pullRequestId, includeChangedFiles: true });
      return buildSnapshot(pr, target);
    },
    /** Fresh identity/version read used for the final recheck and before posting. */
    async versions(run, snapshot) {
      const pr = await call(run, AZURE_TOOLS.pullRequest, { action: 'get', ...scope(snapshot) });
      if (Number(pr?.pullRequestId) !== snapshot.prId) throw new AzureError('The fresh PR read returned a different PR.', { tool: AZURE_TOOLS.pullRequest });
      const head = pr.lastMergeSourceCommit?.commitId, base = pr.lastMergeTargetCommit?.commitId;
      if (!sha(head)) throw new AzureError('The fresh PR read has no source commit.', { tool: AZURE_TOOLS.pullRequest });
      return { head: head.toLowerCase(), base: sha(base) ? base.toLowerCase() : null, status: prStatus(pr.status) };
    },
    async fileContent(run, snapshot, path, version) {
      return call(run, AZURE_TOOLS.file, { action: 'get_content', repositoryId: snapshot.repositoryId, project: snapshot.projectId, path, version, versionType: 'Commit' });
    },
    /** All threads, following the server's top/skip pagination to the end. */
    async threads(run, snapshot) {
      const threads = [];
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const rows = await call(run, AZURE_TOOLS.threads, { action: 'list', ...scope(snapshot), top: THREAD_PAGE, skip: page * THREAD_PAGE });
        if (!Array.isArray(rows)) throw new AzureError('repo_pull_request_thread returned an unexpected response; existing comments could not be checked.', { tool: AZURE_TOOLS.threads });
        threads.push(...rows);
        if (rows.length < THREAD_PAGE) return threads;
      }
      throw new AzureError('The PR has more threads than AZPR can page through.', { tool: AZURE_TOOLS.threads });
    },
    /** Create one thread with exactly the saved content. */
    async createThread(run, snapshot, item) {
      const args = { action: 'create', ...scope(snapshot), content: item.content, status: 'Active' };
      if (item.kind !== 'summary') Object.assign(args, { filePath: item.path, rightFileStartLine: item.startLine,
        rightFileStartOffset: item.startOffset, rightFileEndLine: item.endLine, rightFileEndOffset: item.endOffset });
      const thread = await call(run, AZURE_TOOLS.threadWrite, args);
      const threadId = Number(thread?.id);
      if (!Number.isSafeInteger(threadId) || threadId < 1) {
        throw new AzureError('Thread creation returned no thread ID; the comment may or may not exist.', { tool: AZURE_TOOLS.threadWrite, uncertain: true });
      }
      const returned = Array.isArray(thread.comments) ? thread.comments[0]?.content : undefined;
      return { threadId, contentMatches: returned === undefined ? null : returned === item.content };
    },
  };
}
