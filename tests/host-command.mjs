import assert from 'node:assert/strict';

/** Fixtures wait for a terminal receipt, separately from HTTP admission. */
export function withCommandCompletion(raw, milliseconds = 90000) {
  return async (path, body, ...rest) => {
    const tracked = path.endsWith('/command') && /^pr-(review|deep|check|comment)$/.test(body?.name);
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
