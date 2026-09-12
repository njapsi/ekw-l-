import { describe, expect, it } from 'vitest';
import { MemoryFrontier } from './frontier.js';
import { ConcurrencyLimiter, HostRateLimiter, withRetry } from './rate-limiter.js';

describe('MemoryFrontier', () => {
  it('dedupes and bounds to maxPages', () => {
    const f = new MemoryFrontier(3, 5);
    expect(f.add('a', 0, 'seed')).toBe(true);
    expect(f.add('a', 0, 'link')).toBe(false); // dup
    expect(f.add('b', 1, 'link')).toBe(true);
    expect(f.add('c', 1, 'link')).toBe(true);
    expect(f.add('d', 1, 'link')).toBe(false); // over budget
    expect(f.atCapacity()).toBe(true);
    expect(f.admitted).toBe(3);
  });

  it('refuses URLs past maxDepth', () => {
    const f = new MemoryFrontier(100, 2);
    expect(f.add('deep', 3, 'link')).toBe(false);
  });

  it('serves shallowest-first, then discovery order', () => {
    const f = new MemoryFrontier(100, 5);
    f.add('root', 0, 'seed');
    f.add('d2-a', 2, 'link');
    f.add('d1-a', 1, 'link');
    f.add('d1-b', 1, 'link');
    expect(f.next()?.normalizedUrl).toBe('root');
    expect(f.next()?.normalizedUrl).toBe('d1-a');
    expect(f.next()?.normalizedUrl).toBe('d1-b');
    expect(f.next()?.normalizedUrl).toBe('d2-a');
    expect(f.next()).toBeUndefined();
  });
});

describe('HostRateLimiter', () => {
  it('spaces successive takes on the same host by the min delay', async () => {
    let clock = 0;
    const slept: number[] = [];
    const rl = new HostRateLimiter(
      100,
      () => clock,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    );
    await rl.take('h');
    await rl.take('h');
    await rl.take('h');
    expect(slept).toEqual([100, 100]);
  });

  it('does not delay a different host', async () => {
    let clock = 0;
    const slept: number[] = [];
    const rl = new HostRateLimiter(
      100,
      () => clock,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    );
    await rl.take('a');
    await rl.take('b');
    expect(slept).toEqual([]);
  });
});

describe('ConcurrencyLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('withRetry', () => {
  it('retries then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1, sleep: async () => undefined },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget and rethrows', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('always');
        },
        { retries: 2, baseDelayMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow('always');
    expect(calls).toBe(3);
  });

  it('respects shouldRetry=false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('nope');
        },
        { retries: 5, baseDelayMs: 1, sleep: async () => undefined, shouldRetry: () => false },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });
});
