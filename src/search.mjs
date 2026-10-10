/**
 * Content search over the repository at one exact commit. The runtime reads
 * the whole repository once per run and commit as a zip (Azure DevOps items
 * API), keeps its text files in memory and searches them for literal text, so
 * reviewers can find callers, definitions and the code a test exercises,
 * changed or not. Nothing here executes repository content.
 */
import { inflateRawSync } from 'node:zlib';
import { isBinary } from './azure.mjs';

export const SEARCH_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, textBytes: 256 * 1024 * 1024, files: 200000 });
const MATCHES = 100, PER_FILE = 20, LINE_CHARACTERS = 240;

export class ArchiveError extends Error {
  constructor(message) { super(message); this.name = 'ArchiveError'; }
}

const u16 = (bytes, at) => bytes[at] | bytes[at + 1] << 8;
const u32 = (bytes, at) => (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/**
 * Text files of a zip archive (stored or deflated entries). ZIP64 and
 * encrypted archives are refused; binary and oversized files are skipped, and
 * inflation is bounded so a crafted archive cannot exhaust memory.
 * @returns {{files: Map<string, string>, skipped: {binary: number, large: number}, truncated: boolean}}
 */
export function readZip(bytes, limits = SEARCH_LIMITS) {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (u32(bytes, at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new ArchiveError('the repository archive is not a zip file');
  const entries = u16(bytes, end + 10), directorySize = u32(bytes, end + 12), directory = u32(bytes, end + 16);
  if (entries === 0xffff || directory === 0xffffffff || directorySize === 0xffffffff) throw new ArchiveError('the repository archive needs ZIP64, which AZPR does not read');
  if (entries > limits.files) throw new ArchiveError(`the repository has more than ${limits.files} files`);
  const decoder = new TextDecoder('utf-8');
  const files = new Map(), skipped = { binary: 0, large: 0 };
  let at = directory, text = 0, truncated = false;
  for (let index = 0; index < entries; index++) {
    if (u32(bytes, at) !== 0x02014b50) throw new ArchiveError('the repository archive has a damaged directory');
    const flags = u16(bytes, at + 8), method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20), size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32), local = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ArchiveError('the repository archive is encrypted');
    if (size > limits.fileBytes) { skipped.large++; continue; }
    if (text + size > limits.textBytes) { truncated = true; break; }
    if (u32(bytes, local) !== 0x04034b50) throw new ArchiveError('the repository archive has a damaged entry');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + compressed);
    let content;
    if (method === 0) content = data;
    else if (method === 8) {
      try { content = inflateRawSync(data, { maxOutputLength: size + 1 }); }
      catch { throw new ArchiveError(`the repository archive entry ${name} could not be inflated`); }
    } else throw new ArchiveError(`the repository archive uses an unsupported compression (${method})`);
    if (content.length !== size) throw new ArchiveError(`the repository archive entry ${name} has a wrong size`);
    if (isBinary(content)) { skipped.binary++; continue; }
    files.set('/' + name.replace(/^\.?\/+/, ''), decoder.decode(content));
    text += size;
  }
  return { files, skipped, truncated };
}

/**
 * The searchable repository at one commit, read once per run. A repository
 * that cannot be searched (too large, ZIP64) is cached as unavailable.
 */
export function repositoryArchive(run, azure, snapshot, version) {
  const cache = run.archives ??= new Map();
  if (!cache.has(version)) {
    const pending = (async () => {
      const result = await azure.archive(run, snapshot, version);
      if (result.tooLarge) return { unavailable: `the repository archive is larger than the azure.archiveMegabytes setting allows (${result.size} bytes)` };
      try { return readZip(result.bytes); }
      catch (error) { if (error instanceof ArchiveError) return { unavailable: error.message }; throw error; }
    })();
    cache.set(version, pending);
    pending.catch(() => cache.delete(version));
  }
  return cache.get(version);
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lines that contain literal text, in path order, bounded per file and in
 * total. Only escaped literals become regular expressions, so a query cannot
 * make the search backtrack.
 * @param {{files: Map<string, string>}} archive
 * @param {{query: string, caseSensitive?: boolean, wholeWord?: boolean, include?: (path: string) => boolean}} options
 */
/** A long line is shown around its first match, so any part of it can be found. */
function excerpt(line, pattern) {
  if (line.length <= LINE_CHARACTERS) return line;
  const start = Math.max(0, Math.min(line.search(pattern) - 80, line.length - LINE_CHARACTERS));
  return `${start ? '…' : ''}${line.slice(start, start + LINE_CHARACTERS)}${start + LINE_CHARACTERS < line.length ? '…' : ''}`;
}

export function searchArchive(archive, { query, caseSensitive = false, wholeWord = false, include = () => true }) {
  const source = wholeWord ? `(?<![A-Za-z0-9_])${escapeRegExp(query)}(?![A-Za-z0-9_])` : escapeRegExp(query);
  const pattern = new RegExp(source, caseSensitive ? '' : 'i');
  const matches = [];
  let total = 0, files = 0, searched = 0;
  for (const path of [...archive.files.keys()].sort()) {
    if (!include(path)) continue;
    searched++;
    const text = archive.files.get(path);
    if (!pattern.test(text)) continue;
    files++;
    let inFile = 0;
    text.split('\n').forEach((line, index) => {
      if (!pattern.test(line)) return;
      total++;
      if (inFile++ >= PER_FILE || matches.length >= MATCHES) return;
      const trimmed = line.replace(/\r$/, '').trim();
      matches.push({ path, line: index + 1, text: excerpt(trimmed, pattern) });
    });
  }
  return { matches, total, files, searched };
}
