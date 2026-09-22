/**
 * Per-type fact gathering. Each gatherer reads from the existing module read
 * functions (never a raw model), tolerates missing data (returns
 * `connected: false` + `dataGaps`), and never invents a number.
 */
import { type Db, prisma } from '@growth-agent/db';
import * as monetization from '../monetization/read.js';
import * as seoRead from '../seo/read.js';
import * as tiktokRead from '../tiktok/read.js';
import * as youtubeRead from '../youtube/read.js';
import { listYouTubeOpportunities } from '../youtube/opportunities.js';
import { listExperiments } from '../youtube/experiments.js';
import { listTikTokOpportunities } from '../tiktok/opportunities.js';
import { listExperiments as listTikTokExperiments } from '../tiktok/experiments.js';
import {
  FactSheet,
  fmtCompact,
  fmtInt,
  fmtScore,
  isOpenRec,
  priorityToSeverity,
  recFromRow,
  toNum,
} from './common.js';
import {
  type GatheredReport,
  emptyGathered,
  type MetricInput,
  type ReportTypeKey,
} from './schemas.js';

export interface GatherOptions {
  websiteId?: string;
  crawlId?: string;
}

export async function gatherFacts(
  type: ReportTypeKey,
  organizationId: string,
  opts: GatherOptions,
  db: Db = prisma,
): Promise<GatheredReport> {
  switch (type) {
    case 'YOUTUBE':
      return gatherYouTube(organizationId, db);
    case 'TIKTOK':
      return gatherTikTok(organizationId, db);
    case 'SEO':
      return gatherSeo(organizationId, opts, db);
    case 'WEBSITE_HEALTH':
      return gatherWebsiteHealth(organizationId, opts, db);
    case 'AI_RECOMMENDATIONS':
      return gatherAiRecommendations(organizationId, db);
    case 'GROWTH':
      return gatherGrowth(organizationId, db);
    case 'MONETIZATION':
      return gatherMonetization(organizationId, db);
    default: {
      const _x: never = type;
      throw new Error(`unknown report type ${String(_x)}`);
    }
  }
}

// --- YouTube ----------------------------------------------------------

