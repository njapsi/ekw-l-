/** Part 8: `ResearchProject` CRUD. Execution itself lives in `engine.ts` and
 * runs off the request path (Part 82 — long-running research must go through
 * the worker, never inline in a web request). */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { CreateResearchProjectInput, type CreateResearchProjectInputT } from './schemas.js';

export async function createResearchProject(
  rawInput: CreateResearchProjectInputT,
  opts: { organizationId: string; createdById: string },
  db: Db = prisma,
) {
  const input = CreateResearchProjectInput.parse(rawInput);
  const project = await db.researchProject.create({
    data: {
      organizationId: opts.organizationId,
      createdById: opts.createdById,
      missionId: input.missionId,
      question: input.question,
      objective: input.objective,
      scope: input.scope,
      config: input.config as never,
      status: 'REQUESTED',
    },
  });
  await recordAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.createdById,
      action: 'research.started',
      targetType: 'research_project',
      targetId: project.id,
      metadata: { question: input.question },
    },
    db,
  );
  return project;
}

export async function getResearchProject(organizationId: string, id: string, db: Db = prisma) {
  const project = await db.researchProject.findFirst({
    where: { id, organizationId },
    include: {
      queries: { orderBy: { createdAt: 'asc' } },
      findings: { orderBy: { createdAt: 'asc' }, include: { source: true } },
      citations: { orderBy: { createdAt: 'asc' }, include: { source: true } },
    },
  });
  if (!project) throw AppError.notFound('Research project');
  return project;
}

export async function listResearchProjects(
  organizationId: string,
  filter: { status?: string; missionId?: string; limit?: number } = {},
  db: Db = prisma,
) {
  return db.researchProject.findMany({
    where: {
      organizationId,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.missionId ? { missionId: filter.missionId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 30, 100),
  });
}

export async function cancelResearchProject(
  organizationId: string,
  id: string,
  actorId: string | null,
  db: Db = prisma,
) {
  const result = await db.researchProject.updateMany({
    where: {
      id,
      organizationId,
      status: { notIn: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] },
    },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (result.count === 0) return null;
  await recordAudit(
    { organizationId, actorId, action: 'research.cancelled', targetType: 'research_project', targetId: id },
    db,
  );
  return db.researchProject.findFirst({ where: { id, organizationId } });
}
