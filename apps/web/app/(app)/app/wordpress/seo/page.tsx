import type { Metadata } from 'next';
import Link from 'next/link';
import { wordpress } from '@growth-agent/services';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { loadWordPressState } from '@/lib/wordpress-state';
import { WordPressEmpty } from '@/components/app/wordpress/wordpress-empty';
import { ProposeFixButton } from '@/components/app/wordpress/propose-fix-button';

export const metadata: Metadata = { title: 'WordPress — SEO' };

const SEVERITY_VARIANT: Record<string, 'destructive' | 'warning' | 'outline'> = {
  CRITICAL: 'destructive',
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'outline',
};

export default async function WordPressSeoPage() {
  const { org } = await requireActiveOrg();
  const state = await loadWordPressState(org.id);
  if (state.kind !== 'ready') return <WordPressEmpty />;

  const issues = await wordpress.listActionableSeoIssuesForSite(org.id, state.site.id);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SEO issues WordPress can fix</CardTitle>
          <CardDescription>
            Only title and meta-description issues can be routed through a WordPress content
            update — only title/excerpt/content/slug are writable at all. Every other issue type
            needs a manual or plugin-specific fix. Proposing a fix only files a pending approval;
            nothing changes on WordPress until an admin approves it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {issues.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No open title/meta-description issues were found on the website matching this
              WordPress site — or no completed crawl exists yet. Run a crawl from{' '}
              <Link href="/app/seo" className="underline">
                SEO
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-3">
              {issues.map((issue) => (
                <div
                  key={issue.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={SEVERITY_VARIANT[issue.severity] ?? 'outline'}>
                        {issue.severity.toLowerCase()}
                      </Badge>
                      <p className="font-medium">{issue.title}</p>
                    </div>
                    <p className="text-muted-foreground mt-1 truncate text-xs">
                      {issue.url ?? 'no URL recorded'}
                    </p>
                    {!issue.hasWordPressMatch ? (
                      <p className="text-muted-foreground mt-1 text-xs">
                        No synced WordPress content matches this URL yet.
                      </p>
                    ) : null}
                  </div>
                  {issue.hasWordPressMatch ? (
                    <ProposeFixButton siteId={state.site.id} issueId={issue.id} />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
