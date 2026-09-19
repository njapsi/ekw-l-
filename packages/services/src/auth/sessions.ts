/**
 * Server-side session registry (Phase 2, Parts 13 + 15). ADR-0052.
 *
 * Sessions stay JWTs (ADR-0011: edge middleware verifies without a DB), but
 * every JWT now carries the id of a `UserSession` row (`sid`). The
 * authoritative server check (`requireUser`) rejects a token whose row is
 * revoked, missing, or past its absolute lifetime — so "sign out this
 * device" and "sign out all other sessions" are real, server-enforced
 * revocations, not a client-side cookie delete.
 *
 * The row holds no token material. Its id is not a credential: a JWT is
 * signed and encrypted with AUTH_SECRET, so knowing a session id grants
 * nothing. The UI still shows only a hashed `handle`.
 */
import { createHash } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { describeUserAgent, recordSecurityEvent, toIpPrefix } from '../security/events.js';

const log = createLogger('sessions');

/** Absolute session lifetime, independent of the rolling 8 h JWT expiry. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastActiveAt` is written at most this often per session. */
export const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
/** "Recent authentication" window for sensitive changes (Part 29). */
export const RECENT_AUTH_MS = 15 * 60 * 1000;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const FAILED_LOGIN_ALERT_AT = 5;

export type AuthMethod = 'password' | 'magic-link' | 'google' | 'dev' | 'unknown';

export function authMethodFor(provider: string | undefined): AuthMethod {
  switch (provider) {
    case 'password':
      return 'password';
    case 'nodemailer':
    case 'email':
    case 'resend':
      return 'magic-link';
    case 'google':
      return 'google';
    case 'dev-credentials':
      return 'dev';
    default:
      return 'unknown';
  }
}

export function sessionHandle(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export interface SessionContext {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Called once per successful sign-in. Records the session, the login, and —
 * as a hook for suspicious-session detection — whether this network prefix
 * or device has been seen for this user before. A deactivated account is
 * reactivated by signing in (Part 2).
 */
export async function createUserSession(
  input: { userId: string; authMethod: AuthMethod } & SessionContext,
  db: Db = prisma,
): Promise<{ sessionId: string }> {
  const now = new Date();
  const ipPrefix = toIpPrefix(input.ip);
  const device = describeUserAgent(input.userAgent);
  const priorSessions = await db.userSession.findMany({
    where: { userId: input.userId },
    select: { ipPrefix: true, userAgent: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const newNetwork =
    priorSessions.length > 0 &&
    ipPrefix !== null &&
    !priorSessions.some((s) => s.ipPrefix === ipPrefix);
  const newDevice =
    priorSessions.length > 0 &&
    !priorSessions.some((s) => describeUserAgent(s.userAgent) === device);

  const row = await db.userSession.create({
    data: {
      userId: input.userId,
      authMethod: input.authMethod,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      ipPrefix,
      lastActiveAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    },
    select: { id: true },
  });

  const user = await db.user.update({
    where: { id: input.userId },
    data: { lastLoginAt: now, lastActiveAt: now },
    select: { deactivatedAt: true },
  });
  if (user.deactivatedAt) {
    await db.user.update({ where: { id: input.userId }, data: { deactivatedAt: null } });
    await recordSecurityEvent(
      {
        userId: input.userId,
        type: 'ACCOUNT_REACTIVATED',
        ip: input.ip,
        userAgent: input.userAgent,
      },
      db,
    );
  }

  await recordSecurityEvent(
    {
      userId: input.userId,
      type: 'AUTH_LOGIN',
      severity: newNetwork || newDevice ? 'WARNING' : 'INFO',
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { method: input.authMethod, device, newNetwork, newDevice },
    },
    db,
  );
  return { sessionId: row.id };
}

export type SessionCheck =
  { ok: true } | { ok: false; reason: 'missing' | 'revoked' | 'expired' | 'wrong_user' };

/**
 * The authoritative per-request check. Touches `lastActiveAt` (throttled) on
 * the session and the user as a side effect.
 */
export async function validateSession(
  userId: string,
  sessionId: string,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<SessionCheck> {
  const row = await db.userSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, expiresAt: true, lastActiveAt: true },
  });
  if (!row) return { ok: false, reason: 'missing' };
  if (row.userId !== userId) return { ok: false, reason: 'wrong_user' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };

  if (now.getTime() - row.lastActiveAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS) {
    try {
      await db.userSession.update({ where: { id: sessionId }, data: { lastActiveAt: now } });
      await db.user.update({ where: { id: userId }, data: { lastActiveAt: now } });
    } catch (err) {
      // Activity tracking must never block a request; the session is still valid.
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'activity touch failed');
    }
  }
  return { ok: true };
}

export async function listUserSessions(
  userId: string,
  currentSessionId: string | null,
  db: Db = prisma,
) {
  const rows = await db.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastActiveAt: 'desc' },
    take: 50,
    select: {
      id: true,
      authMethod: true,
      userAgent: true,
      ipPrefix: true,
      createdAt: true,
      lastActiveAt: true,
    },
  });
  return rows.map((r) => ({
    handle: sessionHandle(r.id),
    current: r.id === currentSessionId,
    device: describeUserAgent(r.userAgent),
    authMethod: r.authMethod,
    network: r.ipPrefix,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
  }));
}

