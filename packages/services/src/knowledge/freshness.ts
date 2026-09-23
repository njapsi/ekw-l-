/** Part 23, 36: knowledge freshness. "Do not treat old data as current
 * automatically" — `expiresAt` is computed once at write time from the
 * item's `freshnessPolicy`, and a scheduled sweep (`markStaleKnowledge`,
 * wired to the worker in `jobs.ts`) demotes anything past its expiry to
 * `STALE` rather than silently leaving it `ACTIVE`/`VERIFIED` forever. */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { DEFAULT_FRESHNESS_BY_TYPE, FRESHNESS_POLICIES, type FreshnessPolicyKey } from './schemas.js';
import type { KnowledgeType } from '@growth-agent/db';

const log = createLogger('knowledge.freshness');

export function resolveFreshnessPolicy(type: KnowledgeType, override?: string): FreshnessPolicyKey {
  if (override && override in FRESHNESS_POLICIES) return override as FreshnessPolicyKey;
  return DEFAULT_FRESHNESS_BY_TYPE[type];
}

export function computeExpiry(policyKey: string, from: Date = new Date()): Date | null {
  const policy = FRESHNESS_POLICIES[policyKey as FreshnessPolicyKey];
  if (!policy || policy.ttlDays === null) return null;
  return new Date(from.getTime() + policy.ttlDays * 24 * 60 * 60 * 1000);
}

/**
 * Demote every `ACTIVE`/`VERIFIED`/`UNVERIFIED` item whose `expiresAt` has
 * passed to `STALE`. Never deletes, never silently re-verifies — a human (or
 * a fresh sync) must explicitly re-verify or refresh it. Scoped to one org
 * when given, otherwise sweeps every org (the scheduled job's use).
 */
export async function markStaleKnowledge(
  organizationId: string | undefined,
  db: Db = prisma,
): Promise<number> {
  const result = await db.knowledgeItem.updateMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      status: { in: ['ACTIVE', 'VERIFIED', 'UNVERIFIED'] },
      expiresAt: { lt: new Date() },
    },
    data: { status: 'STALE' },
  });
  if (result.count > 0) {
    log.info({ organizationId: organizationId ?? 'all', count: result.count }, 'knowledge marked stale');
  }
  return result.count;
}

/** A human/agent explicitly confirming an item is still accurate — resets
 * the freshness clock without changing its content. Never auto-called by
 * the extractor or research engine (Part 4's "AI-generated knowledge should
 * NOT automatically become verified"). */
export async function reverifyKnowledgeItem(
  organizationId: string,
  knowledgeId: string,
  db: Db = prisma,
) {
  const item = await db.knowledgeItem.findFirst({ where: { id: knowledgeId, organizationId } });
  if (!item) return null;
  return db.knowledgeItem.update({
    where: { id: knowledgeId },
    data: {
      lastVerifiedAt: new Date(),
      status: item.status === 'STALE' || item.status === 'UNVERIFIED' ? 'VERIFIED' : item.status,
      expiresAt: computeExpiry(item.freshnessPolicy),
    },
  });
}