async function gatherYouTube(orgId: string, db: Db): Promise<GatheredReport> {
  const [overview, recs] = await Promise.all([
    youtubeRead.getChannelOverview(orgId, db),
    youtubeRead.listYouTubeRecommendations(orgId, db),
  ]);
  if (!overview) {
    const g = emptyGathered('your YouTube channel');
    g.dataGaps.push('No YouTube channel is connected or synced.');
    return g;
  }
  const fs = new FactSheet();
  const g = emptyGathered(overview.channel.title || 'your YouTube channel');
  g.connected = true;
  g.subjectRef = overview.channel.channelId;
  g.dataThrough = overview.channel.lastAnalyticsSyncAt ?? overview.channel.lastSyncedAt ?? null;

  const metrics: MetricInput[] = [
    metric(
      'Subscribers',
      overview.channel.subscriberCount,
      fmtCompact(overview.channel.subscriberCount),
    ),
    metric('Total views', overview.channel.viewCount, fmtCompact(overview.channel.viewCount)),
    metric('Videos', overview.channel.videoCount, fmtInt(overview.channel.videoCount)),
  ];
  fs.push(
    `YouTube channel "${overview.channel.title}" has ${fmtInt(overview.channel.subscriberCount)} subscribers, ${fmtInt(overview.channel.viewCount)} total views and ${fmtInt(overview.channel.videoCount)} videos.`,
  );

  if (overview.windows.last28d) {
    const w = overview.windows.last28d;
    metrics.push(
      metric('Views (28d)', w.views, fmtInt(w.views)),
      metric('Watch hours (28d)', w.watchHours, fmtInt(w.watchHours)),
      metric('Net subscribers (28d)', w.netSubscribers, fmtInt(w.netSubscribers)),
    );
    fs.push(
      `In the last 28 days: ${fmtInt(w.views)} views, ${fmtInt(w.watchHours)} watch hours, ${fmtInt(w.netSubscribers)} net subscribers.`,
    );
  } else {
    g.dataGaps.push('YouTube Analytics has not been synced — 28-day performance is unavailable.');
    g.problems.push({
      id: 'yt-no-analytics',
      title: 'Analytics not synced',
      detail:
        'Channel statistics are available but the Analytics API data has not been synced, so trends and watch-time cannot be reported.',
      severity: 'medium',
      evidence: [],
    });
  }

  metrics.push(
    metric('High performers', overview.performers.high, fmtInt(overview.performers.high)),
    metric('Low performers', overview.performers.low, fmtInt(overview.performers.low)),
  );
  if (overview.cadence?.medianGapDays != null) {
    metrics.push(
      metric(
        'Median days between uploads',
        overview.cadence.medianGapDays,
        fmtInt(overview.cadence.medianGapDays),
      ),
    );
    fs.push(`Median gap between uploads is about ${fmtInt(overview.cadence.medianGapDays)} days.`);
  }

  const [opportunities, experiments] = await Promise.all([
    listYouTubeOpportunities(orgId, { status: 'SUGGESTED' }, db),
    listExperiments(orgId, {}, db),
  ]);
  if (opportunities.length > 0) {
    metrics.push(
      metric('Open content opportunities', opportunities.length, fmtInt(opportunities.length)),
    );
    fs.push(
      `${opportunities.length} open content opportunit${opportunities.length === 1 ? 'y' : 'ies'} identified, top-ranked: "${opportunities[0]!.title}" (priority score ${opportunities[0]!.priorityScore.toFixed(2)}).`,
    );
    for (const o of opportunities.slice(0, 5)) {
      g.opportunities.push({
        id: `yt-opp-${o.id}`,
        title: o.title,
        detail: o.description,
        potential: o.confidence,
        effort: o.executionFeasibility >= 0.7 ? 'small' : 'medium',
      });
    }
  }
  const completedExperiments = experiments.filter((e) => e.status === 'COMPLETED');
  if (completedExperiments.length > 0) {
    const supported = completedExperiments.filter((e) => e.conclusion === 'SUPPORTED').length;
    metrics.push(
      metric(
        'Completed experiments',
        completedExperiments.length,
        fmtInt(completedExperiments.length),
      ),
    );
    fs.push(
      `${completedExperiments.length} experiment(s) completed; ${supported} supported the hypothesis, matching this channel's own before/after data.`,
    );
  }
  const runningExperiments = experiments.filter((e) => e.status === 'RUNNING').length;
  if (runningExperiments > 0) {
    fs.push(`${runningExperiments} experiment(s) currently running.`);
  }

  g.metrics = metrics;
  applyRecommendations(g, recs, fs, 'YouTube');
  g.disclaimers.push('Performance figures are historical; they are not a forecast.');
  g.facts = fs.all();
  return g;
}

// --- TikTok -----------------------------------------------------------

