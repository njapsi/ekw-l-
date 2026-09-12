/**
 * The worker writes a `WorkerHeartbeat` row on a short interval; `/admin` and
 * `/api/health` treat a stale row as "the worker fleet is down". The row also
 * carries the last queue-depth snapshot the worker saw, which is the fallback
 * when the web process cannot reach Redis directly.
 */
import { type Db, prisma } from '@growth-agent/db';

/** Older than this ⇒ down. */
export const HEARTBEAT_DOWN_MS = 90_000;
/** Older than this ⇒ degraded. */
export const HEARTBEAT_DEGRADED_MS = 45_000;

export interface HeartbeatInput {
  workerId: string;
  version?: string;
  redisOk: boolean;
  queues: Record<string, unknown>;
  jobsProcessed: number;
  jobsFailed: number;
}

export async function writeHeartbeat(input: HeartbeatInput, db: Db = prisma): Promise<void> {
  const now = new Date();
  await db.workerHeartbeat.upsert({
    where: { workerId: input.workerId },
    create: {
      workerId: input.workerId,
      version: input.version,
      bootAt: now,
      lastBeatAt: now,
      redisOk: input.redisOk,
      queues: input.queues as never,
      jobsProcessed: BigInt(Math.max(0, Math.trunc(input.jobsProcessed))),
      jobsFailed: BigInt(Math.max(0, Math.trunc(input.jobsFailed))),
    },
    update: {
      version: input.version,
      lastBeatAt: now,
      redisOk: input.redisOk,
      queues: input.queues as never,
      jobsProcessed: BigInt(Math.max(0, Math.trunc(input.jobsProcessed))),
      jobsFailed: BigInt(Math.max(0, Math.trunc(input.jobsFailed))),
    },
  });
}

export interface WorkerStatusRow {
  workerId: string;
  version: string | null;
  bootAt: string;
  lastBeatAt: string;
  ageMs: number;
  redisOk: boolean;
  jobsProcessed: number;
  jobsFailed: number;
  queues: unknown;
  health: 'ok' | 'degraded' | 'down';
}

function classify(ageMs: number, redisOk: boolean): 'ok' | 'degraded' | 'down' {
  if (ageMs > HEARTBEAT_DOWN_MS) return 'down';
  if (ageMs > HEARTBEAT_DEGRADED_MS || !redisOk) return 'degraded';
  return 'ok';
}

export async function listWorkerHeartbeats(db: Db = prisma): Promise<WorkerStatusRow[]> {
  const rows = await db.workerHeartbeat.findMany({ orderBy: { lastBeatAt: 'desc' } });
  const now = Date.now();
  return rows.map((r) => {
    const ageMs = now - r.lastBeatAt.getTime();
    return {
      workerId: r.workerId,
      version: r.version,
      bootAt: r.bootAt.toISOString(),
      lastBeatAt: r.lastBeatAt.toISOString(),
      ageMs,
      redisOk: r.redisOk,
      jobsProcessed: Number(r.jobsProcessed),
      jobsFailed: Number(r.jobsFailed),
      queues: r.queues,
      health: classify(ageMs, r.redisOk),
    };
  });
}

/** The freshest heartbeat's health, or `down` when there is none. */
export async function workerFleetHealth(
  db: Db = prisma,
): Promise<{ health: 'ok' | 'degraded' | 'down'; newestAgeMs: number | null; workers: number }> {
  const rows = await listWorkerHeartbeats(db);
  if (rows.length === 0) return { health: 'down', newestAgeMs: null, workers: 0 };
  const best = rows.reduce((a, b) => (a.ageMs <= b.ageMs ? a : b));
  return { health: best.health, newestAgeMs: best.ageMs, workers: rows.length };
}
