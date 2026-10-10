/**
 * AZPR's read-only Azure DevOps tools for private reviewers.
 *
 * The runtime registers these tools with OpenCode and runs them through the
 * same REST client, queue and per-run cache as its own calls. A tool always
 * works on the repository of the run's snapshot, never on a model-chosen
 * organization or repository, and there are no write tools: only the runtime
 * posts comments. Output is bounded and says how to read further.
 */
import { isCommitSha, normalizePath } from './azure.mjs';
import { DIFF_DEFAULTS, diffHunks, renderHunk, splitLines } from './diff.mjs';

export const REVIEW_TOOLS = Object.freeze({ readDiff: 'azpr_read_diff', readFile: 'azpr_read_file', findFiles: 'azpr_find_files', listFiles: 'azpr_list_files', threads: 'azpr_pr_threads' });
export const REVIEW_TOOL_NAMES = Object.freeze(Object.values(REVIEW_TOOLS));
export const READ_LINES = 1000;
const READ_CHARACTERS = 60000;
const LIST_ENTRIES = 1000;
const FIND_RESULTS = 200;
const THREAD_CHARACTERS = 40000;
const COMMENT_EXCERPT = 2000;
const MARKERS = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
const HAS_MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/;

export class ToolInputError extends Error {
  constructor(message) { super(message); this.name = 'ToolInputError'; }
}

const versionProperty = { type: 'string', description: '"head" (the PR source, default), "base" (the merge base the PR is compared with) or a full 40-character commit SHA.' };

/** Tool definitions without their executors (the runtime adds those). */
export function reviewToolDefinitions() {
  return [
    {
      name: REVIEW_TOOLS.readDiff,
      description: `What the PR changed in one file: BASE → HEAD hunks with ${DIFF_DEFAULTS.before} unchanged lines before and ${DIFF_DEFAULTS.after} after each change, extended to the start of the enclosing block when it is near. Each line reads "<mark> <BASE line> <HEAD line> | text" (mark "-" = only in BASE, "+" = only in HEAD; the prefix is not file content). A new or deleted file shows its whole content. Use azpr_read_file for code outside the hunks.`,
      input: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'Repository path at HEAD (for a renamed file, its new path), such as /src/app.ts.' },
        context: { type: 'integer', minimum: 0, maximum: 50, description: `Unchanged lines before and after each change (default ${DIFF_DEFAULTS.before} before, ${DIFF_DEFAULTS.after} after).` },
        fromHunk: { type: 'integer', minimum: 1, description: 'First hunk to return, when an earlier answer said more hunks follow.' },
      } },
    },
    {
      name: REVIEW_TOOLS.readFile,
      description: `Read one file of the PR repository at an exact commit. Returns numbered lines ("N | text"; the prefix is not file content), at most ${READ_LINES} lines per call; use startLine/endLine for other ranges.`,
      input: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'Repository path such as /src/app.ts.' },
        version: versionProperty,
        startLine: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
        endLine: { type: 'integer', minimum: 1, description: `Last line to return (default: up to ${READ_LINES} lines from startLine).` },
      } },
    },
    {
      name: REVIEW_TOOLS.findFiles,
      description: `Find repository paths by name at an exact commit, instead of guessing them: a glob such as "test_*.py", "tests/**/*.ts" or "/src/**/config*" (without "/" it matches file names), or plain text matched anywhere in the path (case-insensitive). Names only, not file contents; at most ${FIND_RESULTS} results.`,
      input: { type: 'object', additionalProperties: false, required: ['pattern'], properties: {
        pattern: { type: 'string', description: 'Glob or plain text.' },
        path: { type: 'string', description: 'Folder to search (default /).' },
        version: versionProperty,
      } },
    },
    {
      name: REVIEW_TOOLS.listFiles,
      description: `List the files and folders of one repository folder at an exact commit (at most ${LIST_ENTRIES} entries).`,
      input: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', description: 'Folder path (default /).' },
        version: versionProperty,
        recursive: { type: 'boolean', description: 'List every descendant instead of direct children (default false).' },
      } },
    },
    {
      name: REVIEW_TOOLS.threads,
      description: 'Read the discussion threads of the PR under review (deleted and system comments excluded). Long comments are shortened unless threadId selects one thread.',
      input: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', description: 'Only threads on this file path.' },
        threadId: { type: 'integer', minimum: 1, description: 'Return only this thread, with complete comment bodies.' },
      } },
    },
  ];
}

