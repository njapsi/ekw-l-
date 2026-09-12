import type { Metadata } from 'next';
import Link from 'next/link';
import { seo } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { AddWebsiteForm } from '@/components/app/seo/seo-actions';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { crawlingHaltedGlobally } from '@/lib/seo';

export const metadata: Metadata = { title: 'SEO' };

export default async function SeoPage() {
  const { org } = await requireActiveOrg();
  const websites = await seo.listWebsites(org.id);
  const halted = crawlingHaltedGlobally();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Technical SEO"
        description="Bounded, robots-aware, SSRF-safe crawls of sites you control. Status codes, canonicals, sitemaps, structured data, rendering, internal linking and crawl depth — scored by category with transparent weighting."
        actions={
          <Link href="/app/seo/search-console" className="text-primary text-sm hover:underline">
            Search Console →
          </Link>
        }
      />

      {halted ? (
        <Alert variant="destructive">
          <AlertTitle>Crawling is paused</AlertTitle>
          <AlertDescription>
            An operator has temporarily disabled crawling on this deployment (
            <code className="font-mono text-xs">CRAWLER_HALT</code>). New crawls will not start.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a website</CardTitle>
          <CardDescription>
            You’ll verify that you control the domain (DNS TXT or an HTML file) before a full crawl
            runs. Unverified domains get a shallow public sample only. The crawler never acts as an
            open fetch proxy and never contacts private or internal addresses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddWebsiteForm />
        </CardContent>
      </Card>

      {websites.length === 0 ? (
        <EmptyState
          title="No websites yet"
          description="Add a website above to run your first technical audit."
        />
      ) : (
        <div className="grid gap-4">
          {websites.map((w) => (
            <Card key={w.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <Link href={`/app/seo/${w.id}`} className="hover:underline">
                      {w.hostname}
                    </Link>
                  </CardTitle>
                  <Badge variant={w.verified ? 'secondary' : 'outline'}>
                    {w.verified ? 'verified' : 'unverified'}
                  </Badge>
                </div>
                <CardDescription>
                  {w.crawlCount} crawl(s).{' '}
                  {w.latestCrawl
                    ? `Latest: ${w.latestCrawl.status.toLowerCase()} ${relDate(
                        w.latestCrawl.createdAt,
                      )}` +
                      (w.latestCrawl.overallScore != null
                        ? ` · score ${w.latestCrawl.overallScore}/100`
                        : '')
                    : 'No crawls run yet.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                <Link href={`/app/seo/${w.id}`} className="text-primary hover:underline">
                  Open →
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Design + limitations: <span className="font-mono text-xs">docs/SEO-ENGINE.md</span>. Scores
        are diagnostic and never predict search rankings.
      </p>
    </div>
  );
}