async function gatherTikTok(orgId: string, db: Db): Promise<GatheredReport> {
  const [overview, recs] = await Promise.all([
    tiktokRead.getAccountOverview(orgId, db),
    tiktokRead.listRecommendations(orgId, db),
  ]);
  if (!overview) {
    const g = emptyGathered('your TikTok account');
    g.dataGaps.push('No TikTok account is connected or synced.');
    return g;
  }
  const fs = new FactSheet();
  const g = emptyGathered(
    overview.account.displayName || overview.account.username || 'your TikTok account',
  );
  g.connected = true;
  g.subjectRef = overview.account.openId;
  g.dataThrough = overview.account.lastSyncedAt ?? null;

  const metrics: MetricInput[] = [
    metric('Followers', overview.account.followerCount, fmtCompact(overview.account.followerCount)),
    metric('Total likes', overview.account.likesCount, fmtCompact(overview.account.likesCount)),
    metric('Videos synced', overview.counts.videosSynced, fmtInt(overview.counts.videosSynced)),
    metric('High performers', overview.performers.high, fmtInt(overview.performers.high)),
    metric('Low performers', overview.performers.low, fmtInt(overview.performers.low)),
  ];
  fs.push(
    `TikTok account "${g.subjectLabel}" has ${fmtInt(overview.account.followerCount)} followers, ${fmtInt(overview.account.likesCount)} total likes and ${fmtInt(overview.counts.videosSynced)} synced videos.`,
  );
  if (overview.cadence?.medianGapDays != null) {
    metrics.push(
      metric(
        'Median days between posts',
        overview.cadence.medianGapDays,
        fmtInt(overview.cadence.medianGapDays),
      ),
    );
  }
  if (overview.themes.length > 0) {
    metrics.push(metric('Content themes', overview.themes.length, fmtInt(overview.themes.length)));
    g.opportunities.push({
      id: 'tt-themes',
      title: `Double down on your strongest theme (#${overview.themes[0]?.tag ?? 'n/a'})`,
      detail: `Your top theme "#${overview.themes[0]?.tag}" spans ${overview.themes[0]?.videos ?? 0} videos with ${fmtInt(overview.themes[0]?.totalViews)} total views.`,
      effort: 'small',
    });
    fs.push(
      `Top content theme is "#${overview.themes[0]?.tag}" with ${fmtInt(overview.themes[0]?.totalViews)} total views across ${overview.themes[0]?.videos ?? 0} videos.`,
    );
  }
  if (overview.account.followerCount == null) {
    g.dataGaps.push('TikTok did not grant follower/stats scope — audience size is unavailable.');
  }

  const [opportunities, experiments] = await Promise.all([
    listTikTokOpportunities(orgId, { status: 'SUGGESTED' }, db),
    listTikTokExperiments(orgId, {}, db),
  ]);
  if (opportunities.length > 0) {
    metrics.push(
      metric('Open content opportunities', opportunities.length, fmtInt(opportunities.length)),
    );
    fs.push(
      `${opportunities.length} open content opportunit${opportunities.length === 1 ? 'y' : 'ies'} identified, top-ranked: "${opportunities[0]!.title}" (priority score ${opportunities[0]!.priorityScore.toFixed(2)}).`,
    );
    for (const o of opportunities.slice(0, 5)) {
      g.opportunities.push({
        id: `tt-opp-${o.id}`,
        title: o.title,
        detail: o.description,
        potential: o.confidence,
        effort: o.executionFeasibility >= 0.7 ? 'small' : 'medium',
      });
    }
  }
  const completedExperiments = experiments.filter((e) => e.status === 'COMPLETED');
  if (completedExperiments.length > 0) {
    const supported = completedExperiments.filter((e) => e.conclusion === 'SUPPORTED').length;
    metrics.push(
      metric(
        'Completed experiments',
        completedExperiments.length,
        fmtInt(completedExperiments.length),
      ),
    );
    fs.push(
      `${completedExperiments.length} experiment(s) completed; ${supported} supported the hypothesis, matching this account's own before/after data.`,
    );
  }
  const runningExperiments = experiments.filter((e) => e.status === 'RUNNING').length;
  if (runningExperiments > 0) {
    fs.push(`${runningExperiments} experiment(s) currently running.`);
  }

  g.metrics = metrics;
  applyRecommendations(g, recs, fs, 'TikTok');
  g.disclaimers.push('TikTok exposes limited historical data; figures reflect the latest sync.');
  g.facts = fs.all();
  return g;
}

// --- SEO (AI SEO Agent view) ---------------------------------------

