/**
 * Automation-rule lifecycle: create / update / pause / resume / delete / list.
 *
 * On every create and update the OWNER's current role is checked against the
 * task type's `requiredAction` — a rule can never be configured to do something
 * its owner cannot do. The same check runs again at execution time
 * (`runner.executeAutomationRun`), so losing a role later disables the rule's
 * effect rather than the rule.
 */
import {
  type AutomationCadence,
  type AutomationStatus,
  type Db,
  type MembershipStatus,
  type Role,
  prisma,
} from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac/authorize.js';
import { CronError, cronForCadence, describeCron, nextRunAfter, parseCron } from './cron.js';
import {
  type AutomationInput,
  type AutomationTaskTypeKey,
  TASK_TYPE_META,
  parseTaskConfig,
} from './schemas.js';

export interface OwnerAuthz {
  role: Role;
  membershipStatus: MembershipStatus;
}

/** The owner's current membership in the org, or `null` if they were removed. */
export async function resolveOwnerAuthz(
  ownerId: string,
  organizationId: string,
  db: Db = prisma,
): Promise<OwnerAuthz | null> {
  const m = await db.membership.findUnique({
    where: { userId_organizationId: { userId: ownerId, organizationId } },
    select: { role: true, status: true },
  });
  if (!m) return null;
  return { role: m.role, membershipStatus: m.status };
}

function assertOwnerMay(
  authz: OwnerAuthz | null,
  taskType: AutomationTaskTypeKey,
  who = 'You',
): void {
  const action = TASK_TYPE_META[taskType].requiredAction;
  if (!authz) {
    throw AppError.forbidden(`${who} are no longer a member of this organization.`);
  }
  try {
    authorize(
      { userId: 'owner', role: authz.role, membershipStatus: authz.membershipStatus },
      action,
    );
  } catch {
    throw AppError.forbidden(
      `${who} need the "${action}" permission to run "${TASK_TYPE_META[taskType].label}".`,
    );
  }
}

interface ResolvedSchedule {
  cadence: AutomationCadence;
  cronExpression: string;
  nextRunAt: Date;
}

function resolveSchedule(input: AutomationInput, from: Date): ResolvedSchedule {
  let cron: string;
  if (input.cadence === 'CUSTOM') {
    if (!input.cronExpression?.trim()) {
      throw AppError.validation('A custom schedule needs a cron expression.');
    }
    try {
      parseCron(input.cronExpression);
    } catch (e) {
      throw AppError.validation(e instanceof CronError ? e.message : 'Invalid cron expression.');
    }
    cron = input.cronExpression.trim();
  } else {
    cron = cronForCadence(input.cadence, {
      hour: input.hour,
      minute: input.minute,
      weekday: input.weekday,
      monthday: input.monthday,
    });
  }
  let nextRunAt: Date;
  try {
    nextRunAt = nextRunAfter(cron, from);
  } catch (e) {
    throw AppError.validation(e instanceof CronError ? e.message : 'That schedule never fires.');
  }
  return { cadence: input.cadence, cronExpression: cron, nextRunAt };
}

export interface CreateAutomationInput extends AutomationInput {
  organizationId: string;
  /** The acting user — also the owner of the new rule. */
  userId: string;
}

export async function createAutomation(input: CreateAutomationInput, db: Db = prisma) {
  const taskType = input.taskType;
  if (!TASK_TYPE_META[taskType]) throw AppError.validation('Unknown automation task type.');

  const authz = await resolveOwnerAuthz(input.userId, input.organizationId, db);
  assertOwnerMay(authz, taskType);

  const config = parseConfigOrThrow(taskType, input.config);
  const schedule = resolveSchedule(input, new Date());
  const maxRetries = clampRetries(input.maxRetries);

  const rule = await db.automationRule.create({
    data: {
      organizationId: input.organizationId,
      ownerId: input.userId,
      createdById: input.userId,
      taskType,
      name: input.name.trim().slice(0, 120) || TASK_TYPE_META[taskType].label,
      cadence: schedule.cadence,
      cronExpression: schedule.cronExpression,
      timezone: 'UTC',
      config: config as never,
      status: 'ACTIVE',
      maxRetries,
      nextRunAt: schedule.nextRunAt,
    },
  });

  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'automation.created',
      targetType: 'automation_rule',
      targetId: rule.id,
      metadata: {
        taskType,
        cron: schedule.cronExpression,
        nextRunAt: schedule.nextRunAt.toISOString(),
      },
    },
    db,
  );
  return rule;
}

export interface UpdateAutomationInput extends Partial<AutomationInput> {
  organizationId: string;
  userId: string;
  automationId: string;
}

