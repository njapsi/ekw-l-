import { integrationSync, integrations } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * The `integrations` queue (Phase 1, Parts 11 + 12):
 *   - `sync-sweep`       repeatable: run due scheduled syncs (bounded per tick)
 *   - `lifecycle-sweep`  repeatable: refresh-ahead, reauth warnings, WordPress
 *                        re-validation, key-rotation re-seal, approval TTL
 *   - `sync`             one sync for one connection (e.g. offloaded "Sync now")
 */
export type IntegrationsJob =
  | { type: 'sync-sweep' }
  | { type: 'lifecycle-sweep' }
  | {
      type: 'sync';
      organizationId: string;
      key: string;
      connectionRef: string;
      trigger?: 'MANUAL' | 'SCHEDULED' | 'AUTOMATION';
    };

export async function processIntegrationsJob(job: Job<IntegrationsJob>): Promise<unknown> {
  const data = job.data;
  switch (data.type) {
    case 'sync-sweep': {
      const res = await integrationSync.sweepDueSyncs();
      if (res.ran > 0) logger.info(res, 'scheduled integration syncs');
      return res;
    }
    case 'lifecycle-sweep': {
      const res = await integrations.sweepTokenLifecycle();
      logger.info(res, 'token lifecycle sweep');
      return res;
    }
    case 'sync': {
      if (!integrationSync.isSyncable(data.key)) throw new Error(`not syncable: ${data.key}`);
      return integrationSync.runIntegrationSync({
        organizationId: data.organizationId,
        key: data.key,
        connectionRef: data.connectionRef,
        trigger: data.trigger ?? 'MANUAL',
      });
    }
    default: {
      const _x: never = data;
      throw new Error(`unknown integrations job ${JSON.stringify(_x)}`);
    }
  }
}
