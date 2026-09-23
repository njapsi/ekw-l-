/**
 * Part 20-22: memory governance. A statement worth remembering becomes a
 * `MemoryCandidate`, not an immediately-live `KnowledgeItem` — "Do not
 * automatically save every statement." A candidate is auto-accepted only
 * when it is unambiguously safe to (low stakes, high confidence, directly
 * user-stated); anything else waits for a human in the Knowledge Center.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { createNotification } from '../notifications/index.js';
import type { KnowledgeClassification, KnowledgeImportance, KnowledgeScope, KnowledgeType } from '@growth-agent/db';
import { createKnowledgeItem } from './items.js';

const log = createLogger('knowledge.candidates');

export interface ProposeMemoryCandidateInput {
  organizationId: string;
  userId?: string | null;
  conversationId?: string | null;
  content: string;
  proposedType: KnowledgeType;
  classification?: KnowledgeClassification;
  scope?: KnowledgeScope;
  importance?: KnowledgeImportance;
  confidence?: number;
  reason: string;
}

/** Auto-accept only a `USER_PROVIDED` statement, `MEDIUM` importance or
 * below, with confidence at or above 0.75 — a business-changing claim
 * (`HIGH`/`CRITICAL` importance) always waits for a human, no matter how
 * confident the extractor was. */
function isSafeToAutoAccept(input: ProposeMemoryCandidateInput): boolean {
  const importance = input.importance ?? 'MEDIUM';
  const confidence = input.confidence ?? 0.6;
  const classification = input.classification ?? 'USER_PROVIDED';
  return (
    classification === 'USER_PROVIDED' &&
    (importance === 'LOW' || importance === 'MEDIUM') &&
    confidence >= 0.75
  );
}

export async function proposeMemoryCandidate(input: ProposeMemoryCandidateInput, db: Db = prisma) {
  // Supersede an unreviewed candidate proposing the same thing again in a
  // later turn, rather than piling up duplicates in the review queue.
  const duplicate = await db.memoryCandidate.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId ?? undefined,
      proposedType: input.proposedType,
      status: 'PENDING',
      content: { equals: input.content, mode: 'insensitive' },
    },
  });
  if (duplicate) return duplicate;

  const candidate = await db.memoryCandidate.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId ?? undefined,
      conversationId: input.conversationId ?? undefined,
      content: input.content.slice(0, 4000),
      proposedType: input.proposedType,
      classification: input.classification ?? 'USER_PROVIDED',
      scope: input.scope ?? 'ORGANIZATION',
      importance: input.importance ?? 'MEDIUM',
      confidence: input.confidence ?? 0.6,
      reason: input.reason.slice(0, 500),
    },
  });

  if (isSafeToAutoAccept(input)) {
    return acceptMemoryCandidate(input.organizationId, candidate.id, null, db, true);
  }

  await createNotification(
    {
      organizationId: input.organizationId,
      userId: input.userId ?? undefined,
      kind: 'knowledge.memory_candidate_pending',
      level: 'INFO',
      title: 'New knowledge to review',
      body: `"${candidate.content.slice(0, 120)}" — review and confirm in the Knowledge Center.`,
      linkPath: '/app/knowledge/memories',
      dedupeKey: `memory-candidate:${candidate.id}`,
    },
    db,
  ).catch(() => undefined);

  return candidate;
}

export async function listMemoryCandidates(
  organizationId: string,
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'AUTO_ACCEPTED' | 'SUPERSEDED' = 'PENDING',
  db: Db = prisma,
) {
  return db.memoryCandidate.findMany({
    where: { organizationId, status },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function acceptMemoryCandidate(
  organizationId: string,
  candidateId: string,
  actorId: string | null,
  db: Db = prisma,
  auto = false,
) {
  const candidate = await db.memoryCandidate.findFirst({ where: { id: candidateId, organizationId } });
  if (!candidate) throw AppError.notFound('Memory candidate');
  if (candidate.status !== 'PENDING') return candidate;

  const item = await createKnowledgeItem(
    {
      type: candidate.proposedType,
      scope: candidate.scope,
      title: candidate.content.slice(0, 120),
      content: candidate.content,
      classification: candidate.classification,
      confidence: candidate.confidence,
      importance: candidate.importance,
      status: 'ACTIVE',
      source: { type: 'USER_INPUT' },
    },
    { organizationId, createdById: candidate.userId ?? actorId },
    db,
  );

  const updated = await db.memoryCandidate.update({
    where: { id: candidateId },
    data: {
      status: auto ? 'AUTO_ACCEPTED' : 'ACCEPTED',
      resolvedKnowledgeId: item.id,
      resolvedById: actorId ?? undefined,
      resolvedAt: new Date(),
    },
  });
  log.info({ organizationId, candidateId, knowledgeId: item.id, auto }, 'memory candidate accepted');
  return updated;
}

export async function rejectMemoryCandidate(
  organizationId: string,
  candidateId: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const candidate = await db.memoryCandidate.findFirst({ where: { id: candidateId, organizationId } });
  if (!candidate) throw AppError.notFound('Memory candidate');
  if (candidate.status !== 'PENDING') return candidate;
  return db.memoryCandidate.update({
    where: { id: candidateId },
    data: { status: 'REJECTED', resolvedById: actorId ?? undefined, resolvedAt: new Date() },
  });
}
