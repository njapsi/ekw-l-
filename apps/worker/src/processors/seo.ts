import { security, seo } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { PlaywrightRenderer } from '../seo/playwright-renderer.js';

/**
 * SEO job payloads. The web app runs a bounded crawl inline today (ADR-0013);
 * this queue is for large / scheduled crawls and the AI summary. A single
 * shared renderer is reused across jobs and closed on shutdown.
 */
export type SeoJob =
  | {
      type: 'crawl.start';
      organizationId: string;
      userId: string;
      websiteId: string;
      request?: {
        maxPages?: number;
        maxDepth?: number;
        maxDurationSec?: number;
        concurrency?: number;
        renderMode?: 'STATIC' | 'AUTO' | 'HEADLESS';
      };
    }
  | { type: 'crawl.resume'; organizationId: string; userId: string; crawlId: string }
  | { type: 'audit.summary'; organizationId: string; crawlId: string }
  | {
      type: 'agent.run';
      organizationId: string;
      crawlId?: string;
      websiteId?: string;
      question?: string;
      goals?: string[];
    };

let renderer: PlaywrightRenderer | null = null;
function getRenderer(): PlaywrightRenderer {
  if (!renderer) renderer = new PlaywrightRenderer();
  return renderer;
}

export async function closeSeoRenderer(): Promise<void> {
  await renderer?.close();
  renderer = null;
}

export async function processSeoJob(job: Job<SeoJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'seo job');

  switch (data.type) {
    case 'crawl.start':
      await security.assertJobAuthorized(
        { organizationId: data.organizationId, actorUserId: data.userId, jobId: job.id },
        'seo.analyze',
      );
      return seo.startCrawl(
        {
          organizationId: data.organizationId,
          userId: data.userId,
          websiteId: data.websiteId,
          request: data.request,
        },
        { renderer: getRenderer() },
      );
    case 'crawl.resume':
      return seo.resumeCrawl(
        { organizationId: data.organizationId, userId: data.userId, crawlId: data.crawlId },
        { renderer: getRenderer() },
      );
    case 'audit.summary':
      return seo.runSeoAuditSummaryJob({
        organizationId: data.organizationId,
        crawlId: data.crawlId,
        trigger: 'worker',
      });
    case 'agent.run':
      return seo.runSeoAgentJob({
        organizationId: data.organizationId,
        crawlId: data.crawlId,
        websiteId: data.websiteId,
        question: data.question,
        goals: data.goals,
        trigger: 'worker',
      });
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown seo job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
