import type { Metadata } from 'next';
import Link from 'next/link';
import { integrations, wordpress } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { LayoutTemplate } from 'lucide-react';
import { requireActiveOrg } from '@/lib/auth';
import { ActionButton } from '@/components/integrations/action-button';
import {
  WordPressChangeRequest,
  WordPressConnectForm,
  WordPressDraftForm,
} from '@/components/integrations/wordpress-forms';
import {
  checkWordPressAction,
  disconnectWordPressAction,
  syncNowAction,
} from '@/server/integration-actions';

export const metadata: Metadata = { title: 'WordPress' };

function when(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
}

export default async function WordPressPage() {
  const { org } = await requireActiveOrg();
  const [entries, sites] = await Promise.all([
    integrations.getConnectionCenter(org.id),
    wordpress.listWordPressSites(org.id),
  ]);
  const entry = entries.find((e) => e.descriptor.key === 'WORDPRESS');
  const site = sites[0] ?? null;
  const content = site
    ? await wordpress.listWordPressContent(org.id, { siteId: site.id, limit: 50 })
    : [];
  const caps = new Set(site?.detectedCapabilities ?? []);
  const usable = (id: string) => entry?.capabilities.find((c) => c.id === id)?.usable ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="WordPress"
        description="Read your posts and pages, create drafts, and — only with an admin's approval — update or publish content."
      />
      <p className="text-sm">
        <Link href="/app/integrations" className="underline">
          ← All connections
        </Link>
      </p>

      {!entry?.configured ? (
        <Card>
          <CardContent className="pt-6 text-sm">{entry?.diagnostic.explanation}</CardContent>
        </Card>
      ) : !site ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect a WordPress site</CardTitle>
          </CardHeader>
          <CardContent>
            <WordPressConnectForm />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <div className="min-w-0">
                <CardTitle className="text-base">{site.siteName || site.siteUrl}</CardTitle>
                <p className="text-muted-foreground truncate text-xs">
                  {site.siteUrl} · signed in as {site.username}
                </p>
              </div>
              <Badge variant={entry.state === 'CONNECTED' ? 'success' : 'warning'}>
                {entry.state.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {entry.state !== 'CONNECTED' ? (
                <div className="bg-muted/40 space-y-1 rounded-md p-3 text-sm">
                  <p className="font-medium">{entry.diagnostic.title}</p>
                  <p className="text-muted-foreground text-xs">{entry.diagnostic.explanation}</p>
                  <p className="text-xs">{entry.diagnostic.recommendedAction}</p>
                </div>
              ) : null}
              <dl className="grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground text-xs">Last check</dt>
                  <dd>{when(site.lastCheckAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Last successful sync</dt>
                  <dd>{when(entry.sync.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">WordPress capabilities</dt>
                  <dd className="font-mono text-xs">
                    {site.detectedCapabilities.join(', ') || 'none detected'}
                  </dd>
                </div>
              </dl>
              {entry.sync.lastFailureAt &&
              (!entry.sync.lastSuccessAt || entry.sync.lastFailureAt > entry.sync.lastSuccessAt) ? (
                <p className="text-destructive text-xs">
                  Last sync failed ({when(entry.sync.lastFailureAt)}): {entry.sync.lastError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <ActionButton
                  label="Sync now"
                  pendingLabel="Syncing…"
                  action={syncNowAction.bind(null, 'WORDPRESS', site.id)}
                />
                <ActionButton
                  label="Test connection"
                  pendingLabel="Testing…"
                  action={checkWordPressAction.bind(null, site.id)}
                />
                <ActionButton
                  label="Disconnect"
                  pendingLabel="Disconnecting…"
                  variant="ghost"
                  confirm="Disconnect this WordPress site? The stored application password is deleted and synced content is removed from Growth Agent."
                  action={disconnectWordPressAction.bind(null, site.id)}
                />
              </div>
              {entry.state === 'REAUTH_REQUIRED' ? (
                <div className="border-t pt-4">
                  <p className="mb-3 text-sm font-medium">
                    Reconnect with a new application password
                  </p>
                  <WordPressConnectForm />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Posts and pages</CardTitle>
            </CardHeader>
            <CardContent>
              {content.length === 0 ? (
                <EmptyState
                  icon={<LayoutTemplate />}
                  title="No content synced yet"
                  description="Run a sync to pull posts and pages exactly as WordPress reports them."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground text-left text-xs">
                      <tr>
                        <th scope="col" className="py-2 pr-3">
                          Title
                        </th>
                        <th scope="col" className="py-2 pr-3">
                          Type
                        </th>
                        <th scope="col" className="py-2 pr-3">
                          Status
                        </th>
                        <th scope="col" className="py-2 pr-3">
                          Modified
                        </th>
                        <th scope="col" className="py-2">
                          Changes
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {content.map((c) => {
                        const kind = c.type === 'PAGE' ? 'pages' : 'posts';
                        const canPublish =
                          (c.status === 'draft' || c.status === 'pending') &&
                          usable('wordpress.publish') &&
                          caps.has(kind === 'pages' ? 'publish_pages' : 'publish_posts');
                        const canEdit =
                          usable('wordpress.update_post') &&
                          caps.has(kind === 'pages' ? 'edit_pages' : 'edit_posts') &&
                          (c.status !== 'publish' ||
                            caps.has(
                              kind === 'pages' ? 'edit_published_pages' : 'edit_published_posts',
                            ));
                        return (
                          <tr key={c.id} className="border-t align-top">
                            <td className="py-2 pr-3">
                              {c.link ? (
                                <a
                                  href={c.link}
                                  className="underline"
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  {c.title}
                                </a>
                              ) : (
                                c.title
                              )}
                            </td>
                            <td className="py-2 pr-3">{c.type === 'PAGE' ? 'Page' : 'Post'}</td>
                            <td className="py-2 pr-3">{c.status}</td>
                            <td className="whitespace-nowrap py-2 pr-3">{when(c.modifiedAt)}</td>
                            <td className="py-2">
                              {canPublish || canEdit ? (
                                <WordPressChangeRequest
                                  siteId={site.id}
                                  wpId={c.wpId}
                                  kind={kind}
                                  title={c.title}
                                  canPublish={canPublish}
                                  canEdit={canEdit}
                                />
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {usable('wordpress.create_draft') ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">New draft</CardTitle>
              </CardHeader>
              <CardContent>
                <WordPressDraftForm siteId={site.id} />
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
