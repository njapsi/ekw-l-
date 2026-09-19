import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { isAppError, organizations } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import { ACTIVE_ORG_COOKIE, getSessionUser, requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Accept invitation' };

/**
 * Invitation landing page. Opening the link never changes anything (a GET
 * must be safe: mail scanners and link previews open links too). The user
 * sees who invited them, to what, and with which role, and joins only by
 * pressing Accept — a POST (Server Action) that re-verifies everything.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await getSessionUser();
  if (!user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }
  const preview = await organizations.previewInvitation(token);

  async function accept() {
    'use server';
    const me = await requireUser();
    let orgId: string;
    try {
      const membership = await organizations.acceptInvitation(me.id, me.email, token);
      orgId = membership.organizationId;
    } catch (e) {
      const msg = isAppError(e) && e.expose ? e.message : 'This invitation could not be accepted.';
      redirect(`/invite/${token}?error=${encodeURIComponent(msg)}`);
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

  return (
    <div className="container flex min-h-screen items-center justify-center py-12">
      <div className="w-full max-w-md space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {preview ? (
          <Card>
            <CardHeader>
              <CardTitle>Join {preview.organizationName}</CardTitle>
              <CardDescription>
                {preview.invitedByName ?? 'A member'} invited{' '}
                <span className="font-medium">{preview.email}</span> to join as{' '}
                <span className="font-medium">{preview.role.toLowerCase()}</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {preview.email.toLowerCase() !== user.email.toLowerCase() ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    You are signed in as {user.email}. Sign in as {preview.email} to accept this
                    invitation.
                  </AlertDescription>
                </Alert>
              ) : (
                <form action={accept}>
                  <Button type="submit" className="w-full">
                    Accept and join
                  </Button>
                </form>
              )}
              <Button asChild variant="ghost" className="w-full">
                <Link href="/app">Not now</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <Alert variant="destructive">
              <AlertDescription>
                This invitation link is invalid, expired or has already been used. Ask the person
                who invited you to send a new one.
              </AlertDescription>
            </Alert>
            <Button asChild variant="outline">
              <Link href="/app">Go to the app</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
