import type { Metadata } from 'next';
import Link from 'next/link';
import { youtube } from '@growth-agent/services';
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
import { DisconnectButton, SyncButton } from '@/components/app/youtube/youtube-actions';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { youtubeConfigured } from '@/lib/youtube';

export const metadata: Metadata = { title: 'YouTube integration' };

const ERROR_COPY: Record<string, string> = {
  not_configured: 'YouTube OAuth isn’t configured on this deployment.',
  access_denied: 'You declined the permission request. Nothing was connected.',
  bad_state: 'The sign-in link expired or was tampered with. Please try connecting again.',
  missing_params: 'Google’s response was missing required parameters. Please try again.',
  connect_failed: 'We could not complete the connection. Please try again.',
  oauth_error: 'Google returned an error during authorization.',
};

export default async function YouTubeIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; channels?: string; error?: string }>;
}) {
  const { org, user } = await requireActiveOrg();
  const sp = await searchParams;
  const canManage = ['OWNER', 'ADMIN'].includes(org.role);

  const connection = await youtube.getConnectionSummary(org.id);
  const runs = await youtube.getRecentSyncRuns(org.id);
  const configured = youtubeConfigured();

  return (
    <div className="space-y-6">
      <PageHeader
        title="YouTube"
        description="Connect a YouTube channel via Google OAuth (read-only). Tokens are encrypted at rest and never sent to your browser."
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
            Linked {sp.channels ?? '1'} channel(s). Run a sync to pull channel info, videos, and
            analytics.
          </AlertDescription>
        </Alert>
      ) : null}

      {!configured ? (
        <Alert>
          <AlertTitle>Not configured</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_ID</code>,{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code> and{' '}
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
            Scopes are read-only: <code className="font-mono text-xs">youtube.readonly</code> and{' '}
            <code className="font-mono text-xs">yt-analytics.readonly</code>
            {connection?.hasRevenueScope ? ' (+ monetary analytics)' : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection && connection.status !== 'REVOKED' ? (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Row k="Account">{connection.displayName ?? '—'}</Row>
                <Row k="Token refreshed">{relDate(connection.lastRefreshedAt)}</Row>
                <Row k="Health">
                  {connection.health
                    ? `${connection.health.ok ? 'ok' : 'attention'} · ${connection.health.detail ?? ''}`
                    : 'unknown'}
                </Row>
                <Row k="Quota used today">{connection.health?.quotaUnitsUsedToday ?? 0} units</Row>
              </dl>
              {connection.lastError ? (
                <p className="text-destructive text-sm">{connection.lastError}</p>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap items-center gap-3">
                  <SyncButton>Sync now</SyncButton>
                  <SyncButton facet="analytics">Sync analytics only</SyncButton>
                  <DisconnectButton />
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
                <a href="/api/integrations/youtube/connect">Connect YouTube</a>
              </Button>
              <Button asChild variant="outline" disabled={!configured || !canManage}>
                <a href="/api/integrations/youtube/connect?revenue=1">Connect + include revenue</a>
              </Button>
              {!canManage ? (
                <p className="text-muted-foreground text-xs">
                  Ask an owner or admin to connect YouTube.
                </p>
              ) : null}
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
                    {r.itemsProcessed} items · {r.quotaUnitsSpent} quota · {relDate(r.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Signed in as {user.email}. Disconnecting revokes our access at Google and scrubs the stored
        tokens; your synced history is kept so a reconnect keeps your trends.
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
