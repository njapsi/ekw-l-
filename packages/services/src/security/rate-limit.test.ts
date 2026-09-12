import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny in-memory stand-in for the observability Redis client.
const store = new Map<string, { value: number; expireAt: number }>();
const fakeRedis = {
  status: 'ready' as string,
  connect: vi.fn(async () => undefined),
  async incr(key: string) {
    const now = Date.now();
    const cur = store.get(key);
    if (cur && cur.expireAt > now) {
      cur.value += 1;
      return cur.value;
    }
    store.set(key, { value: 1, expireAt: Number.MAX_SAFE_INTEGER });
    return 1;
  },
  async expire(key: string, sec: number) {
    const cur = store.get(key);
    if (cur) cur.expireAt = Date.now() + sec * 1000;
    return 1;
  },
};

vi.mock('../observability/redis.js', () => ({
  getObservabilityRedis: () => fakeRedis,
}));

const { checkRateLimit, clientIpFrom, resetRateLimitWarnForTest } = await import('./rate-limit.js');

beforeEach(() => {
  store.clear();
  fakeRedis.status = 'ready';
  resetRateLimitWarnForTest();
});
afterEach(() => vi.clearAllMocks());

describe('checkRateLimit', () => {
  it('allows up to the limit then blocks, with a retry hint', async () => {
    const key = 'magic-link:alice@example.com';
    for (let i = 0; i < 3; i += 1) {
      const r = await checkRateLimit({ key, limit: 3, windowSec: 60 });
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(3 - (i + 1));
    }
    const blocked = await checkRateLimit({ key, limit: 3, windowSec: 60 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('keeps separate counters per key', async () => {
    await checkRateLimit({ key: 'a', limit: 1, windowSec: 60 });
    const a2 = await checkRateLimit({ key: 'a', limit: 1, windowSec: 60 });
    const b1 = await checkRateLimit({ key: 'b', limit: 1, windowSec: 60 });
    expect(a2.ok).toBe(false);
    expect(b1.ok).toBe(true);
  });

  it('fails OPEN when Redis errors (never locks users out)', async () => {
    fakeRedis.incr = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await checkRateLimit({ key: 'x', limit: 1, windowSec: 60 });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
  });
});

describe('clientIpFrom', () => {
  it('takes the first x-forwarded-for hop', () => {
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });
  it('falls back to x-real-ip then "unknown"', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIpFrom(new Headers())).toBe('unknown');
  });
});
