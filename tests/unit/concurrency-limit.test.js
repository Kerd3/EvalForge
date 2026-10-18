import { describe, expect, it } from 'vitest';
import { createConcurrencyLimit } from '../../src/providers/concurrency-limit.js';

describe('provider concurrency limit', () => {
  it('never runs more than the configured number of calls and releases slots on failure', async () => {
    const runWithLimit = createConcurrencyLimit(2);
    let active = 0;
    let maximum = 0;
    const operation = async (fail = false) => runWithLimit(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (fail) throw new Error('provider failed');
      return 'ok';
    });

    const results = await Promise.allSettled([operation(true), operation(), operation(), operation()]);
    expect(maximum).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(await operation()).toBe('ok');
  });
});
