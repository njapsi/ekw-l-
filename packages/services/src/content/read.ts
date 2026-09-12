/**
 * Org-scoped read helpers for the content repurposing UI. Every query is
 * filtered by `organizationId`.
 */
import { type Db, type ContentAssetStatus, prisma } from '@growth-agent/db';
import type { ContentAnalysis } from './schemas.js';

export async function listProjects(organizationId: string, db: Db = prisma) {
  const projects = await db.repurposeProject.findMany({
    where: { organizationId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 60,
    select: {
      id: true,
      name: true,
      sourceType: true,
      status: true,
      sourceTitle: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { assets: true } },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    sourceType: p.sourceType,
    status: p.status,
    sourceTitle: p.sourceTitle,
    assetCount: p._count.assets,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export async function getProject(organizationId: string, projectId: string, db: Db = prisma) {
  const project = await db.repurposeProject.findFirst({
    where: { id: projectId, organizationId, deletedAt: null },
    include: {
      assets: {
        orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        include: {
          currentVersion: true,
          _count: { select: { versions: true } },
        },
      },
    },
  });
  if (!project) return null;

  const statusCounts: Record<string, number> = {};
  for (const a of project.assets) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;

  return {
    id: project.id,
    name: project.name,
    sourceType: project.sourceType,
    status: project.status,
    sourceUrl: project.sourceUrl,
    sourceTitle: project.sourceTitle,
    sourceDescription: project.sourceDescription,
    sourceTranscript: project.sourceTranscript,
    sourceBody: project.sourceBody,
    sourceTags: project.sourceTags,
    sourceDurationSec: project.sourceDurationSec,
    analysis: (project.analysis as unknown as ContentAnalysis | null) ?? null,
    analysisGrounded: project.analysisGrounded,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    statusCounts,
    assets: project.assets.map((a) => ({
      id: a.id,
      type: a.type,
      platform: a.platform,
      title: a.title,
      status: a.status,
      sourceAngle: a.sourceAngle,
      scheduledFor: a.scheduledFor,
      publishedAt: a.publishedAt,
      publishTarget: a.publishTarget,
      failureReason: a.failureReason,
      approvedAt: a.approvedAt,
      versionCount: a._count.versions,
      currentVersionNumber: a.currentVersion?.versionNumber ?? null,
      body: a.currentVersion?.body ?? '',
      structured: a.currentVersion?.structured ?? null,
      updatedAt: a.updatedAt,
    })),
  };
}

export async function getAsset(organizationId: string, assetId: string, db: Db = prisma) {
  return db.contentAsset.findFirst({
    where: { id: assetId, organizationId },
    include: { currentVersion: true, project: { select: { id: true, name: true } } },
  });
}

export async function listAssetVersions(organizationId: string, assetId: string, db: Db = prisma) {
  const asset = await db.contentAsset.findFirst({
    where: { id: assetId, organizationId },
    select: { id: true, currentVersionId: true },
  });
  if (!asset) return { current: null, versions: [] };
  const versions = await db.contentAssetVersion.findMany({
    where: { contentAssetId: assetId },
    orderBy: { versionNumber: 'desc' },
    take: 50,
  });
  return {
    current: asset.currentVersionId,
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      body: v.body,
      structured: v.structured,
      editedById: v.editedById,
      editSummary: v.editSummary,
      isAi: v.editedById === null,
      isCurrent: v.id === asset.currentVersionId,
      createdAt: v.createdAt,
    })),
  };
}

/** SCHEDULED assets whose time has come — surfaced to the user, never auto-published. */
export async function listDueScheduled(organizationId: string, db: Db = prisma) {
  return db.contentAsset.findMany({
    where: { organizationId, status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: 'asc' },
    include: { project: { select: { id: true, name: true } } },
    take: 100,
  });
}

export async function countAssetsByStatus(
  organizationId: string,
  db: Db = prisma,
): Promise<Record<ContentAssetStatus, number>> {
  const rows = await db.contentAsset.groupBy({
    by: ['status'],
    where: { organizationId },
    _count: { _all: true },
  });
  const out = { DRAFT: 0, APPROVED: 0, SCHEDULED: 0, PUBLISHED: 0, FAILED: 0 } as Record<
    ContentAssetStatus,
    number
  >;
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}