async function gatherSeo(orgId: string, opts: GatherOptions, db: Db): Promise<GatheredReport> {
  const site = await resolveWebsite(orgId, opts, db);
  if (!site) {
    const g = emptyGathered('your website');
    g.dataGaps.push('No verified website with a completed crawl was found.');
    return g;
  }
  const fs = new FactSheet();
  const g = emptyGathered(site.hostname);
  g.connected = true;
  g.subjectRef = site.id;
  g.dataThrough = site.latestCrawl?.createdAt ?? null;

  const [ranked, agentReport, issuePage] = await Promise.all([
    seoRead.listRankedSeoRecommendations(orgId, site.id, db),
    seoRead.latestSeoAgentReport(orgId, site.id, db),
    site.latestCrawl
      ? seoRead.listCrawlIssues(orgId, site.latestCrawl.id, { limit: 10 }, db)
      : Promise.resolve({
          issues: [] as Array<Record<string, unknown>>,
          nextCursor: null,
          total: 0,
        }),
  ]);

  const metrics: MetricInput[] = [];
  if (site.latestCrawl?.overallScore != null) {
    metrics.push(
      metric(
        'Overall SEO score',
        site.latestCrawl.overallScore,
        fmtScore(site.latestCrawl.overallScore),
      ),
    );
    fs.push(
      `Overall SEO score for ${site.hostname} is ${fmtScore(site.latestCrawl.overallScore)}.`,
    );
  }
  metrics.push(
    metric(
      'Pages crawled',
      site.latestCrawl?.pagesCrawled ?? null,
      fmtInt(site.latestCrawl?.pagesCrawled),
    ),
    metric(
      'Issues found',
      site.latestCrawl?.issuesFound ?? null,
      fmtInt(site.latestCrawl?.issuesFound),
    ),
    metric('Ranked recommendations', ranked.length, fmtInt(ranked.length)),
  );
  fs.push(
    `The latest crawl covered ${fmtInt(site.latestCrawl?.pagesCrawled)} pages and found ${fmtInt(site.latestCrawl?.issuesFound)} issues; ${ranked.length} ranked recommendations are open.`,
  );

  const quickWins = ranked.filter((r) => r.actionPlan === 'quick_win').length;
  if (quickWins > 0) {
    metrics.push(metric('Quick wins', quickWins, fmtInt(quickWins)));
    g.opportunities.push({
      id: 'seo-quick-wins',
      title: `${quickWins} quick win${quickWins === 1 ? '' : 's'} available`,
      detail:
        'Low-effort, high-confidence fixes the AI SEO Agent flagged as "quick win" in its action plan.',
      effort: 'small',
    });
  }

  for (const issue of issuePage.issues.slice(0, 6)) {
    const sev = String((issue as { severity?: string }).severity ?? 'MEDIUM').toLowerCase();
    g.problems.push({
      id: `seo-issue-${String((issue as { id?: string }).id ?? Math.random())}`,
      title: String((issue as { code?: string }).code ?? 'Issue'),
      detail: String(
        (issue as { recommendedFix?: string; explanation?: string }).recommendedFix ??
          (issue as { explanation?: string }).explanation ??
          'See the crawl issue detail.',
      ),
      severity: (['critical', 'high', 'medium', 'low', 'info'].includes(sev)
        ? sev
        : 'medium') as never,
      evidence: [
        `Affected URLs: ${fmtInt((issue as { affectedUrlCount?: number }).affectedUrlCount ?? 0)}`,
      ],
    });
  }

  g.metrics = metrics;
  applyRecommendations(
    g,
    ranked.length ? ranked : await seoRead.listSeoRecommendations(orgId, db),
    fs,
    'SEO',
  );
  if (agentReport)
    fs.push(
      'An AI SEO Agent report is available with action plans and a machine-readability score.',
    );
  g.disclaimers.push(
    'SEO scores are diagnostic, not a ranking prediction. No tool can guarantee search rankings.',
  );
  g.facts = fs.all();
  return g;
}

