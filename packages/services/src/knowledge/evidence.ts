/** Part 7: the evidence architecture — links one claim to the source that
 * backs it. Every important recommendation should be traceable to evidence
 * whenever evidence exists. */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';

export interface AttachEvidenceInput {
  organizationId: string;
  knowledgeId: string;
  sourceId: string;
  claim: string;
  evidence: string;
  location?: string;
  confidence?: number;
}

export async function attachEvidence(input: AttachEvidenceInput, db: Db = prisma) {
  const knowledge = await db.knowledgeItem.findFirst({
    where: { id: input.knowledgeId, organizationId: input.organizationId },
  });
  if (!knowledge) throw AppError.notFound('Knowledge item');
  const source = await db.knowledgeSource.findFirst({
    where: { id: input.sourceId, organizationId: input.organizationId },
  });
  if (!source) throw AppError.notFound('Source');

  return db.knowledgeEvidence.create({
    data: {
      organizationId: input.organizationId,
      knowledgeId: input.knowledgeId,
      sourceId: input.sourceId,
      claim: input.claim.slice(0, 2000),
      evidence: input.evidence.slice(0, 4000),
      location: input.location,
      confidence: input.confidence ?? 0.5,
    },
  });
}

export async function listEvidenceForKnowledge(
  organizationId: string,
  knowledgeId: string,
  db: Db = prisma,
) {
  return db.knowledgeEvidence.findMany({
    where: { organizationId, knowledgeId },
    include: { source: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getEvidence(organizationId: string, id: string, db: Db = prisma) {
  return db.knowledgeEvidence.findFirst({
    where: { id, organizationId },
    include: { source: true, knowledge: true },
  });
}

export async function searchEvidence(
  organizationId: string,
  query: string,
  limit = 20,
  db: Db = prisma,
) {
  return db.knowledgeEvidence.findMany({
    where: {
      organizationId,
      OR: [
        { claim: { contains: query, mode: 'insensitive' } },
        { evidence: { contains: query, mode: 'insensitive' } },
      ],
    },
    include: { source: true },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 50),
  });
}