export async function updateAutomation(input: UpdateAutomationInput, db: Db = prisma) {
  const rule = await getRuleOrThrow(input.organizationId, input.automationId, db);
  const taskType: AutomationTaskTypeKey = input.taskType ?? rule.taskType;

  // The acting user must be able to manage automations AND the owner (after any
  // ownership stays the same) must still be allowed to run the task type.
  const authz = await resolveOwnerAuthz(rule.ownerId, input.organizationId, db);
  assertOwnerMay(authz, taskType, 'The owner');

  const nextConfig =
    input.config !== undefined
      ? parseConfigOrThrow(taskType, input.config)
      : (rule.config as unknown);

  const merged: AutomationInput = {
    name: input.name ?? rule.name,
    taskType,
    cadence: input.cadence ?? rule.cadence,
    cronExpression:
      input.cronExpression ?? (rule.cadence === 'CUSTOM' ? rule.cronExpression : undefined),
    hour: input.hour,
    minute: input.minute,
    weekday: input.weekday,
    monthday: input.monthday,
    config: nextConfig,
    maxRetries: input.maxRetries,
  };
  const schedule = resolveSchedule(merged, new Date());

  const updated = await db.automationRule.update({
    where: { id: rule.id },
    data: {
      name: merged.name.trim().slice(0, 120) || TASK_TYPE_META[taskType].label,
      taskType,
      cadence: schedule.cadence,
      cronExpression: schedule.cronExpression,
      config: nextConfig as never,
      maxRetries: input.maxRetries != null ? clampRetries(input.maxRetries) : rule.maxRetries,
      nextRunAt: rule.status === 'ACTIVE' || rule.status === 'FAILING' ? schedule.nextRunAt : null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'automation.updated',
      targetType: 'automation_rule',
      targetId: rule.id,
      metadata: { taskType, cron: schedule.cronExpression },
    },
    db,
  );
  return updated;
}

export async function setAutomationStatus(
  input: {
    organizationId: string;
    userId: string;
    automationId: string;
    status: Extract<AutomationStatus, 'ACTIVE' | 'PAUSED'>;
  },
  db: Db = prisma,
) {
  const rule = await getRuleOrThrow(input.organizationId, input.automationId, db);

  let nextRunAt: Date | null = rule.nextRunAt;
  let failureCount = rule.failureCount;
  if (input.status === 'ACTIVE') {
    // Re-enabling clears a FAILING/DISABLED state and reschedules.
    nextRunAt = nextRunAfter(rule.cronExpression, new Date());
    failureCount = 0;
  } else {
    nextRunAt = null;
  }

  const updated = await db.automationRule.update({
    where: { id: rule.id },
    data: {
      status: input.status,
      nextRunAt,
      failureCount,
      lastError: input.status === 'ACTIVE' ? null : rule.lastError,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: input.status === 'ACTIVE' ? 'automation.resumed' : 'automation.paused',
      targetType: 'automation_rule',
      targetId: rule.id,
    },
    db,
  );
  return updated;
}

export async function deleteAutomation(
  input: { organizationId: string; userId: string; automationId: string },
  db: Db = prisma,
) {
  const rule = await getRuleOrThrow(input.organizationId, input.automationId, db);
  await db.automationRule.delete({ where: { id: rule.id } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'automation.deleted',
      targetType: 'automation_rule',
      targetId: rule.id,
      metadata: { taskType: rule.taskType },
    },
    db,
  );
}

export async function listAutomations(organizationId: string, db: Db = prisma) {
  const rules = await db.automationRule.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: {
      runs: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  return rules.map((r) => ({
    ...shapeRule(r),
    lastRun: r.runs[0]
      ? {
          id: r.runs[0].id,
          status: r.runs[0].status,
          finishedAt: r.runs[0].finishedAt?.toISOString() ?? null,
          error: r.runs[0].error,
        }
      : null,
  }));
}

export async function getAutomation(organizationId: string, automationId: string, db: Db = prisma) {
  const rule = await db.automationRule.findFirst({
    where: { id: automationId, organizationId },
  });
  if (!rule) return null;
  const runs = await db.automationRun.findMany({
    where: { automationRuleId: rule.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return {
    ...shapeRule(rule),
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      triggeredBy: run.triggeredBy,
      scheduledFor: run.scheduledFor.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs,
      nextAttemptAt: run.nextAttemptAt?.toISOString() ?? null,
      output: run.output,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
    })),
  };
}

// --- shared helpers ----------------------------------------------------

function shapeRule(r: {
  id: string;
  taskType: string;
  name: string;
  cadence: string;
  cronExpression: string;
  timezone: string;
  config: unknown;
  status: string;
  maxRetries: number;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  nextRunAt: Date | null;
  failureCount: number;
  totalRuns: number;
  lastError: string | null;
  ownerId: string;
  createdAt: Date;
}) {
  return {
    id: r.id,
    taskType: r.taskType,
    taskLabel: TASK_TYPE_META[r.taskType as AutomationTaskTypeKey]?.label ?? r.taskType,
    name: r.name,
    cadence: r.cadence,
    cronExpression: r.cronExpression,
    scheduleLabel: describeCron(r.cronExpression),
    timezone: r.timezone,
    config: r.config,
    status: r.status,
    maxRetries: r.maxRetries,
    ownerId: r.ownerId,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastRunStatus: r.lastRunStatus,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    failureCount: r.failureCount,
    totalRuns: r.totalRuns,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  };
}

async function getRuleOrThrow(organizationId: string, automationId: string, db: Db) {
  const rule = await db.automationRule.findFirst({ where: { id: automationId, organizationId } });
  if (!rule) throw AppError.notFound('Automation');
  return rule;
}

function parseConfigOrThrow(taskType: AutomationTaskTypeKey, raw: unknown): unknown {
  try {
    return parseTaskConfig(taskType, raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid configuration.';
    throw AppError.validation(
      `Invalid configuration for ${TASK_TYPE_META[taskType].label}: ${msg}`,
    );
  }
}

function clampRetries(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 3;
  return Math.min(6, Math.max(0, Math.trunc(n)));
}
