import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, fullNumber } from '@/lib/format';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Performance' };

export default async function TikTokPerformancePage() {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;
  const o = state.overview;

  return (
    <div className="space-y-6">
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
