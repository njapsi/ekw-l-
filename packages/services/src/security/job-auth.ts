/**
 * Background-job authorization (Phase 2, Part 22).
 *
 * A job payload is written by our own server code, but it is still *data*:
 * the actor's role can change, the membership can be removed, or the
 * organization can enter its deletion grace period between enqueue and
 * execution. Every user-initiated job therefore re-derives authorization from
 * the database at the moment it runs — never from a role or permission
 * carried in the payload (payloads carry only ids).
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { type Authorizable, authorize } from '../rbac/authorize.js';

export interface JobAuthContext {
  organizationId: string;
  /** The member who caused the job; null for platform/system jobs. */
  actorUserId: string | null;
  jobId?: string | number | null;
  agentRunId?: string | null;
}

export class JobAuthorizationError extends AppError {
  constructor(message: string) {
    super('permission_denied', message);
    this.name = 'JobAuthorizationError';
  }
}

export async function assertJobAuthorized(
  ctx: JobAuthContext,
  permission: Authorizable | null,
  db: Db = prisma,
): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { deletedAt: true, deletionScheduledAt: true },
  });
  if (!org || org.deletedAt || org.deletionScheduledAt) {
    throw new JobAuthorizationError('The organization no longer exists or is being deleted.');
  }
  if (!ctx.actorUserId || !permission) return;

  const [membership, user] = await Promise.all([
    db.membership.findUnique({
      where: {
        userId_organizationId: { userId: ctx.actorUserId, organizationId: ctx.organizationId },
      },
      select: { role: true, status: true },
    }),
    db.user.findUnique({
      where: { id: ctx.actorUserId },
      select: { deletedAt: true, deactivatedAt: true, deletionScheduledAt: true },
    }),
  ]);
  if (!membership || !user || user.deletedAt || user.deactivatedAt || user.deletionScheduledAt) {
    throw new JobAuthorizationError('The member who started this job is no longer active here.');
  }
  try {
    authorize(
      { userId: ctx.actorUserId, role: membership.role, membershipStatus: membership.status },
      permission,
    );
  } catch (err) {
    throw new JobAuthorizationError(
      err instanceof Error
        ? err.message
        : 'The member who started this job lost the permission to run it.',
    );
  }
}
