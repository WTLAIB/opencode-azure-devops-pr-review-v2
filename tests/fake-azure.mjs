// Offline stand-in for the Azure DevOps Services REST API (api-version 7.1):
// pull request, iterations, iteration changes, threads and items. The same
// handler serves in-process tests (as a fetch function) and exact-host
// fixtures (as a loopback HTTP server).
import { Buffer } from 'node:buffer';

export const FAKE_PAT = 'fixture-pat-0123456789abcdefghijklmnopqrstuvwxyz';
const json = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) });
export const azureError = (status, typeKey, message) => json(status, { $id: '1', innerException: null, message, typeName: `Microsoft.TeamFoundation.${typeKey}, Microsoft.TeamFoundation`, typeKey, errorCode: 0, eventId: 3000 });

export function fakeAzure(options = {}) {
  const state = {
    org: options.org ?? 'org', project: options.project ?? 'proj', repo: options.repo ?? 'repo', prId: options.prId ?? 123,
    projectId: 'pid', repositoryId: 'rid', pat: options.pat ?? FAKE_PAT,
    head: options.head ?? 'b'.repeat(40), base: options.base ?? 'a'.repeat(40), target: options.target ?? 'c'.repeat(40), status: options.status ?? 'active',
    iteration: 1, files: options.files ?? ['/src/Main.java'], binary: new Set(options.binary ?? []),
    sources: options.sources ?? {}, threads: [], nextThread: 1000, calls: [], fail: {}, afterVersions: null, snapshotTaken: false,
  };
  const pr = () => ({
    pullRequestId: state.prId, status: state.status, title: 'Fixture PR', description: 'Fixture description', isDraft: false,
    repository: { id: state.repositoryId, name: state.repo, project: { id: state.projectId, name: state.project } },
    lastMergeSourceCommit: { commitId: state.head }, lastMergeTargetCommit: { commitId: state.target },
    sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', supportsIterations: true,
  });
  const iterations = () => Array.from({ length: state.iteration }, (_, index) => ({ id: index + 1, reason: index ? 'push' : 'create',
    sourceRefCommit: { commitId: state.head }, targetRefCommit: { commitId: state.target }, commonRefCommit: { commitId: state.base } }));
  const source = (path, version) => state.sources[`${version}:${path}`] ?? state.sources[path] ?? `fixture code\nsecond line of ${path}\n`;
  const moved = () => { if (state.snapshotTaken && state.afterVersions) { Object.assign(state, state.afterVersions); state.afterVersions = null; } };

  const routes = [
    ['pr', 'GET', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)$/i, () => { moved(); return json(200, pr()); }],
    ['iterations', 'GET', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/iterations$/i, () => { moved(); return json(200, { value: iterations(), count: state.iteration }); }],
    ['changes', 'GET', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/iterations\/(\d+)\/changes$/i, request => {
      const top = Math.min(Number(request.query.get('$top') ?? 100), 2000), skip = Number(request.query.get('$skip') ?? 0);
      const entries = state.files.slice(skip, skip + top).map((path, index) => ({ changeTrackingId: skip + index + 1, changeId: skip + index + 1, item: { objectId: 'f'.repeat(40), path }, changeType: 'edit' }));
      const more = skip + top < state.files.length;
      if (!more) state.snapshotTaken = true;
      return json(200, { changeEntries: entries, ...(more ? { nextSkip: skip + top, nextTop: top } : {}) });
    }],
    ['threads', 'GET', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/threads$/i, () =>
      json(200, { value: state.threads.filter(thread => !thread.deleted), count: state.threads.length })],
    ['createThread', 'POST', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/threads$/i, request => {
      const body = JSON.parse(request.body);
      const thread = { id: state.nextThread++, status: 'active', isDeleted: false, publishedDate: new Date().toISOString(),
        comments: body.comments.map((comment, index) => ({ id: index + 1, parentCommentId: 0, content: comment.content, commentType: 'text', author: { displayName: 'AZPR fixture' } })),
        threadContext: body.threadContext ?? null,
        pullRequestThreadContext: body.threadContext ? { changeTrackingId: state.files.indexOf(body.threadContext.filePath) + 1, iterationContext: { firstComparingIteration: state.iteration, secondComparingIteration: state.iteration } } : null };
      state.threads.push(thread);
      return json(200, thread);
    }],
    ['items', 'GET', /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/items$/i, request => {
      const path = request.query.get('path'), scope = request.query.get('scopePath'), version = request.query.get('versionDescriptor.version');
      if (path) {
        if (!state.files.includes(path) && !Object.hasOwn(state.sources, path) && !Object.hasOwn(state.sources, `${version}:${path}`)) {
          return azureError(404, 'GitItemNotFoundException', `TF401174: The item '${path}' could not be found in the repository 'repo' at the version specified by '${version}'.`);
        }
        const bytes = state.binary.has(path) ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) : Buffer.from(source(path, version), 'utf8');
        return { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, body: bytes };
      }
      const prefix = scope === '/' ? '/' : `${scope}/`;
      const children = new Map();
      for (const file of state.files.filter(file => file.startsWith(prefix))) {
        const rest = file.slice(prefix.length).split('/');
        const recursive = /full/i.test(request.query.get('recursionLevel') ?? '');
        if (rest.length === 1 || recursive) children.set(file, { path: file, isFolder: false, gitObjectType: 'blob' });
        if (rest.length > 1) children.set(prefix + rest[0], { path: prefix + rest[0], isFolder: true, gitObjectType: 'tree' });
      }
      return json(200, { value: [{ path: scope, isFolder: true, gitObjectType: 'tree' }, ...children.values()], count: children.size + 1 });
    }],
  ];

  /** One request: { method, url, headers, body } -> { status, headers, body } or a never-settling promise. */
  async function handle({ method, url, headers, body }) {
    const parsed = new URL(url);
    const auth = headers.authorization ?? headers.Authorization;
    const route = routes.find(([, verb, pattern]) => verb === method && pattern.test(parsed.pathname));
    const call = { method, route: route?.[0] ?? 'unknown', path: decodeURIComponent(parsed.pathname), query: Object.fromEntries(parsed.searchParams), ...(body ? { body: JSON.parse(body) } : {}) };
    state.calls.push(call);
    if (auth !== `Basic ${Buffer.from(':' + state.pat).toString('base64')}`) {
      return { status: 203, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!DOCTYPE html><html><body>Sign in</body></html>' };
    }
    if (parsed.searchParams.get('api-version') !== '7.1') return azureError(400, 'VssVersionOutOfRangeException', 'Unexpected api-version in the fixture.');
    if (!route) return azureError(404, 'NotFoundException', 'Unknown fixture route.');
    const [org] = parsed.pathname.split('/').filter(Boolean);
    if (org.toLowerCase() !== state.org.toLowerCase()) return azureError(404, 'AccountNotFoundException', 'Unknown organization.');
    const failure = state.fail[route[0]];
    if (typeof failure === 'function') {
      const replaced = await failure(call, state);
      if (replaced !== undefined) return replaced;
    }
    return route[3]({ query: parsed.searchParams, body });
  }

  async function fetch(url, init = {}) {
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason;
    const pending = handle({ method: init.method ?? 'GET', url: String(url), headers: init.headers ?? {}, body: init.body });
    const response = await (signal ? Promise.race([pending, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) : pending);
    return new Response(response.status === 204 ? null : response.body, { status: response.status, headers: response.headers });
  }

  /** Node http handler for exact-host fixtures. */
  async function serve(request, response) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const result = await handle({ method: request.method, url: `http://fixture${request.url}`, headers: request.headers, body: body || undefined });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  }

  return {
    state, fetch, serve, handle,
    prUrl: () => `https://dev.azure.com/${state.org}/${state.project}/_git/${state.repo}/pullrequest/${state.prId}`,
    snapshot: () => ({ head: state.head, base: state.base, files: state.files }),
    callsTo: route => state.calls.filter(call => call.route === route),
  };
}

/** A tool registry that re-applies plugin transforms to fresh definitions, like OpenCode V2. */
export function toolRegistry(extra = []) {
  const transforms = [];
  let current = new Map();
  const rebuild = () => {
    const tools = new Map(extra.map(tool => [tool.id, { ...tool, options: { ...tool.options } }]));
    const editor = {
      list: () => [...tools.values()],
      get: id => tools.get(id),
      add(tool) { tools.set(tool.name, { ...tool, id: tool.name }); },
      update(id, update) { const tool = tools.get(id); if (tool) update(tool); },
      remove(id) { tools.delete(id); },
    };
    for (const transform of transforms) transform(editor);
    current = tools;
  };
  rebuild();
  return {
    async transform(fn) { transforms.push(fn); rebuild(); return { dispose() { transforms.splice(transforms.indexOf(fn), 1); rebuild(); } }; },
    async list() { return [...current.values()].map(({ execute: _execute, ...rest }) => rest); },
    tool: id => current.get(id),
    // Like OpenCode 2.0.22, only codemode:false tools are offered to models directly.
    names: () => [...current.values()].filter(tool => tool.options?.codemode === false).map(tool => tool.id),
    rebuild,
  };
}
