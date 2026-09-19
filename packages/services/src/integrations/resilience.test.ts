import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  IntegrationApiError,
  classifyHttpStatus,
  parseRetryAfter,
  resetBreakers,
  resilientCall,
  toIntegrationError,
  withRetry,
  withTimeout,
} from './resilience.js';

const noSleep = vi.fn(async (_ms: number) => {});

beforeEach(() => {
  noSleep.mockClear();
  resetBreakers();
});

describe('classifyHttpStatus', () => {
  it('maps statuses onto the shared vocabulary', () => {
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(403)).toBe('permission');
    expect(classifyHttpStatus(404)).toBe('not_found');
    expect(classifyHttpStatus(422)).toBe('validation');
    expect(classifyHttpStatus(429)).toBe('rate_limited');
    expect(classifyHttpStatus(503)).toBe('server');
  });

  it('marks only transient kinds retryable', () => {
    expect(new IntegrationApiError('x', 'rate_limited', 'm').retryable).toBe(true);
    expect(new IntegrationApiError('x', 'server', 'm').retryable).toBe(true);
    expect(new IntegrationApiError('x', 'auth', 'm').retryable).toBe(false);
    expect(new IntegrationApiError('x', 'validation', 'm').retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and caps it', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('3600')).toBe(60_000);
  });

  it('parses an HTTP date', () => {
    const now = Date.parse('2026-09-19T12:00:00Z');
    expect(parseRetryAfter('Sat, 19 Sep 2026 12:00:05 GMT', now)).toBe(5000);
  });

  it('ignores garbage', () => {
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('toIntegrationError', () => {
  it('recognises timeouts and network failures', () => {
    expect(toIntegrationError('p', new Error('request timed out')).kind).toBe('timeout');
    expect(toIntegrationError('p', new Error('connect ECONNREFUSED')).kind).toBe('network');
  });
});

describe('withRetry', () => {
  it('retries transient failures and then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new IntegrationApiError('p', 'server', 'boom', 503);
        return 'ok';
      },
      { retries: 2, sleep: noSleep, random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it('never retries an auth failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new IntegrationApiError('p', 'auth', 'bad token', 401);
        },
        { retries: 5, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(1);
  });

  it("honours the provider's Retry-After over its own backoff", async () => {
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new IntegrationApiError('p', 'rate_limited', 'slow down', 429, 7000);
        return 'ok';
      },
      { retries: 1, sleep: noSleep },
    );
    expect(noSleep).toHaveBeenCalledWith(7000);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new IntegrationApiError('p', 'server', 'down', 500);
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toBe(3);
  });

  it('keeps every backoff within the jittered ceiling', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new IntegrationApiError('p', 'server', 'down');
        },
        {
          retries: 4,
          baseDelayMs: 100,
          maxDelayMs: 300,
          random: () => 0.999,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toThrow();
    expect(delays.every((d) => d <= 300)).toBe(true);
  });
});

describe('withTimeout', () => {
  it('rejects with a timeout error when the promise stalls', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'p')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold of transient failures and fails fast', async () => {
    const t = 0;
    const cb = new CircuitBreaker('p', { failureThreshold: 2, cooldownMs: 1000, now: () => t });
    const fail = () =>
      cb.run(async () => {
        throw new IntegrationApiError('p', 'server', 'down');
      });
    await expect(fail()).rejects.toThrow();
    await expect(fail()).rejects.toThrow();
    expect(cb.state).toBe('open');

    const spy = vi.fn(async () => 'ok');
    await expect(cb.run(spy)).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not trip on credential errors', async () => {
    const cb = new CircuitBreaker('p', { failureThreshold: 1 });
    await expect(
      cb.run(async () => {
        throw new IntegrationApiError('p', 'auth', 'bad token');
      }),
    ).rejects.toThrow();
    expect(cb.state).toBe('closed');
  });

  it('closes again after a successful half-open trial', async () => {
    let t = 0;
    const cb = new CircuitBreaker('p', { failureThreshold: 1, cooldownMs: 1000, now: () => t });
    await expect(
      cb.run(async () => {
        throw new IntegrationApiError('p', 'server', 'down');
      }),
    ).rejects.toThrow();
    t = 1500;
    expect(cb.state).toBe('half_open');
    await expect(cb.run(async () => 'ok')).resolves.toBe('ok');
    expect(cb.state).toBe('closed');
  });

  it('re-opens if the half-open trial fails', async () => {
    let t = 0;
    const cb = new CircuitBreaker('p', { failureThreshold: 3, cooldownMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) {
      await expect(
        cb.run(async () => {
          throw new IntegrationApiError('p', 'server', 'down');
        }),
      ).rejects.toThrow();
    }
    t = 1500;
    await expect(
      cb.run(async () => {
        throw new IntegrationApiError('p', 'server', 'still down');
      }),
    ).rejects.toThrow();
    expect(cb.state).toBe('open');
  });
});

describe('resilientCall', () => {
  it('composes timeout + retry + breaker', async () => {
    let calls = 0;
    const out = await resilientCall(
      async () => {
        calls += 1;
        if (calls === 1) throw new IntegrationApiError('p', 'network', 'reset');
        return 42;
      },
      { provider: 'p', breakerKey: 'p', retries: 1, sleep: noSleep, timeoutMs: 1000 },
    );
    expect(out).toBe(42);
  });
});
