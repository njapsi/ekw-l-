import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  Gauge,
  Lightbulb,
  Music2,
  Plug,
  Rss,
  Youtube,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { dashboard } from '@growth-agent/services';

export const metadata: Metadata = { title: 'Dashboard' };

const RUN_STATUS_VARIANT: Record<
  string,
  'default' | 'success' | 'warning' | 'destructive' | 'secondary'
> = {
  COMPLETED: 'success',
  RUNNING: 'default',
  QUEUED: 'secondary',
  NEEDS_APPROVAL: 'warning',
  FAILED: 'destructive',
  CANCELLED: 'secondary',
};

const AGENT_LABEL: Record<string, string> = {
  'growth-agent': 'Growth Agent',
  'youtube-analyst': 'YouTube Analyst',
  'tiktok-analyst': 'TikTok Analyst',
  'seo-auditor': 'SEO Auditor',
  'seo-agent': 'SEO Agent',
  'monetization-analyst': 'Monetization Analyst',
};

export default async function DashboardPage() {
  const { org, user } = await requireActiveOrg();
  const summary = await dashboard.getDashboardSummary(org.id, user.id);
  const { context, connectionSummary, activeAutomations, totalAutomations, recentAgentRuns } =
    summary;

  const hasAnyConnection =
    context.youtube.connected || context.tiktok.connected || context.seo.websites > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good to see you, ${user.name?.split(' ')[0] ?? 'there'}`}
        description={`Your growth overview for ${org.name}.`}
        actions={
          <Button asChild>
            <Link href="/app/agent">
              <Bot className="size-4" /> Ask Growth Agent
            </Link>
          </Button>
        }
      />

      {!hasAnyConnection ? (
        <EmptyState
          icon={<Plug />}
          title="Your AI growth workspace is ready"
          description="Connect a platform to start seeing real analysis here. We never show sample or fabricated data — every number on this page comes from your own connected accounts."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link href="/app/integrations/youtube">Connect YouTube</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/app/integrations/tiktok">Connect TikTok</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/app/seo">Add website</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              icon={<Youtube className="size-4" aria-hidden />}
              label="YouTube"
              value={
                context.youtube.connected
                  ? `${context.youtube.subscriberCount ?? '—'} subscribers`
                  : 'Not connected'
              }
              hint={
                context.youtube.connected
                  ? `${context.youtube.videoCount ?? 0} videos`
                  : 'Connect to see channel health'
              }
              href="/app/youtube"
            />
            <SummaryCard
              icon={<Music2 className="size-4" aria-hidden />}
              label="TikTok"
              value={
                context.tiktok.connected
                  ? (context.tiktok.displayName ?? 'Connected')
                  : 'Not connected'
              }
              hint={context.tiktok.hasStats ? 'Follower stats available' : 'Awaiting stats'}
              href="/app/tiktok"
            />
            <SummaryCard
              icon={<Gauge className="size-4" aria-hidden />}
              label="SEO health"
              value={
                context.seo.latestCrawl?.overallScore != null
                  ? `${context.seo.latestCrawl.overallScore}/100`
                  : context.seo.websites > 0
                    ? 'No crawl yet'
                    : 'No website yet'
              }
              hint={
                context.seo.latestCrawl
                  ? `${context.seo.latestCrawl.issuesFound} issues found`
                  : `${context.seo.verifiedWebsites}/${context.seo.websites} verified`
              }
              href="/app/seo"
            />
            <SummaryCard
              icon={<Rss className="size-4" aria-hidden />}
              label="Automations"
              value={`${activeAutomations} active`}
              hint={`${totalAutomations} total`}
              href="/app/automations"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lightbulb className="size-4" aria-hidden /> AI insights
                </CardTitle>
                <CardDescription>
                  {context.recentRecommendations > 0
                    ? `Growth Agent found ${context.recentRecommendations} recommendation${context.recentRecommendations === 1 ? '' : 's'} in the last 30 days.`
                    : 'No recommendations yet — connect more sources or ask Growth Agent to analyze what you have.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/app/agent">
                    Ask Growth Agent <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
                {context.seo.latestCrawl ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/app/seo/${context.seo.latestCrawl.websiteId}`}>
                      Review SEO opportunities <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                ) : null}
                {context.youtube.connected ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/app/youtube/opportunities">
                      YouTube opportunities <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plug className="size-4" aria-hidden /> Connected platforms
                </CardTitle>
                <CardDescription>
                  {connectionSummary.connected} connected
                  {connectionSummary.needsAttention > 0
                    ? ` · ${connectionSummary.needsAttention} need attention`
                    : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline" size="sm">
                  <Link href="/app/integrations">
                    Manage connections <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="size-4" aria-hidden /> Recent agent activity
                </CardTitle>
                <CardDescription>
                  {context.openTasks} open task{context.openTasks === 1 ? '' : 's'} across your
                  recommendations.
                </CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/app/tasks">
                  View tasks <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {recentAgentRuns.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No agent runs yet. Start a conversation to see activity here.
                </p>
              ) : (
                <ul className="divide-border divide-y">
                  {recentAgentRuns.map((run) => (
                    <li key={run.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex items-center gap-2 text-sm">
                        <CheckCircle2
                          className="text-muted-foreground size-4 shrink-0"
                          aria-hidden
                        />
                        {AGENT_LABEL[run.agent] ?? run.agent}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'secondary'}>
                          {run.status.replace('_', ' ').toLowerCase()}
                        </Badge>
                        <time
                          className="text-muted-foreground text-xs"
                          dateTime={run.createdAt.toISOString()}
                        >
                          {relativeTime(run.createdAt)}
                        </time>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  hint,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="hover:bg-muted/50 h-full transition-colors">
        <CardHeader className="pb-2">
          <CardDescription className="flex items-center gap-1.5">
            {icon}
            {label}
          </CardDescription>
          <CardTitle className="text-xl">{value}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>
      </Card>
    </Link>
  );
}

/** Small, dependency-free relative-time label — this app has no date library
 * anywhere (`Intl.RelativeTimeFormat` covers the one case we need). */
function relativeTime(date: Date): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}
