/**
 * Content asset lifecycle — edit (with version history), approve, schedule,
 * mark published, mark failed, revert, regenerate.
 *
 * APPROVAL → PUBLISH/SCHEDULE (master instruction). The engine NEVER publishes:
 * `markPublished` only records that the user published the content elsewhere.
 * Every transition is audit-logged.
 */
import type { AIProvider } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { renderAsset } from './render.js';
import { GEN_SCHEMAS, type ContentAnalysis } from './schemas.js';

async function loadAsset(db: Db, organizationId: string, assetId: string) {
  const asset = await db.contentAsset.findFirst({
    where: { id: assetId, organizationId },
    include: { currentVersion: true, project: true },
  });
  if (!asset) throw AppError.notFound('Content asset');
  return asset;
}

async function nextVersion(db: Db, assetId: string): Promise<number> {
  const last = await db.contentAssetVersion.findFirst({
    where: { contentAssetId: assetId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  return (last?.versionNumber ?? 0) + 1;
}

async function addVersion(
  db: Db,
  input: {
    assetId: string;
    organizationId: string;
    body: string;
    structured: Record<string, unknown> | null;
    editedById: string | null;
    editSummary: string;
  },
): Promise<string> {
  const version = await db.contentAssetVersion.create({
    data: {
      contentAssetId: input.assetId,
      organizationId: input.organizationId,
      versionNumber: await nextVersion(db, input.assetId),
      body: input.body,
      structured: (input.structured ?? undefined) as never,
      editedById: input.editedById,
      editSummary: input.editSummary,
    },
  });
  await db.contentAsset.update({
    where: { id: input.assetId },
    data: { currentVersionId: version.id },
  });
  return version.id;
}

export interface EditAssetInput {
  organizationId: string;
  userId: string;
  assetId: string;
  body: string;
  structured?: Record<string, unknown> | null;
  editSummary?: string;
}

export async function editAsset(input: EditAssetInput, db: Db = prisma) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  const body = input.body.trim();
  if (!body) throw AppError.validation('The content body cannot be empty.');

  await addVersion(db, {
    assetId: asset.id,
    organizationId: input.organizationId,
    body: body.slice(0, 200_000),
    structured:
      input.structured ??
      (asset.currentVersion?.structured as Record<string, unknown> | null) ??
      null,
    editedById: input.userId,
    editSummary: (input.editSummary ?? 'User edit').slice(0, 300),
  });
  // An edit invalidates a prior approval / schedule / publish.
  if (asset.status !== 'DRAFT') {
    await db.contentAsset.update({
      where: { id: asset.id },
      data: {
        status: 'DRAFT',
        approvedById: null,
        approvedAt: null,
        scheduledFor: null,
        publishedAt: null,
      },
    });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.edited',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { fromStatus: asset.status, toStatus: 'DRAFT' },
    },
    db,
  );
  return db.contentAsset.findUnique({ where: { id: asset.id }, include: { currentVersion: true } });
}

export async function approveAsset(
  input: { organizationId: string; userId: string; assetId: string },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  if (asset.status !== 'DRAFT') {
    throw AppError.validation(
      `Only a draft can be approved (this one is ${asset.status.toLowerCase()}).`,
    );
  }
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: { status: 'APPROVED', approvedById: input.userId, approvedAt: new Date() },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.approved',
      targetType: 'content_asset',
      targetId: asset.id,
    },
    db,
  );
  return updated;
}

export async function scheduleAsset(
  input: { organizationId: string; userId: string; assetId: string; scheduledFor: Date },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  if (asset.status !== 'APPROVED' && asset.status !== 'SCHEDULED') {
    throw AppError.validation('Approve the content before scheduling it.');
  }
  if (input.scheduledFor.getTime() <= Date.now()) {
    throw AppError.validation('The scheduled time must be in the future.');
  }
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: { status: 'SCHEDULED', scheduledFor: input.scheduledFor },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.scheduled',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { scheduledFor: input.scheduledFor.toISOString() },
    },
    db,
  );
  return updated;
}

export async function unscheduleAsset(
  input: { organizationId: string; userId: string; assetId: string },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  if (asset.status !== 'SCHEDULED') throw AppError.validation('This content is not scheduled.');
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: { status: 'APPROVED', scheduledFor: null },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.unscheduled',
      targetType: 'content_asset',
      targetId: asset.id,
    },
    db,
  );
  return updated;
}

/**
 * Record that the user published this content on the target platform. The
 * engine performs NO external action — it only marks the status.
 */
