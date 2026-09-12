import { youtube } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * YouTube job payloads. The web app can enqueue these instead of running a sync
 * inline once channel volume warrants it. The processors call the same
 * `@growth-agent/services/youtube` functions the server actions use.
 */
export type YouTubeJob =
  | { type: 'sync.full'; organizationId: string; connectionId: string }
  | {
      type: 'sync.channel';
      organizationId: string;
      connectionId: string;
      channelId: string;
      facet: 'all' | 'channel' | 'videos' | 'analytics';
    }
  | { type: 'analyst.run'; organizationId: string; channelId: string };

function redirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/integrations/google/callback`;
}

export async function processYouTubeJob(job: Job<YouTubeJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'youtube job');

  switch (data.type) {
    case 'sync.full':
      return youtube.runYouTubeFullSync({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
        redirectUri: redirectUri(),
      });
    case 'sync.channel':
      return youtube.runYouTubeChannelSync({
        organizationId: data.organizationId,
        connectionId: data.connectionId,
        redirectUri: redirectUri(),
        channelId: data.channelId,
        facet: data.facet,
      });
    case 'analyst.run':
      return youtube.runYouTubeAnalystJob({
        organizationId: data.organizationId,
        channelId: data.channelId,
        trigger: 'worker',
      });
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown youtube job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