/** "head", "base" or a full SHA, resolved against the run's snapshot. */
export function resolveVersion(version, snapshot) {
  const value = version === undefined || version === null ? 'head' : typeof version === 'string' ? version.trim() : null;
  const baseLabel = snapshot.baseKind === 'target' ? 'BASE (target branch)' : 'BASE (merge base)';
  if (value === null) throw new ToolInputError('version must be a string: "head", "base" or a full commit SHA.');
  if (value === '' || value.toLowerCase() === 'head') return { sha: snapshot.head, label: 'HEAD (PR source)' };
  if (value.toLowerCase() === 'base') return { sha: snapshot.base, label: baseLabel };
  if (isCommitSha(value)) {
    const sha = value.toLowerCase();
    return { sha, label: sha === snapshot.head ? 'HEAD (PR source)' : sha === snapshot.base ? baseLabel : 'commit' };
  }
  throw new ToolInputError(`version "${value.slice(0, 80)}" is not "head", "base" or a full commit SHA.`);
}

function pathArgument(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\0\r\n]/.test(value)) throw new ToolInputError('path must be a repository path such as /src/app.ts.');
  return normalizePath(value.trim());
}
const lineArgument = (value, name) => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new ToolInputError(`${name} must be a positive integer.`);
  return value;
};

/** Numbered lines of one file, bounded by line count and characters. */
export function renderFile(file, { label, startLine, endLine }) {
  const head = `${file.path} at ${label} ${file.version.slice(0, 12)}`;
  if (file.binary) return { text: `${head} is a binary file (${file.size} bytes); its content is not shown.` };
  if (file.tooLarge) return { text: `${head} is larger than AZPR reads (${file.size} bytes); its content is not shown.` };
  const lines = file.text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const total = lines.length;
  if (!total) return { text: `${head} is empty.` };
  if (startLine && startLine > total) return { text: `${head} has ${total} lines; startLine ${startLine} is past the end.` };
  const first = startLine ?? 1;
  let last = Math.min(endLine ?? first + READ_LINES - 1, total, first + READ_LINES - 1);
  if (last < first) throw new ToolInputError('endLine must not be smaller than startLine.');
  const rows = [];
  let characters = 0;
  for (let number = first; number <= last; number++) {
    const row = `${number} | ${lines[number - 1]}`;
    if (rows.length && characters + row.length > READ_CHARACTERS) { last = number - 1; break; }
    rows.push(row);
    characters += row.length + 1;
  }
  const more = last < total ? ` Continue with startLine ${last + 1}.` : '';
  return { text: `${head} — lines ${first}-${last} of ${total}.${more}\nThe "N | " prefixes are line numbers, not file content.\n\n${rows.join('\n')}` };
}

const DIFF_LEGEND = 'Each line is "<mark> <BASE line> <HEAD line> | text": "-" exists only in BASE, "+" only in HEAD, a blank mark in both; the prefix is not file content.';

/** A new or deleted file: its whole content as one-sided diff lines, bounded like a file read. */
function wholeFile(file, { title, mark, version }) {
  const lines = splitLines(file.text);
  if (!lines.length) return `${title}: the file is empty.`;
  const width = String(lines.length).length, pad = number => String(number).padStart(width), blank = ' '.repeat(width);
  const rows = [];
  let characters = 0, last = 0;
  for (let index = 0; index < Math.min(lines.length, READ_LINES); index++) {
    const row = `${mark} ${mark === '+' ? `${blank} ${pad(index + 1)}` : `${pad(index + 1)} ${blank}`} | ${lines[index]}`;
    if (rows.length && characters + row.length > READ_CHARACTERS) break;
    rows.push(row);
    characters += row.length + 1;
    last = index + 1;
  }
  const more = last < lines.length ? `\nLines ${last + 1}-${lines.length} follow: read them with azpr_read_file (version "${version}", startLine ${last + 1}).` : '';
  return `${title}: the whole file (${lines.length} lines) ${mark === '+' ? 'is new in HEAD' : 'exists only in BASE'}.\n${DIFF_LEGEND}${more}\n\n${rows.join('\n')}`;
}

/**
 * BASE → HEAD hunks of one file, bounded by characters with hunk paging.
 * `base`/`head` are file reads, or null where the file does not exist.
 */
