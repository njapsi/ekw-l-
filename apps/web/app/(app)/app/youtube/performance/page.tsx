import type { Metadata } from 'next';
import { youtube } from '@growth-agent/services';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { SyncButton } from '@/components/app/youtube/youtube-actions';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, fullNumber } from '@/lib/format';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Performance' };

const CLASSIFICATION_LABEL: Record<string, string> = {
  OUTPERFORMING: 'Outperforming',
  TYPICAL: 'Typical',
  UNDERPERFORMING: 'Underperforming',
  INSUFFICIENT_DATA: 'Not enough peers yet',
};
const CLASSIFICATION_VARIANT: Record<
  string,
  'default' | 'secondary' | 'outline' | 'success' | 'warning'
> = {
  OUTPERFORMING: 'success',
  TYPICAL: 'secondary',
  UNDERPERFORMING: 'warning',
  INSUFFICIENT_DATA: 'outline',
};

export default async function YouTubePerformancePage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;
  const o = state.overview;
  const benchmarks = await youtube.getRecentVideoBenchmarks(org.id, 50);

  return (
    <div className="space-y-6">
      {benchmarks.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Video benchmark</CardTitle>
            <CardDescription>
              Each video compared to the median of its own format (Shorts vs. long-form) among your{' '}
              {benchmarks.length} most recent videos — never a global YouTube average. Outperforming
              is ≥1.5× the peer median; underperforming is ≤0.5×.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {benchmarks.slice(0, 10).map((b) => (
              <div
                key={b.videoId}
                className="border-border flex items-center justify-between gap-3 border-b pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{b.title}</p>
                  <p className="text-muted-foreground text-xs">
                    {fullNumber(b.views)} views · {b.format === 'short' ? 'Short' : 'Long-form'}
                    {b.ratioToPeerMedian != null
                      ? ` · ${b.ratioToPeerMedian.toFixed(2)}× peer median`
                      : ''}
                  </p>
                </div>
                <Badge variant={CLASSIFICATION_VARIANT[b.classification] ?? 'outline'}>
                  {CLASSIFICATION_LABEL[b.classification] ?? b.classification}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Video catalogue</CardTitle>
          <CardDescription>
            Derived from lifetime public stats on {fullNumber(o.counts.videosSynced)} synced videos
            (calculated metrics — not from the Analytics API).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Stat label="Median views / video" value={compactNumber(o.performers.medianViews)} />
          <Stat
            label="High performers"
            value={fullNumber(o.performers.high)}
            hint="≥ 1.5× median views"
          />
          <Stat
            label="Underperformers"
            value={fullNumber(o.performers.low)}
            hint="≤ 0.5× median views"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Publishing cadence</CardTitle>
          <CardDescription>Across the synced date range.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Stat label="Uploads / week" value={o.cadence.videosPerWeek.toFixed(2)} />
          <Stat
            label="Median gap"
            value={
              o.cadence.medianGapDays != null ? `${o.cadence.medianGapDays.toFixed(1)} d` : '—'
            }
          />
          <Stat
            label="Longest gap"
            value={
              o.cadence.longestGapDays != null ? `${Math.round(o.cadence.longestGapDays)} d` : '—'
            }
          />
        </CardContent>
      </Card>

      {o.hasAnalytics ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent trend</CardTitle>
            <CardDescription>Last 28 days vs the previous 28 (Analytics API).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Stat label="Views (28d)" value={fullNumber(o.windows.last28d?.views ?? null)} />
            <Stat
              label="Watch hours (28d)"
              value={fullNumber(o.windows.last28d?.watchHours ?? null)}
            />
            <Stat
              label="Net subs (28d)"
              value={fullNumber(o.windows.last28d?.netSubscribers ?? null)}
              hint="see the Growth tab for the daily series"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Analytics not available</CardTitle>
            <CardDescription>
              View-over-time, impressions, and CTR come from the Analytics API. Sync analytics to
              populate this section. If the API returns no rows for a new or small channel, that is
              reported here rather than estimated.
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
