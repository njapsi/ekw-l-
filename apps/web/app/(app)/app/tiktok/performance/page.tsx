import type { Metadata } from 'next';
import { tiktok } from '@growth-agent/services';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, fullNumber } from '@/lib/format';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Performance' };

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

export default async function TikTokPerformancePage() {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;
  const o = state.overview;
  const benchmarks = await tiktok.getRecentVideoBenchmarks(org.id, 50);

  return (
    <div className="space-y-6">
      {benchmarks.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Video benchmark</CardTitle>
            <CardDescription>
              Each video compared to the median of its own duration bucket (short ≤60s vs. extended
              &gt;60s) among your {benchmarks.length} most recent videos — never a global TikTok
              average. Outperforming is ≥1.5× the peer median; underperforming is ≤0.5×.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {benchmarks.slice(0, 10).map((b) => (
              <div
                key={b.videoId}
                className="border-border flex items-center justify-between gap-3 border-b pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{b.caption ?? b.videoId}</p>
                  <p className="text-muted-foreground text-xs">
                    {fullNumber(b.views)} views ·{' '}
                    {b.format === 'short' ? 'Short (≤60s)' : 'Extended (>60s)'}
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
            Calculated from lifetime per-video stats on {fullNumber(o.counts.videosSynced)} synced
            videos. TikTok’s public API has no day-by-day analytics, so there is no time-series here
            — that is a real limitation, not missing data.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Stat label="Median views / video" value={compactNumber(o.performers.medianViews)} />
          <Stat
            label="High performers"
            value={fullNumber(o.performers.high)}
            hint="≥ 1.5× median"
          />
          <Stat label="Underperformers" value={fullNumber(o.performers.low)} hint="≤ 0.5× median" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Posting cadence</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Stat label="Posts / week" value={o.cadence.postsPerWeek.toFixed(2)} />
          <Stat
            label="Median gap"
            value={
              o.cadence.medianGapDays != null ? `${o.cadence.medianGapDays.toFixed(1)} d` : '—'
            }
          />
          <Stat
            label="Range"
            value={
              o.cadence.firstAt && o.cadence.lastAt
                ? `${o.cadence.firstAt.toISOString().slice(0, 10)} → ${o.cadence.lastAt
                    .toISOString()
                    .slice(0, 10)}`
                : '—'
            }
          />
        </CardContent>
      </Card>
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
