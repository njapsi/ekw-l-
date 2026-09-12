import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { youtube } from '@growth-agent/services';
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
} from '@growth-agent/ui';
import { MonetizationAttestations } from '@/components/app/youtube/monetization-attestations';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { getMonetizationAttestations } from '@/server/youtube-actions';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Monetization' };

export default async function YouTubeMonetizationPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const channel = await youtube.getPrimaryChannel(org.id);
  if (!channel)
    return <YouTubeEmpty state={{ kind: 'not_synced', connection: state.connection }} />;

  const dailyRows = await prisma.youTubeMetric.findMany({
    where: { organizationId: org.id, subjectType: 'CHANNEL', subjectId: channel.channelId },
    orderBy: { date: 'asc' },
  });
  const attestations = await getMonetizationAttestations();

  const assessment = youtube.assessMonetization({
    subscriberCount: channel.subscriberCount,
    hiddenSubscriberCount: channel.hiddenSubscriberCount,
    daily: dailyRows.length
      ? dailyRows.map((d) => ({
          date: d.date,
          views: d.views,
          estimatedMinutesWatched: d.estimatedMinutesWatched,
          likes: d.likes,
          comments: d.comments,
          shares: d.shares,
          subscribersGained: d.subscribersGained,
          subscribersLost: d.subscribersLost,
          estimatedRevenue: d.estimatedRevenue ? Number(d.estimatedRevenue) : null,
        }))
      : null,
    analyticsSyncedThrough: channel.lastAnalyticsSyncAt,
    attestations,
  });

  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>How to read this page</AlertTitle>
        <AlertDescription>{assessment.estimate.disclaimer}</AlertDescription>
      </Alert>

      {/* 1. Official */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Official YouTube requirements</CardTitle>
          <CardDescription>Published eligibility criteria (facts, with sources).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            {assessment.official.map((r) => (
              <li key={r.id}>
                <p>{r.requirement}</p>
                <p className="text-muted-foreground text-xs">Source: {r.source}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 2. API data */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. What our synced data shows</CardTitle>
          <CardDescription>
            From the official APIs. Items the API cannot provide are marked unavailable with a way
            to check them yourself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            {assessment.apiData.map((d) => (
              <li key={d.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{d.label}</span>
                  <Badge variant={d.status === 'available' ? 'secondary' : 'outline'}>
                    {d.status === 'available' ? d.kind : 'unavailable'}
                  </Badge>
                  {d.value ? <span className="font-mono">{d.value}</span> : null}
                </div>
                {d.detail ? <p className="text-muted-foreground text-xs">{d.detail}</p> : null}
                {d.howToVerify ? (
                  <p className="text-muted-foreground text-xs">
                    <span className="font-medium">How to verify:</span> {d.howToVerify}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 3. User-provided */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Your attestations</CardTitle>
          <CardDescription>
            Information only you can confirm. Stored as assumptions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MonetizationAttestations initial={attestations} />
        </CardContent>
      </Card>

      {/* 4. Estimate */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Readiness estimate</CardTitle>
          <CardDescription>
            A prediction derived from sections 1–3. Confidence in the estimate:{' '}
            {(assessment.estimate.confidence * 100).toFixed(0)}%.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{assessment.estimate.summary}</p>
          <Group title="Looks met" items={assessment.estimate.metThresholds} tone="ok" />
          <Group title="Appears unmet" items={assessment.estimate.unmetThresholds} tone="bad" />
          <Group
            title="Cannot verify from data"
            items={assessment.estimate.unverified}
            tone="muted"
          />
          <p className="text-muted-foreground text-xs">{assessment.estimate.disclaimer}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Group({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'ok' | 'bad' | 'muted';
}) {
  if (items.length === 0) return null;
  const color =
    tone === 'ok'
      ? 'text-emerald-600'
      : tone === 'bad'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <div>
      <p className={`text-xs font-medium ${color}`}>{title}</p>
      <ul className="text-muted-foreground ml-4 list-disc text-sm">
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
