import { searchConsole } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Search Console sync — refresh the org's property list and (for the selected
 * property) the performance + sitemaps snapshots. Callable from a scheduled
 * automation or offloaded from a Server Action; the same `runSearchConsoleSyncJob`
 * also runs inline in the web app.
 */
export interface SearchConsoleJob {
  organizationId: string;
  redirectUri: string;
  connectionId?: string;
  rangeDays?: number;
  propertiesOnly?: boolean;
}

export async function processSearchConsoleJob(job: Job<SearchConsoleJob>): Promise<unknown> {
  const { organizationId, redirectUri, connectionId, rangeDays, propertiesOnly } = job.data;
  logger.info({ jobId: job.id, organizationId }, 'search console sync job');
  return searchConsole.runSearchConsoleSyncJob({
    organizationId,
    redirectUri,
    connectionId,
    rangeDays,
    propertiesOnly,
  });
}
