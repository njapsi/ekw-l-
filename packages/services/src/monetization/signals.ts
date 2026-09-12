/**
 * The deterministic signal snapshot the opportunity engine reasons over:
 * connected-creator data (YouTube, TikTok, SEO) + the user-provided
 * `BusinessProfile` + a summary of user-entered revenue. No third-party data is
 * inferred without the user's input.
 */
import { type Db, prisma } from '@growth-agent/db';
import { assessMonetization, type MonetizationAssessment } from '../youtube/monetization.js';

export interface MonetizationSignals {
  youtube: {
    connected: boolean;
    channelTitle: string | null;
    subscriberCount: number | null;
    hiddenSubscriberCount: boolean;
    videoCount: number | null;
    viewCount: number | null;
    hasAnalytics: boolean;
    /** Careful YPP-eligibility assessment (official + API + attestations). */
    assessment: MonetizationAssessment | null;
  };
  tiktok: {
    connected: boolean;
    displayName: string | null;
    followerCount: number | null;
    hasStats: boolean;
  };
  seo: {
    websites: number;
    verifiedWebsites: number;
    hasCompletedCrawl: boolean;
  };
  business: {
    profileExists: boolean;
    niche: string | null;
    audienceDescription: string | null;
    offerings: string[];
    goals: string[];
    emailListSize: number | null;
    hasWebsite: boolean;
    sellsProducts: boolean;
    doesSponsorships: boolean;
    doesAffiliates: boolean;
    doesConsulting: boolean;
    hasMembership: boolean;
    hasCourse: boolean;
  };
  revenue: {
    entryCount: number;
    channelsWithRevenue: string[];
    /** Total of the most recent 12 months, in the profile's currency mix. */
    last12moTotalByCurrency: Record<string, number>;
  };
  /** Largest connected audience across platforms (used for the estimate bands). */
  largestAudience: number | null;
}

export async function gatherMonetizationSignals(
  organizationId: string,
  db: Db = prisma,
): Promise<MonetizationSignals> {
  const [ytChannel, ytConn, ttAccount, ttConn, websites, completedCrawl, profile, revenue] =
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
      db.website.findMany({ where: { organizationId }, select: { verified: true } }),
      db.crawl.findFirst({ where: { organizationId, status: 'COMPLETED' }, select: { id: true } }),
      db.businessProfile.findUnique({ where: { organizationId } }),
      db.revenueEntry.findMany({
        where: { organizationId, deletedAt: null },
        select: { channel: true, amount: true, currency: true, periodStart: true },
      }),
    ]);

  const daily = ytChannel
    ? await db.youTubeMetric.findMany({
        where: { organizationId, subjectType: 'CHANNEL', subjectId: ytChannel.channelId },
        orderBy: { date: 'asc' },
      })
    : [];

  const attestations = (profile?.attestations ?? undefined) as
    | Partial<Record<'twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', boolean>>
    | undefined;

  const assessment = ytChannel
    ? assessMonetization({
        subscriberCount: ytChannel.subscriberCount,
        hiddenSubscriberCount: ytChannel.hiddenSubscriberCount,
        daily: daily.length
          ? daily.map((d) => ({
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
        analyticsSyncedThrough: ytChannel.lastAnalyticsSyncAt,
        attestations,
      })
    : null;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const last12moTotalByCurrency: Record<string, number> = {};
  const channelsWithRevenue = new Set<string>();
  for (const r of revenue) {
    channelsWithRevenue.add(r.channel);
    if (r.periodStart >= cutoff) {
      last12moTotalByCurrency[r.currency] =
        (last12moTotalByCurrency[r.currency] ?? 0) + Number(r.amount);
    }
  }

  const ytSubs = ytChannel?.subscriberCount ? Number(ytChannel.subscriberCount) : null;
  const ttFollowers = ttAccount?.followerCount ? Number(ttAccount.followerCount) : null;
  const largestAudience =
    ytSubs != null || ttFollowers != null ? Math.max(ytSubs ?? 0, ttFollowers ?? 0) : null;

  return {
    youtube: {
      connected: Boolean(ytConn && ytConn.status !== 'REVOKED'),
      channelTitle: ytChannel?.title ?? null,
      subscriberCount: ytSubs,
      hiddenSubscriberCount: ytChannel?.hiddenSubscriberCount ?? false,
      videoCount: ytChannel?.videoCount ?? null,
      viewCount: ytChannel?.viewCount ? Number(ytChannel.viewCount) : null,
      hasAnalytics: daily.length > 0,
      assessment,
    },
    tiktok: {
      connected: Boolean(ttConn && ttConn.status !== 'REVOKED'),
      displayName: ttAccount?.displayName ?? ttConn?.displayName ?? null,
      followerCount: ttFollowers,
      hasStats: ttAccount?.followerCount != null,
    },
    seo: {
      websites: websites.length,
      verifiedWebsites: websites.filter((w) => w.verified).length,
      hasCompletedCrawl: Boolean(completedCrawl),
    },
    business: {
      profileExists: Boolean(profile),
      niche: profile?.niche ?? null,
      audienceDescription: profile?.audienceDescription ?? null,
      offerings: profile?.offerings ?? [],
      goals: profile?.goals ?? [],
      emailListSize: profile?.emailListSize ?? null,
      hasWebsite: profile?.hasWebsite ?? websites.length > 0,
      sellsProducts: profile?.sellsProducts ?? false,
      doesSponsorships: profile?.doesSponsorships ?? false,
      doesAffiliates: profile?.doesAffiliates ?? false,
      doesConsulting: profile?.doesConsulting ?? false,
      hasMembership: profile?.hasMembership ?? false,
      hasCourse: profile?.hasCourse ?? false,
    },
    revenue: {
      entryCount: revenue.length,
      channelsWithRevenue: [...channelsWithRevenue],
      last12moTotalByCurrency,
    },
    largestAudience,
  };
}
