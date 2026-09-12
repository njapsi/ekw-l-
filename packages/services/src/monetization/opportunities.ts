/**
 * Opportunity lifecycle. Statuses (master instruction "MONETIZATION DASHBOARD"):
 * SUGGESTED (potential) → IN_PROGRESS / ACTIVE (current) → COMPLETED, or
 * DISMISSED with a reason. A recommended action can become a `Task`.
 */
import { type Db, type OpportunityStatus, prisma } from '@growth-agent/db';
import { createTask } from '../agent/tasks.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { CHANNEL_LABEL } from './schemas.js';

const CHANNEL_TO_DOMAIN: Record<string, 'YOUTUBE' | 'TIKTOK' | 'GROWTH' | 'CONTENT'> = {
  PLATFORM_MONETIZATION: 'YOUTUBE',
};

export async function updateOpportunityStatus(
  input: {
    organizationId: string;
    userId: string;
    opportunityId: string;
    status: OpportunityStatus;
    reason?: string;
  },
  db: Db = prisma,
) {
  const opp = await db.monetizationOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const updated = await db.monetizationOpportunity.update({
    where: { id: opp.id },
    data: {
      status: input.status,
      dismissedReason:
        input.status === 'DISMISSED' ? (input.reason ?? 'Dismissed by user.').slice(0, 500) : null,
      completedNote:
        input.status === 'COMPLETED'
          ? ((input.reason ?? null)?.slice(0, 500) ?? null)
          : opp.completedNote,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.opportunity.status_changed',
      targetType: 'monetization_opportunity',
      targetId: opp.id,
      metadata: { from: opp.status, to: input.status, channel: opp.channel },
    },
    db,
  );
  return updated;
}

export async function promoteOpportunityToTask(
  input: { organizationId: string; userId: string; opportunityId: string },
  db: Db = prisma,
) {
  const opp = await db.monetizationOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const channelLabel = CHANNEL_LABEL[opp.channel] ?? opp.channel;
  const task = await createTask(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      title: `Monetization: ${opp.title}`,
      description: `${opp.description}\n\nEstimates (labelled): audience fit ${opp.audienceFit}, difficulty ${opp.difficulty}, potential ${opp.potential}. ${opp.potentialBasis}`,
      instructions: opp.requiredActions.map((a, i) => `${i + 1}. ${a}`).join('\n'),
      priority: opp.priorityScore != null && opp.priorityScore >= 65 ? 'high' : 'medium',
      domain: CHANNEL_TO_DOMAIN[opp.channel] ?? 'GROWTH',
      affectedRefs: [`monetization:${opp.channel}`],
    },
    db,
  );
  if (opp.status === 'SUGGESTED') {
    await db.monetizationOpportunity.update({
      where: { id: opp.id },
      data: { status: 'IN_PROGRESS' },
    });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.opportunity.promoted',
      targetType: 'monetization_opportunity',
      targetId: opp.id,
      metadata: { taskId: task.id, channel: channelLabel },
    },
    db,
  );
  return task;
}

export async function listOpportunities(
  organizationId: string,
  opts: { status?: OpportunityStatus } = {},
  db: Db = prisma,
) {
  return db.monetizationOpportunity.findMany({
    where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
  });
}
