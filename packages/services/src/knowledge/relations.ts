/** Part 24: a relational knowledge graph (deliberately not a graph database
 * — Part 24 explicitly allows a relational model when it's sufficient). */
import { type Db, prisma } from '@growth-agent/db';
import type { KnowledgeRelationType } from '@growth-agent/db';
import { AppError } from '../errors.js';

export async function createRelation(
  organizationId: string,
  input: { fromId: string; toId: string; type: KnowledgeRelationType },
  db: Db = prisma,
) {
  const [from, to] = await Promise.all([
    db.knowledgeItem.findFirst({ where: { id: input.fromId, organizationId } }),
    db.knowledgeItem.findFirst({ where: { id: input.toId, organizationId } }),
  ]);
  if (!from || !to) throw AppError.notFound('Knowledge item');
  return db.knowledgeRelation.upsert({
    where: { fromId_toId_type: { fromId: input.fromId, toId: input.toId, type: input.type } },
    create: { organizationId, fromId: input.fromId, toId: input.toId, type: input.type },
    update: {},
  });
}

export async function listRelationsFor(organizationId: string, knowledgeId: string, db: Db = prisma) {
  const [from, to] = await Promise.all([
    db.knowledgeRelation.findMany({
      where: { organizationId, fromId: knowledgeId },
      include: { to: true },
    }),
    db.knowledgeRelation.findMany({
      where: { organizationId, toId: knowledgeId },
      include: { from: true },
    }),
  ]);
  return {
    outgoing: from.map((r) => ({ type: r.type, item: r.to })),
    incoming: to.map((r) => ({ type: r.type, item: r.from })),
  };
}
