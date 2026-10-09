// Offline stand-in for @azure-devops/mcp repository tools, shaped like the
// OpenCode MCP executor results the runtime receives ({ output, content }).
export function fakeAzure(options = {}) {
  const state = {
    org: options.org ?? 'org', project: options.project ?? 'proj', repo: options.repo ?? 'repo', prId: options.prId ?? 123,
    head: options.head ?? 'b'.repeat(40), base: options.base ?? 'a'.repeat(40), status: options.status ?? 1,
    files: options.files ?? ['/src/Main.java'], filesComplete: options.filesComplete ?? true,
    sources: options.sources ?? {}, threads: [], nextThread: 1000, calls: [], fail: {}, afterVersions: null,
  };
  const pr = () => ({
    pullRequestId: state.prId, status: state.status, title: 'Fixture PR', description: 'Fixture description',
    url: `https://dev.azure.com/${state.org}/pid/_apis/git/repositories/rid/pullRequests/${state.prId}`,
    repository: { id: 'rid', name: state.repo, project: { id: 'pid', name: state.project } },
    lastMergeSourceCommit: { commitId: state.head }, lastMergeTargetCommit: { commitId: state.base },
    sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
  });
  const handlers = {
    repo_pull_request: args => {
      // The first read is the snapshot; later reads can report moved versions.
      if (!args.includeChangedFiles && state.afterVersions) Object.assign(state, state.afterVersions);
      return { ...pr(), ...(args.includeChangedFiles ? { changedFilesSummary: {
        changeEntries: state.files.map(path => ({ changeType: 2, item: { path } })), fileCount: state.files.length,
        ...(state.filesComplete ? {} : { nextSkip: state.files.length, nextTop: 100 }) } } : {}) };
    },
    repo_pull_request_thread: args => state.threads.filter(thread => !thread.deleted).slice(args.skip ?? 0, (args.skip ?? 0) + (args.top ?? 100)),
    repo_pull_request_thread_write: args => {
      const thread = { id: state.nextThread++, status: 'active', comments: [{ id: 1, content: args.content }],
        threadContext: args.filePath ? { filePath: args.filePath, rightFileStart: { line: args.rightFileStartLine, offset: args.rightFileStartOffset }, rightFileEnd: { line: args.rightFileEndLine, offset: args.rightFileEndOffset } } : null };
      state.threads.push(thread);
      return thread;
    },
    repo_file: args => state.sources[args.path] ?? `fixture code\nsecond line of ${args.path}\n`,
  };
  const execute = name => async (args, execution) => {
    state.calls.push({ name, args, execution });
    const failure = state.fail[name];
    if (typeof failure === 'function') {
      const replaced = await failure(args, state, execution);
      if (replaced !== undefined) return replaced;
    } else if (failure) {
      throw Object.assign(new Error(failure), { _tag: 'Tool.Error' });
    }
    const value = handlers[name](args);
    return { output: value, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
  };
  const definitions = () => Object.keys(handlers).map(name => ({ id: `ado_${name}`, name, options: { namespace: 'ado', codemode: false }, description: name, execute: execute(name) }));
  return {
    state,
    definitions,
    list: () => definitions().map(({ execute: _execute, ...rest }) => rest),
    prUrl: () => `https://dev.azure.com/${state.org}/${state.project}/_git/${state.repo}/pullrequest/${state.prId}`,
    snapshot: () => ({ head: state.head, base: state.base, files: state.files }),
  };
}

/** A tool registry that re-applies plugin transforms to fresh definitions. */
export function toolRegistry(azure, extra = []) {
  const transforms = [];
  let current = new Map();
  const rebuild = () => {
    const tools = new Map([...azure.definitions(), ...extra].map(tool => [tool.id, { ...tool, options: { ...tool.options } }]));
    for (const transform of transforms) transform({ list: () => [...tools.values()], get: id => tools.get(id), update(id, update) { const tool = tools.get(id); if (tool) update(tool); } });
    current = tools;
  };
  rebuild();
  return {
    async transform(fn) { transforms.push(fn); rebuild(); return { dispose() { transforms.splice(transforms.indexOf(fn), 1); rebuild(); } }; },
    async list() { return [...current.values()].map(({ execute: _execute, ...rest }) => rest); },
    tool: id => current.get(id),
    rebuild,
  };
}
