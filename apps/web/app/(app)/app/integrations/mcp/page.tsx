import type { Metadata } from 'next';
import Link from 'next/link';
import { mcp } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { Plug } from 'lucide-react';
import { requireActiveOrg } from '@/lib/auth';
import { ActionButton } from '@/components/integrations/action-button';
import { AddMcpServerForm, TrustLevelSelect } from '@/components/integrations/mcp-forms';
import {
  deleteMcpServerAction,
  setMcpServerEnabledAction,
  setMcpToolEnabledAction,
  testMcpServerAction,
} from '@/server/mcp-actions';

export const metadata: Metadata = { title: 'MCP Servers' };

function when(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never checked';
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  CONNECTED: 'success',
  PENDING: 'secondary',
  DEGRADED: 'warning',
  ERROR: 'destructive',
  DISABLED: 'secondary',
};

const RISK_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  LOW: 'success',
  MEDIUM: 'secondary',
  HIGH: 'warning',
  CRITICAL: 'destructive',
};

export default async function McpServersPage() {
  const { org } = await requireActiveOrg();
  const servers = await mcp.listMcpServers(org.id);
  const toolsByServer = await Promise.all(servers.map((s) => mcp.listMcpServerTools(org.id, s.id)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP Servers"
        description="Connect third-party Model Context Protocol servers. Every discovered tool starts disabled — enable only what you want the agent to use, and only after reviewing it."
      />
      <p className="text-sm">
        <Link href="/app/integrations" className="underline">
          ← All connections
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a server</CardTitle>
        </CardHeader>
        <CardContent>
          <AddMcpServerForm />
        </CardContent>
      </Card>

      {servers.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title="No MCP servers connected"
          description="Add one above to let the agent discover its read-only tools — nothing is exposed to the agent until you explicitly enable it."
        />
      ) : (
        servers.map((server, i) => {
          const tools = toolsByServer[i] ?? [];
          return (
            <Card key={server.id}>
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="text-base">{server.name}</CardTitle>
                  <p className="text-muted-foreground truncate text-xs">{server.endpoint}</p>
                </div>
                <Badge variant={STATUS_VARIANT[server.status] ?? 'secondary'}>
                  {server.status.toLowerCase()}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground text-xs">Trust level</dt>
                    <dd>
                      <TrustLevelSelect serverId={server.id} value={server.trustLevel} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Last checked</dt>
                    <dd>{when(server.lastCheckAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Tools</dt>
                    <dd>
                      {server.enabledToolCount} of {server.toolCount} enabled
                    </dd>
                  </div>
                </dl>
                {server.lastError ? (
                  <p className="text-destructive text-xs">{server.lastError}</p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  <ActionButton
                    label="Test connection"
                    pendingLabel="Connecting…"
                    action={testMcpServerAction.bind(null, server.id)}
                  />
                  <ActionButton
                    label={server.enabled ? 'Disable server' : 'Enable server'}
                    pendingLabel="Updating…"
                    action={setMcpServerEnabledAction.bind(null, server.id, !server.enabled)}
                  />
                  <ActionButton
                    label="Remove"
                    pendingLabel="Removing…"
                    variant="ghost"
                    confirm={`Remove "${server.name}"? Every discovered tool is deleted with it.`}
                    action={deleteMcpServerAction.bind(null, server.id)}
                  />
                </div>

                {tools.length > 0 ? (
                  <div className="overflow-x-auto border-t pt-4">
                    <table className="w-full text-sm">
                      <thead className="text-muted-foreground text-left text-xs">
                        <tr>
                          <th scope="col" className="py-2 pr-3">
                            Tool
                          </th>
                          <th scope="col" className="py-2 pr-3">
                            Risk
                          </th>
                          <th scope="col" className="py-2">
                            Enabled
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {tools.map((t) => (
                          <tr key={t.id} className="border-t align-top">
                            <td className="py-2 pr-3">
                              <p className="font-mono text-xs">{t.namespacedName}</p>
                              {t.description ? (
                                <p className="text-muted-foreground text-xs">{t.description}</p>
                              ) : null}
                            </td>
                            <td className="py-2 pr-3">
                              <Badge variant={RISK_VARIANT[t.riskLevel] ?? 'secondary'}>
                                {t.riskLevel.toLowerCase()}
                              </Badge>
                            </td>
                            <td className="py-2">
                              <ActionButton
                                label={t.enabled ? 'Disable' : 'Enable'}
                                pendingLabel="Updating…"
                                size="sm"
                                variant={t.enabled ? 'outline' : 'default'}
                                action={setMcpToolEnabledAction.bind(
                                  null,
                                  server.id,
                                  t.id,
                                  !t.enabled,
                                )}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    No tools discovered yet — test the connection to discover them.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
