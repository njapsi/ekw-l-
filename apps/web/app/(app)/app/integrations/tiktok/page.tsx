import type { Metadata } from 'next';
import Link from 'next/link';
import { tiktok } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@growth-agent/ui';
import { DisconnectTikTokButton, TikTokSyncButton } from '@/components/app/tiktok/tiktok-actions';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { tiktokConfigured } from '@/lib/tiktok';

export const metadata: Metadata = { title: 'TikTok integration' };

const ERROR_COPY: Record<string, string> = {
  not_configured: 'TikTok OAuth isn’t configured on this deployment.',
  access_denied: 'You declined the permission request. Nothing was connected.',
  bad_state: 'The sign-in link expired or was tampered with. Please try connecting again.',
  missing_params:
    'TikTok’s response was missing required parameters (or the PKCE cookie). Try again.',
  connect_failed: 'We could not complete the connection. Please try again.',
  oauth_error: 'TikTok returned an error during authorization.',
};

export default async function TikTokIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; account?: string; error?: string }>;
}) {
  const { org, user } = await requireActiveOrg();
  const sp = await searchParams;
  const canManage = ['OWNER', 'ADMIN'].includes(org.role);

  const connection = await tiktok.getConnectionSummary(org.id);
  const runs = await tiktok.getRecentSyncRuns(org.id);
  const configured = tiktokConfigured();

  return (
    <div className="space-y-6">
      <PageHeader
        title="TikTok"
        description="Connect a TikTok account via the official Login Kit (OAuth 2.0 + PKCE). Tokens are encrypted at rest and never sent to your browser."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/app/integrations">All integrations</Link>
          </Button>
        }
      />

      {sp.error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn’t connect</AlertTitle>
          <AlertDescription>{ERROR_COPY[sp.error] ?? 'Something went wrong.'}</AlertDescription>
        </Alert>
      ) : null}
      {sp.connected ? (
        <Alert>
          <AlertTitle>Connected</AlertTitle>
          <AlertDescription>
            Linked {sp.account ?? 'your account'}. Run a sync to pull profile info and recent
            videos.
          </AlertDescription>
        </Alert>
      ) : null}

      {!configured ? (
        <Alert>
          <AlertTitle>Not configured</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono text-xs">TIKTOK_CLIENT_KEY</code>,{' '}
            <code className="font-mono text-xs">TIKTOK_CLIENT_SECRET</code> and{' '}
            <code className="font-mono text-xs">ENCRYPTION_KEY</code> to enable this integration.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Connection</CardTitle>
            {connection ? (
              <Badge
                variant={
                  connection.status === 'ACTIVE'
                    ? 'secondary'
                    : connection.status === 'REVOKED'
                      ? 'outline'
                      : 'destructive'
                }
              >
                {connection.status.toLowerCase()}
              </Badge>
            ) : (
              <Badge variant="outline">not connected</Badge>
            )}
          </div>
          <CardDescription>
            Requested scopes:{' '}
            <code className="font-mono text-xs">user.info.basic/profile/stats</code>,{' '}
            <code className="font-mono text-xs">video.list</code>
            {connection?.canPublish ? (
              <>
                , <code className="font-mono text-xs">video.publish</code>
              </>
            ) : null}
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection && connection.status !== 'REVOKED' ? (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Row k="Account">{connection.displayName ?? '—'}</Row>
                <Row k="Token refreshed">{relDate(connection.lastRefreshedAt)}</Row>
                <Row k="Stats scope">{connection.hasStats ? 'granted' : 'not granted'}</Row>
                <Row k="Publish scope">{connection.canPublish ? 'granted' : 'not granted'}</Row>
              </dl>
              {connection.lastError ? (
                <p className="text-destructive text-sm">{connection.lastError}</p>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap items-center gap-3">
                  <TikTokSyncButton>Sync now</TikTokSyncButton>
                  <DisconnectTikTokButton />
                  {!connection.canPublish ? (
                    <Button asChild size="sm" variant="outline">
                      <a href="/api/integrations/tiktok/connect?publish=1">
                        Reconnect + allow publishing
                      </a>
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Only owners and admins can manage this connection.
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild disabled={!configured || !canManage}>
                <a href="/api/integrations/tiktok/connect">Connect TikTok</a>
              </Button>
              <Button asChild variant="outline" disabled={!configured || !canManage}>
                <a href="/api/integrations/tiktok/connect?publish=1">Connect + allow publishing</a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent syncs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No syncs have run yet.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 py-2">
                  <span>
                    <span className="font-mono text-xs">{r.kind.toLowerCase()}</span>{' '}
                    {r.status.toLowerCase()}
                    {r.error ? <span className="text-destructive"> — {r.error}</span> : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {r.itemsProcessed} items · {relDate(r.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Signed in as {user.email}. The TikTok public API exposes limited analytics; anything it does
        not return is shown as unavailable and never estimated. See{' '}
        <span className="font-mono text-xs">docs/TIKTOK-INTEGRATION.md</span>.
      </p>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="border-border/50 flex justify-between gap-4 border-b py-1">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
