import { hostname } from 'node:os';
import { observability } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { resolveCorrelationId } from '@growth-agent/observability';
import { logger } from './logger.js';
import { connection } from './queues.js';

export const WORKER_ID = `${hostname()}:${process.pid}`;
const VERSION = process.env.npm_package_version ?? '0.0.0';

let jobsProcessed = 0;
let jobsFailed = 0;

/**
 * Wrap a queue processor: attach the inbound correlation id, time the job, feed
 * the metrics registry, and route an unhandled throw through `captureError`
 * (source WORKER) before re-throwing so BullMQ still records the failure.
 */
export function instrumentJob<T>(
  queue: string,
  processor: (job: Job) => Promise<T>,
): (job: Job) => Promise<T> {
  return async (job: Job) => {
    const started = Date.now();
    const data = (job.data ?? {}) as { correlationId?: string; organizationId?: string };
    const correlationId = resolveCorrelationId(data.correlationId);
    const child = logger.child({ queue, jobId: job.id, correlationId });
    try {
      const out = await processor(job);
      const durationMs = Date.now() - started;
      jobsProcessed += 1;
      observability.recordJob({ queue, ok: true, durationMs });
      child.info({ durationMs }, 'job ok');
      return out;
    } catch (err) {
      const durationMs = Date.now() - started;
      jobsFailed += 1;
      observability.recordJob({ queue, ok: false, durationMs });
      await observability.captureError(err, {
        source: 'WORKER',
        route: `queue:${queue}`,
        correlationId,
        organizationId: data.organizationId,
        context: { jobId: String(job.id ?? ''), jobName: job.name, attemptsMade: job.attemptsMade },
      });
      child.error(
        { durationMs, err: err instanceof Error ? err.message : String(err) },
        'job failed',
      );
      throw err;
    }
  };
}

let timer: NodeJS.Timeout | undefined;

/** Start writing a `WorkerHeartbeat` row on an interval. Returns a stop fn. */
export function startHeartbeat(intervalMs = 15_000): () => void {
  const beat = async () => {
    try {
      const depths = await observability.getQueueDepths();
      const queues: Record<string, unknown> = {};
      for (const d of depths) {
        queues[d.name] = {
          waiting: d.waiting,
          active: d.active,
          delayed: d.delayed,
          failed: d.failed,
          paused: d.isPaused,
        };
      }
      await observability.writeHeartbeat({
        workerId: WORKER_ID,
        version: VERSION,
        redisOk: connection.status === 'ready',
        queues,
        jobsProcessed,
        jobsFailed,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'heartbeat write failed',
      );
    }
  };
  void beat();
  timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}

export function jobCounters(): { processed: number; failed: number } {
  return { processed: jobsProcessed, failed: jobsFailed };
}
