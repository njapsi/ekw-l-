import type { Metadata } from 'next';
import Link from 'next/link';
import { approvals, integrations, mcp } from '@growth-agent/services';

type ConnectionCenterEntry = Awaited<ReturnType<typeof integrations.getConnectionCenter>>[number];
type ConnectionState = ConnectionCenterEntry['state'];
type ResolvedCapability = ConnectionCenterEntry['capabilities'][number];
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Globe,
  LayoutTemplate,
  Lock,
  Music2,
  Plug,
  Search,
  Youtube,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { TestConnectionButton } from '@/components/integrations/test-connection-button';
import { ActionButton } from '@/components/integrations/action-button';
import { syncNowAction } from '@/server/integration-actions';

export const metadata: Metadata = { title: 'Connections' };

const ICONS: Record<string, React.ReactNode> = {
  YOUTUBE: <Youtube />,
  TIKTOK: <Music2 />,
  GOOGLE_SEARCH_CONSOLE: <Search />,
  WEBSITE: <Globe />,
  WORDPRESS: <LayoutTemplate />,
};

/**
 * The visible label for each state. Deliberately plain language — a user
 * should never have to decode an enum name.
 */
const STATE_LABEL: Record<ConnectionState, string> = {
  NOT_CONNECTED: 'Not connected',
  CONNECTING: 'Setup incomplete',
  CONNECTED: 'Connected',
  DEGRADED: 'Degraded',
  EXPIRED: 'Renewing',
  REAUTH_REQUIRED: 'Action needed',
  ERROR: 'Error',
  DISCONNECTED: 'Disconnected',
};

const STATE_VARIANT: Record<ConnectionState, 'success' | 'warning' | 'destructive' | 'outline'> = {
  NOT_CONNECTED: 'outline',
  CONNECTING: 'warning',
  CONNECTED: 'success',
  DEGRADED: 'warning',
  EXPIRED: 'warning',
  REAUTH_REQUIRED: 'destructive',
  ERROR: 'destructive',
  DISCONNECTED: 'outline',
};

function StateIcon({ state }: { state: ConnectionState }) {
  switch (state) {
    case 'CONNECTED':
      return <CheckCircle2 className="size-3.5" aria-hidden />;
    case 'DEGRADED':
    case 'EXPIRED':
    case 'CONNECTING':
      return <Clock className="size-3.5" aria-hidden />;
    case 'ERROR':
    case 'REAUTH_REQUIRED':
      return <AlertTriangle className="size-3.5" aria-hidden />;
    default:
      return <CircleSlash className="size-3.5" aria-hidden />;
  }
}