export function renderDiff({ path, change, base, head, snapshot, context, fromHunk = 1 }) {
  const kind = change ? `${change.changeType.join(', ') || 'changed'}${change.originalPath ? ` from ${change.originalPath}` : ''}` : 'not in the PR\'s changed files';
  const title = `${path} — BASE ${snapshot.base.slice(0, 12)} → HEAD ${snapshot.head.slice(0, 12)} (${kind})`;
  const unreadable = [base, head].find(file => file?.binary || file?.tooLarge);
  if (unreadable) return `${title}: ${unreadable.binary ? 'binary' : `larger than AZPR reads (${unreadable.size} bytes)`} at ${unreadable === base ? 'BASE' : 'HEAD'}; no diff is shown.`;
  if (!base && !head) return `${title}: the file exists in neither version.`;
  if (!base || !head) return wholeFile(head ?? base, { title, mark: head ? '+' : '-', version: head ? 'head' : 'base' });
  const { hunks, baseLines, headLines } = diffHunks(base.text, head.text, context === undefined ? {} : { before: context, after: context });
  if (!hunks.length) return `${title}: no differences between BASE and HEAD.`;
  if (fromHunk > hunks.length) return `${title} has ${hunks.length} hunk(s); fromHunk ${fromHunk} is past the end.`;
  const width = String(Math.max(baseLines, headLines)).length;
  const parts = [];
  let characters = 0, next = fromHunk - 1;
  while (next < hunks.length) {
    let rendered = renderHunk(hunks[next], width);
    if (parts.length && characters + rendered.length > READ_CHARACTERS) break;
    if (rendered.length > READ_CHARACTERS) {
      rendered = rendered.slice(0, rendered.lastIndexOf('\n', READ_CHARACTERS)) + `\n[The rest of this hunk is not shown; read HEAD lines ${hunks[next].head} or BASE lines ${hunks[next].base} with azpr_read_file.]`;
    }
    parts.push(rendered);
    characters += rendered.length + 2;
    next++;
  }
  const more = next < hunks.length ? `\nHunks ${next + 1}-${hunks.length} follow: call again with fromHunk ${next + 1}.` : '';
  const folded = hunks.filter(hunk => hunk.repeats).length;
  const foldNote = folded ? `\n${folded} hunk(s) repeat an earlier change and are folded to one line: the same lines as the named hunk except for the listed string and number values (earlier→this). Read a folded hunk's exact lines with azpr_read_file.` : '';
  return `${title}: ${hunks.length} hunk(s)${folded ? `, ${folded} folded` : ''}; BASE ${baseLines} lines, HEAD ${headLines} lines.\n${DIFF_LEGEND}${foldNote}${more}\n\n${parts.join('\n\n')}`;
}

/**
 * Name matcher: a glob ("*" within a name, "**" across folders, "?" one
 * character; without "/" it matches the file name) or case-insensitive text.
 */
export function pathMatcher(pattern) {
  if (!/[*?]/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return path => path.toLowerCase().includes(needle);
  }
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp(pattern.startsWith('/') ? `^${source}$` : `(?:^|/)${source}$`, 'i');
  return path => regex.test(path);
}

/** Matching paths of a recursive listing, folders marked with a trailing slash. */
export function renderMatches(items, { pattern, path, label, version }) {
  const match = pathMatcher(pattern);
  const found = (Array.isArray(items) ? items : [])
    .filter(item => typeof item?.path === 'string' && normalizePath(item.path) !== path && match(normalizePath(item.path)))
    .map(item => `${normalizePath(item.path)}${item.isFolder === true || item.gitObjectType === 'tree' ? '/' : ''}`)
    .sort();
  const head = `${found.length} path(s) under ${path} at ${label} ${version.slice(0, 12)} match ${JSON.stringify(pattern)}`;
  if (!found.length) return `${head}. Check the folder with azpr_list_files or try a broader pattern.`;
  const more = found.length > FIND_RESULTS ? `\n${found.length - FIND_RESULTS} more are not shown; narrow the pattern or the folder.` : '';
  return `${head}.\n${found.slice(0, FIND_RESULTS).join('\n')}${more}`;
}

/** Folder entries, folders marked with a trailing slash. */
export function renderListing(items, { path, label, version }) {
  const entries = (Array.isArray(items) ? items : [])
    .filter(item => typeof item?.path === 'string' && normalizePath(item.path) !== path)
    .map(item => `${normalizePath(item.path)}${item.isFolder === true || item.gitObjectType === 'tree' ? '/' : ''}`)
    .sort();
  const shown = entries.slice(0, LIST_ENTRIES);
  const more = entries.length > shown.length ? `\n${entries.length - shown.length} more entries are not shown; list a subfolder instead.` : '';
  return { text: `${path} at ${label} ${version.slice(0, 12)} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.\n${shown.join('\n')}${more}` };
}