export async function markAssetPublished(
  input: {
    organizationId: string;
    userId: string;
    assetId: string;
    target?: string;
    note?: string;
  },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  if (asset.status !== 'APPROVED' && asset.status !== 'SCHEDULED') {
    throw AppError.validation(
      'Approve (and optionally schedule) the content before marking it published.',
    );
  }
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      publishTarget: (input.target ?? 'manual').slice(0, 60),
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.published_marked',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { target: input.target ?? 'manual', note: input.note ?? null },
    },
    db,
  );
  return updated;
}

export async function markAssetFailed(
  input: { organizationId: string; userId: string; assetId: string; reason: string },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: { status: 'FAILED', failureReason: input.reason.slice(0, 500) },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.failed',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { reason: input.reason.slice(0, 200), fromStatus: asset.status },
    },
    db,
  );
  return updated;
}

export async function resetAssetToDraft(
  input: { organizationId: string; userId: string; assetId: string },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  const updated = await db.contentAsset.update({
    where: { id: asset.id },
    data: {
      status: 'DRAFT',
      failureReason: null,
      approvedById: null,
      approvedAt: null,
      scheduledFor: null,
      publishedAt: null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.reset_to_draft',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { fromStatus: asset.status },
    },
    db,
  );
  return updated;
}

/** Point the asset at an earlier version by appending a copy of it. */
export async function revertAsset(
  input: { organizationId: string; userId: string; assetId: string; versionNumber: number },
  db: Db = prisma,
) {
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  const target = await db.contentAssetVersion.findFirst({
    where: { contentAssetId: asset.id, versionNumber: input.versionNumber },
  });
  if (!target) throw AppError.notFound('Version');
  await addVersion(db, {
    assetId: asset.id,
    organizationId: input.organizationId,
    body: target.body,
    structured: target.structured as Record<string, unknown> | null,
    editedById: input.userId,
    editSummary: `Reverted to v${input.versionNumber}`,
  });
  if (asset.status !== 'DRAFT') {
    await db.contentAsset.update({
      where: { id: asset.id },
      data: {
        status: 'DRAFT',
        approvedById: null,
        approvedAt: null,
        scheduledFor: null,
        publishedAt: null,
      },
    });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.reverted',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { toVersion: input.versionNumber },
    },
    db,
  );
  return db.contentAsset.findUnique({ where: { id: asset.id }, include: { currentVersion: true } });
}

export type RegenModel = Pick<AIProvider, 'generateObject'>;

/** Re-run the model for one asset's type, optionally with user steering. */
export async function regenerateAsset(
  deps: { db?: Db; model?: RegenModel },
  input: { organizationId: string; userId: string; assetId: string; instructions?: string },
) {
  const db = deps.db ?? prisma;
  const asset = await loadAsset(db, input.organizationId, input.assetId);
  const analysis = asset.project.analysis as ContentAnalysis | null;
  if (!analysis) throw AppError.validation('The project has no analysis to regenerate from.');
  const type = asset.type;
  const { schema, label } = GEN_SCHEMAS[type];

  let rendered: { title: string; body: string; structured: Record<string, unknown> };
  if (deps.model) {
    const res = await deps.model.generateObject({
      schema,
      system:
        'Regenerate this single content deliverable from the analysis. Build only on the KEY IDEAS; never guarantee views, revenue, virality or rankings.',
      prompt: `ANALYSIS:\n${JSON.stringify({ summary: analysis.summary, keyIdeas: analysis.keyIdeas, contentAngles: analysis.contentAngles }, null, 1).slice(0, 8000)}\n\nDELIVERABLE: ${label}\n${input.instructions ? `USER INSTRUCTIONS: ${input.instructions}` : ''}\n\nProduce it.`,
    });
    rendered = renderAsset(type, res.object);
  } else {
    // no model → keep current body, just note the request
    rendered = {
      title: asset.title ?? label,
      body: `${asset.currentVersion?.body ?? ''}\n\n[Regeneration requested${input.instructions ? `: ${input.instructions}` : ''} — no AI provider configured.]`,
      structured: (asset.currentVersion?.structured as Record<string, unknown> | null) ?? {},
    };
  }

  await addVersion(db, {
    assetId: asset.id,
    organizationId: input.organizationId,
    body: rendered.body,
    structured: rendered.structured,
    editedById: null,
    editSummary: input.instructions
      ? `Regenerated: ${input.instructions.slice(0, 120)}`
      : 'Regenerated',
  });
  if (asset.status !== 'DRAFT') {
    await db.contentAsset.update({
      where: { id: asset.id },
      data: {
        status: 'DRAFT',
        approvedById: null,
        approvedAt: null,
        scheduledFor: null,
        publishedAt: null,
      },
    });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.asset.regenerated',
      targetType: 'content_asset',
      targetId: asset.id,
      metadata: { model: Boolean(deps.model) },
    },
    db,
  );
  return db.contentAsset.findUnique({ where: { id: asset.id }, include: { currentVersion: true } });
}
