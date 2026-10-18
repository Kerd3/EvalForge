/** A process-local FIFO semaphore for bounding calls to an external provider. */
export function createConcurrencyLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Concurrency limit must be a positive integer');
  let active = 0;
  const waiters = [];

  async function acquire() {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
  }

  return async function runWithLimit(operation) {
    await acquire();
    try { return await operation(); }
    finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}
