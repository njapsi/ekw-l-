import type { Metadata } from 'next';
import { PageHeader } from '@growth-agent/ui';
import { requireUser } from '@/lib/auth';
import { SetPasswordForm } from '@/components/app/set-password-form';

export const metadata: Metadata = { title: 'Set password' };

export default async function SetPasswordPage() {
  await requireUser();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Set your password"
        description="Add or change the password used to log in with email and password."
      />
      <SetPasswordForm />
    </div>
  );
}
