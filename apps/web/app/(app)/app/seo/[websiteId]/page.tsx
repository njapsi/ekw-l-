import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { searchConsole, seo } from '@growth-agent/services';
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
import {
  CrawlControls,
  StartCrawlForm,
  VerifyWebsiteButton,
} from '@/components/app/seo/seo-actions';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { VERIFY_FILE_PATH, VERIFY_TXT_PREFIX } from '@/lib/seo';

export const metadata: Metadata = { title: 'Website — SEO' };

export default async function WebsiteDetailPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const { org } = await requireActiveOrg();
  const site = await seo.getWebsite(org.id, websiteId);
  if (!site) notFound();
  const [crawls, gsc] = await Promise.all([
    seo.listCrawls(org.id, websiteId),
    searchConsole.getPerformanceForAgent(org.id, site.hostname).catch(() => null),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={site.hostname}
        description={site.url}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/app/seo">All websites</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Search Console</CardTitle>
            <Link href="/app/seo/search-console" className="text-primary text-xs hover:underline">
              Open dashboard →
            </Link>
          </div>
        </CardHeader>
        <CardContent className="text-sm">
          {gsc ? (
            <div className="grid gap-3 sm:grid-cols-4">
              <Sc label="Clicks" value={gsc.performance.totals.clicks.toLocaleString()} />
              <Sc label="Impressions" value={gsc.performance.totals.impressions.toLocaleString()} />
              <Sc
                label="Avg CTR"
                value={
                  gsc.performance.totals.ctr != null
                    ? `${(gsc.performance.totals.ctr * 100).toFixed(1)}%`
                    : '—'
                }
              />
              <Sc
                label="Avg position"
                value={
                  gsc.performance.totals.position != null
                    ? gsc.performance.totals.position.toFixed(1)
                    : '—'
                }
              />
            </div>
          ) : (
            <p className="text-muted-foreground">
              No verified Search Console property is connected for this hostname.{' '}
              <Link
                href="/app/integrations/search-console"
                className="text-primary hover:underline"
              >
                Connect Search Console
              </Link>{' '}
              to let the SEO agent combine crawler findings with Google’s own search data.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Ownership verification</CardTitle>
            <Badge variant={site.verified ? 'secondary' : 'outline'}>
              {site.verified ? `verified · ${site.verificationMethod}` : 'not verified'}
            </Badge>
          </div>
          <CardDescription>
            A full crawl (more pages, greater depth, optional rendering) only runs for a verified
            domain. Publish <strong>one</strong> of the following, then check again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!site.verified ? (
            <>
              <div className="bg-muted/40 rounded-md p-3">
                <p className="font-medium">Option A — DNS TXT record</p>
                <p className="text-muted-foreground">
                  Add a TXT record to <code className="font-mono text-xs">{site.hostname}</code>{' '}
                  with value:
                </p>
                <code className="mt-1 block break-all font-mono text-xs">
                  {VERIFY_TXT_PREFIX}
                  {site.verificationToken}
                </code>
              </div>
              <div className="bg-muted/40 rounded-md p-3">
                <p className="font-medium">Option B — HTML file</p>
                <p className="text-muted-foreground">
                  Serve this exact text at{' '}
                  <code className="font-mono text-xs">
                    {site.url}
                    {VERIFY_FILE_PATH}
                  </code>
                  :
                </p>
                <code className="mt-1 block break-all font-mono text-xs">
                  {site.verificationToken}
                </code>
              </div>
              <VerifyWebsiteButton websiteId={site.id} />
            </>
          ) : (
            <p className="text-muted-foreground">
              Verified {relDate(site.verifiedAt)}. You can run full crawls.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Start a crawl</CardTitle>
          <CardDescription>
            Limits are capped by your plan tier and (for unverified domains) the public-sample gate.
            Per-host rate limiting and <code className="font-mono text-xs">robots.txt</code> /
            <code className="font-mono text-xs"> Crawl-delay</code> are always honoured.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StartCrawlForm websiteId={site.id} verified={site.verified} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Crawl history</CardTitle>
        </CardHeader>
        <CardContent>
          {crawls.length === 0 ? (
            <p className="text-muted-foreground text-sm">No crawls yet.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {crawls.map((c) => {
                const score = (c.scores as { overall?: number } | null)?.overall ?? null;
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge
                        variant={
                          c.status === 'COMPLETED'
                            ? 'secondary'
                            : c.status === 'BLOCKED' || c.status === 'FAILED'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {c.status.toLowerCase()}
                      </Badge>
                      <Link href={`/app/seo/${site.id}/crawls/${c.id}`} className="hover:underline">
                        {relDate(c.createdAt)}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {c.pagesCrawled} pages · {c.issuesFound} issues
                        {score != null ? ` · ${score}/100` : ''}
                        {c.blockedReason ? ` · ${c.blockedReason}` : ''}
                      </span>
                    </span>
                    <CrawlControls crawlId={c.id} status={c.status} />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Safety</AlertTitle>
        <AlertDescription>
          The crawler resolves DNS itself and refuses loopback, private, link-local, ULA, multicast
          and cloud-metadata addresses — on the start URL and every redirect hop. It never forwards
          your credentials to a target and never returns arbitrary fetched bodies.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function Sc({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
