import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fixtures wait for a terminal receipt, separately from HTTP admission. */
export function withCommandCompletion(raw, milliseconds = 90000) {
  return async (path, body, ...rest) => {
    const tracked = path.endsWith('/command') && /^pr-(review|deep|quick|check|comment)$/.test(body?.name);
    const inbox = path.replace(/\/command$/, '/inbox');
    const before = tracked ? new Set((await raw(inbox, undefined, ...rest)).data.map(item => item.id)) : null;
    const value = await raw(path, body, ...rest);
    if (!tracked) return value;
    const admitted = (await raw(inbox, undefined, ...rest)).data.find(item => !before.has(item.id) && /\] STARTED /.test(item.payload?.text));
    assert.ok(admitted, 'Native command must return a queued start notice before workflow completion.');
    const prefix = admitted.payload.text.split(']')[0] + ']';
    const end = Date.now() + milliseconds;
    do {
      const items = (await raw(inbox, undefined, ...rest)).data;
      if (items.some(item => item.payload?.text?.startsWith(prefix) && /^\[AZPR [a-f0-9]{8}\] [A-Z_]+(?:;|\n|$)/.test(item.payload.text))) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < end);
    throw new Error('Fixture timed out waiting for the admitted workflow receipt.');
  };
}

/**
 * What a run left behind, for the fixture runs with debug off (`--cleanup`):
 * the session IDs a receipt's stage lines name, whether a session still exists
 * on the host, the private sessions the host lists (their titles), and AZPR's
 * session records under the state directory (record ID -> session IDs).
 */
export function privateSessions(raw, stateDirectory) {
  return {
    named: receipt => [...new Set([...receipt.matchAll(/^- azpr-[^\n]*session=(ses_[A-Za-z0-9]+)/gm)].map(match => match[1]))],
    async exists(id) {
      try { return Boolean((await raw(`/api/session/${id}`)).data?.id); }
      catch (error) { if (/: 404 |NotFound/.test(error.message)) return false; throw error; }
    },
    async listed() {
      return ((await raw('/api/session')).data ?? []).map(session => session.title ?? '').filter(title => /^\[AZPR [a-f0-9]{8}\] /.test(title));
    },
    async records() {
      const directory = join(stateDirectory, 'opencode', 'azpr-v2', 'sessions'), found = {};
      for (const name of (await readdir(directory).catch(() => [])).filter(file => file.endsWith('.json'))) {
        found[name.slice(name.lastIndexOf('-') + 1, -'.json'.length)] = JSON.parse(await readFile(join(directory, name), 'utf8'));
      }
      return found;
    },
  };
}
