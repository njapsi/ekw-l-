/**
 * The integration approval queue (Phase 1, Parts 7 + 14).
 *
 * The capability model *declares* that WRITE / PUBLISH / DANGEROUS actions
 * need a human; this module *enforces* it. Such an action can only reach an
 * external system through `decideActionRequest(..., 'approve')`:
 *
 *   request → PENDING ──approve──▶ APPROVED → execute → EXECUTED | FAILED
 *                     ├─reject───▶ REJECTED
 *                     ├─cancel───▶ CANCELLED (by the requester)
 *                     └─timeout──▶ EXPIRED   (7 days)
 *
 * The PENDING → APPROVED transition is a single conditional `updateMany`, so
 * two admins clicking "Approve" at once execute the action exactly once.
 *
 * There is no org-level "skip approval" switch today: hard rule 4 allows one
 * ("unless the org enabled automation mode") but none exists in the product,
 * so the safe default — always ask — is the only behaviour (ADR-0051).
 */
import { type Db, type IntegrationActionSource, type Prisma, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ZodError, type ZodType } from 'zod';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import {
  INTEGRATIONS,
  type IntegrationCapability,
  type IntegrationKey,
  requiresApproval,
  resolveCapabilities,
} from '../integrations/contract.js';
import { createNotification } from '../notifications/index.js';
import { scrubSecrets } from '../observability/scrub.js';
import { actionClassForLevel, assertGovernanceAllows } from '../governance/index.js';
import {
  CreateDraftPayload,
  PublishPostPayload,
  UpdatePostPayload,
  createDraft,
  executePublishPost,
  executeUpdatePost,
} from '../wordpress/actions.js';
import { requireWordPressSite } from '../wordpress/connect.js';
import { wordPressState } from '../wordpress/state.js';

const log = createLogger('approvals');

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ExecCtx {
  organizationId: string;
  connectionRef: string;
  actorId: string;
  db: Db;
}

interface Executor {
  integration: IntegrationKey;
  schema: ZodType<unknown>;
  /** Scopes the connection holds + whether it is usable — checked at request AND execute. */
  connection: (
    organizationId: string,
    connectionRef: string,
    db: Db,
  ) => Promise<{
    granted: string[];
    state: ReturnType<typeof wordPressState>;
    label: string;
  }>;
  execute: (ctx: ExecCtx, payload: unknown) => Promise<unknown>;
}

async function wordPressConnection(organizationId: string, connectionRef: string, db: Db) {
  const site = await requireWordPressSite(organizationId, connectionRef, db);
  return { granted: site.detectedCapabilities, state: wordPressState(site), label: site.siteUrl };
}

/**
 * Every externally-visible action Growth Agent can perform after approval.
 * A capability not listed here cannot be requested at all.
 * (TikTok publishing keeps its own pre-existing approval flow — ADR-0017.)
 */
const EXECUTORS: Record<string, Executor> = {
  // A draft is DRAFT-level and normally runs directly; it is listed so an
  // organization whose governance policy requires approval for AI drafts can
  // route agent-proposed drafts through this queue.
  'wordpress.create_draft': {
    integration: 'WORDPRESS',
    schema: CreateDraftPayload,
    connection: wordPressConnection,
    execute: (c, p) =>
      createDraft(
        { organizationId: c.organizationId, siteId: c.connectionRef, actorId: c.actorId, db: c.db },
        p,
      ),
  },
  'wordpress.update_post': {
    integration: 'WORDPRESS',
    schema: UpdatePostPayload,
    connection: wordPressConnection,
    execute: (c, p) =>
      executeUpdatePost(
        { organizationId: c.organizationId, siteId: c.connectionRef, actorId: c.actorId, db: c.db },
        p,
      ),
  },
  'wordpress.publish': {
    integration: 'WORDPRESS',
    schema: PublishPostPayload,
    connection: wordPressConnection,
    execute: (c, p) =>
      executePublishPost(
        { organizationId: c.organizationId, siteId: c.connectionRef, actorId: c.actorId, db: c.db },
        p,
      ),
  },
};

export function listApprovableCapabilities(): string[] {
  return Object.keys(EXECUTORS);
}

function capabilityFor(executor: Executor, capabilityId: string): IntegrationCapability {
  const cap = INTEGRATIONS[executor.integration].capabilities.find((c) => c.id === capabilityId);
  if (!cap) throw new Error(`executor ${capabilityId} has no descriptor capability`);
  return cap;
}

function parsePayload(schema: ZodType<unknown>, raw: unknown): unknown {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw AppError.validation(err.issues[0]?.message ?? 'Invalid request.');
    }
    throw err;
  }
}

