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
import { repositoryArchive, searchArchive } from './search.mjs';

export const REVIEW_TOOLS = Object.freeze({ readDiff: 'azpr_read_diff', readFile: 'azpr_read_file', searchCode: 'azpr_search_code', findFiles: 'azpr_find_files', listFiles: 'azpr_list_files', threads: 'azpr_pr_threads' });
export const REVIEW_TOOL_NAMES = Object.freeze(Object.values(REVIEW_TOOLS));
export const READ_LINES = 1000;
/**
 * OpenCode keeps only a preview of a tool output over 51,200 bytes (its
 * default tool_output.max_bytes) and saves the rest where private reviewers
 * cannot read it, so every AZPR tool answer stays below that in UTF-8 bytes.
 */
const OUTPUT_BYTES = 48000;
const READ_BYTES = 45000;
const LIST_ENTRIES = 1000;
const FIND_RESULTS = 200;
const THREAD_BYTES = 40000;
const COMMENT_EXCERPT = 2000;
const MARKERS = /<!-- azpr-comment:[a-f0-9]{32} -->/g;
const HAS_MARKER = /<!-- azpr-comment:[a-f0-9]{32} -->/;

export class ToolInputError extends Error {
  constructor(message) { super(message); this.name = 'ToolInputError'; }
}

const bytes = text => Buffer.byteLength(text);
/** End index of the longest part of `text` from `start` within `budget` UTF-8 bytes; never splits a surrogate pair. */
function fitEnd(text, start, budget) {
  let used = 0, index = start;
  while (index < text.length) {
    const code = text.codePointAt(index);
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + width > budget) break;
    used += width;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}
