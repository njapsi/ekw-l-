/**
 * Read-only BullMQ queue introspection for `/admin` — depth, recent failures,
 * and the repeatable scheduler ticks. Never enqueues anything; the worker owns
 * production. Job payloads are deliberately NOT surfaced (they can carry user
 * text); only the id / name / failure reason are.
 */
import { Queue } from 'bullmq';
import { QUEUE_ORDER, type QueueName } from './queue-names.js';
import { getObservabilityRedis } from './redis.js';
import { scrubSecrets } from './scrub.js';

const queues = new Map<QueueName, Queue>();

function queueFor(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getObservabilityRedis() });
    queues.set(name, q);
  }
  return q;
}

export interface QueueDepth {
  name: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  isPaused: boolean;
  error?: string;
}

export async function getQueueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    QUEUE_ORDER.map(async (name) => {
      try {
        const q = queueFor(name);
        const counts = await q.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
          'paused',
        );
        const isPaused = await q.isPaused();
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          paused: counts.paused ?? 0,
          isPaused,
        } satisfies QueueDepth;
      } catch (err) {
        return {
          name,
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 0,
          paused: 0,
          isPaused: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueueDepth;
      }
    }),
  );
}

export interface FailedJobSummary {
  queue: QueueName;
  id: string;
  name: string;
  failedReason: string;
  attemptsMade: number;
  timestamp: string | null;
  finishedOn: string | null;
}

export async function getRecentFailedJobs(
  name: QueueName,
  limit = 15,
): Promise<FailedJobSummary[]> {
  try {
    const q = queueFor(name);
    const jobs = await q.getJobs(['failed'], 0, Math.max(0, limit - 1), false);
    return jobs
      .filter((j): j is NonNullable<typeof j> => Boolean(j))
      .map((j) => ({
        queue: name,
        id: String(j.id ?? '—'),
        name: j.name,
        failedReason: scrubSecrets(j.failedReason ?? '').slice(0, 500),
        attemptsMade: j.attemptsMade,
        timestamp: j.timestamp ? new Date(j.timestamp).toISOString() : null,
        finishedOn: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
      }));
  } catch {
    return [];
  }
}

export async function getAllRecentFailedJobs(limitPerQueue = 8): Promise<FailedJobSummary[]> {
  const perQueue = await Promise.all(
    QUEUE_ORDER.map((name) => getRecentFailedJobs(name, limitPerQueue)),
  );
  return perQueue
    .flat()
    .sort((a, b) =>
      (b.finishedOn ?? b.timestamp ?? '').localeCompare(a.finishedOn ?? a.timestamp ?? ''),
    );
}

export interface RepeatableTick {
  name: string;
  pattern: string | null;
  every: number | null;
  next: string | null;
}

export async function getRepeatableTicks(): Promise<RepeatableTick[]> {
  try {
    const q = queueFor('automation');
    const repeatables = await q.getRepeatableJobs();
    return repeatables.map((r) => ({
      name: r.name,
      pattern: r.pattern ?? null,
      every: typeof r.every === 'number' ? r.every : r.every ? Number(r.every) : null,
      next: r.next ? new Date(r.next).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function closeObservabilityQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
  queues.clear();
}