async function assertCapabilityUsable(
  executor: Executor,
  cap: IntegrationCapability,
  organizationId: string,
  connectionRef: string,
  db: Db,
) {
  const conn = await executor.connection(organizationId, connectionRef, db);
  const resolved = resolveCapabilities(
    INTEGRATIONS[executor.integration],
    conn.granted,
    conn.state,
  ).find((c) => c.id === cap.id);
  if (!resolved?.usable) {
    throw AppError.forbidden(
      resolved?.unavailableReason ??
        `${INTEGRATIONS[executor.integration].label} is not in a usable state (${conn.state}).`,
    );
  }
  return conn;
}

export interface RequestActionInput {
  organizationId: string;
  requestedById: string | null;
  source?: IntegrationActionSource;
  capabilityId: string;
  connectionRef: string;
  payload: unknown;
  summary: string;
}

export async function requestIntegrationAction(input: RequestActionInput, db: Db = prisma) {
  const executor = EXECUTORS[input.capabilityId];
  if (!executor) {
    throw AppError.validation(`"${input.capabilityId}" is not an action Growth Agent can perform.`);
  }
  const cap = capabilityFor(executor, input.capabilityId);
  // AI governance (ADR-0052): a disabled action class cannot even be
  // requested, and the org may require approval for classes (e.g. drafts)
  // that the capability floor alone would let run directly.
  const governance = await assertGovernanceAllows(
    input.organizationId,
    executor.integration,
    actionClassForLevel(cap.level),
    { viaAgent: input.source === 'AGENT' },
    db,
  );
  if (!requiresApproval(cap.level) && !governance.requiresApproval) {
    throw AppError.validation(`${cap.label} does not need approval; run it directly.`);
  }
  const payload = parsePayload(executor.schema, input.payload);
  const conn = await assertCapabilityUsable(
    executor,
    cap,
    input.organizationId,
    input.connectionRef,
    db,
  );

  const summary = scrubSecrets(input.summary.trim()).slice(0, 300) || cap.label;
  const row = await db.integrationActionRequest.create({
    data: {
      organizationId: input.organizationId,
      integration: executor.integration,
      connectionRef: input.connectionRef,
      capabilityId: cap.id,
      level: cap.level,
      summary,
      payload: payload as Prisma.InputJsonValue,
      source: input.source ?? 'USER',
      requestedById: input.requestedById,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    actorId: input.requestedById,
    actorType:
      input.source === 'AGENT' ? 'AGENT' : input.source === 'AUTOMATION' ? 'SYSTEM' : 'USER',
    action: 'integration.action_requested',
    targetType: 'integration_action_request',
    targetId: row.id,
    metadata: { capabilityId: cap.id, level: cap.level, connection: conn.label },
  });
  await createNotification(
    {
      organizationId: input.organizationId,
      kind: 'integration.approval_needed',
      level: 'WARNING',
      title: `Approval needed: ${cap.label}`,
      body: `${summary} (${conn.label}). Nothing changes on ${INTEGRATIONS[executor.integration].label} until an admin approves it.`,
      linkPath: '/app/integrations/approvals',
      dedupeKey: `approval-requested:${row.id}`,
      sourceType: 'integration_action_request',
      sourceId: row.id,
      email: false,
    },
    db,
  );
  return row;
}

export async function listActionRequests(
  organizationId: string,
  opts: { status?: 'PENDING' | 'ALL'; limit?: number } = {},
  db: Db = prisma,
) {
  return db.integrationActionRequest.findMany({
    where: { organizationId, ...(opts.status === 'PENDING' ? { status: 'PENDING' } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 200),
  });
}

export async function countPendingActions(organizationId: string, db: Db = prisma) {
  return db.integrationActionRequest.count({
    where: { organizationId, status: 'PENDING', expiresAt: { gt: new Date() } },
  });
}

export type Decision = 'approve' | 'reject';

export async function decideActionRequest(
  input: { organizationId: string; deciderId: string; requestId: string; decision: Decision },
  db: Db = prisma,
) {
  const now = new Date();
  // Atomic claim — the only way out of PENDING.
  const claimed = await db.integrationActionRequest.updateMany({
    where: {
      id: input.requestId,
      organizationId: input.organizationId,
      status: 'PENDING',
      expiresAt: { gt: now },
    },
    data: {
      status: input.decision === 'approve' ? 'APPROVED' : 'REJECTED',
      decidedById: input.deciderId,
      decidedAt: now,
    },
  });
  const row = await db.integrationActionRequest.findFirst({
    where: { id: input.requestId, organizationId: input.organizationId },
  });
  if (!row) throw AppError.notFound('Approval request');
  if (claimed.count === 0) {
    throw AppError.conflict(
      row.status === 'PENDING'
        ? 'This request has expired.'
        : `This request was already ${row.status.toLowerCase()}.`,
    );
  }

  await recordAudit({
    organizationId: input.organizationId,
    actorId: input.deciderId,
    action:
      input.decision === 'approve' ? 'integration.action_approved' : 'integration.action_rejected',
    targetType: 'integration_action_request',
    targetId: row.id,
    metadata: { capabilityId: row.capabilityId },
  });

  if (input.decision === 'reject') {
    await notifyRequester(
      row.organizationId,
      row.requestedById,
      row.id,
      'rejected',
      row.summary,
      db,
    );
    return row;
  }

  const executor = EXECUTORS[row.capabilityId];
  let finalRow;
  try {
    if (!executor) throw new AppError('internal_error', 'No executor for this action.');
    const cap = capabilityFor(executor, row.capabilityId);
    // Re-check at execution time: permissions may have changed since the request.
    await assertCapabilityUsable(executor, cap, row.organizationId, row.connectionRef, db);
    // …and the governance policy may have been tightened since.
    await assertGovernanceAllows(
      row.organizationId,
      executor.integration,
      actionClassForLevel(cap.level),
      { viaAgent: row.source === 'AGENT' },
      db,
    );
    const payload = parsePayload(executor.schema, row.payload);
    const result = await executor.execute(
      {
        organizationId: row.organizationId,
        connectionRef: row.connectionRef,
        actorId: input.deciderId,
        db,
      },
      payload,
    );
    finalRow = await db.integrationActionRequest.update({
      where: { id: row.id },
      data: { status: 'EXECUTED', executedAt: new Date(), result: result as Prisma.InputJsonValue },
    });
    await recordAudit({
      organizationId: row.organizationId,
      actorId: input.deciderId,
      action: 'integration.action_executed',
      targetType: 'integration_action_request',
      targetId: row.id,
      metadata: { capabilityId: row.capabilityId },
    });
    await notifyRequester(
      row.organizationId,
      row.requestedById,
      row.id,
      'executed',
      row.summary,
      db,
    );
  } catch (err) {
    const message = scrubSecrets(
      err instanceof AppError && err.expose
        ? err.message
        : err instanceof Error
          ? err.message
          : 'execution failed',
    ).slice(0, 500);
    log.warn({ requestId: row.id, capabilityId: row.capabilityId }, 'approved action failed');
    finalRow = await db.integrationActionRequest.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: message },
    });
    await recordAudit({
      organizationId: row.organizationId,
      actorId: input.deciderId,
      action: 'integration.action_failed',
      targetType: 'integration_action_request',
      targetId: row.id,
      metadata: { capabilityId: row.capabilityId, error: message },
    });
    await notifyRequester(row.organizationId, row.requestedById, row.id, 'failed', row.summary, db);
  }
  return finalRow;
}

