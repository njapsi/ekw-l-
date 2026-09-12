import type { Metadata } from 'next';
import Link from 'next/link';
import { youtube } from '@growth-agent/services';
import { Card, CardContent, EmptyState } from '@growth-agent/ui';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { compactNumber, relDate } from '@/lib/format';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Videos' };

export default async function YouTubeVideosPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; sort?: string }>;
}) {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const sp = await searchParams;
  const sort = sp.sort === 'views' ? 'views' : 'recent';
  const { videos, nextCursor } = await youtube.listVideosPage(org.id, { cursor: sp.cursor, sort });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-sm">
        <Link
          href="/app/youtube/videos"
          className={sort === 'recent' ? 'font-medium underline' : 'text-muted-foreground'}
        >
          Most recent
        </Link>
        <span className="text-muted-foreground">·</span>
        <Link
          href="/app/youtube/videos?sort=views"
          className={sort === 'views' ? 'font-medium underline' : 'text-muted-foreground'}
        >
          Most viewed
        </Link>
      </div>

      {videos.length === 0 ? (
        <EmptyState title="No videos synced yet" description="Run a sync from the Overview tab." />
      ) : (
        <Card>
          <CardContent className="divide-border divide-y p-0">
            {videos.map((v) => (
              <div key={v.id} className="flex items-center gap-4 p-4">
                {v.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnailUrl} alt="" className="h-12 w-20 rounded object-cover" />
                ) : (
                  <div className="bg-muted h-12 w-20 shrink-0 rounded" />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={`https://www.youtube.com/watch?v=${v.videoId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="line-clamp-1 text-sm font-medium hover:underline"
                  >
                    {v.title}
                  </a>
                  <p className="text-muted-foreground text-xs">
                    {relDate(v.publishedAt)} · {compactNumber(v.viewCount)} views ·{' '}
                    {compactNumber(v.likeCount)} likes · {compactNumber(v.commentCount)} comments
                    {v.engagementRatePct != null ? ` · ${v.engagementRatePct}% engagement` : ''}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {nextCursor ? (
        <Link
          href={`/app/youtube/videos?${new URLSearchParams({ sort, cursor: nextCursor })}`}
          className="text-sm underline"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
