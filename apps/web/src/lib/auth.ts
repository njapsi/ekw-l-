import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, isRecentAuth, validateSession } from '@growth-agent/services/auth';
import { AppError, authorize, type Authorizable } from '@growth-agent/services';
import { getOrganizationForUser, listOrganizationsForUser, prisma } from '@growth-agent/db';
import type { Role } from '@growth-agent/db';
import type { AppSessionUser } from '@growth-agent/services/auth';

export const ACTIVE_ORG_COOKIE = 'ga_active_org';

export type SessionUser = AppSessionUser;

/** The raw session, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  return session?.user ?? null;
}

/**
 * Require an authenticated, non-revoked user. Redirects to /login otherwise.
 * The session-revocation check (compare JWT `sessionVersion` to the DB) runs
 * here — the authoritative check that middleware cannot do on the edge.
 *
 * Wrapped in React's per-request `cache()` (already used for
 * `getCorrelationId`, `lib/observability.ts`): every `/app/*` navigation
 * calls this once per layout and once per page, which otherwise doubled the
 * session-revocation query on every request.
 */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await getSessionUser();
  if (!user?.id) redirect('/login');

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sessionVersion: true, deletedAt: true, deactivatedAt: true },
  });
  if (!row || row.deletedAt || row.deactivatedAt || row.sessionVersion !== user.sessionVersion) {
    redirect('/login?reason=session_expired');
  }
  // Per-session revocation (Phase 2): a token whose `UserSession` row was
  // revoked ("sign out this device" / "sign out all other sessions") or has
  // passed its absolute lifetime is rejected here, server-side. Tokens issued
  // before session tracking carry no id; they are still bounded by
  // `sessionVersion`, which "sign out all other sessions" bumps.
  if (user.sessionId) {
    const check = await validateSession(user.id, user.sessionId);
    if (!check.ok) redirect(`/login?reason=session_${check.reason}`);
  }
  return user;
});

export interface ActiveOrgContext {
  user: SessionUser;
  org: { id: string; slug: string; name: string; role: Role };
}

/**
 * Resolve the active organization for the current request: the one named by the
 * `ga_active_org` cookie if the user still belongs to it, else their first.
 * Redirects to onboarding when the user has no organization at all.
 *
 * Also `cache()`d per-request, same reasoning as `requireUser` above.
 */
export const requireActiveOrg = cache(async (): Promise<ActiveOrgContext> => {
  const user = await requireUser();
  const cookieStore = await cookies();
  const preferredId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  if (preferredId) {
    const org = await getOrganizationForUser(user.id, preferredId);
    if (org) return { user, org };
  }
  const orgs = await listOrganizationsForUser(user.id);
  const first = orgs[0];
  if (!first) redirect('/onboarding');
  return { user, org: first };
});

/**
 * Assert the current user may perform `action` (a capability permission such
 * as `content.publish`, or a legacy action alias) in the active org. The role
 * comes from the membership row loaded by `requireActiveOrg`, never from the
 * JWT or the request.
 */
export async function requirePermission(action: Authorizable): Promise<ActiveOrgContext> {
  const ctx = await requireActiveOrg();
  authorize({ userId: ctx.user.id, role: ctx.org.role, membershipStatus: 'ACTIVE' }, action);
  return ctx;
}

/** Require platform-staff. Used by /admin. */
export async function requirePlatformStaff(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isPlatformStaff) redirect('/app');
  return user;
}

export function assert(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}

/**
 * Sensitive changes (password change, account / organization deletion,
 * sign-out-everywhere) require a sign-in within the last 15 minutes
 * (OWASP ASVS V3 re-authentication; NIST 800-63B-4 §2.2.3).
 */
export async function hasRecentAuth(): Promise<boolean> {
  const user = await requireUser();
  return isRecentAuth(user.authAt);
}