function relative(date: Date | null): string | null {
  if (!date) return null;
  const mins = Math.round((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function CapabilityList({ capabilities }: { capabilities: ResolvedCapability[] }) {
  // Only read-level capabilities are shown as plain chips; anything that can
  // change an external system is badged so the permission is never implicit.
  return (
    <ul className="flex flex-wrap gap-1.5">
      {capabilities.map((cap) => {
        const gated = cap.level !== 'READ';
        return (
          <li key={cap.id}>
            <span
              title={cap.usable ? undefined : (cap.unavailableReason ?? 'Not available')}
              className={
                cap.usable
                  ? 'bg-accent text-accent-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs'
                  : 'text-muted-foreground border-border inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-xs'
              }
            >
              {gated ? <Lock className="size-3" aria-hidden /> : null}
              {cap.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function isUsableState(state: ConnectionState): boolean {
  return state === 'CONNECTED' || state === 'DEGRADED';
}

/** Last successful sync + the latest failure if it is more recent — never a guess. */
function SyncLine({ entry }: { entry: ConnectionCenterEntry }) {
  const { sync } = entry;
  const failedLast =
    sync.lastFailureAt && (!sync.lastSuccessAt || sync.lastFailureAt > sync.lastSuccessAt);
  return (
    <p className="text-xs">
      <span className="text-muted-foreground">
        {sync.running
          ? 'Sync running…'
          : sync.lastSuccessAt
            ? `Last synced ${relative(sync.lastSuccessAt)}`
            : 'Never synced'}
      </span>
      {failedLast ? (
        <span className="text-destructive block">
          Last sync failed {relative(sync.lastFailureAt)}: {sync.lastError}
        </span>
      ) : null}
    </p>
  );
}

function IntegrationCard({ entry }: { entry: ConnectionCenterEntry }) {
  const { descriptor, state, diagnostic, capabilities } = entry;
  const showDiagnostic = state !== 'CONNECTED';
  const checked = relative(entry.lastCheckedAt);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <span className="bg-accent text-accent-foreground flex size-9 items-center justify-center rounded-md [&_svg]:size-4">
          {ICONS[descriptor.key]}
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-base">{descriptor.label}</CardTitle>
          {entry.accountLabel ? (
            <p className="text-muted-foreground truncate text-xs">
              {entry.accountLabel}
              {entry.linkedCount > 1 ? ` +${entry.linkedCount - 1} more` : ''}
            </p>
          ) : null}
        </div>
        <Badge variant={STATE_VARIANT[state]} className="gap-1 whitespace-nowrap">
          <StateIcon state={state} />
          {entry.configured ? STATE_LABEL[state] : 'Unavailable'}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{descriptor.description}</p>

        {showDiagnostic ? (
          <div className="bg-muted/40 space-y-1 rounded-md p-3">
            <p className="text-sm font-medium">{diagnostic.title}</p>
            <p className="text-muted-foreground text-xs">{diagnostic.explanation}</p>
            <p className="text-xs">{diagnostic.recommendedAction}</p>
            {diagnostic.technicalDetail ? (
              <details className="text-muted-foreground text-xs">
                <summary className="cursor-pointer">Technical details</summary>
                <code className="mt-1 block break-all font-mono text-[11px]">
                  {diagnostic.technicalDetail}
                </code>
                <span className="mt-1 block">Reference: {diagnostic.referenceId}</span>
              </details>
            ) : null}
          </div>
        ) : null}

        {capabilities.length > 0 ? <CapabilityList capabilities={capabilities} /> : null}

        {entry.syncable && entry.connectionId && entry.configured && state !== 'NOT_CONNECTED' ? (
          <SyncLine entry={entry} />
        ) : null}

        <div className="flex flex-wrap gap-3">
          {entry.connectionId && descriptor.authKind === 'oauth' ? (
            <TestConnectionButton connectionId={entry.connectionId} />
          ) : null}
          {entry.syncable && entry.connectionId && isUsableState(state) ? (
            <ActionButton
              label="Sync now"
              pendingLabel="Syncing…"
              action={syncNowAction.bind(null, descriptor.key, entry.connectionId)}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-muted-foreground text-xs">
            {checked ? `Last checked ${checked}` : 'Never checked'}
          </p>
          {descriptor.implemented && entry.configured ? (
            <Button asChild size="sm" variant={state === 'CONNECTED' ? 'outline' : 'default'}>
              <Link href={entry.manageHref}>
                {diagnostic.action === 'RECONNECT'
                  ? 'Reconnect'
                  : state === 'NOT_CONNECTED'
                    ? 'Set up'
                    : 'Manage'}
              </Link>
            </Button>
          ) : (
            <Button size="sm" disabled title={diagnostic.recommendedAction}>
              Unavailable
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function IntegrationsPage() {
  const { org } = await requireActiveOrg();
  const [entries, pendingApprovals, mcpServers] = await Promise.all([
    integrations.getConnectionCenter(org.id),
    approvals.countPendingActions(org.id),
    mcp.listMcpServers(org.id),
  ]);
  const mcpEnabledCount = mcpServers.filter((s) => s.enabled).length;
  const summary = integrations.summarizeCenter(entries);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="Connect the accounts and properties you own. Tokens are encrypted at rest and never sent to your browser."
      />

      {pendingApprovals > 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <p className="text-sm">
              <strong>{pendingApprovals}</strong> change{pendingApprovals === 1 ? '' : 's'} to a
              connected account {pendingApprovals === 1 ? 'is' : 'are'} waiting for approval.
              Nothing is applied until an admin approves.
            </p>
            <Button asChild size="sm">
              <Link href="/app/integrations/approvals">Review</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-xs">
          <Link href="/app/integrations/approvals" className="underline">
            Approval history
          </Link>
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-semibold tabular-nums">{summary.connected}</p>
            <p className="text-muted-foreground text-xs">Connected</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-semibold tabular-nums">{summary.needsAttention}</p>
            <p className="text-muted-foreground text-xs">Need attention</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-semibold tabular-nums">{summary.available}</p>
            <p className="text-muted-foreground text-xs">Available on this deployment</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {entries.map((entry) => (
          <IntegrationCard key={entry.descriptor.key} entry={entry} />
        ))}
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <Plug className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">MCP servers</CardTitle>
              <p className="text-muted-foreground text-xs">
                Third-party Model Context Protocol tools.
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              {mcpServers.length === 0
                ? 'None connected.'
                : `${mcpServers.length} server${mcpServers.length === 1 ? '' : 's'}, ${mcpEnabledCount} enabled.`}
            </p>
            <Button asChild size="sm">
              <Link href="/app/integrations/mcp">Manage</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
