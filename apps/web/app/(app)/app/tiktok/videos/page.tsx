import type { Metadata } from 'next';
import Link from 'next/link';
import { tiktok } from '@growth-agent/services';
import { Card, CardContent, EmptyState } from '@growth-agent/ui';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, relDate } from '@/lib/format';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Video library' };

export default async function TikTokVideosPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; sort?: string }>;
}) {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;

  const sp = await searchParams;
  const sort = sp.sort === 'views' ? 'views' : 'recent';
  const { videos, nextCursor } = await tiktok.listVideosPage(org.id, { cursor: sp.cursor, sort });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-sm">
        <Link
          href="/app/tiktok/videos"
          className={sort === 'recent' ? 'font-medium underline' : 'text-muted-foreground'}
        >
          Most recent
        </Link>
        <span className="text-muted-foreground">·</span>
        <Link
          href="/app/tiktok/videos?sort=views"
          className={sort === 'views' ? 'font-medium underline' : 'text-muted-foreground'}
        >
          Most viewed
        </Link>
      </div>

      {videos.length === 0 ? (
        <EmptyState title="No videos synced yet" />
      ) : (
        <Card>
          <CardContent className="divide-border divide-y p-0">
            {videos.map((v) => (
              <div key={v.id} className="flex items-center gap-4 p-4">
                {v.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.coverImageUrl} alt="" className="h-16 w-12 rounded object-cover" />
                ) : (
                  <div className="bg-muted h-16 w-12 shrink-0 rounded" />
                )}
                <div className="min-w-0 flex-1">
                  {v.shareUrl ? (
                    <a
                      href={v.shareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="line-clamp-2 text-sm hover:underline"
                    >
                      {v.caption ?? '(no caption)'}
                    </a>
                  ) : (
                    <p className="line-clamp-2 text-sm">{v.caption ?? '(no caption)'}</p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    {relDate(v.createTime)} · {compactNumber(v.viewCount)} views ·{' '}
                    {compactNumber(v.likeCount)} likes · {compactNumber(v.commentCount)} comments ·{' '}
                    {compactNumber(v.shareCount)} shares
                    {v.engagementRatePct != null ? ` · ${v.engagementRatePct}% engagement` : ''}
                  </p>
                  {v.hashtags.length ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {v.hashtags.map((h) => `#${h}`).join(' ')}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {nextCursor ? (
        <Link
          href={`/app/tiktok/videos?${new URLSearchParams({ sort, cursor: nextCursor })}`}
          className="text-sm underline"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
