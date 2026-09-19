import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { security } from '@growth-agent/services';
import { listUserSessions } from '@growth-agent/services/auth';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import { SessionsCard } from '@/components/app/settings/security-panel';
import { requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Security · Settings' };

const EVENT_LABEL: Record<string, string> = {
  AUTH_LOGIN: 'Signed in',
  AUTH_LOGIN_FAILED: 'Failed sign-in attempt',
  REPEATED_LOGIN_FAILURE: 'Repeated failed sign-ins',
  AUTH_LOGOUT: 'Signed out',
  SESSION_REVOKED: 'A session was signed out',
  SESSIONS_REVOKED: 'All other sessions were signed out',
  PASSWORD_CHANGED: 'Password changed',
  PASSWORD_RESET_REQUESTED: 'Password reset requested',
  ACCOUNT_DEACTIVATED: 'Account deactivated',
  ACCOUNT_REACTIVATED: 'Account reactivated',
  ACCOUNT_DELETION_REQUESTED: 'Account deletion requested',
  ROLE_ESCALATION: 'Your role was raised',
  OWNER_TRANSFER: 'Ownership transferred to you',
  MEMBER_REMOVED: 'Removed from an organization',
  API_KEY_CREATED: 'API key created',
  API_KEY_REVOKED: 'API key revoked',
  ORG_DELETION_REQUESTED: 'Organization deletion requested',
};

const LOGIN_TYPES = [
  'AUTH_LOGIN',
  'AUTH_LOGIN_FAILED',
  'REPEATED_LOGIN_FAILURE',
  'AUTH_LOGOUT',
] as const;

function when(d: Date) {
  return (
    d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
  );
}

export default async function SecuritySettingsPage() {
  const user = await requireUser();
  const [sessions, loginHistory, events, account] = await Promise.all([
    listUserSessions(user.id, user.sessionId),
    security.listSecurityEvents(user.id, { types: [...LOGIN_TYPES], limit: 20 }),
    security.listSecurityEvents(user.id, { limit: 60 }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true, emailVerified: true, accounts: { select: { provider: true } } },
    }),
  ]);
  const otherEvents = events
    .filter((e) => !(LOGIN_TYPES as readonly string[]).includes(e.type))
    .slice(0, 20);
  const providers = new Set(account?.accounts.map((a) => a.provider) ?? []);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sign-in methods</CardTitle>
          <CardDescription>The ways you can sign in to this account.</CardDescription>
        </CardHeader>
        <CardContent className="divide-border divide-y text-sm">
          <div className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium">Password</p>
              <p className="text-muted-foreground text-xs">
                {account?.passwordHash
                  ? 'Set. Changing it signs out every other session.'
                  : 'Not set. You sign in with email links or Google.'}
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/app/set-password">
                {account?.passwordHash ? 'Change password' : 'Set a password'}
              </Link>
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium">Email sign-in links</p>
              <p className="text-muted-foreground text-xs">
                Always available for {user.email}. Links work once and expire after 15 minutes.
              </p>
            </div>
            <Badge variant={account?.emailVerified ? 'success' : 'warning'}>
              {account?.emailVerified ? 'Verified' : 'Unverified'}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium">Google</p>
              <p className="text-muted-foreground text-xs">
                {providers.has('google') ? 'Linked to this account.' : 'Not linked.'}
              </p>
            </div>
            <Badge variant="outline">{providers.has('google') ? 'Linked' : 'Not linked'}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Two-factor authentication</CardTitle>
          <CardDescription>
            Not available yet. Nothing on this page turns on a second factor today, and your account
            is protected by your password or email link only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          {[
            { name: 'Passkeys (WebAuthn)', note: 'Phishing-resistant. Planned first.' },
            { name: 'Authenticator app (TOTP)', note: 'One-time codes. Not phishing-resistant.' },
            { name: 'Recovery codes', note: 'For when you lose a device.' },
          ].map((f) => (
            <div key={f.name} className="rounded-md border p-3">
              <p className="flex items-center justify-between gap-2 font-medium">
                {f.name}
                <Badge variant="outline">Coming soon</Badge>
              </p>
              <p className="text-muted-foreground mt-1 text-xs">{f.note}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <SessionsCard
        sessions={sessions.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          lastActiveAt: s.lastActiveAt.toISOString(),
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Login history</CardTitle>
          <CardDescription>
            The most recent sign-ins and failed attempts on your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loginHistory.length === 0 ? (
            <p className="text-muted-foreground text-sm">No sign-ins recorded yet.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {loginHistory.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex items-center gap-2">
                    {EVENT_LABEL[e.type] ?? e.type}
                    {e.severity !== 'INFO' ? (
                      <Badge variant={e.severity === 'CRITICAL' ? 'destructive' : 'warning'}>
                        {e.severity === 'CRITICAL' ? 'Review' : 'New device or network'}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {security.describeUserAgent(e.userAgent)} · {e.ipPrefix ?? 'network unknown'} ·{' '}
                    {when(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Security events</CardTitle>
          <CardDescription>
            Changes to your account&apos;s security and your access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {otherEvents.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {otherEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="text-muted-foreground text-xs">{when(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
