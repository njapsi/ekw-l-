import type { Metadata } from 'next';
import Link from 'next/link';
import { searchConsole } from '@growth-agent/services';
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
import { SearchConsoleActions } from '@/components/app/seo/search-console-integration-actions';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { searchConsoleConfigured } from '@/lib/search-console';

export const metadata: Metadata = { title: 'Search Console integration' };
export const dynamic = 'force-dynamic';

const ERROR_COPY: Record<string, string> = {
  not_configured: 'Search Console OAuth isn’t configured on this deployment.',
  access_denied: 'You declined the permission request. Nothing was connected.',
  bad_state: 'The sign-in link expired or was tampered with. Please try connecting again.',
  missing_params: 'Google’s response was missing required parameters. Please try again.',
  connect_failed: 'We could not complete the connection. Please try again.',
  oauth_error: 'Google returned an error during authorization.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  account_limit: 'Your plan’s connected-account limit has been reached.',
};

export default async function SearchConsoleIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; properties?: string; error?: string }>;
}) {
  const { org, user } = await requireActiveOrg();
  const sp = await searchParams;
  const canManage = ['OWNER', 'ADMIN'].includes(org.role);
  const configured = searchConsoleConfigured();

  const [connection, properties] = await Promise.all([
    configured ? searchConsole.getConnectionSummary(org.id) : Promise.resolve(null),
    configured ? searchConsole.listProperties(org.id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Google Search Console"
        description="Connect a Google account with Search Console access (read-only). Tokens are encrypted at rest and never sent to your browser. Shares the Google OAuth client with YouTube."
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
            Found {sp.properties ?? '0'} propert{sp.properties === '1' ? 'y' : 'ies'}. Pick one on
            the{' '}
            <Link className="underline" href="/app/seo/search-console">
              Search Console dashboard
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      {!configured ? (
        <Alert>
          <AlertTitle>Not configured</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_ID</code>,{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code> and{' '}
            <code className="font-mono text-xs">ENCRYPTION_KEY</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Connection</CardTitle>
            <Badge
              variant={
                connection?.status === 'ACTIVE'
                  ? 'secondary'
                  : connection?.status === 'REVOKED' || !connection
                    ? 'outline'
                    : 'destructive'
              }
            >
              {connection?.status.toLowerCase() ?? 'not connected'}
            </Badge>
          </div>
          <CardDescription>
            Scopes: <code className="font-mono text-xs">webmasters.readonly</code> +{' '}
            <code className="font-mono text-xs">openid</code> +{' '}
            <code className="font-mono text-xs">userinfo.email</code> (read-only).
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
                <Row k="Properties">{properties.length}</Row>
              </dl>
              {connection.lastError ? (
                <p className="text-destructive text-sm">{connection.lastError}</p>
              ) : null}
              {canManage ? (
                <SearchConsoleActions />
              ) : (
                <p className="text-muted-foreground text-xs">
                  Only owners and admins can manage this connection.
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild disabled={!configured || !canManage}>
                <a href="/api/integrations/search-console/connect">Connect Search Console</a>
              </Button>
              {!canManage ? (
                <p className="text-muted-foreground text-xs">
                  Ask an owner or admin to connect Search Console.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {properties.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Properties</CardTitle>
            <CardDescription>
              Verification status comes from Google. Choose the active property on the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {properties.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="truncate font-mono text-xs">{p.siteUrl}</span>
                  <span className="flex items-center gap-2">
                    {p.isSelected ? <Badge variant="secondary">active</Badge> : null}
                    <Badge variant={p.verified ? 'outline' : 'destructive'}>
                      {p.verified
                        ? p.permissionLevel.toLowerCase().replace(/_/g, ' ')
                        : 'unverified'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Signed in as {user.email}. Disconnecting revokes our access at Google and scrubs the stored
        tokens.
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
