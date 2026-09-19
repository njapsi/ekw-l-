/**
 * Account-level lifecycle beyond deletion (Phase 2, Parts 2, 29, 30):
 * deactivation, password change, and the personal data export.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { type SessionContext, revokeOtherSessions } from '../auth/sessions.js';
import { AppError } from '../errors.js';
import { recordSecurityEvent } from '../security/events.js';

/**
 * Pause the account: every session is revoked, automations the user owns are
 * paused (they would otherwise keep running under a person who stepped
 * away), and notifications stop because nobody can sign in. Signing in again
 * reactivates it (`createUserSession`). Owned automations stay paused until
 * re-enabled — resuming work silently is the unsafe default.
 */
export async function deactivateAccount(
  userId: string,
  ctx: SessionContext = {},
  db: Db = prisma,
): Promise<{ automationsPaused: number }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
  if (!user || user.deletedAt) throw AppError.notFound('User');

  await db.user.update({ where: { id: userId }, data: { deactivatedAt: new Date() } });
  const paused = await db.automationRule.updateMany({
    // tenant-scope-ok: scoped to the user's own automations across their orgs.
    where: { ownerId: userId, status: { in: ['ACTIVE', 'FAILING'] } },
    data: { status: 'PAUSED', lastError: 'Paused because the owner deactivated their account.' },
  });
  await revokeOtherSessions(userId, null, 'account_deactivated', ctx, db);
  await recordSecurityEvent(
    {
      userId,
      type: 'ACCOUNT_DEACTIVATED',
      severity: 'WARNING',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { automationsPaused: paused.count },
    },
    db,
  );
  await recordAudit(
    {
      actorId: userId,
      action: 'user.deactivated',
      targetType: 'user',
      targetId: userId,
      metadata: { automationsPaused: paused.count },
    },
    db,
  );
  return { automationsPaused: paused.count };
}

export function passwordPolicyError(password: string): string | null {
  // NIST SP 800-63B-4 §3.1.1.2: length over composition rules, a generous
  // maximum, no forced complexity classes.
  if (password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  return null;
}

/**
 * Change (or set) a password.
 *
 *   - An account that already has a password must supply it, unless the
 *     session authenticated in the last 15 minutes (the password-reset flow
 *     lands here straight from a fresh magic-link sign-in).
 *   - Every *other* session is revoked afterwards (OWASP: a password change
 *     must end sessions an attacker may hold).
 */
export async function changePassword(
  input: {
    userId: string;
    currentPassword?: string;
    newPassword: string;
    recentAuth: boolean;
    currentSessionId: string | null;
  },
  ctx: SessionContext = {},
  db: Db = prisma,
): Promise<{ otherSessionsRevoked: number }> {
  const policy = passwordPolicyError(input.newPassword);
  if (policy) throw AppError.validation(policy);

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { passwordHash: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw AppError.notFound('User');

  if (user.passwordHash && !input.recentAuth) {
    if (!input.currentPassword || !verifyPassword(input.currentPassword, user.passwordHash)) {
      await recordSecurityEvent(
        {
          userId: input.userId,
          type: 'AUTH_LOGIN_FAILED',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          metadata: { reason: 'password_change_wrong_current' },
        },
        db,
      );
      throw AppError.forbidden('Your current password is incorrect.');
    }
  }
  if (user.passwordHash && verifyPassword(input.newPassword, user.passwordHash)) {
    throw AppError.validation('Choose a password different from your current one.');
  }

  await db.user.update({
    where: { id: input.userId },
    data: { passwordHash: hashPassword(input.newPassword) },
  });
  const revoked = await revokeOtherSessions(
    input.userId,
    input.currentSessionId,
    'password_changed',
    ctx,
    db,
  );
  await recordSecurityEvent(
    {
      userId: input.userId,
      type: 'PASSWORD_CHANGED',
      severity: 'WARNING',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { hadPassword: Boolean(user.passwordHash), otherSessionsRevoked: revoked },
    },
    db,
  );
  await recordAudit(
    {
      actorId: input.userId,
      action: user.passwordHash ? 'auth.password_changed' : 'auth.password_set',
      targetType: 'user',
      targetId: input.userId,
    },
    db,
  );
  return { otherSessionsRevoked: revoked };
}

/**
 * Personal data export (Part 30). Only what belongs to *this person*: their
 * profile, preferences, memberships, sessions, security events, their own
 * notifications and the audit events they performed. It never includes
 * another member's data or any organization's business data — that is the
 * organization export, gated by `organization.update`.
 */
export async function exportUserData(userId: string, db: Db = prisma) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      emailVerified: true,
      createdAt: true,
      lastLoginAt: true,
      lastActiveAt: true,
      deactivatedAt: true,
      profile: { select: { timezone: true, locale: true, marketingOptIn: true } },
      preferences: { select: { key: true, value: true } },
      accounts: { select: { provider: true, type: true } },
      memberships: {
        select: {
          role: true,
          status: true,
          createdAt: true,
          organization: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });
  if (!user) throw AppError.notFound('User');
  const [sessions, securityEvents, notifications, auditEvents] = await Promise.all([
    db.userSession.findMany({
      where: { userId },
      select: {
        authMethod: true,
        userAgent: true,
        ipPrefix: true,
        createdAt: true,
        lastActiveAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    db.securityEvent.findMany({
      where: { userId },
      select: { type: true, severity: true, ipPrefix: true, userAgent: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
    db.notification.findMany({
      // tenant-scope-ok: the user's own notifications across their orgs.
      where: { userId },
      select: {
        organizationId: true,
        kind: true,
        title: true,
        body: true,
        createdAt: true,
        readAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
    db.auditLog.findMany({
      // tenant-scope-ok: only events this user performed, across their orgs.
      where: { actorId: userId },
      select: {
        organizationId: true,
        action: true,
        targetType: true,
        targetId: true,
        result: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    }),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schema: 'growth-agent.user-export.v1',
    user: {
      ...user,
      // Provider names only — OAuth tokens are never exported.
      accounts: user.accounts,
    },
    sessions,
    securityEvents,
    notifications,
    auditEvents,
  };
}
