import { describe, expect, it, vi } from 'vitest';
import { listWorkerHeartbeats, workerFleetHealth, writeHeartbeat } from './worker-heartbeat.js';

function row(over: Record<string, unknown> = {}) {
  return {
    workerId: 'w1',
    version: '1.0.0',
    bootAt: new Date(Date.now() - 3_600_000),
    lastBeatAt: new Date(),
    redisOk: true,
    jobsProcessed: 12n,
    jobsFailed: 1n,
    queues: {},
    ...over,
  };
}

describe('writeHeartbeat', () => {
  it('upserts by workerId and coerces counters to BigInt', async () => {
    const db = { workerHeartbeat: { upsert: vi.fn(async () => undefined) } } as any;
    await writeHeartbeat(
      { workerId: 'w1', redisOk: true, queues: { a: 1 }, jobsProcessed: 5, jobsFailed: 2 },
      db,
    );
    const arg = db.workerHeartbeat.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ workerId: 'w1' });
    expect(arg.update.jobsProcessed).toBe(5n);
  });
});

describe('listWorkerHeartbeats classification', () => {
  it('fresh beat ⇒ ok', async () => {
    const db = { workerHeartbeat: { findMany: vi.fn(async () => [row()]) } } as any;
    expect((await listWorkerHeartbeats(db))[0]!.health).toBe('ok');
  });
  it('stale beat ⇒ degraded then down', async () => {
    const degraded = {
      workerHeartbeat: {
        findMany: vi.fn(async () => [row({ lastBeatAt: new Date(Date.now() - 60_000) })]),
      },
    } as any;
    expect((await listWorkerHeartbeats(degraded))[0]!.health).toBe('degraded');
    const down = {
      workerHeartbeat: {
        findMany: vi.fn(async () => [row({ lastBeatAt: new Date(Date.now() - 120_000) })]),
      },
    } as any;
    expect((await listWorkerHeartbeats(down))[0]!.health).toBe('down');
  });
  it('redis not ok ⇒ degraded even with a fresh beat', async () => {
    const db = {
      workerHeartbeat: { findMany: vi.fn(async () => [row({ redisOk: false })]) },
    } as any;
    expect((await listWorkerHeartbeats(db))[0]!.health).toBe('degraded');
  });
});

describe('workerFleetHealth', () => {
  it('is down when nothing has checked in', async () => {
    const db = { workerHeartbeat: { findMany: vi.fn(async () => []) } } as any;
    expect(await workerFleetHealth(db)).toMatchObject({ health: 'down', workers: 0 });
  });
  it('reports the freshest worker', async () => {
    const db = {
      workerHeartbeat: {
        findMany: vi.fn(async () => [
          row({ workerId: 'old', lastBeatAt: new Date(Date.now() - 120_000) }),
          row({ workerId: 'new', lastBeatAt: new Date() }),
        ]),
      },
    } as any;
    expect(await workerFleetHealth(db)).toMatchObject({ health: 'ok', workers: 2 });
  });
});
