import type { Metadata } from 'next';
import { users } from '@growth-agent/services';
import { ProfileForm } from '@/components/app/settings/profile-form';
import { requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Profile · Settings' };

export default async function SettingsProfilePage() {
  const user = await requireUser();
  const profile = await users.getProfile(user.id);
  return (
    <ProfileForm
      profile={{
        name: profile?.name ?? null,
        email: profile?.email ?? user.email,
        emailVerified: Boolean(profile?.emailVerified),
        timezone: profile?.timezone ?? 'UTC',
        locale: profile?.locale ?? 'en',
      }}
    />
  );
}
