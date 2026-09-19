import type { Metadata } from 'next';
import { PageHeader } from '@growth-agent/ui';
import { prisma } from '@growth-agent/db';
import { isRecentAuth } from '@growth-agent/services/auth';
import { requireUser } from '@/lib/auth';
import { SetPasswordForm } from '@/components/app/set-password-form';

export const metadata: Metadata = { title: 'Set password' };

export default async function SetPasswordPage() {
  const user = await requireUser();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  // The current password is required unless the user just signed in (e.g.
  // from the password-reset link): see users.changePassword.
  const requireCurrent = Boolean(row?.passwordHash) && !isRecentAuth(user.authAt);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Set your password"
        description="Add or change the password used to log in with email and password."
      />
      <SetPasswordForm requireCurrent={requireCurrent} />
    </div>
  );
}
