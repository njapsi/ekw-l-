'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isAppError, organizations } from '@growth-agent/services';
import { ACTIVE_ORG_COOKIE, requireUser } from '@/lib/auth';

export async function createOrgAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? 'TEAM');

  let orgId: string;
  try {
    const org = await organizations.createOrganization(user.id, {
      name,
      type: type as 'PERSONAL' | 'TEAM' | 'AGENCY' | 'BUSINESS',
    });
    orgId = org.id;
  } catch (e) {
    if (isAppError(e) && e.expose) return { error: e.message };
    if (e instanceof Error && e.name === 'ZodError')
      return { error: 'Enter a name (2–80 characters).' };
    return { error: 'Could not create the organization. Please try again.' };
  }

  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect('/app/dashboard');
}