// --- Website Health (technical crawl) ------------------------------

async function gatherWebsiteHealth(
  orgId: string,
  opts: GatherOptions,
  db: Db,
): Promise<GatheredReport> {
  const site = await resolveWebsite(orgId, opts, db);
  if (!site?.latestCrawl) {
    const g = emptyGathered('your website');
    g.dataGaps.push('No completed crawl was found. Add and verify a website, then run a crawl.');
    return g;
  }
  const overview = await seoRead.getCrawlOverview(orgId, site.latestCrawl.id, db);
  if (!overview) {
    const g = emptyGathered(site.hostname);
    g.dataGaps.push('The crawl could not be loaded.');
    return g;
  }
  const fs = new FactSheet();
  const g = emptyGathered(site.hostname);
  g.connected = true;
  g.subjectRef = site.id;
  g.dataThrough = overview.crawl.finishedAt ?? overview.crawl.createdAt ?? null;

  const scores = overview.crawl.scores as {
    overall?: number;
    grade?: string;
    categories?: Array<{ category: string; score: number }>;
  } | null;
  const summary = overview.crawl.summary as Record<string, number> | null;
  const metrics: MetricInput[] = [];
  if (scores?.overall != null) {
    metrics.push(
      metric(
        'Overall score',
        scores.overall,
        `${fmtScore(scores.overall)}${scores.grade ? ` (${scores.grade})` : ''}`,
      ),
    );
    fs.push(
      `Website health score is ${fmtScore(scores.overall)}${scores.grade ? `, grade ${scores.grade}` : ''}.`,
    );
  }
  metrics.push(
    metric('Pages crawled', overview.crawl.pagesCrawled, fmtInt(overview.crawl.pagesCrawled)),
    metric('Total issues', overview.issues.total, fmtInt(overview.issues.total)),
  );
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
    const n = overview.issues.bySeverity[sev] ?? 0;
    if (n > 0) metrics.push(metric(`${sev[0]}${sev.slice(1).toLowerCase()} issues`, n, fmtInt(n)));
  }
  fs.push(
    `The crawl found ${fmtInt(overview.issues.total)} issues: ${(
      ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
    )
      .map((s) => `${overview.issues.bySeverity[s] ?? 0} ${s.toLowerCase()}`)
      .join(', ')}.`,
  );
  if (summary) {
    if (summary.orphanPages != null)
      metrics.push(metric('Orphan pages', summary.orphanPages, fmtInt(summary.orphanPages)));
    if (summary.brokenInternalLinks != null)
      metrics.push(
        metric(
          'Broken internal links',
          summary.brokenInternalLinks,
          fmtInt(summary.brokenInternalLinks),
        ),
      );
    if (summary.nonIndexablePages != null)
      metrics.push(
        metric('Non-indexable pages', summary.nonIndexablePages, fmtInt(summary.nonIndexablePages)),
      );
    const orphans = summary.orphanPages ?? 0;
    if (orphans > 0)
      g.opportunities.push({
        id: 'wh-orphans',
        title: `Link ${fmtInt(orphans)} orphan page${orphans === 1 ? '' : 's'}`,
        detail:
          'Pages with no internal links pointing to them are hard for crawlers and users to reach.',
        effort: 'small',
      });
  }

  const issuePage = await seoRead.listCrawlIssues(orgId, site.latestCrawl.id, { limit: 10 }, db);
  for (const issue of issuePage.issues.slice(0, 8)) {
    const sev = String((issue as { severity?: string }).severity ?? 'MEDIUM').toLowerCase();
    g.problems.push({
      id: `wh-issue-${String((issue as { id?: string }).id ?? Math.random())}`,
      title: String((issue as { code?: string }).code ?? 'Issue'),
      detail: String(
        (issue as { recommendedFix?: string }).recommendedFix ??
          (issue as { explanation?: string }).explanation ??
          'See the crawl issue detail.',
      ),
      severity: (['critical', 'high', 'medium', 'low', 'info'].includes(sev)
        ? sev
        : 'medium') as never,
      evidence: [`Category: ${String((issue as { category?: string }).category ?? 'n/a')}`],
    });
  }

  g.metrics = metrics;
  applyRecommendations(g, await seoRead.listSeoRecommendations(orgId, db), fs, 'SEO');
  g.disclaimers.push(
    'Scores are diagnostic. Fixing issues improves crawlability, not guaranteed rankings.',
  );
  g.facts = fs.all();
  return g;
}

