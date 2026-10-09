/**
 * Bounded MCP execution shared by every private workflow in this plugin.
 *
 * - `concurrency` limits simultaneous MCP calls; it never limits total work.
 * - Each call has its own timeout. A timed-out call releases its slot at once,
 *   so one hung MCP request can no longer freeze every review in the process.
 *   The host cannot cancel the underlying request; its late result is ignored.
 * - Slots are released in `finally`, never by a host hook that might not run.
 */
export class ToolTimeoutError extends Error {
  constructor(label, milliseconds) {
    super(`${label} did not finish within ${Math.round(milliseconds / 1000)} seconds; the call was abandoned and its slot released.`);
    this.name = 'ToolTimeoutError';
    this.timeout = true;
  }
}

const abortReason = signal => signal?.reason instanceof Error ? signal.reason : new Error('Operation cancelled.');

export function createToolQueue({ concurrency = 3, timeoutMs = 120000 } = {}) {
  const limits = { concurrency, timeoutMs };
  const waiting = [];
  let active = 0;

  function pump() {
    while (active < limits.concurrency && waiting.length) {
      const next = waiting.shift();
      next.cleanup();
      active++;
      next.resolve();
    }
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      waiting.push(entry);
      pump();
    });
  }

  /** Run one MCP operation inside a slot, bounded by its timeout and signal. */
  async function run(operation, { signal, timeoutMs = limits.timeoutMs, label = 'MCP tool call' } = {}) {
    await acquire(signal);
    let timer, onAbort;
    try {
      const work = Promise.resolve().then(operation);
      // A result that arrives after a timeout or cancellation is ignored.
      work.catch(() => {});
      const guards = [work];
      if (timeoutMs) guards.push(new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(label, timeoutMs)), timeoutMs);
      }));
      if (signal) guards.push(new Promise((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }));
      return await Promise.race(guards);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      active--;
      pump();
    }
  }

  return {
    run,
    configure({ concurrency: nextConcurrency, timeoutMs: nextTimeout } = {}) {
      if (Number.isInteger(nextConcurrency) && nextConcurrency > 0) limits.concurrency = nextConcurrency;
      if (Number.isInteger(nextTimeout) && nextTimeout > 0) limits.timeoutMs = nextTimeout;
      pump();
    },
    stats: () => ({ active, queued: waiting.length, ...limits }),
  };
}
