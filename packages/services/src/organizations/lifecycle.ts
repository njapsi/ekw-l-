/**
 * Account & organization lifecycle (Phase 19 — FORENSIC-AUDIT M-2 / D-8).
 *
 * Model: a deletion request sets `deletionScheduledAt = now + grace` and (for a
 * user) bumps `sessionVersion` to sign every session out. Nothing is destroyed
 * yet — the owner/user can cancel during the grace window. An hourly worker
 * sweep (`runLifecycleSweepJob`) hard-deletes organizations (cascading every
 * tenant row via the FKs — incl. the now-`CASCADE` `crawl_pages`/`crawl_links`)
 * and anonymises users whose grace has elapsed.
 *
 * `authorize('org:delete')` gates the org path (OWNER-only). The user path is
 * self-service. The purge functions are only reachable from the sweep.
 */
import { type Db, prisma, requireMembership } from '@growth-agent/db';
import { createHash } from 'node:crypto';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { runInTransaction } from '../db-tx.js';
import { AppError } from '../errors.js';
import { createNotification } from '../notifications/index.js';
import { authorize } from '../rbac/authorize.js';
import { billingContextFromEnv } from '../billing/service.js';
import { cancelSubscription } from '../billing/plan-change.js';
import { disconnectConnection } from '../integrations/index.js';
import { recordSecurityEvent } from '../security/events.js';
import { disconnectWordPressSite } from '../wordpress/connect.js';

const log = createLogger('lifecycle');

export const GRACE_DAYS = clampInt(process.env.ACCOUNT_DELETION_GRACE_DAYS, 7, 1, 90);
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

function clampInt(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// --- Organization deletion ------------------------------------------------

export interface OrgDeletionState {
  organizationId: string;
  scheduledAt: string | null;
  purgeAt: string | null;
  requestedById: string | null;
}

async function scheduleOrgDeletion(
  organizationId: string,
  requestedById: string,
  db: Db,
): Promise<OrgDeletionState> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw AppError.notFound('Organization');
  if (org.deletionScheduledAt) {
    return {
      organizationId,
      scheduledAt: org.deletionScheduledAt.toISOString(),
      purgeAt: org.deletionScheduledAt.toISOString(),
      requestedById: org.deletionRequestedById,
    };
  }
  const purgeAt = new Date(Date.now() + GRACE_MS);
  await db.organization.update({
    where: { id: organizationId },
    data: { deletionScheduledAt: purgeAt, deletionRequestedById: requestedById },
  });
  // Phase 2 (Part 29): nothing keeps acting for an org that is being deleted.
  // Automations and scheduled syncs already skip deletion-scheduled orgs; here
  // pending approvals are withdrawn and a paid plan is set to lapse.
  const approvalsCancelled = await db.integrationActionRequest.updateMany({
    where: { organizationId, status: 'PENDING' },
    data: { status: 'CANCELLED', error: 'Organization scheduled for deletion.' },
  });
  const subscription = await cancelPaidPlanForDeletion(organizationId, requestedById, db);
  await recordSecurityEvent(
    {
      userId: requestedById,
      organizationId,
      type: 'ORG_DELETION_REQUESTED',
      severity: 'CRITICAL',
      metadata: { purgeAt: purgeAt.toISOString() },
    },
    db,
  );
  await recordAudit(
    {
      organizationId,
      actorId: requestedById,
      action: 'organization.deletion_requested',
      targetType: 'organization',
      targetId: organizationId,
      metadata: {
        purgeAt: purgeAt.toISOString(),
        graceDays: GRACE_DAYS,
        approvalsCancelled: approvalsCancelled.count,
        subscription,
      },
    },
    db,
  );
  await createNotification(
    {
      organizationId,
      userId: null,
      kind: 'organization.deletion_requested',
      level: 'CRITICAL',
      title: 'This organization is scheduled for deletion',
      body: `All data for this organization will be permanently deleted on ${purgeAt.toUTCString()}. An owner can still cancel from Settings.`,
      linkPath: '/app/settings',
      dedupeKey: `org:${organizationId}:deletion:${purgeAt.getTime()}`,
    },
    db,
  );
  log.warn({ organizationId, purgeAt }, 'organization deletion scheduled');
  return {
    organizationId,
    scheduledAt: purgeAt.toISOString(),
    purgeAt: purgeAt.toISOString(),
    requestedById,
  };
}

export async function requestOrganizationDeletion(
  input: { actorUserId: string; organizationId: string; allowLastOrg?: boolean },
  db: Db = prisma,
): Promise<OrgDeletionState> {
  const membership = await requireMembership(input.actorUserId, input.organizationId, db);
  authorize(
    { userId: input.actorUserId, role: membership.role, membershipStatus: membership.status },
    'org:delete',
  );

  if (!input.allowLastOrg) {
    const count = await db.membership.count({
      where: {
        userId: input.actorUserId,
        status: 'ACTIVE',
        organization: { deletedAt: null, deletionScheduledAt: null },
      },
    });
    if (count <= 1) {
      throw AppError.conflict(
        'This is your only organization. Create another one first, or delete your account instead.',
      );
    }
  }

  return scheduleOrgDeletion(input.organizationId, input.actorUserId, db);
}

