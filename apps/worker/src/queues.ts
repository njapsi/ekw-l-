import { QUEUE_NAMES, type QueueName } from '@growth-agent/services/observability';
import { Queue } from 'bullmq';
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

export const seoCrawlQueue = new Queue(QUEUE_NAMES.seoCrawl, { connection });
export const agentRunQueue = new Queue(QUEUE_NAMES.agentRun, { connection });
export const reportQueue = new Queue(QUEUE_NAMES.report, { connection });
export const youtubeSyncQueue = new Queue(QUEUE_NAMES.youtubeSync, { connection });
export const tiktokSyncQueue = new Queue(QUEUE_NAMES.tiktokSync, { connection });
export const searchConsoleSyncQueue = new Queue(QUEUE_NAMES.searchConsoleSync, { connection });
export const contentPipelineQueue = new Queue(QUEUE_NAMES.contentPipeline, { connection });
export const automationQueue = new Queue(QUEUE_NAMES.automation, { connection });
export const integrationsQueue = new Queue(QUEUE_NAMES.integrations, { connection });