/** Live discussion threads in a compact JSON form. */
export function renderThreads(threads, { path, threadId }) {
  const rows = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (thread?.isDeleted === true || (threadId !== undefined && thread?.id !== threadId)) continue;
    const context = thread.threadContext ?? {};
    const file = typeof context.filePath === 'string' ? normalizePath(context.filePath) : null;
    if (path !== undefined && file !== path) continue;
    const comments = (Array.isArray(thread.comments) ? thread.comments : [])
      .filter(comment => comment?.isDeleted !== true && comment?.commentType !== 'system' && typeof comment?.content === 'string' && comment.content.trim())
      .map(comment => {
        const content = comment.content.replace(MARKERS, '').trim();
        const shortened = threadId === undefined && content.length > COMMENT_EXCERPT;
        return { author: comment.author?.displayName ?? comment.author?.uniqueName ?? null, published: comment.publishedDate ?? null,
          content: shortened ? `${content.slice(0, COMMENT_EXCERPT)} [shortened; read threadId ${thread.id} for the full text]` : content };
      });
    if (!comments.length) continue;
    rows.push({ threadId: thread.id, status: thread.status ?? null,
      ...(file ? { path: file, startLine: context.rightFileStart?.line ?? context.leftFileStart?.line ?? null,
        endLine: context.rightFileEnd?.line ?? context.leftFileEnd?.line ?? null, side: context.rightFileStart ? 'right' : context.leftFileStart ? 'left' : null } : {}),
      azpr: (Array.isArray(thread.comments) ? thread.comments : []).some(comment => HAS_MARKER.test(comment?.content ?? '')),
      comments });
  }
  let shown = rows, note = '';
  while (shown.length && JSON.stringify(shown).length > THREAD_CHARACTERS) shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.8)));
  if (shown.length < rows.length) note = `\n${rows.length - shown.length} more thread(s) are not shown; filter by path or threadId.`;
  if (threadId !== undefined && !rows.length) return { text: `Thread ${threadId} does not exist on this PR or has no live comments.` };
  return { text: `${rows.length} live thread(s)${path ? ` on ${path}` : ''}.${note}\n${JSON.stringify(shown, null, 1)}` };
}

/**
 * Run one tool for an authorized private session. Returns the visible text and,
 * for file reads, the observed source for later anchor checks.
 */
export async function runReviewTool(name, input, { azure, run, snapshot }) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === REVIEW_TOOLS.readDiff) {
    const path = pathArgument(args.path);
    if (args.context !== undefined && (!Number.isInteger(args.context) || args.context < 0 || args.context > 50)) throw new ToolInputError('context must be an integer from 0 to 50.');
    const fromHunk = lineArgument(args.fromHunk, 'fromHunk') ?? 1;
    const change = (snapshot.changes ?? []).find(item => item.path === path);
    const types = change?.changeType ?? [];
    // A missing version is part of the answer (an added or deleted file), not an error.
    const read = async (filePath, version, absent) => {
      if (absent) return null;
      try { return await azure.readFile(run, snapshot, filePath, version); }
      catch (error) { if (error?.kind === 'not-found') return null; throw error; }
    };
    const [base, head] = await Promise.all([read(change?.originalPath ?? path, snapshot.base, types.includes('add')), read(path, snapshot.head, types.includes('delete'))]);
    const text = renderDiff({ path, change, base, head, snapshot, context: args.context, fromHunk });
    return { text, ...(typeof head?.text === 'string' ? { observation: { path, version: snapshot.head, text: head.text } } : {}) };
  }
  if (name === REVIEW_TOOLS.findFiles) {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern || pattern.length > 300 || /[\0\r\n]/.test(pattern)) throw new ToolInputError('pattern must be a glob such as "test_*.py" or plain text.');
    const path = pathArgument(args.path, '/');
    const { sha, label } = resolveVersion(args.version, snapshot);
    return { text: renderMatches(await azure.listItems(run, snapshot, path, sha, true), { pattern, path, label, version: sha }) };
  }
  if (name === REVIEW_TOOLS.readFile) {
    const path = pathArgument(args.path);
    const { sha, label } = resolveVersion(args.version, snapshot);
    const startLine = lineArgument(args.startLine, 'startLine'), endLine = lineArgument(args.endLine, 'endLine');
    if (startLine && endLine && endLine < startLine) throw new ToolInputError('endLine must not be smaller than startLine.');
    const file = await azure.readFile(run, snapshot, path, sha);
    return { ...renderFile(file, { label, startLine, endLine }), ...(typeof file.text === 'string' ? { observation: { path, version: sha, text: file.text } } : {}) };
  }
  if (name === REVIEW_TOOLS.listFiles) {
    const path = pathArgument(args.path, '/');
    const { sha, label } = resolveVersion(args.version, snapshot);
    if (args.recursive !== undefined && typeof args.recursive !== 'boolean') throw new ToolInputError('recursive must be true or false.');
    return renderListing(await azure.listItems(run, snapshot, path, sha, args.recursive === true), { path, label, version: sha });
  }
  if (name === REVIEW_TOOLS.threads) {
    const path = args.path === undefined ? undefined : pathArgument(args.path);
    if (args.threadId !== undefined && (!Number.isInteger(args.threadId) || args.threadId < 1)) throw new ToolInputError('threadId must be a positive integer.');
    return renderThreads(await azure.threads(run, snapshot), { path, threadId: args.threadId });
  }
  throw new ToolInputError(`Unknown AZPR tool ${name}.`);
}
