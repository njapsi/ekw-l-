/**
 * The single source of truth for BullMQ queue names. Both `apps/worker` (which
 * produces + consumes) and the `/admin` observability views (which only read
 * depth + failures) import from here so the two can never drift.
 */
export const QUEUE_NAMES = {
  seoCrawl: 'seo-crawl',
  agentRun: 'agent-run',
  report: 'report-generation',
  youtubeSync: 'youtube-sync',
  tiktokSync: 'tiktok-sync',
  searchConsoleSync: 'search-console-sync',
  contentPipeline: 'content-pipeline',
  automation: 'automation',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Stable display order for the admin UI. */
export const QUEUE_ORDER: readonly QueueName[] = [
  QUEUE_NAMES.agentRun,
  QUEUE_NAMES.seoCrawl,
  QUEUE_NAMES.report,
  QUEUE_NAMES.youtubeSync,
  QUEUE_NAMES.tiktokSync,
  QUEUE_NAMES.searchConsoleSync,
  QUEUE_NAMES.contentPipeline,
  QUEUE_NAMES.automation,
];
