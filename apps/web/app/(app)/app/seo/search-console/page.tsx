import type { Metadata } from 'next';
import Link from 'next/link';
import { searchConsole } from '@growth-agent/services';
import { Alert, AlertDescription, AlertTitle, Button, PageHeader } from '@growth-agent/ui';
import { SearchConsoleDashboard } from '@/components/app/seo/search-console-dashboard';
import { requirePermission } from '@/lib/auth';
import { searchConsoleConfigured } from '@/lib/search-console';

export const metadata: Metadata = { title: 'Search Console — SEO' };
export const dynamic = 'force-dynamic';

export default async function SearchConsolePage() {
  const { org } = await requirePermission('data:read');
  const configured = searchConsoleConfigured();

  const [dashboard, properties] = await Promise.all([
    configured ? searchConsole.getDashboard(org.id) : Promise.resolve(null),
    configured ? searchConsole.listProperties(org.id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Search Console"
        description="Google's own search-performance, sitemap and indexing data for a verified property. All figures are captured from the official API — nothing is estimated."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/app/seo">All websites</Link>
          </Button>
        }
      />

      {!configured ? (
        <Alert>
          <AlertTitle>Not configured</AlertTitle>
          <AlertDescription>
            Search Console reuses the Google OAuth client. Set{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_ID</code>,{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code> and{' '}
            <code className="font-mono text-xs">ENCRYPTION_KEY</code> to enable it.
          </AlertDescription>
        </Alert>
      ) : !dashboard?.connection ? (
        <Alert>
          <AlertTitle>Not connected</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>Connect a Google account that has access to your Search Console property.</span>
            <Button asChild size="sm" className="w-fit">
              <Link href="/app/integrations/search-console">Set up Search Console</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <SearchConsoleDashboard
          dashboard={JSON.parse(JSON.stringify(dashboard))}
          properties={properties.map((p) => ({
            id: p.id,
            siteUrl: p.siteUrl,
            verified: p.verified,
            permissionLevel: p.permissionLevel,
            isSelected: p.isSelected,
          }))}
        />
      )}
    </div>
  );
}
