import type { Metadata } from 'next';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { TikTokSyncButton } from '@/components/app/tiktok/tiktok-actions';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, fullNumber, relDate } from '@/lib/format';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Account overview' };

export default async function TikTokOverviewPage() {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;

  const { overview: o, connection } = state;
  const statsAvailable = connection.hasStats;

  const stats = [
    {
      label: 'Followers',
      value: statsAvailable ? compactNumber(o.account.followerCount) : 'Not available',
      hint: statsAvailable
        ? fullNumber(o.account.followerCount)
        : 'user.info.stats scope not granted',
    },
    {
      label: 'Total likes',
      value: statsAvailable ? compactNumber(o.account.likesCount) : 'Not available',
      hint: statsAvailable ? fullNumber(o.account.likesCount) : 'user.info.stats scope not granted',
    },
    {
      label: 'Videos (API stat)',
      value: statsAvailable ? compactNumber(o.account.videoCountStat) : 'Not available',
      hint: `${o.counts.videosSynced} synced`,
    },
    {
      label: 'Videos synced',
      value: fullNumber(o.counts.videosSynced),
      hint: `synced ${relDate(o.account.lastVideoSyncAt)}`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {o.account.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.account.avatarUrl} alt="" className="size-10 rounded-full" />
          ) : null}
          <div>
            <p className="font-medium">
              {o.account.displayName ?? o.account.username ?? o.account.openId}
              {o.account.isVerified ? <Badge className="ml-2">verified</Badge> : null}
            </p>
            <p className="text-muted-foreground text-xs">
              {o.account.username ? `@${o.account.username}` : o.account.openId} · synced{' '}
              {relDate(o.account.lastSyncedAt)}
            </p>
          </div>
        </div>
        <TikTokSyncButton>Sync now</TikTokSyncButton>
      </div>

      {!statsAvailable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Follower & like totals unavailable</CardTitle>
            <CardDescription>
              This connection was not granted the{' '}
              <code className="font-mono text-xs">user.info.stats</code> scope, so the API does not
              return follower/like counts. Reconnect and approve it to add them — we do not estimate
              these.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-1">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-2xl">{s.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">{s.hint}</CardContent>
          </Card>
        ))}
      </div>

      {o.themes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hashtag themes</CardTitle>
            <CardDescription>Derived from your synced captions (calculated).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {o.themes.map((t) => (
              <Badge key={t.tag} variant="outline">
                #{t.tag} · {t.videos} videos
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
