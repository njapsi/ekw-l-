import { type ActorType, type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';

const log = createLogger('audit');

export interface AuditInput {
  organizationId?: string | null;
  actorId?: string | null;
  actorType?: ActorType;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  /** SUCCESS (default) | FAILURE | DENIED. */
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  /** Correlation id of the originating request / job. */
  requestId?: string;
  agentRunId?: string;
}

/**
 * Append a security-relevant event to the audit log (docs/SECURITY.md §12).
 * Never throws into the caller: an audit-write failure is logged, not
 * propagated, so it cannot break the user-facing operation — but it is also
 * never silently dropped.
 */
export async function recordAudit(input: AuditInput, db: Db = prisma): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId ?? null,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'USER',
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: input.metadata as never,
        result: input.result ?? 'SUCCESS',
        requestId: input.requestId,
        agentRunId: input.agentRunId,
      },
    });
  } catch (err) {
    log.error({ err, action: input.action }, 'failed to write audit log entry');
  }
}

export {
  AUDIT_CATEGORIES,
  auditCategory,
  auditEventType,
  auditLabel,
  type AuditCategory,
} from './catalog.js';
export {
  AUDIT_EXPORT_MAX_ROWS,
  auditFilterInput,
  exportAuditCsv,
  listAuditActors,
  listAuditEvents,
  type AuditEventView,
  type AuditFilter,
} from './query.js';
