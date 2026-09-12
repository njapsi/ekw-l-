import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkAiProviders,
  checkDatabase,
  checkExternalIntegrations,
  checkWorker,
  runHealthChecks,
} from './health.js';

const AI_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of AI_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of AI_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('checkDatabase', () => {
  it('is ok when SELECT 1 succeeds', async () => {
    const db = { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) } as any;
    expect((await checkDatabase(db)).state).toBe('ok');
  });
  it('is down when the query throws', async () => {
    const db = {
      $queryRaw: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    } as any;
    const r = await checkDatabase(db);
    expect(r.state).toBe('down');
    expect(r.detail).toContain('ECONNREFUSED');
  });
  it('is down (not hung) when the query never resolves', async () => {
    vi.useFakeTimers();
    try {
      const db = { $queryRaw: vi.fn(() => new Promise(() => undefined)) } as any;
      const pending = checkDatabase(db);
      await vi.advanceTimersByTimeAsync(3_000);
      const r = await pending;
      expect(r.state).toBe('down');
      expect(r.detail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkAiProviders', () => {
  it('is unconfigured with no keys', async () => {
    expect((await checkAiProviders()).state).toBe('unconfigured');
  });
  it('is ok (no network) when a key is present and deep is off', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    const r = await checkAiProviders({ deep: false });
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('anthropic');
  });
});

describe('checkExternalIntegrations', () => {
  it('is unconfigured with no connections', async () => {
    const db = { oAuthConnection: { groupBy: vi.fn(async () => []) } } as any;
    expect((await checkExternalIntegrations(db)).state).toBe('unconfigured');
  });
  it('is degraded when some connections are in error', async () => {
    const db = {
      oAuthConnection: {
        groupBy: vi.fn(async () => [
          { status: 'ACTIVE', _count: { _all: 3 } },
          { status: 'ERROR', _count: { _all: 1 } },
        ]),
      },
    } as any;
    const r = await checkExternalIntegrations(db);
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('4 connected, 1');
  });
  it('is down (not hung) when the query never resolves', async () => {
    vi.useFakeTimers();
    try {
      const db = { oAuthConnection: { groupBy: vi.fn(() => new Promise(() => undefined)) } } as any;
      const pending = checkExternalIntegrations(db);
      await vi.advanceTimersByTimeAsync(3_000);
      const r = await pending;
      expect(r.state).toBe('down');
      expect(r.detail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkWorker', () => {
  it('is down with no heartbeat', async () => {
    const db = { workerHeartbeat: { findMany: vi.fn(async () => []) } } as any;
    expect((await checkWorker(db)).state).toBe('down');
  });
  it('is ok with a fresh heartbeat', async () => {
    const db = {
      workerHeartbeat: {
        findMany: vi.fn(async () => [
          {
            workerId: 'w1',
            version: '1',
            bootAt: new Date(),
            lastBeatAt: new Date(),
            redisOk: true,
            jobsProcessed: 0n,
            jobsFailed: 0n,
            queues: {},
          },
        ]),
      },
    } as any;
    expect((await checkWorker(db)).state).toBe('ok');
  });
  it('is down (not hung) when the heartbeat query never resolves', async () => {
    vi.useFakeTimers();
    try {
      const db = {
        workerHeartbeat: { findMany: vi.fn(() => new Promise(() => undefined)) },
      } as any;
      const pending = checkWorker(db);
      await vi.advanceTimersByTimeAsync(3_000);
      const r = await pending;
      expect(r.state).toBe('down');
      expect(r.detail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runHealthChecks', () => {
  it('returns a well-formed report with every dependency', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [{ ok: 1 }]),
      oAuthConnection: { groupBy: vi.fn(async () => []) },
      workerHeartbeat: { findMany: vi.fn(async () => []) },
    } as any;
    const report = await runHealthChecks(db);
    expect(report.checks.map((c) => c.name).sort()).toEqual([
      'ai_provider',
      'database',
      'external_integrations',
      'redis',
      'worker',
    ]);
    expect(['ok', 'degraded', 'down']).toContain(report.status);
  });
});
