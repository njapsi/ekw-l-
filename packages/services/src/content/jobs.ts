/**
 * Content-pipeline job entry points. Analysis + generation run inline in Server
 * Actions for a single project (bounded); the worker path is for large batches
 * and the scheduled-content sweep.
 */
import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { type AnalyzeResult, analyzeProject } from './analyze.js';
import { regenerateAsset } from './assets.js';
import { type GenerateResult, generateAssets } from './generate.js';
import type { ContentAssetTypeKey } from './schemas.js';

const log = createLogger('content.jobs');

function modelFromEnv(): { generateObject: never } | undefined {
  try {
    return createRegistryFromEnv().getForRole('analyst').provider as never;
  } catch {
    return undefined;
  }
}

export async function analyzeProjectJob(
  input: { organizationId: string; projectId: string; trigger?: string },
  db: Db = prisma,
): Promise<AnalyzeResult> {
  return analyzeProject({ db, model: modelFromEnv() }, input);
}

export async function generateAssetsJob(
  input: {
    organizationId: string;
    userId: string;
    projectId: string;
    types?: ContentAssetTypeKey[];
    trigger?: string;
  },
  db: Db = prisma,
): Promise<GenerateResult> {
  return generateAssets({ db, model: modelFromEnv() }, input);
}

export async function regenerateAssetJob(
  input: { organizationId: string; userId: string; assetId: string; instructions?: string },
  db: Db = prisma,
) {
  return regenerateAsset({ db, model: modelFromEnv() }, input);
}

/**
 * Sweep due scheduled content. Per the master instruction the engine does NOT
 * auto-publish — this only records that the scheduled time passed so the user is
 * prompted. Assets stay SCHEDULED until the user marks them published.
 */
export async function sweepDueScheduledJob(db: Db = prisma): Promise<{ due: number }> {
  const due = await db.contentAsset.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
    select: { id: true, organizationId: true, title: true, scheduledFor: true },
    take: 500,
  });
  for (const a of due) {
    await recordAudit(
      {
        organizationId: a.organizationId,
        action: 'content.asset.due',
        actorType: 'SYSTEM',
        targetType: 'content_asset',
        targetId: a.id,
        metadata: { scheduledFor: a.scheduledFor?.toISOString() ?? null },
      },
      db,
    ).catch(() => undefined);
  }
  if (due.length) log.info({ count: due.length }, 'scheduled content is due (not auto-published)');
  return { due: due.length };
}