export async function cancelOrganizationDeletion(
  input: { actorUserId: string; organizationId: string },
  db: Db = prisma,
): Promise<void> {
  const membership = await requireMembership(input.actorUserId, input.organizationId, db);
  authorize(
    { userId: input.actorUserId, role: membership.role, membershipStatus: membership.status },
    'org:delete',
  );
  const org = await db.organization.findUnique({ where: { id: input.organizationId } });
  if (!org || !org.deletionScheduledAt) return;
  await db.organization.update({
    where: { id: input.organizationId },
    data: { deletionScheduledAt: null, deletionRequestedById: null },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      action: 'organization.deletion_cancelled',
      targetType: 'organization',
      targetId: input.organizationId,
    },
    db,
  );
}

/** Hard-delete an organization and every row that cascades from it. */
export async function purgeOrganization(organizationId: string, db: Db = prisma): Promise<boolean> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org?.deletionScheduledAt || org.deletionScheduledAt.getTime() > Date.now()) return false;

  await recordAudit(
    {
      organizationId,
      actorType: 'SYSTEM',
      action: 'organization.purge_started',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { name: org.name, requestedById: org.deletionRequestedById },
    },
    db,
  );
  // Revoke our access at the providers before the rows (and the ciphertexts
  // needed to revoke) disappear. Best-effort: a provider outage must not keep
  // an organization's data alive past its grace period.
  const upstream = await revokeUpstreamCredentials(organizationId, org.deletionRequestedById, db);
  // Cascades via the 63 `onDelete: Cascade` FKs (incl. crawl_pages / crawl_links
  // redefined in migration 20260917120000). `SetNull` FKs (audit_logs actor/org,
  // recommendations.previousReportId) are left as tombstones by design.
  await db.organization.delete({ where: { id: organizationId } });
  await recordAudit(
    {
      organizationId: null,
      actorType: 'SYSTEM',
      action: 'organization.purged',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { name: org.name, upstreamRevocation: upstream },
    },
    db,
  );
  log.warn({ organizationId }, 'organization purged');
  return true;
}

// --- User-account deletion ----------------------------------------------

export interface AccountDeletionState {
  userId: string;
  scheduledAt: string | null;
  purgeAt: string | null;
  cascadedOrganizationIds: string[];
}

export async function requestAccountDeletion(
  userId: string,
  db: Db = prisma,
): Promise<AccountDeletionState> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw AppError.notFound('User');
  if (user.deletionScheduledAt) {
    return {
      userId,
      scheduledAt: user.deletionScheduledAt.toISOString(),
      purgeAt: user.deletionScheduledAt.toISOString(),
      cascadedOrganizationIds: [],
    };
  }

  // Organizations where this user is the ONLY active owner must go with them.
  const ownerMemberships = await db.membership.findMany({
    where: { userId, role: 'OWNER', status: 'ACTIVE', organization: { deletedAt: null } },
    select: { organizationId: true },
  });
  const cascaded: string[] = [];
  for (const m of ownerMemberships) {
    const otherOwners = await db.membership.count({
      where: {
        organizationId: m.organizationId,
        role: 'OWNER',
        status: 'ACTIVE',
        userId: { not: userId },
      },
    });
    if (otherOwners === 0) {
      await scheduleOrgDeletion(m.organizationId, userId, db);
      cascaded.push(m.organizationId);
    }
  }

  const purgeAt = new Date(Date.now() + GRACE_MS);
  await db.user.update({
    where: { id: userId },
    // Sign every session out now (requireUser compares sessionVersion). Do NOT
    // set deletedAt yet — the user can sign back in during grace to cancel.
    data: { deletionScheduledAt: purgeAt, sessionVersion: { increment: 1 } },
  });
  await db.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'account_deletion_requested' },
  });
  await recordSecurityEvent(
    {
      userId,
      type: 'ACCOUNT_DELETION_REQUESTED',
      severity: 'CRITICAL',
      metadata: { purgeAt: purgeAt.toISOString(), cascadedOrganizationIds: cascaded },
    },
    db,
  );
  await recordAudit(
    {
      actorId: userId,
      action: 'account.deletion_requested',
      targetType: 'user',
      targetId: userId,
      metadata: { purgeAt: purgeAt.toISOString(), cascadedOrganizationIds: cascaded },
    },
    db,
  );
  log.warn({ userId, purgeAt, cascaded }, 'account deletion scheduled');
  return {
    userId,
    scheduledAt: purgeAt.toISOString(),
    purgeAt: purgeAt.toISOString(),
    cascadedOrganizationIds: cascaded,
  };
}

export async function cancelAccountDeletion(userId: string, db: Db = prisma): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.deletionScheduledAt) return;
  await db.user.update({ where: { id: userId }, data: { deletionScheduledAt: null } });
  await recordAudit(
    { actorId: userId, action: 'account.deletion_cancelled', targetType: 'user', targetId: userId },
    db,
  );
}

