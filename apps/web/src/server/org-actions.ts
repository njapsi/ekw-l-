'use server';

import { cookies } from 'next/headers';
import { getOrganizationForUser } from '@growth-agent/db';
import { ACTIVE_ORG_COOKIE, requireUser } from '@/lib/auth';

/** Set the active organization cookie after verifying membership. */
export async function switchOrgAction(organizationId: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const org = await getOrganizationForUser(user.id, organizationId);
  if (!org) return { ok: false };
  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return { ok: true };
}
