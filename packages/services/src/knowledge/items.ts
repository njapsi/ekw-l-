/** Part 3-5. Core `KnowledgeItem` CRUD. Every write is tenant-scoped by a
 * server-derived `organizationId` — never taken from client input. */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import {
  CreateKnowledgeItemInput,
  type CreateKnowledgeItemInputT,
  UpdateKnowledgeItemInput,
  type UpdateKnowledgeItemInputT,
} from './schemas.js';
import { computeExpiry, resolveFreshnessPolicy } from './freshness.js';
import { createOrReuseSource } from './sources.js';
import { detectConflictsForItem } from './conflicts.js';

export interface CreateKnowledgeItemOptions {
  organizationId: string;
  createdById?: string | null;
  freshnessPolicy?: string;
  /** Skip conflict detection (the ingestion/consolidation pipelines run it
   * themselves in bulk, after all items in a batch exist). */
  skipConflictCheck?: boolean;
}

export async function createKnowledgeItem(
  rawInput: CreateKnowledgeItemInputT,
  opts: CreateKnowledgeItemOptions,
  db: Db = prisma,
) {
  const input = CreateKnowledgeItemInput.parse(rawInput);
  const freshnessPolicy = resolveFreshnessPolicy(input.type, opts.freshnessPolicy);

  let primarySourceId: string | undefined;
  if (input.source) {
    const source = await createOrReuseSource(
      { organizationId: opts.organizationId, content: input.content, ...input.source },
      db,
    );
    primarySourceId = source.id;
  }

  const item = await db.knowledgeItem.create({
    data: {
      organizationId: opts.organizationId,
      createdById: opts.createdById ?? undefined,
      missionId: input.scope === 'MISSION' ? input.missionId : undefined,
      type: input.type,
      scope: input.scope,
      title: input.title,
      content: input.content,
      summary: input.summary,
      classification: input.classification,
      confidence: input.confidence,
      importance: input.importance,
      status: input.status,
      primarySourceId,
      freshnessPolicy,
      expiresAt: computeExpiry(freshnessPolicy),
      metadata: input.metadata as never,
    },
  });

  await recordAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.createdById ?? null,
      action: 'knowledge.created',
      targetType: 'knowledge_item',
      targetId: item.id,
      metadata: { type: item.type, scope: item.scope, classification: item.classification },
    },
    db,
  );

  if (!opts.skipConflictCheck) {
    await detectConflictsForItem(opts.organizationId, item.id, db).catch(() => undefined);
  }

  return item;
}

export async function getKnowledgeItem(organizationId: string, id: string, db: Db = prisma) {
  const item = await db.knowledgeItem.findFirst({
    where: { id, organizationId },
    include: { primarySource: true, evidence: { include: { source: true } } },
  });
  if (!item) throw AppError.notFound('Knowledge item');
  return item;
}

export interface ListKnowledgeItemsFilter {
  type?: string;
  status?: string;
  scope?: string;
  missionId?: string;
  classification?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export async function listKnowledgeItems(
  organizationId: string,
  filter: ListKnowledgeItemsFilter = {},
  db: Db = prisma,
) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const items = await db.knowledgeItem.findMany({
    where: {
      organizationId,
      ...(filter.type ? { type: filter.type as never } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.scope ? { scope: filter.scope as never } : {}),
      ...(filter.missionId ? { missionId: filter.missionId } : {}),
      ...(filter.classification ? { classification: filter.classification as never } : {}),
      ...(filter.search
        ? {
            OR: [
              { title: { contains: filter.search, mode: 'insensitive' } },
              { content: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  return { items: items.slice(0, limit), nextCursor: hasMore ? items[limit]!.id : null };
}

export async function updateKnowledgeItem(
  organizationId: string,
  id: string,
  rawInput: UpdateKnowledgeItemInputT,
  actorId: string | null,
  db: Db = prisma,
) {
  const input = UpdateKnowledgeItemInput.parse(rawInput);
  const existing = await db.knowledgeItem.findFirst({ where: { id, organizationId } });
  if (!existing) throw AppError.notFound('Knowledge item');

  const updated = await db.knowledgeItem.update({
    where: { id },
    data: {
      ...input,
      metadata: input.metadata as never,
    },
  });
  await recordAudit(
    {
      organizationId,
      actorId,
      action: 'knowledge.updated',
      targetType: 'knowledge_item',
      targetId: id,
      metadata: { fields: Object.keys(input) },
    },
    db,
  );
  return updated;
}

/** Part 4: the ONLY path that sets `VERIFIED` — never automatic. */
export async function verifyKnowledgeItem(
  organizationId: string,
  id: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const existing = await db.knowledgeItem.findFirst({ where: { id, organizationId } });
  if (!existing) throw AppError.notFound('Knowledge item');
  const updated = await db.knowledgeItem.update({
    where: { id },
    data: {
      status: 'VERIFIED',
      lastVerifiedAt: new Date(),
      expiresAt: computeExpiry(existing.freshnessPolicy),
    },
  });
  await recordAudit(
    { organizationId, actorId, action: 'knowledge.verified', targetType: 'knowledge_item', targetId: id },
    db,
  );
  return updated;
}

export async function archiveKnowledgeItem(
  organizationId: string,
  id: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const existing = await db.knowledgeItem.findFirst({ where: { id, organizationId } });
  if (!existing) throw AppError.notFound('Knowledge item');
  const updated = await db.knowledgeItem.update({ where: { id }, data: { status: 'ARCHIVED' } });
  await recordAudit(
    { organizationId, actorId, action: 'knowledge.archived', targetType: 'knowledge_item', targetId: id },
    db,
  );
  return updated;
}

/** Part 59: right-to-delete. Cascades (evidence/embeddings/relations/
 * conflicts) are all `onDelete: Cascade` in the schema except conflicts,
 * which also cascade — nothing orphaned in the vector index either, since
 * `knowledge_embeddings` cascades on `knowledgeId`. */
export async function deleteKnowledgeItem(
  organizationId: string,
  id: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const existing = await db.knowledgeItem.findFirst({ where: { id, organizationId } });
  if (!existing) throw AppError.notFound('Knowledge item');
  await db.knowledgeItem.delete({ where: { id } });
  await recordAudit(
    { organizationId, actorId, action: 'knowledge.deleted', targetType: 'knowledge_item', targetId: id },
    db,
  );
}

/** Marks a knowledge item as having been used in a retrieval/answer, for
 * Part 3's `lastUsedAt` freshness signal. Best-effort, never throws. */
export async function touchLastUsed(ids: string[], db: Db = prisma): Promise<void> {
  if (ids.length === 0) return;
  await db.knowledgeItem
    .updateMany({ where: { id: { in: ids } }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}
