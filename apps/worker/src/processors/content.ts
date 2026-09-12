import { content } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Content-pipeline jobs. Analysis + generation for a single project run inline
 * in the web Server Actions; this queue is for batches and the scheduled-content
 * sweep. The sweep NEVER publishes — it only records that scheduled content is
 * due so the user is prompted (master instruction: "Do not automatically
 * publish").
 */
export type ContentJob =
  | { type: 'analyze'; organizationId: string; projectId: string }
  | {
      type: 'generate';
      organizationId: string;
      userId: string;
      projectId: string;
      types?: string[];
    }
  | { type: 'sweep.scheduled' };

export async function processContentJob(job: Job<ContentJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'content job');

  switch (data.type) {
    case 'analyze':
      return content.analyzeProjectJob({
        organizationId: data.organizationId,
        projectId: data.projectId,
        trigger: 'worker',
      });
    case 'generate':
      return content.generateAssetsJob({
        organizationId: data.organizationId,
        userId: data.userId,
        projectId: data.projectId,
        types: data.types as never,
        trigger: 'worker',
      });
    case 'sweep.scheduled':
      return content.sweepDueScheduledJob();
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown content job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
