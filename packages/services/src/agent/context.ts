/**
 * Org context snapshot for the Growth Agent — a read-only summary of what the
 * organization has connected and the freshest data available. Always gathered
 * first so the planner and synthesis are grounded in what actually exists
 * (master instruction: the agent only works from connected data).
 */
import { type Db, prisma } from '@growth-agent/db';

export interface OrgContext {
  youtube: {
    connected: boolean;
    channelTitle: string | null;
    subscriberCount: string | null;
    videoCount: number | null;
    lastSyncedAt: Date | null;
    hasAnalytics: boolean;
  };
  tiktok: {
    connected: boolean;
    displayName: string | null;
    hasStats: boolean;
    lastSyncedAt: Date | null;
  };
  seo: {
    websites: number;
    verifiedWebsites: number;
    latestCrawl: {
      crawlId: string;
      websiteId: string;
      hostname: string;
      status: string;
      pagesCrawled: number;
      issuesFound: number;
      overallScore: number | null;
      finishedAt: Date | null;
    } | null;
  };
  openTasks: number;
  recentRecommendations: number;
}

export async function loadOrgContext(organizationId: string, db: Db = prisma): Promise<OrgContext> {
  const [ytChannel, ytConn, ttAccount, ttConn, websites, latestCrawl, openTasks, recentRecs] =
    await Promise.all([
      db.youTubeChannel.findFirst({
        where: { organizationId },
        orderBy: { subscriberCount: 'desc' },
      }),
      db.oAuthConnection.findFirst({
        where: { organizationId, provider: 'YOUTUBE' },
        orderBy: { createdAt: 'desc' },
      }),
      db.tikTokAccount.findFirst({ where: { organizationId }, orderBy: { followerCount: 'desc' } }),
      db.oAuthConnection.findFirst({
        where: { organizationId, provider: 'TIKTOK' },
        orderBy: { createdAt: 'desc' },
      }),
      db.website.findMany({ where: { organizationId }, select: { id: true, verified: true } }),
      db.crawl.findFirst({
        where: { organizationId, status: 'COMPLETED' },
        orderBy: { finishedAt: 'desc' },
        include: { website: true },
      }),
      db.task.count({
        where: { organizationId, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } },
      }),
      db.recommendation.count({
        where: {
          organizationId,
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
        },
      }),
    ]);

  const ytAnalytics = ytChannel
    ? (await db.youTubeMetric.count({
        where: { organizationId, subjectType: 'CHANNEL', subjectId: ytChannel.channelId },
      })) > 0
    : false;

  const scores = latestCrawl?.scores as { overall?: number } | null;

  return {
    youtube: {
      connected: Boolean(ytConn && ytConn.status !== 'REVOKED'),
      channelTitle: ytChannel?.title ?? null,
      subscriberCount: ytChannel?.subscriberCount ? ytChannel.subscriberCount.toString() : null,
      videoCount: ytChannel?.videoCount ?? null,
      lastSyncedAt: ytChannel?.lastSyncedAt ?? null,
      hasAnalytics: ytAnalytics,
    },
    tiktok: {
      connected: Boolean(ttConn && ttConn.status !== 'REVOKED'),
      displayName: ttAccount?.displayName ?? ttConn?.displayName ?? null,
      hasStats: Boolean(ttAccount?.followerCount != null),
      lastSyncedAt: ttAccount?.lastSyncedAt ?? null,
    },
    seo: {
      websites: websites.length,
      verifiedWebsites: websites.filter((w) => w.verified).length,
      latestCrawl: latestCrawl
        ? {
            crawlId: latestCrawl.id,
            websiteId: latestCrawl.websiteId,
            hostname: latestCrawl.website.hostname,
            status: latestCrawl.status,
            pagesCrawled: latestCrawl.pagesCrawled,
            issuesFound: latestCrawl.issuesFound,
            overallScore: scores?.overall ?? null,
            finishedAt: latestCrawl.finishedAt,
          }
        : null,
    },
    openTasks,
    recentRecommendations: recentRecs,
  };
}

export function summarizeOrgContext(ctx: OrgContext): string {
  const parts: string[] = [];
  parts.push(
    ctx.youtube.connected
      ? `YouTube connected: "${ctx.youtube.channelTitle ?? 'channel'}", ${ctx.youtube.subscriberCount ?? 'n/a'} subscribers, ${ctx.youtube.videoCount ?? 'n/a'} videos, analytics ${ctx.youtube.hasAnalytics ? 'synced' : 'not synced'}.`
      : 'YouTube: not connected.',
  );
  parts.push(
    ctx.tiktok.connected
      ? `TikTok connected: "${ctx.tiktok.displayName ?? 'account'}", follower stats ${ctx.tiktok.hasStats ? 'available' : 'not granted'}.`
      : 'TikTok: not connected.',
  );
  parts.push(
    ctx.seo.latestCrawl
      ? `SEO: ${ctx.seo.verifiedWebsites}/${ctx.seo.websites} verified website(s); latest crawl of ${ctx.seo.latestCrawl.hostname} — ${ctx.seo.latestCrawl.pagesCrawled} pages, ${ctx.seo.latestCrawl.issuesFound} issues, score ${ctx.seo.latestCrawl.overallScore ?? 'n/a'}/100.`
      : `SEO: ${ctx.seo.websites} website(s) registered, no completed crawl yet.`,
  );
  parts.push(
    `${ctx.openTasks} open task(s); ${ctx.recentRecommendations} recommendation(s) in the last 30 days.`,
  );
  return parts.join(' ');
}
