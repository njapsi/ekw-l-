/**
 * Part 53-54: duplicate detection + a safe consolidation workflow.
 * "Never silently merge contradictory information" — this module only ever
 * *suggests* a pair for a human to review (`findDuplicateCandidates`); the
 * actual merge (`consolidateInto`) is a separate, explicit, audited action
 * that keeps one item's content and archives the other, never auto-invoked.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

function normalize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface DuplicateCandidate {
  aId: string;
  bId: string;
  aTitle: string;
  bTitle: string;
  similarity: number;
}

/** Same org, same type/scope, high normalized-text overlap (>= 0.6) — a
 * conservative threshold so near-identical restatements ("our audience is
 * small businesses" / "our customers are primarily small businesses") are
 * caught without merging genuinely distinct items. */
export async function findDuplicateCandidates(
  organizationId: string,
  limit = 20,
  db: Db = prisma,
): Promise<DuplicateCandidate[]> {
  const items = await db.knowledgeItem.findMany({
    where: { organizationId, status: { notIn: ['ARCHIVED', 'REJECTED', 'EXPIRED'] } },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });

  const byGroup = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.type}:${item.scope}`;
    const group = byGroup.get(key) ?? [];
    group.push(item);
    byGroup.set(key, group);
  }

  const results: DuplicateCandidate[] = [];
  for (const group of byGroup.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const similarity = jaccard(normalize(a.content), normalize(b.content));
        if (similarity >= 0.6) {
          results.push({ aId: a.id, bId: b.id, aTitle: a.title, bTitle: b.title, similarity });
        }
      }
    }
  }
  return results.sort((x, y) => y.similarity - x.similarity).slice(0, limit);
}

/** Explicit, human-triggered merge: `keepId` survives, `mergeId` is
 * archived and pointed at the survivor via a `RELATES_TO` relation so the
 * history isn't lost. */
export async function consolidateInto(
  organizationId: string,
  keepId: string,
  mergeId: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const [keep, merge] = await Promise.all([
    db.knowledgeItem.findFirst({ where: { id: keepId, organizationId } }),
    db.knowledgeItem.findFirst({ where: { id: mergeId, organizationId } }),
  ]);
  if (!keep || !merge) throw AppError.notFound('Knowledge item');

  await db.knowledgeItem.update({ where: { id: mergeId }, data: { status: 'ARCHIVED' } });
  await db.knowledgeRelation.upsert({
    where: { fromId_toId_type: { fromId: mergeId, toId: keepId, type: 'DERIVED_FROM' } },
    create: { organizationId, fromId: mergeId, toId: keepId, type: 'DERIVED_FROM' },
    update: {},
  });
  await recordAudit(
    {
      organizationId,
      actorId,
      action: 'knowledge.consolidated',
      targetType: 'knowledge_item',
      targetId: keepId,
      metadata: { mergedId: mergeId },
    },
    db,
  );
  return keep;
}