/** How many of `rows` (joined by newlines) fit in `budget` bytes. */
function fitting(rows, budget) {
  let used = 0, count = 0;
  for (const row of rows) { used += bytes(row) + 1; if (used > budget) break; count++; }
  return count;
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
      description: `Read one file of the PR repository at an exact commit. Returns numbered lines ("N | text"; the prefix is not file content), at most ${READ_LINES} lines per call; use startLine/endLine for other ranges, and startColumn to continue a line too long for one read.`,
      input: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'Repository path such as /src/app.ts.' },
        version: versionProperty,
        startLine: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
        endLine: { type: 'integer', minimum: 1, description: `Last line to return (default: up to ${READ_LINES} lines from startLine).` },
        startColumn: { type: 'integer', minimum: 1, description: 'Character position in startLine to start from (default 1); the answer names it when a long line continues.' },
      } },
    },
    {
      name: REVIEW_TOOLS.searchCode,
      description: 'Search the contents of every text file of the repository at an exact commit for literal text (not a regular expression), such as a function, class, type or configuration key: find definitions, callers and the code a test exercises, changed or not. Returns "path:line: text" matches, at most 100 (20 per file).',
      input: { type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', description: 'Literal text to find, 2-200 characters on one line.' },
        path: { type: 'string', description: 'Limit to a folder such as /src, or a name glob such as "*.py" or "tests/**/*.ts".' },
        version: versionProperty,
        caseSensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
        wholeWord: { type: 'boolean', description: 'Match whole identifiers only (default false).' },
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

/**
 * Numbered lines of one file, bounded by line count and bytes. A line longer
 * than one read is shown in parts: startColumn continues it, so no source is
 * out of reach.
 */
export function renderFile(file, { label, startLine, endLine, startColumn }) {
  const head = `${file.path} at ${label} ${file.version.slice(0, 12)}`;
  if (file.binary) return { text: `${head} is a binary file (${file.size} bytes); its content is not shown.` };
  if (file.tooLarge) return { text: `${head} is larger than AZPR reads (${file.size} bytes); its content is not shown.` };
  const lines = file.text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const total = lines.length;
  if (!total) return { text: `${head} is empty.` };
  if (startLine && startLine > total) return { text: `${head} has ${total} lines; startLine ${startLine} is past the end.` };
  const first = startLine ?? 1, column = startColumn ?? 1;
  if (column > 1 && column > lines[first - 1].length) return { text: `${head}: line ${first} has ${lines[first - 1].length} characters; startColumn ${column} is past its end.` };
  let last = Math.min(endLine ?? first + READ_LINES - 1, total, first + READ_LINES - 1);
  if (last < first) throw new ToolInputError('endLine must not be smaller than startLine.');
  const rows = [];
  let used = 0, cut;
  for (let number = first; number <= last; number++) {
    const from = number === first ? column - 1 : 0, prefix = `${number} | `, line = lines[number - 1];
    const row = prefix + (from ? line.slice(from) : line);
    if (used + bytes(row) + 1 <= READ_BYTES) { rows.push(row); used += bytes(row) + 1; continue; }
    if (rows.length) { last = number - 1; break; }
    const end = fitEnd(line, from, READ_BYTES - bytes(prefix) - 1);
    rows.push(prefix + line.slice(from, end));
    cut = { number, next: end + 1, length: line.length };
    last = number;
    break;
  }
  const part = column > 1 || cut ? ` (line ${first} from character ${column}${cut ? ` to ${cut.next - 1} of ${cut.length}` : ''})` : '';
  const more = cut ? ` Line ${cut.number} continues: call again with startLine ${cut.number} and startColumn ${cut.next}.`
    : last < total ? ` Continue with startLine ${last + 1}.` : '';
  return { text: `${head} — lines ${first}-${last} of ${total}${part}.${more}\nThe "N | " prefixes are line numbers, not file content.\n\n${rows.join('\n')}` };
}

const DIFF_LEGEND = 'Each line is "<mark> <BASE line> <HEAD line> | text": "-" exists only in BASE, "+" only in HEAD, a blank mark in both; the prefix is not file content.';

/** A new or deleted file: its whole content as one-sided diff lines, bounded like a file read. */
function wholeFile(file, { title, mark, version }) {
  const lines = splitLines(file.text);
  if (!lines.length) return `${title}: the file is empty.`;
  const width = String(lines.length).length, pad = number => String(number).padStart(width), blank = ' '.repeat(width);
  const rows = [];
  let used = 0, last = 0, more = '';
  for (let index = 0; index < Math.min(lines.length, READ_LINES); index++) {
    const prefix = `${mark} ${mark === '+' ? `${blank} ${pad(index + 1)}` : `${pad(index + 1)} ${blank}`} | `, row = prefix + lines[index];
    if (used + bytes(row) + 1 <= READ_BYTES) { rows.push(row); used += bytes(row) + 1; last = index + 1; continue; }
    if (!rows.length) {
      const end = fitEnd(lines[index], 0, READ_BYTES - bytes(prefix) - 1);
      rows.push(prefix + lines[index].slice(0, end));
      more = `\nLine 1 has ${lines[index].length} characters; continue it with azpr_read_file (version "${version}", startLine 1, startColumn ${end + 1}).`;
      last = 1;
    }
    break;
  }
  if (!more && last < lines.length) more = `\nLines ${last + 1}-${lines.length} follow: read them with azpr_read_file (version "${version}", startLine ${last + 1}).`;
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
    if (parts.length && characters + bytes(rendered) > READ_BYTES) break;
    if (bytes(rendered) > READ_BYTES) {
      const end = fitEnd(rendered, 0, READ_BYTES - 300), cut = rendered.lastIndexOf('\n', end);
      rendered = rendered.slice(0, cut > 0 ? cut : end) + `\n[The rest of this hunk is not shown; read HEAD lines ${hunks[next].head} or BASE lines ${hunks[next].base} with azpr_read_file.]`;
    }
    parts.push(rendered);
    characters += bytes(rendered) + 2;
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
  const shown = found.slice(0, fitting(found.slice(0, FIND_RESULTS), READ_BYTES));
  const more = found.length > shown.length ? `\n${found.length - shown.length} more are not shown; narrow the pattern or the folder.` : '';
  return `${head}.\n${shown.join('\n')}${more}`;
}

/** A path filter: a folder (its files and subfolders) or a glob. */
function scopeFilter(value) {
  if (value === undefined) return () => true;
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\0\r\n]/.test(value)) throw new ToolInputError('path must be a folder such as /src or a glob such as "*.py".');
  if (/[*?]/.test(value)) return pathMatcher(value.trim());
  const folder = normalizePath(value.trim()).replace(/\/+$/, '');
  return folder ? path => path === folder || path.startsWith(folder + '/') : () => true;
}

/** Search results as "path:line: text", with what was searched. */
export function renderSearch(result, { query, label, version, archive }) {
  const notes = [archive.skipped.large && `${archive.skipped.large} file(s) over 2 MB`, archive.truncated && 'files beyond the in-memory limit']
    .filter(Boolean);
  const scope = `${result.searched} text file(s) at ${label} ${version.slice(0, 12)}${notes.length ? `; not searched: ${notes.join(', ')}` : ''}`;
  if (!result.total) return `No match for ${JSON.stringify(query)} in ${scope}. Try a shorter or different name, or find files with azpr_find_files.`;
  const rows = result.matches.map(match => `${match.path}:${match.line}: ${match.text}`);
  const shown = rows.slice(0, fitting(rows, READ_BYTES));
  const more = result.total > shown.length ? `\nShowing ${shown.length} of ${result.total}; narrow with path or wholeWord.` : '';
  return `${result.total} match(es) for ${JSON.stringify(query)} in ${result.files} file(s) (searched ${scope}).${more}\n${shown.join('\n')}`;
}

