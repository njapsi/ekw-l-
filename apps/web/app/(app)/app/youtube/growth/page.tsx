import type { Metadata } from 'next';
import { youtube } from '@growth-agent/services';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { SyncButton } from '@/components/app/youtube/youtube-actions';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { fullNumber } from '@/lib/format';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Growth' };

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 600;
  const h = 60;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * h}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-16 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="trend"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default async function YouTubeGrowthPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const growth = await youtube.getGrowthSeries(org.id);

  if (!growth || !growth.hasData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No analytics time-series yet</CardTitle>
          <CardDescription>
            Growth over time comes from the YouTube Analytics API. Sync analytics to populate this
            view. New or very small channels may have no rows for the requested range — that is
            shown here, never estimated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncButton facet="analytics">Sync analytics</SyncButton>
        </CardContent>
      </Card>
    );
  }

  const last90 = growth.series.slice(-90);
  const totals = {
    views: last90.reduce((s, d) => s + d.views, 0),
    watchHours: last90.reduce((s, d) => s + d.watchHours, 0),
    netSubs: last90.reduce((s, d) => s + d.netSubscribers, 0),
  };
  const hasRevenue = last90.some((d) => d.estimatedRevenue != null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Views — last {last90.length} days</CardTitle>
          <CardDescription>Daily views from the Analytics API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Sparkline values={last90.map((d) => d.views)} />
          <p className="text-muted-foreground text-sm">
            {fullNumber(totals.views)} views · {fullNumber(totals.watchHours)} watch hours ·{' '}
            {fullNumber(totals.netSubs)} net subscribers over the window.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Net subscribers — daily</CardTitle>
        </CardHeader>
        <CardContent>
          <Sparkline values={last90.map((d) => d.netSubscribers)} />
        </CardContent>
      </Card>

      {hasRevenue ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estimated revenue — daily</CardTitle>
            <CardDescription>
              From the monetary Analytics scope. Estimated by YouTube; not a guarantee of payout.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline values={last90.map((d) => d.estimatedRevenue ?? 0)} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-xs">
          Revenue data is not shown — the connection was not granted the monetary analytics scope,
          or the account has no revenue. Reconnect from the integrations page and choose to include
          revenue to add it.
        </p>
      )}
    </div>
  );
}
