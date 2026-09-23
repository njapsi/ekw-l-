/**
 * Part 37: two knowledge items that disagree are surfaced, never silently
 * resolved by picking one. Detection is a deliberately conservative
 * heuristic (same org, same `type`, overlapping title/content keywords, but
 * materially different confidence-weighted content) — a false negative
 * (missed conflict) is far cheaper than a false positive spamming the user
 * with unrelated items flagged as "conflicting".
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { createNotification } from '../notifications/index.js';

const log = createLogger('knowledge.conflicts');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'is', 'are', 'our', 'we', 'for', 'in', 'on', 'with',
  'this', 'that', 'it', 'be', 'as', 'at', 'by', 'from',
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Two items conflict when they cover the same topic (high title/keyword
 * overlap) but their content doesn't overlap much (they're saying different,
 * likely contradictory, things about it) — not just "similar", which is
 * `consolidation.ts`'s job (near-duplicates merge; this is the opposite: same
 * topic, different claim).
 */
function looksConflicting(
  a: { title: string; content: string },
  b: { title: string; content: string },
): boolean {
  const titleOverlap = jaccard(keywords(a.title), keywords(b.title));
  if (titleOverlap < 0.4) return false;
  const contentOverlap = jaccard(keywords(a.content), keywords(b.content));
  return contentOverlap < 0.35;
}

export async function detectConflictsForItem(
  organizationId: string,
  knowledgeId: string,
  db: Db = prisma,
): Promise<number> {
  const item = await db.knowledgeItem.findFirst({ where: { id: knowledgeId, organizationId } });
  if (!item || item.status === 'ARCHIVED' || item.status === 'REJECTED') return 0;

  const candidates = await db.knowledgeItem.findMany({
    where: {
      organizationId,
      type: item.type,
      scope: item.scope,
      id: { not: item.id },
      status: { notIn: ['ARCHIVED', 'REJECTED', 'EXPIRED'] },
    },
    take: 100,
    orderBy: { updatedAt: 'desc' },
  });

  let created = 0;
  for (const candidate of candidates) {
    if (!looksConflicting(item, candidate)) continue;
    const [knowledgeAId, knowledgeBId] = [item.id, candidate.id].sort();
    const existing = await db.knowledgeConflict.findFirst({
      where: { organizationId, knowledgeAId, knowledgeBId, status: 'OPEN' },
    });
    if (existing) continue;
    await db.knowledgeConflict.create({
      data: {
        organizationId,
        topic: item.title,
        knowledgeAId: knowledgeAId!,
        knowledgeBId: knowledgeBId!,
      },
    });
    await db.knowledgeItem.updateMany({
      where: { id: { in: [item.id, candidate.id] }, status: { not: 'ARCHIVED' } },
      data: { status: 'CONFLICTED' },
    });
    created++;
  }

  if (created > 0) {
    log.info({ organizationId, knowledgeId, created }, 'knowledge conflicts detected');
    await createNotification(
      {
        organizationId,
        kind: 'knowledge.conflict_detected',
        level: 'WARNING',
        title: 'Conflicting information found',
        body: `"${item.title}" conflicts with ${created} other stored item${created === 1 ? '' : 's'}. Review and resolve in the Knowledge Center.`,
        linkPath: '/app/knowledge/conflicts',
        dedupeKey: `knowledge:conflict:${knowledgeId}`,
      },
      db,
    ).catch(() => undefined);
  }
  return created;
}

export async function listConflicts(
  organizationId: string,
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED' = 'OPEN',
  db: Db = prisma,
) {
  return db.knowledgeConflict.findMany({
    where: { organizationId, status },
    include: { knowledgeA: true, knowledgeB: true },
    orderBy: { detectedAt: 'desc' },
    take: 100,
  });
}

export async function resolveConflict(
  organizationId: string,
  conflictId: string,
  input: { resolution: string; keepKnowledgeId?: string; status: 'RESOLVED' | 'DISMISSED' },
  actorId: string | null,
  db: Db = prisma,
) {
  const conflict = await db.knowledgeConflict.findFirst({ where: { id: conflictId, organizationId } });
  if (!conflict) return null;
  const updated = await db.knowledgeConflict.update({
    where: { id: conflictId },
    data: {
      status: input.status,
      resolution: input.resolution,
      resolvedById: actorId ?? undefined,
      resolvedAt: new Date(),
    },
  });
  if (input.status === 'RESOLVED') {
    const bothIds = [conflict.knowledgeAId, conflict.knowledgeBId];
    if (input.keepKnowledgeId && bothIds.includes(input.keepKnowledgeId)) {
      const rejectedId = bothIds.find((id) => id !== input.keepKnowledgeId)!;
      await db.knowledgeItem.update({ where: { id: rejectedId }, data: { status: 'REJECTED' } });
      await db.knowledgeItem.update({
        where: { id: input.keepKnowledgeId },
        data: { status: 'VERIFIED', lastVerifiedAt: new Date() },
      });
    } else {
      // Neither side declared the winner (e.g. "both are true in different
      // contexts") — clear CONFLICTED back to ACTIVE, don't guess a verdict.
      await db.knowledgeItem.updateMany({
        where: { id: { in: bothIds }, organizationId, status: 'CONFLICTED' },
        data: { status: 'ACTIVE' },
      });
    }
  }
  return updated;
}
