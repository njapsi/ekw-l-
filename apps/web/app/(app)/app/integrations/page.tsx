import type { Metadata } from 'next';
import Link from 'next/link';
import { integrations } from '@growth-agent/services';
import { Music2, Search, Youtube } from 'lucide-react';
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
import { searchConsoleConfigured } from '@/lib/search-console';
import { tiktokConfigured } from '@/lib/tiktok';
import { youtubeConfigured } from '@/lib/youtube';

export const metadata: Metadata = { title: 'Integrations' };

export default async function IntegrationsPage() {
  const { org } = await requireActiveOrg();
  const [ytConn, ttConn, gscConn] = await Promise.all([
    integrations.getConnectionForOrg(org.id, 'YOUTUBE'),
    integrations.getConnectionForOrg(org.id, 'TIKTOK'),
    integrations.getConnectionForOrg(org.id, 'GOOGLE_SEARCH_CONSOLE'),
  ]);
  const connected = (c: typeof ytConn) => Boolean(c && c.status !== 'REVOKED');

  const providers = [
    {
      key: 'youtube',
      name: 'YouTube',
      icon: <Youtube />,
      blurb: 'Data API v3 and Analytics API v2, read-only.',
      href: '/app/integrations/youtube',
      configured: youtubeConfigured(),
      connected: connected(ytConn),
      available: true,
    },
    {
      key: 'tiktok',
      name: 'TikTok',
      icon: <Music2 />,
      blurb:
        'Official Login Kit + Display API. Publishing via the Content Posting API where scoped.',
      href: '/app/integrations/tiktok',
      configured: tiktokConfigured(),
      connected: connected(ttConn),
      available: true,
    },
    {
      key: 'gsc',
      name: 'Google Search Console',
      icon: <Search />,
      blurb:
        'Official Search Console API: search performance, sitemaps, URL inspection. Feeds the SEO agent.',
      href: '/app/integrations/search-console',
      configured: searchConsoleConfigured(),
      connected: connected(gscConn),
      available: true,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect the accounts and properties you own. Tokens are encrypted at rest and never sent to your browser."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {providers.map((p) => {
          const status = !p.available
            ? 'Coming later'
            : !p.configured
              ? 'Not configured'
              : p.connected
                ? 'Connected'
                : 'Not connected';
          return (
            <Card key={p.key}>
              <CardHeader className="flex-row items-center gap-3 space-y-0">
                <span className="bg-accent text-accent-foreground flex size-9 items-center justify-center rounded-md [&_svg]:size-4">
                  {p.icon}
                </span>
                <div className="flex-1">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                </div>
                <Badge variant={status === 'Connected' ? 'secondary' : 'outline'}>{status}</Badge>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">{p.blurb}</p>
                {p.available && p.href ? (
                  <Button asChild size="sm" variant={p.connected ? 'outline' : 'default'}>
                    <Link href={p.href}>{p.connected ? 'Manage' : 'Set up'}</Link>
                  </Button>
                ) : (
                  <Button size="sm" disabled>
                    Connect
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