// --- AI Recommendations (all surfaces) ----------------------------

async function gatherAiRecommendations(orgId: string, db: Db): Promise<GatheredReport> {
  const rows = await db.recommendation.findMany({
    where: { organizationId: orgId },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    take: 300,
  });
  const open = rows.filter((r) => isOpenRec(r.status));
  const fs = new FactSheet();
  const g = emptyGathered('your organization');
  g.connected = rows.length > 0;
  if (!g.connected) {
    g.dataGaps.push('No recommendations have been generated yet — run an analysis first.');
    return g;
  }
  g.dataThrough = rows[0]?.updatedAt ?? rows[0]?.createdAt ?? null;

  const byPriority: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  for (const r of open) {
    byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
  }
  const metrics: MetricInput[] = [
    metric('Open recommendations', open.length, fmtInt(open.length)),
    metric('Critical', byPriority.critical ?? 0, fmtInt(byPriority.critical ?? 0)),
    metric('High', byPriority.high ?? 0, fmtInt(byPriority.high ?? 0)),
    metric(
      'Approved, not applied',
      rows.filter((r) => r.status === 'APPROVED').length,
      fmtInt(rows.filter((r) => r.status === 'APPROVED').length),
    ),
    metric('Domains covered', Object.keys(byDomain).length, fmtInt(Object.keys(byDomain).length)),
  ];
  fs.push(
    `${open.length} recommendations are open across ${Object.keys(byDomain).length} domain(s): ${Object.entries(
      byDomain,
    )
      .map(([d, n]) => `${d.toLowerCase()} ${n}`)
      .join(', ')}.`,
  );
  fs.push(
    `By priority: ${byPriority.critical ?? 0} critical, ${byPriority.high ?? 0} high, ${byPriority.medium ?? 0} medium, ${byPriority.low ?? 0} low.`,
  );

  g.metrics = metrics;
  const recs = open.map((r) => recFromRow(r as never));
  g.recommendations = recs;
  for (const r of recs
    .filter((x) => x.priority === 'critical' || x.priority === 'high')
    .slice(0, 8)) {
    g.problems.push({
      id: `air-${r.id}`,
      title: r.title,
      detail: r.why,
      severity: priorityToSeverity(r.priority),
      evidence: [],
    });
  }
  g.disclaimers.push(
    'Recommendations are prioritized estimates; apply human judgement before acting.',
  );
  g.facts = fs.all();
  return g;
}

// --- Growth (cross-surface) --------------------------------------

