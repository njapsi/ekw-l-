import type { Metadata } from 'next';
import Link from 'next/link';
import { wordpress } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { loadWordPressState } from '@/lib/wordpress-state';
import { WordPressEmpty } from '@/components/app/wordpress/wordpress-empty';

export const metadata: Metadata = { title: 'WordPress — Overview' };

const AVAILABILITY_VARIANT: Record<string, 'success' | 'warning' | 'outline'> = {
  AVAILABLE: 'success',
  REQUIRES_PERMISSION: 'warning',
  NOT_AVAILABLE: 'outline',
};

export default async function WordPressOverviewPage() {
  const { org } = await requireActiveOrg();
  const state = await loadWordPressState(org.id);
  if (state.kind !== 'ready') return <WordPressEmpty />;

  const matrix = await wordpress.getWordPressCapabilityMatrix(org.id);
  const { site } = state;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">{site.siteName || site.siteUrl}</CardTitle>
            <CardDescription className="truncate">
              {site.siteUrl} · signed in as {site.username}
            </CardDescription>
          </div>
          <Badge variant={site.status === 'ACTIVE' ? 'success' : 'warning'}>
            {site.status.toLowerCase()}
          </Badge>
        </CardHeader>
        <CardContent className="text-muted-foreground text-xs">
          Last checked {relDate(site.lastCheckAt)}. Manage the connection, sync, and drafts from{' '}
          <Link href="/app/integrations/wordpress" className="underline">
            Connections → WordPress
          </Link>
          .
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Capability matrix</CardTitle>
          <CardDescription>
            What the connected WordPress account and this deployment&apos;s client actually
            permit — never assumed from a role name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            {matrix.capabilities.map((c) => (
              <div
                key={c.key}
                className="border-border flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium">{c.key}</p>
                  <p className="text-muted-foreground mt-1 text-xs">{c.reason}</p>
                </div>
                <Badge variant={AVAILABILITY_VARIANT[c.availability] ?? 'outline'}>
                  {c.availability.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
