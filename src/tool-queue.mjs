/**
 * Bounded Azure DevOps execution shared by every AZPR workflow in this plugin.
 *
 * - `concurrency` limits simultaneous calls; it never limits total work.
 * - Each call has its own timeout. A timed-out call releases its slot at once
 *   and its operation's signal is aborted, so one hung request cannot freeze
 *   every review in the process.
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

  /**
   * Run one operation inside a slot, bounded by its timeout and signal. The
   * operation receives a signal that aborts on timeout or cancellation.
   */
  async function run(operation, { signal, timeoutMs = limits.timeoutMs, label = 'Azure DevOps call' } = {}) {
    await acquire(signal);
    const controller = new AbortController();
    let timer, onAbort;
    try {
      const guards = [];
      if (timeoutMs) guards.push(new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new ToolTimeoutError(label, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }));
      if (signal) guards.push(new Promise((_, reject) => {
        onAbort = () => { controller.abort(abortReason(signal)); reject(abortReason(signal)); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }));
      const work = Promise.resolve().then(() => operation(controller.signal));
      // A result that arrives after a timeout or cancellation is ignored.
      work.catch(() => {});
      return await Promise.race([work, ...guards]);
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
