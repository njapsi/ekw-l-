import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { organizations } from '@growth-agent/services';
import { Alert, AlertDescription, Button } from '@growth-agent/ui';
import { ACTIVE_ORG_COOKIE, getSessionUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getSessionUser();

  if (!user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }

  let error: string | null = null;
  let orgId: string | null = null;
  try {
    const membership = await organizations.acceptInvitation(user.id, user.email, token);
    orgId = membership.organizationId;
  } catch (e) {
    error = e instanceof Error ? e.message : 'This invitation could not be accepted.';
  }

  if (orgId) {
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

  return (
    <div className="container flex min-h-screen items-center justify-center py-12">
      <div className="w-full max-w-md space-y-4">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button asChild variant="outline">
          <Link href="/app">Go to the app</Link>
        </Button>
      </div>
    </div>
  );
}
