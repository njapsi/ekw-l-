/**
 * Tasks — agent recommendations promoted to trackable work (master instruction:
 * "ACTIONS"). A task carries Title, Priority, Affected URLs, Instructions and
 * Status. Tasks are internal to the app; nothing here mutates an external
 * system. An action that would affect an external system is flagged
 * `requiresExternalAction` and must be carried out through the owning feature's
 * approval flow (TikTok publish approval, YouTube metadata change, …).
 */
import { type Db, type RecommendationDomain, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { recordCompletedTask } from './memory.js';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';

export interface CreateTaskInput {
  organizationId: string;
  userId: string;
  title: string;
  description?: string;
  instructions: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  domain?: RecommendationDomain;
  affectedUrls?: string[];
  affectedRefs?: string[];
  sourceRecommendationId?: string;
  sourceConversationId?: string;
  requiresExternalAction?: boolean;
  externalActionKind?: string;
}

export async function createTask(input: CreateTaskInput, db: Db = prisma) {
  const task = await db.task.create({
    data: {
      organizationId: input.organizationId,
      createdById: input.userId,
      title: input.title.slice(0, 200),
      description: (input.description ?? input.title).slice(0, 4000),
      instructions: input.instructions.slice(0, 8000),
      priority: input.priority ?? 'medium',
      domain: input.domain ?? 'GROWTH',
      affectedUrls: (input.affectedUrls ?? []).slice(0, 200),
      affectedRefs: (input.affectedRefs ?? []).slice(0, 50),
      sourceRecommendationId: input.sourceRecommendationId,
      sourceConversationId: input.sourceConversationId,
      requiresExternalAction: input.requiresExternalAction ?? false,
      externalActionKind: input.externalActionKind,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'task.created',
      targetType: 'task',
      targetId: task.id,
      metadata: {
        domain: task.domain,
        priority: task.priority,
        external: task.requiresExternalAction,
      },
    },
    db,
  );
  return task;
}

/** Materialise a stored `Recommendation` as a task, copying its fields. */
export async function createTaskFromRecommendation(
  input: {
    organizationId: string;
    userId: string;
    recommendationId: string;
    sourceConversationId?: string;
  },
  db: Db = prisma,
) {
  const rec = await db.recommendation.findFirst({
    where: { id: input.recommendationId, organizationId: input.organizationId },
  });
  if (!rec) throw AppError.notFound('Recommendation');

  const evidence = rec.evidence as { affectedUrlSample?: string[]; affectedUrls?: string[] } | null;
  const affectedUrls = evidence?.affectedUrlSample ?? evidence?.affectedUrls ?? [];

  return createTask(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      title: rec.title,
      description: rec.explanation,
      instructions: rec.implementationInstructions,
      priority: normalizePriority(rec.priority),
      domain: rec.domain,
      affectedUrls,
      affectedRefs: rec.subjectRef ? [rec.subjectRef] : [],
      sourceRecommendationId: rec.id,
      sourceConversationId: input.sourceConversationId,
    },
    db,
  );
}

export async function listTasks(
  organizationId: string,
  opts: { status?: TaskStatus; domain?: RecommendationDomain } = {},
  db: Db = prisma,
) {
  return db.task.findMany({
    where: {
      organizationId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.domain ? { domain: opts.domain } : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
}

export async function getTask(organizationId: string, taskId: string, db: Db = prisma) {
  return db.task.findFirst({ where: { id: taskId, organizationId } });
}

export async function updateTaskStatus(
  input: { organizationId: string; userId: string; taskId: string; status: TaskStatus },
  db: Db = prisma,
) {
  const task = await db.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
  });
  if (!task) throw AppError.notFound('Task');

  const done = input.status === 'DONE';
  const updated = await db.task.update({
    where: { id: task.id },
    data: {
      status: input.status,
      completedAt: done ? new Date() : task.status === 'DONE' ? null : task.completedAt,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'task.status_changed',
      targetType: 'task',
      targetId: task.id,
      metadata: { from: task.status, to: input.status },
    },
    db,
  );
  if (done) {
    await recordCompletedTask(
      { organizationId: input.organizationId, taskId: task.id, title: task.title },
      db,
    );
  }
  return updated;
}

function normalizePriority(p: string): 'critical' | 'high' | 'medium' | 'low' {
  const s = p.toLowerCase();
  if (s.startsWith('crit')) return 'critical';
  if (s.startsWith('hi')) return 'high';
  if (s.startsWith('lo')) return 'low';
  return 'medium';
}
