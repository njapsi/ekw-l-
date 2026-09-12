import type { Metadata } from 'next';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { SyncButton } from '@/components/app/youtube/youtube-actions';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, fullNumber, relDate } from '@/lib/format';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Overview' };

export default async function YouTubeOverviewPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const { overview: o, connection } = state;
  const stats = [
    {
      label: 'Subscribers',
      value: o.channel.hiddenSubscriberCount ? 'Hidden' : compactNumber(o.channel.subscriberCount),
      full: o.channel.hiddenSubscriberCount
        ? 'This channel hides its count'
        : fullNumber(o.channel.subscriberCount),
    },
    {
      label: 'Lifetime views',
      value: compactNumber(o.channel.viewCount),
      full: fullNumber(o.channel.viewCount),
    },
    {
      label: 'Public videos',
      value: compactNumber(o.channel.videoCount),
      full: fullNumber(o.channel.videoCount),
    },
    {
      label: 'Videos synced',
      value: fullNumber(o.counts.videosSynced),
      full: `${o.counts.analyticsDays} days of analytics`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {o.channel.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.channel.thumbnailUrl} alt="" className="size-10 rounded-full" />
          ) : null}
          <div>
            <p className="font-medium">{o.channel.title}</p>
            <p className="text-muted-foreground text-xs">
              {o.channel.handle ?? o.channel.channelId} · synced {relDate(o.channel.lastSyncedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connection.hasRevenueScope ? <Badge variant="secondary">revenue scope</Badge> : null}
          <SyncButton>Sync now</SyncButton>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-1">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-2xl">{s.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">{s.full}</CardContent>
          </Card>
        ))}
      </div>

      {o.hasAnalytics ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 28 days</CardTitle>
            <CardDescription>From the YouTube Analytics API (2-day reporting lag).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Metric label="Views" value={fullNumber(o.windows.last28d?.views ?? null)} />
            <Metric label="Watch hours" value={fullNumber(o.windows.last28d?.watchHours ?? null)} />
            <Metric
              label="Net subscribers"
              value={fullNumber(o.windows.last28d?.netSubscribers ?? null)}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Analytics not synced</CardTitle>
            <CardDescription>
              Time-series analytics (views over time, watch hours, subscriber flow) haven’t been
              pulled yet, or the API returned no rows for the requested range.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SyncButton facet="analytics">Sync analytics</SyncButton>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