/** Sign out one other device, identified by its public handle. */
export async function revokeSessionByHandle(
  userId: string,
  handle: string,
  currentSessionId: string | null,
  ctx: SessionContext = {},
  db: Db = prisma,
): Promise<void> {
  const rows = await db.userSession.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  });
  const target = rows.find((r) => sessionHandle(r.id) === handle);
  if (!target) throw AppError.notFound('Session');
  if (target.id === currentSessionId) {
    throw AppError.validation('Use "Sign out" to end the session you are using now.');
  }
  await db.userSession.update({
    where: { id: target.id },
    data: { revokedAt: new Date(), revokedReason: 'user_revoked' },
  });
  await recordSecurityEvent(
    { userId, type: 'SESSION_REVOKED', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { handle } },
    db,
  );
}

/**
 * Revoke every session except `keepSessionId`, and bump `sessionVersion` so
 * tokens issued before session tracking existed (which carry no `sid`) die
 * too. The caller refreshes the current token so it carries the new version.
 */
export async function revokeOtherSessions(
  userId: string,
  keepSessionId: string | null,
  reason: string,
  ctx: SessionContext = {},
  db: Db = prisma,
): Promise<number> {
  const res = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await db.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  await recordSecurityEvent(
    {
      userId,
      type: 'SESSIONS_REVOKED',
      severity: 'WARNING',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { count: res.count, reason, keptCurrent: keepSessionId !== null },
    },
    db,
  );
  return res.count;
}

/** Mark the current session ended on sign-out. */
export async function endSession(
  userId: string,
  sessionId: string,
  db: Db = prisma,
): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'sign_out' },
  });
  await recordSecurityEvent({ userId, type: 'AUTH_LOGOUT' }, db);
}

/**
 * Record a failed password sign-in for an existing account and, past the
 * threshold within the window, raise a WARNING-level "repeated failures"
 * event (the hook for alerting / lockout policy). Throttling itself is the
 * existing per-address rate limit — NIST 800-63B prefers rate limiting to
 * hard lockout, which would let an attacker lock victims out at will.
 */
export async function recordFailedLogin(
  userId: string,
  ctx: SessionContext & { reason: string },
  db: Db = prisma,
): Promise<{ repeated: boolean }> {
  await recordSecurityEvent(
    {
      userId,
      type: 'AUTH_LOGIN_FAILED',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: ctx.reason },
    },
    db,
  );
  const since = new Date(Date.now() - FAILED_LOGIN_WINDOW_MS);
  const recent = await db.securityEvent.count({
    where: { userId, type: 'AUTH_LOGIN_FAILED', createdAt: { gte: since } },
  });
  if (recent === FAILED_LOGIN_ALERT_AT) {
    await recordSecurityEvent(
      {
        userId,
        type: 'REPEATED_LOGIN_FAILURE',
        severity: 'CRITICAL',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { failures: recent, windowMinutes: FAILED_LOGIN_WINDOW_MS / 60_000 },
      },
      db,
    );
    return { repeated: true };
  }
  return { repeated: false };
}

export function isRecentAuth(authAt: number | null | undefined, now: number = Date.now()): boolean {
  return typeof authAt === 'number' && now - authAt <= RECENT_AUTH_MS;
}