/** The requester (or an admin) withdraws a request that is still pending. */
export async function cancelActionRequest(
  input: { organizationId: string; userId: string; requestId: string; isAdmin: boolean },
  db: Db = prisma,
) {
  const res = await db.integrationActionRequest.updateMany({
    where: {
      id: input.requestId,
      organizationId: input.organizationId,
      status: 'PENDING',
      ...(input.isAdmin ? {} : { requestedById: input.userId }),
    },
    data: { status: 'CANCELLED', decidedById: input.userId, decidedAt: new Date() },
  });
  if (res.count === 0) throw AppError.conflict('Only a pending request you made can be cancelled.');
}

/** Sweep: pending requests past their TTL become EXPIRED (never executed). */
export async function expirePendingActions(now: Date = new Date(), db: Db = prisma) {
  const res = await db.integrationActionRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return res.count;
}

async function notifyRequester(
  organizationId: string,
  userId: string | null,
  requestId: string,
  outcome: 'executed' | 'failed' | 'rejected',
  summary: string,
  db: Db,
) {
  if (!userId) return;
  await createNotification(
    {
      organizationId,
      userId,
      kind: `integration.action_${outcome}`,
      level: outcome === 'executed' ? 'INFO' : 'WARNING',
      title:
        outcome === 'executed'
          ? 'Approved action completed'
          : outcome === 'failed'
            ? 'Approved action failed'
            : 'Action request rejected',
      body: summary,
      linkPath: '/app/integrations/approvals',
      dedupeKey: `approval-${outcome}:${requestId}`,
      sourceType: 'integration_action_request',
      sourceId: requestId,
      email: false,
    },
    db,
  );
}
