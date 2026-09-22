// Side effect: validate the environment at worker boot (FORENSIC-AUDIT D-3).
import '@growth-agent/services/config';
import { type Job, Worker } from 'bullmq';
import { observability } from '@growth-agent/services';
import { logger } from './logger.js';
import { type AgentJob, processAgentJob } from './processors/agent.js';
import { type AutomationJob, processAutomationJob } from './processors/automation.js';
import { type ContentJob, processContentJob } from './processors/content.js';
import { type IntegrationsJob, processIntegrationsJob } from './processors/integrations.js';
import { type ReportJob, processReportJob } from './processors/report.js';
import { type SearchConsoleJob, processSearchConsoleJob } from './processors/search-console.js';
import { type SeoJob, closeSeoRenderer, processSeoJob } from './processors/seo.js';
import { type TikTokJob, processTikTokJob } from './processors/tiktok.js';
import { type YouTubeJob, processYouTubeJob } from './processors/youtube.js';
import { startHealthServer } from './health-server.js';
import { instrumentJob, startHeartbeat } from './observability.js';
import { QUEUE_NAMES, agentRunQueue, automationQueue, connection, integrationsQueue } from './queues.js';

/**
 * Worker entrypoint. The YouTube, TikTok, SEO, Growth Agent, content-pipeline,
 * report-generation and automation queues are live. The automation queue also
 * carries the repeatable "scheduler" ticks (ARCHITECTURE.md §4).
 *
 * Every job runs through `instrumentJob` (correlation id, metrics, error
 * capture), a `WorkerHeartbeat` row is refreshed on an interval, and a small
 * HTTP listener exposes `/healthz` + `/metrics` (Phase 13).
 */
type Processor = (job: Job) => Promise<unknown>;

const PROCESSORS: Record<string, Processor> = {
  [QUEUE_NAMES.youtubeSync]: (job) => processYouTubeJob(job as Job<YouTubeJob>),
  [QUEUE_NAMES.tiktokSync]: (job) => processTikTokJob(job as Job<TikTokJob>),
  [QUEUE_NAMES.searchConsoleSync]: (job) => processSearchConsoleJob(job as Job<SearchConsoleJob>),
  [QUEUE_NAMES.seoCrawl]: (job) => processSeoJob(job as Job<SeoJob>),
  [QUEUE_NAMES.agentRun]: (job) => processAgentJob(job as Job<AgentJob>),
  [QUEUE_NAMES.contentPipeline]: (job) => processContentJob(job as Job<ContentJob>),
  [QUEUE_NAMES.report]: (job) => processReportJob(job as Job<ReportJob>),
  [QUEUE_NAMES.automation]: (job) => processAutomationJob(job as Job<AutomationJob>),
  [QUEUE_NAMES.integrations]: (job) => processIntegrationsJob(job as Job<IntegrationsJob>),
};

/** Register the repeatable scheduler ticks (idempotent — keyed job ids). */
async function registerSchedules(): Promise<void> {
  await automationQueue.add(
    'sweep',
    { type: 'sweep' },
    {
      repeat: { every: 60_000 },
      jobId: 'automation-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  await automationQueue.add(
    'retry-sweep',
    { type: 'retry-sweep' },
    {
      repeat: { every: 30_000 },
      jobId: 'automation-retry-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  await automationQueue.add(
    'lifecycle-sweep',
    { type: 'lifecycle-sweep' },
    {
      repeat: { every: 3_600_000 }, // hourly — deletion grace is measured in days
      jobId: 'lifecycle-sweep',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
  // Phase 1: scheduled integration syncs + token/credential lifecycle.
  await integrationsQueue.add(
    'sync-sweep',
    { type: 'sync-sweep' },
    {
      repeat: { every: 15 * 60_000 },
      jobId: 'integrations-sync-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  await integrationsQueue.add(
    'lifecycle-sweep',
    { type: 'lifecycle-sweep' },
    {
      repeat: { every: 15 * 60_000 },
      jobId: 'integrations-lifecycle-sweep',
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  // Phase 10: Growth Mission execution + digests, on the previously-idle
  // agent-run queue (`docs/AGENT-RUNTIME.md` §8) rather than a new queue.
  await agentRunQueue.add(
    'mission-sweep',
    { type: 'mission.sweep' },
    { repeat: { every: 60_000 }, jobId: 'mission-sweep', removeOnComplete: 50, removeOnFail: 50 },
  );
  await agentRunQueue.add(
    'mission-daily-brief',
    { type: 'mission.daily.brief' },
    { repeat: { every: 86_400_000 }, jobId: 'mission-daily-brief', removeOnComplete: 20, removeOnFail: 20 },
  );
  await agentRunQueue.add(
    'mission-weekly-review',
    { type: 'mission.weekly.review' },
    { repeat: { every: 7 * 86_400_000 }, jobId: 'mission-weekly-review', removeOnComplete: 10, removeOnFail: 10 },
  );
  logger.info('automation + lifecycle + integration + mission scheduler ticks registered');
}

function startWorker(name: string, processor: Processor) {
  const worker = new Worker(name, instrumentJob(name, processor), { connection, concurrency: 4 });
  worker.on('failed', (job, err) => {
    logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed');
  });
  return worker;
}

const workers = Object.entries(PROCESSORS).map(([name, p]) => startWorker(name, p));
logger.info({ queues: Object.keys(PROCESSORS) }, 'growth-agent worker started');

const stopHeartbeat = startHeartbeat();
const healthServer = startHealthServer();

void registerSchedules().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'failed to register schedules',
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopHeartbeat();
  healthServer.close();
  await Promise.all(workers.map((w) => w.close()));
  await automationQueue.close();
  await integrationsQueue.close();
  await agentRunQueue.close();
  await closeSeoRenderer();
  await observability.closeObservabilityQueues();
  await observability.closeObservabilityRedis();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