async function gatherGrowth(orgId: string, db: Db): Promise<GatheredReport> {
  const [yt, tt, sites, dash, recRows] = await Promise.all([
    youtubeRead.getChannelOverview(orgId, db).catch(() => null),
    tiktokRead.getAccountOverview(orgId, db).catch(() => null),
    seoRead
      .listWebsites(orgId, db)
      .catch(() => [] as Awaited<ReturnType<typeof seoRead.listWebsites>>),
    monetization.getMonetizationDashboard(orgId, db).catch(() => null),
    db.recommendation.findMany({
      where: { organizationId: orgId },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    }),
  ]);
  const fs = new FactSheet();
  const g = emptyGathered('your organization');
  const connectedSurfaces =
    (yt ? 1 : 0) + (tt ? 1 : 0) + (sites.some((s) => s.latestCrawl) ? 1 : 0);
  g.connected =
    connectedSurfaces > 0 || Boolean(dash && (dash.current.length || dash.potential.length));
  if (!g.connected) {
    g.dataGaps.push('No platform is connected and no analysis has run yet.');
    return g;
  }

  const openRecs = recRows.filter((r) => isOpenRec(r.status));
  const audiences: number[] = [];
  if (yt?.channel.subscriberCount) audiences.push(Number(yt.channel.subscriberCount));
  if (tt?.account.followerCount) audiences.push(Number(tt.account.followerCount));
  const largestAudience = audiences.length ? Math.max(...audiences) : null;

  const metrics: MetricInput[] = [
    metric('Connected surfaces', connectedSurfaces, `${connectedSurfaces} of 3`),
    metric(
      'Largest audience',
      largestAudience,
      largestAudience == null ? '—' : fmtCompact(largestAudience),
    ),
    metric('Open recommendations', openRecs.length, fmtInt(openRecs.length)),
  ];
  if (dash) {
    metrics.push(
      metric('Monetization: active', dash.current.length, fmtInt(dash.current.length)),
      metric('Monetization: potential', dash.potential.length, fmtInt(dash.potential.length)),
    );
    for (const opp of dash.potential.slice(0, 4)) {
      g.opportunities.push({
        id: `growth-opp-${opp.id}`,
        title: opp.title,
        detail: opp.description,
        potential: `${opp.potential} (estimate)`,
        effort: opp.difficulty,
      });
    }
  }
  if (yt?.windows.last28d) {
    metrics.push(
      metric('YouTube views (28d)', yt.windows.last28d.views, fmtInt(yt.windows.last28d.views)),
    );
  }
  fs.push(
    `${connectedSurfaces} of 3 growth surfaces are connected (YouTube ${yt ? 'yes' : 'no'}, TikTok ${tt ? 'yes' : 'no'}, SEO crawl ${sites.some((s) => s.latestCrawl) ? 'yes' : 'no'}).`,
  );
  if (largestAudience != null)
    fs.push(`Largest connected audience is about ${fmtInt(largestAudience)}.`);
  fs.push(`${openRecs.length} recommendations are open across all surfaces.`);
  if (dash)
    fs.push(
      `Monetization: ${dash.current.length} active, ${dash.potential.length} potential opportunities.`,
    );

  g.metrics = metrics;
  applyRecommendations(g, openRecs, fs, 'growth');
  g.disclaimers.push(
    'This summary aggregates other analyses; see the per-surface reports for detail.',
  );
  g.dataThrough = new Date();
  g.facts = fs.all();
  return g;
}

// --- Monetization -----------------------------------------------