/** Anonymise a user whose grace elapsed. Keeps the row as a tombstone. */
export async function purgeUser(userId: string, db: Db = prisma): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.deletionScheduledAt || user.deletionScheduledAt.getTime() > Date.now()) return false;

  const tombstone = `deleted+${createHash('sha256').update(userId).digest('hex').slice(0, 24)}@deleted.invalid`;
  await runInTransaction(db, async (tx) => {
    // tenant-scope-ok: purging a deleted user removes their membership from
    // every organization they belong to, by design — there is no single
    // organizationId to scope this to.
    await tx.membership.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        email: tombstone,
        name: null,
        image: null,
        deletedAt: new Date(),
        deletionScheduledAt: null,
        sessionVersion: { increment: 1 },
      },
    });
  });
  await recordAudit(
    { actorType: 'SYSTEM', action: 'account.purged', targetType: 'user', targetId: userId },
    db,
  );
  log.warn({ userId }, 'user account anonymised');
  return true;
}

// --- Worker sweep ------------------------------------------------------

/** Purge organizations and users whose grace window has elapsed. Hourly. */
export async function runLifecycleSweepJob(
  db: Db = prisma,
): Promise<{ orgsPurged: number; usersPurged: number }> {
  const now = new Date();
  const dueOrgs = await db.organization.findMany({
    where: { deletionScheduledAt: { lte: now } },
    select: { id: true },
    take: 50,
  });
  let orgsPurged = 0;
  for (const o of dueOrgs) {
    try {
      if (await purgeOrganization(o.id, db)) orgsPurged++;
    } catch (err) {
      log.error({ err: String(err), organizationId: o.id }, 'org purge failed');
    }
  }

  const dueUsers = await db.user.findMany({
    where: { deletionScheduledAt: { lte: now }, deletedAt: null },
    select: { id: true },
    take: 50,
  });
  let usersPurged = 0;
  for (const u of dueUsers) {
    try {
      if (await purgeUser(u.id, db)) usersPurged++;
    } catch (err) {
      log.error({ err: String(err), userId: u.id }, 'user purge failed');
    }
  }

  if (orgsPurged || usersPurged) log.warn({ orgsPurged, usersPurged }, 'lifecycle sweep purged');
  return { orgsPurged, usersPurged };
}

/**
 * If the org has a live paid subscription, set it to cancel at period end so
 * the customer is not charged for an organization that will no longer
 * exist. Returns what happened, for the audit trail.
 */
async function cancelPaidPlanForDeletion(
  organizationId: string,
  actorUserId: string,
  db: Db,
): Promise<
  'none' | 'cancel_at_period_end' | 'already_cancelling' | 'billing_unconfigured' | 'failed'
> {
  const sub = await db.subscription.findUnique({
    where: { organizationId },
    select: { stripeSubscriptionId: true, cancelAtPeriodEnd: true, status: true },
  });
  if (!sub?.stripeSubscriptionId || sub.status === 'CANCELED') return 'none';
  if (sub.cancelAtPeriodEnd) return 'already_cancelling';
  const ctx = billingContextFromEnv();
  if (!ctx.gateway.configured) return 'billing_unconfigured';
  try {
    await cancelSubscription(
      { organizationId, userId: actorUserId },
      { gateway: ctx.gateway, config: ctx.config, db },
    );
    return 'cancel_at_period_end';
  } catch (err) {
    log.error(
      { organizationId, err: err instanceof Error ? err.message : String(err) },
      'could not cancel subscription for an organization scheduled for deletion',
    );
    await createNotification(
      {
        organizationId,
        userId: actorUserId,
        kind: 'billing.cancel_failed',
        level: 'CRITICAL',
        title: 'Cancel your subscription manually',
        body: 'This organization is scheduled for deletion, but its paid plan could not be cancelled automatically. Cancel it from Billing to avoid further charges.',
        linkPath: '/app/billing',
        dedupeKey: `org:${organizationId}:deletion-cancel-failed`,
      },
      db,
    );
    return 'failed';
  }
}

async function revokeUpstreamCredentials(
  organizationId: string,
  actorUserId: string | null,
  db: Db,
): Promise<{ oauth: number; wordpress: number; failures: number }> {
  let oauth = 0;
  let wordpress = 0;
  let failures = 0;
  const conns = await db.oAuthConnection.findMany({
    where: { organizationId, status: { not: 'REVOKED' } },
    select: { id: true },
  });
  for (const c of conns) {
    try {
      await disconnectConnection(organizationId, c.id, actorUserId ?? 'system', db);
      oauth += 1;
    } catch (err) {
      failures += 1;
      log.warn(
        { connectionId: c.id, err: err instanceof Error ? err.message : String(err) },
        'upstream revoke failed',
      );
    }
  }
  const sites = await db.wordPressSite.findMany({
    where: { organizationId, status: { not: 'REVOKED' } },
    select: { id: true },
  });
  for (const site of sites) {
    try {
      await disconnectWordPressSite(organizationId, site.id, actorUserId ?? 'system', db);
      wordpress += 1;
    } catch (err) {
      failures += 1;
      log.warn(
        { siteId: site.id, err: err instanceof Error ? err.message : String(err) },
        'wordpress revoke failed',
      );
    }
  }
  return { oauth, wordpress, failures };
}