/** Folder entries, folders marked with a trailing slash. */
export function renderListing(items, { path, label, version }) {
  const entries = (Array.isArray(items) ? items : [])
    .filter(item => typeof item?.path === 'string' && normalizePath(item.path) !== path)
    .map(item => `${normalizePath(item.path)}${item.isFolder === true || item.gitObjectType === 'tree' ? '/' : ''}`)
    .sort();
  const shown = entries.slice(0, fitting(entries.slice(0, LIST_ENTRIES), READ_BYTES));
  const more = entries.length > shown.length ? `\n${entries.length - shown.length} more entries are not shown; list a subfolder instead.` : '';
  return { text: `${path} at ${label} ${version.slice(0, 12)} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.\n${shown.join('\n')}${more}` };
}

const threadText = shown => JSON.stringify(shown, null, 1);

/** One thread cut to THREAD_BYTES: whole comments first, then the start of the next one. */
function boundThread(row) {
  // Compact JSON bytes leave room for the indentation of the shown form.
  const budget = THREAD_BYTES * 0.85 - bytes(JSON.stringify({ ...row, comments: [], omittedComments: row.comments.length }));
  const comments = [];
  let used = 0;
  for (const comment of row.comments) {
    const size = bytes(JSON.stringify(comment)) + 1;
    if (used + size <= budget) { comments.push(comment); used += size; continue; }
    const marker = ' [shortened: this thread is longer than AZPR shows]';
    const room = budget - used - bytes(JSON.stringify({ ...comment, content: marker })) - 1;
    if (room > 0) comments.push({ ...comment, content: comment.content.slice(0, fitEnd(comment.content, 0, room / 1.2)) + marker });
    break;
  }
  const bounded = () => ({ ...row, comments, ...(row.comments.length > comments.length ? { omittedComments: row.comments.length - comments.length } : {}) });
  while (comments.length > 1 && bytes(threadText([bounded()])) > THREAD_BYTES) comments.pop();
  return bounded();
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
  while (shown.length > 1 && bytes(threadText(shown)) > THREAD_BYTES) shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.8)));
  // A single thread that is still too long is cut inside, so the loop always ends.
  if (shown.length === 1 && bytes(threadText(shown)) > THREAD_BYTES) shown = [boundThread(shown[0])];
  if (shown.length < rows.length) note = `\n${rows.length - shown.length} more thread(s) are not shown; filter by path or threadId.`;
  if (threadId !== undefined && !rows.length) return { text: `Thread ${threadId} does not exist on this PR or has no live comments.` };
  return { text: `${rows.length} live thread(s)${path ? ` on ${path}` : ''}.${note}\n${threadText(shown)}` };
}

/**
 * Run one tool for an authorized private session. Returns the visible text and,
 * for file reads, the observed source for later anchor checks.
 */
export async function runReviewTool(name, input, context) {
  const result = await reviewTool(name, input, context);
  if (bytes(result.text) <= OUTPUT_BYTES) return result;
  // Every renderer is bounded below this; the cut is only a safety net.
  return { ...result, text: `${result.text.slice(0, fitEnd(result.text, 0, OUTPUT_BYTES - 200))}\n[Output cut to the tool-output limit; request a narrower range.]` };
}

async function reviewTool(name, input, { azure, run, snapshot }) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // Models often send an optional argument as null or "": that means not given.
  const args = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && !(typeof value === 'string' && !value.trim())));
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
  if (name === REVIEW_TOOLS.searchCode) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (query.trim().length < 2 || query.length > 200 || /[\0\r\n]/.test(query)) throw new ToolInputError('query must be literal text of 2 to 200 characters on one line.');
    for (const key of ['caseSensitive', 'wholeWord']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new ToolInputError(`${key} must be true or false.`);
    const include = scopeFilter(args.path);
    const { sha, label } = resolveVersion(args.version, snapshot);
    const archive = await repositoryArchive(run, azure, snapshot, sha);
    if (archive.unavailable) return { text: `Content search is unavailable for this repository: ${archive.unavailable}. Find files with azpr_find_files and read them with azpr_read_file.` };
    return { text: renderSearch(searchArchive(archive, { query, caseSensitive: args.caseSensitive === true, wholeWord: args.wholeWord === true, include }), { query, label, version: sha, archive }) };
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
    const startColumn = lineArgument(args.startColumn, 'startColumn');
    if (startLine && endLine && endLine < startLine) throw new ToolInputError('endLine must not be smaller than startLine.');
    if (startColumn && !startLine) throw new ToolInputError('startColumn continues startLine; give both.');
    const file = await azure.readFile(run, snapshot, path, sha);
    return { ...renderFile(file, { label, startLine, endLine, startColumn }), ...(typeof file.text === 'string' ? { observation: { path, version: sha, text: file.text } } : {}) };
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
