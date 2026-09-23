/**
 * Part 17-18: hybrid retrieval. Ranking blends keyword relevance + semantic
 * similarity (when embeddings are available) + metadata (recency, org
 * -assigned importance, confidence) — never vector similarity alone, per the
 * brief's explicit instruction. Retrieval is always tenant-scoped
 * (`organizationId` is a required, server-derived parameter) and respects
 * `KnowledgeScope` (Part 18: cross-tenant retrieval must be impossible; a
 * mission only sees `MISSION`-scoped items for ITS OWN `missionId` plus
 * every `ORGANIZATION`-scoped item).
 */
import { type Db, prisma } from '@growth-agent/db';
import type { KnowledgeScope, KnowledgeStatus, KnowledgeType } from '@growth-agent/db';
import { touchLastUsed } from './items.js';
import { type EmbeddingCapableModel, vectorSearch } from './embeddings.js';

export interface RetrievalFilter {
  types?: KnowledgeType[];
  scope?: KnowledgeScope;
  missionId?: string;
  statuses?: KnowledgeStatus[];
  limit?: number;
}

export interface RetrievedKnowledge {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  type: KnowledgeType;
  classification: string;
  confidence: number;
  importance: string;
  status: string;
  score: number;
  matchedVia: Array<'keyword' | 'vector' | 'importance'>;
}

const DEFAULT_STATUSES: KnowledgeStatus[] = ['ACTIVE', 'VERIFIED', 'UNVERIFIED', 'DRAFT', 'CONFLICTED'];
const IMPORTANCE_WEIGHT: Record<string, number> = { LOW: 0.1, MEDIUM: 0.3, HIGH: 0.6, CRITICAL: 1 };
const RECENCY_HALF_LIFE_DAYS = 180;

export async function retrieveKnowledge(
  organizationId: string,
  query: string,
  filter: RetrievalFilter = {},
  model: EmbeddingCapableModel | undefined,
  db: Db = prisma,
): Promise<RetrievedKnowledge[]> {
  const statuses = filter.statuses ?? DEFAULT_STATUSES;
  const limit = Math.min(filter.limit ?? 12, 50);
  const q = query.trim();

  const pool = await db.knowledgeItem.findMany({
    where: {
      organizationId,
      status: { in: statuses },
      ...(filter.types ? { type: { in: filter.types } } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
      // A caller scoped to one mission sees that mission's own items plus
      // every non-mission-scoped (org/user) item — never another mission's.
      ...(filter.missionId
        ? { OR: [{ missionId: filter.missionId }, { scope: { not: 'MISSION' } }] }
        : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { content: { contains: q, mode: 'insensitive' } },
              { summary: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });

  const vectorMatches = q ? await vectorSearch(organizationId, model, q, 40, db) : [];
  const bestDistanceByItem = new Map<string, number>();
  for (const m of vectorMatches) {
    const prev = bestDistanceByItem.get(m.knowledgeId);
    if (prev === undefined || m.distance < prev) bestDistanceByItem.set(m.knowledgeId, m.distance);
  }

  // A chunk can match semantically without matching any keyword — pull in
  // whatever the keyword pool missed.
  const poolIds = new Set(pool.map((p) => p.id));
  const extraIds = [...bestDistanceByItem.keys()].filter((id) => !poolIds.has(id));
  const extra = extraIds.length
    ? await db.knowledgeItem.findMany({
        where: { id: { in: extraIds }, organizationId, status: { in: statuses } },
      })
    : [];

  const now = Date.now();
  const scored = [...pool, ...extra].map((item) => {
    let keywordScore = 0;
    if (q) {
      const lower = q.toLowerCase();
      if (item.title.toLowerCase().includes(lower)) keywordScore += 0.5;
      if (item.summary?.toLowerCase().includes(lower)) keywordScore += 0.3;
      if (item.content.toLowerCase().includes(lower)) keywordScore += 0.2;
      keywordScore = Math.min(keywordScore, 1);
    }
    const distance = bestDistanceByItem.get(item.id);
    // Cosine distance is 0 (identical) .. 2 (opposite); map to a 0..1 score.
    const vectorScore = distance === undefined ? 0 : Math.max(0, 1 - distance / 2);
    const ageDays = (now - item.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - ageDays / RECENCY_HALF_LIFE_DAYS);
    const importanceScore = IMPORTANCE_WEIGHT[item.importance] ?? 0.3;

    const score =
      keywordScore * 0.3 +
      vectorScore * 0.3 +
      importanceScore * 0.15 +
      item.confidence * 0.15 +
      recencyScore * 0.1;

    const matchedVia: RetrievedKnowledge['matchedVia'] = [];
    if (keywordScore > 0) matchedVia.push('keyword');
    if (vectorScore > 0) matchedVia.push('vector');
    if (!q) matchedVia.push('importance');

    return { item, score, matchedVia };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  await touchLastUsed(top.map((t) => t.item.id), db);

  return top.map(({ item, score, matchedVia }) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    content: item.content,
    type: item.type,
    classification: item.classification,
    confidence: item.confidence,
    importance: item.importance,
    status: item.status,
    score: Math.round(score * 1000) / 1000,
    matchedVia,
  }));
}