async function gatherMonetization(orgId: string, db: Db): Promise<GatheredReport> {
  const dash = await monetization.getMonetizationDashboard(orgId, db).catch(() => null);
  const fs = new FactSheet();
  const g = emptyGathered('your organization');
  if (
    !dash ||
    (dash.current.length === 0 && dash.potential.length === 0 && !dash.revenue.summary.hasData)
  ) {
    g.dataGaps.push('No monetization scan has run and no revenue has been entered.');
    return g;
  }
  g.connected = true;
  g.dataThrough = dash.lastScanAt ?? null;

  const metrics: MetricInput[] = [
    metric('Active opportunities', dash.current.length, fmtInt(dash.current.length)),
    metric('Potential opportunities', dash.potential.length, fmtInt(dash.potential.length)),
    metric('Completed', dash.completed.length, fmtInt(dash.completed.length)),
    metric(
      'Recommended actions',
      dash.recommendedActions.length,
      fmtInt(dash.recommendedActions.length),
    ),
    metric('Revenue entries', dash.revenue.entries.length, fmtInt(dash.revenue.entries.length)),
  ];
  const cur = Object.entries(dash.revenue.summary.byCurrency ?? {});
  if (cur.length) {
    metrics.push({
      key: 'revenue-total',
      label: 'Recorded revenue',
      value: cur
        .map(([c, v]) => `${new Intl.NumberFormat('en').format(Number(v))} ${c}`)
        .join(' + '),
      raw: cur.length === 1 ? Number(cur[0]?.[1]) : null,
      note: 'User-entered only; the engine never invents revenue.',
    });
  }
  fs.push(
    `Monetization: ${dash.current.length} active, ${dash.potential.length} potential, ${dash.completed.length} completed opportunities; ${dash.revenue.entries.length} user-entered revenue entries.`,
  );
  if (dash.lastScanOverview) fs.push(`Latest scan overview: ${dash.lastScanOverview}`);

  for (const opp of dash.potential.slice(0, 6)) {
    g.opportunities.push({
      id: `mon-${opp.id}`,
      title: opp.title,
      detail: opp.description,
      potential: `${opp.potential} (labelled estimate)`,
      effort: opp.difficulty,
    });
  }
  for (const opp of dash.current.slice(0, 6)) {
    g.recommendations.push({
      id: `mon-rec-${opp.id}`,
      title: `Advance: ${opp.title}`,
      why: opp.description,
      actions: opp.requiredActions.length ? opp.requiredActions : ['Review this opportunity.'],
      priority: opp.priorityScore != null && opp.priorityScore >= 65 ? 'high' : 'medium',
      effort: opp.difficulty === 'low' ? 'small' : opp.difficulty === 'high' ? 'large' : 'medium',
      confidence: typeof opp.confidence === 'number' ? opp.confidence : 0.5,
      expectedImpact: `${opp.potential} potential (labelled estimate, not a revenue figure).`,
    });
  }

  g.metrics = metrics;
  g.disclaimers.push(
    'Potential is a labelled estimate, never a dollar amount. Platform-program eligibility is decided by the platform, not this tool. Revenue shown is user-entered only.',
  );
  g.facts = fs.all();
  return g;
}

// --- shared helpers -------------------------------------------------

function metric(label: string, raw: unknown, value: string): MetricInput {
  return { key: label, label, value, raw: toNum(raw) };
}

interface RecLike {
  id: string;
  title: string;
  status?: string | null;
  priority?: string | null;
}

function applyRecommendations(
  g: GatheredReport,
  rows: RecLike[],
  fs: FactSheet,
  domainLabel: string,
): void {
  const open = rows.filter((r) => isOpenRec(r.status));
  g.recommendations = open.map((r) => recFromRow(r as never));
  fs.push(`${open.length} open ${domainLabel} recommendation(s).`);
  for (const r of g.recommendations
    .filter((x) => x.priority === 'critical' || x.priority === 'high')
    .slice(0, 6)) {
    g.problems.push({
      id: `rec-${r.id}`,
      title: r.title,
      detail: r.why,
      severity: priorityToSeverity(r.priority),
      evidence: [],
    });
  }
}

async function resolveWebsite(
  orgId: string,
  opts: GatherOptions,
  db: Db,
): Promise<
  | (Awaited<ReturnType<typeof seoRead.listWebsites>>[number] & {
      latestCrawl: NonNullable<
        Awaited<ReturnType<typeof seoRead.listWebsites>>[number]['latestCrawl']
      > | null;
    })
  | null
> {
  const sites = await seoRead.listWebsites(orgId, db);
  if (sites.length === 0) return null;
  if (opts.websiteId) {
    return sites.find((s) => s.id === opts.websiteId) ?? null;
  }
  // Prefer a verified site with a completed crawl; else the newest with any crawl.
  const withCrawl = sites.filter((s) => s.latestCrawl && s.latestCrawl.status === 'COMPLETED');
  return withCrawl[0] ?? sites.find((s) => s.latestCrawl) ?? sites[0] ?? null;
}
