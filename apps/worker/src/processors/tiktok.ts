import { tiktok } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

export type TikTokJob =
  | { type: 'sync.full'; organizationId: string; connectionId: string }
  | {
      type: 'sync.account';
      organizationId: string;
      connectionId: string;
      accountId: string;
      facet: 'account' | 'videos' | 'all';
    }
  | { type: 'analyst.run'; organizationId: string; accountId: string }
  | { type: 'publish.status'; organizationId: string; connectionId: string; publishRowId: string };

function redirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/integrations/tiktok/callback`;
}

export async function processTikTokJob(job: Job<TikTokJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'tiktok job');

  switch (data.type) {
    case 'sync.full':
      return tiktok.runTikTokFullSync({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
        redirectUri: redirectUri(),
      });
    case 'sync.account':
      return tiktok.runTikTokAccountSync({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
        redirectUri: redirectUri(),
        accountId: data.accountId,
        facet: data.facet,
      });
    case 'analyst.run':
      return tiktok.runTikTokAnalystJob({
        organizationId: data.organizationId,
        accountId: data.accountId,
        trigger: 'worker',
      });
    case 'publish.status':
      return tiktok.refreshTikTokPublishStatus({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
        redirectUri: redirectUri(),
        publishRowId: data.publishRowId,
      });
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown tiktok job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
