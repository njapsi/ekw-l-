import { QUEUE_NAMES, type QueueName } from '@growth-agent/services/observability';
import { Queue, type QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

/**
 * Long-running operations run here, never inline in a request (section H).
 * `QUEUE_NAMES` is defined once in `@growth-agent/services/observability` so the
 * worker and the `/admin` queue views cannot drift.
 */
export { QUEUE_NAMES };
export type { QueueName };

/**
 * Phase 12 hardening: every queue previously had NO `defaultJobOptions`, which
 * meant BullMQ's own default of `attempts: 1` applied everywhere — a job that
 * failed once (a transient DB/Redis/network blip) got zero retries and sat in
 * the `failed` set forever with no automated recovery. Exponential backoff
 * with jitter (BullMQ's built-in `'exponential'` type) spaces retries out so a
 * brief outage doesn't turn into a retry storm the moment it recovers.
 * `removeOnComplete`/`removeOnFail` bound Redis memory growth — without them
 * BullMQ keeps every job's data forever.
 *
 * This is a config-only change: it makes a genuinely transient failure
 * recoverable without human action, but it does NOT make a business-logic
 * failure (a real bug, a permanently invalid input) retry indefinitely —
 * `attempts` still caps it, and a job that keeps failing after every retry is
 * exactly what `queue_failed_jobs` (`observability/queues.ts`) and its alert
 * rule (`deploy/alerts.yml`) exist to surface.
 */
const STANDARD_JOB_OPTIONS: QueueOptions['defaultJobOptions'] = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1_000 },
};

/**
 * A whole crawl (potentially thousands of page fetches) is expensive to
 * re-run from scratch, and the crawler already has its own per-host
 * retry/backoff internally (`packages/services/src/seo/fetch.ts`) — a
 * BullMQ-level retry here is only for "the job process itself died", not for
 * ordinary page-fetch failures the crawler already recovers from. Fewer
 * attempts, a longer initial delay.
 */
const CRAWL_JOB_OPTIONS: QueueOptions['defaultJobOptions'] = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1_000 },
};

export const seoCrawlQueue = new Queue(QUEUE_NAMES.seoCrawl, {
  connection,
  defaultJobOptions: CRAWL_JOB_OPTIONS,
});
export const agentRunQueue = new Queue(QUEUE_NAMES.agentRun, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const reportQueue = new Queue(QUEUE_NAMES.report, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const youtubeSyncQueue = new Queue(QUEUE_NAMES.youtubeSync, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const tiktokSyncQueue = new Queue(QUEUE_NAMES.tiktokSync, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const searchConsoleSyncQueue = new Queue(QUEUE_NAMES.searchConsoleSync, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const contentPipelineQueue = new Queue(QUEUE_NAMES.contentPipeline, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const automationQueue = new Queue(QUEUE_NAMES.automation, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const integrationsQueue = new Queue(QUEUE_NAMES.integrations, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
export const billingQueue = new Queue(QUEUE_NAMES.billing, {
  connection,
  defaultJobOptions: STANDARD_JOB_OPTIONS,
});
