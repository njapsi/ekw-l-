import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@growth-agent/services/auth';
import { AppError, authorize, type Action } from '@growth-agent/services';
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
    select: { sessionVersion: true, deletedAt: true },
  });
  if (!row || row.deletedAt || row.sessionVersion !== user.sessionVersion) {
    redirect('/login?reason=session_expired');
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

/** Assert the current user may perform `action` in the active org. */
export async function requirePermission(action: Action): Promise<ActiveOrgContext> {
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
