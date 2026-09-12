import { reports } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Report-generation jobs. A single report generates inline in the web Server
 * Action (bounded — a few reads + one optional model call); this queue is for
 * batches (e.g. a scheduled weekly pack) and re-runs.
 */
export type ReportJob = {
  type: 'generate';
  organizationId: string;
  userId: string;
  reportType:
    | 'YOUTUBE'
    | 'TIKTOK'
    | 'SEO'
    | 'WEBSITE_HEALTH'
    | 'AI_RECOMMENDATIONS'
    | 'GROWTH'
    | 'MONETIZATION';
  title?: string;
  params?: { websiteId?: string; crawlId?: string };
};

export async function processReportJob(job: Job<ReportJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type, reportType: data.reportType }, 'report job');

  switch (data.type) {
    case 'generate':
      return reports.generateReportJob({
        organizationId: data.organizationId,
        userId: data.userId,
        type: data.reportType,
        title: data.title,
        params: data.params,
      });
    default: {
      const _exhaustive: never = data.type;
      throw new Error(`unknown report job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
