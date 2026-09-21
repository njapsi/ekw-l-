/**
 * The capability registry for the Growth Agent orchestrator (master instruction
 * "ORCHESTRATION" / "AGENT EXECUTION"). Each capability is a thin, tenant-scoped
 * wrapper over a specialized agent or analysis that already exists
 * (`@growth-agent/services/{youtube,tiktok,seo}`). The orchestrator selects a
 * subset, runs them, and collects their evidence + recommendations.
 *
 * A capability never gets a raw model or DB beyond its context; it degrades
 * gracefully (`skipped` / `needs_prerequisite`) rather than throwing when a
 * prerequisite (a connected account, a completed crawl, an AI key) is missing.
 */
import type { AIProvider } from '@growth-agent/ai';
import type { Db } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import * as seo from '../seo/index.js';
import * as youtube from '../youtube/index.js';
import * as tiktok from '../tiktok/index.js';
import { assessMonetization } from '../youtube/monetization.js';
import type { OrgContext } from './context.js';
import { connectionFacts } from './integration-tools.js';
import type { CapabilityId, EvidenceItem } from './schemas.js';
import { executeAgentTool } from './tool-executor.js';

const log = createLogger('agent.capabilities');

export type AgentModel = Pick<AIProvider, 'generateObject'>;

export interface CapabilityContext {
  organizationId: string;
  userId: string;
  db: Db;
  model?: AgentModel;
  /** The user's message this turn — passed to capabilities that answer questions. */
  message: string;
  orgContext: OrgContext;
  goals: string[];
  /** The current turn's `AgentRun` id, so a capability that dispatches through
   * `executeAgentTool` (Phase 6, Part 62) attaches its tool events to this
   * turn's durable timeline instead of running standalone. */
  agentRunId?: string;
}

export interface CapabilityRecommendation {
  title: string;
  problem: string;
  whyItMatters: string;
  howToFix: string;
  expectedBenefit: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  difficulty: 'trivial' | 'small' | 'medium' | 'large';
  confidence: number;
  domain: 'SEO' | 'YOUTUBE' | 'TIKTOK' | 'CONTENT' | 'GROWTH';
  affectedUrls: string[];
  affectedRefs: string[];
}

export interface CapabilityResult {
  capabilityId: CapabilityId;
  status: 'ok' | 'skipped' | 'needs_prerequisite' | 'error';
  summary: string;
  evidence: Array<{ statement: string; kind: EvidenceItem['kind'] }>;
  recommendations: CapabilityRecommendation[];
  note?: string;
  agentRunId?: string;
}

export interface Capability {
  id: CapabilityId;
  title: string;
  description: string;
  /** Lowercase keywords the deterministic router matches against the message. */
  keywords: string[];
  run(ctx: CapabilityContext): Promise<CapabilityResult>;
}

function fact(statement: string): { statement: string; kind: EvidenceItem['kind'] } {
  return { statement, kind: 'fact' };
}
function metric(statement: string): { statement: string; kind: EvidenceItem['kind'] } {
  return { statement, kind: 'calculated_metric' };
}
function rec(statement: string): { statement: string; kind: EvidenceItem['kind'] } {
  return { statement, kind: 'recommendation' };
}

// --- org-context -----------------------------------------------------

const orgContextCapability: Capability = {
  id: 'org-context',
  title: 'Connected-data snapshot',
  description: 'What the organization has connected and the freshest data available.',
  keywords: [],
  async run(ctx) {
    // What the agent may actually use, per the capability model — so it never
    // reasons as if a disconnected or under-scoped account were available.
    let connections: string[] = [];
    try {
      connections = await connectionFacts(ctx.organizationId, ctx.db);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'connection facts unavailable for org-context',
      );
    }
    return {
      capabilityId: 'org-context',
      status: 'ok',
      summary: 'Snapshot of connected sources and the most recent synced data.',
      evidence: [
        fact(
          ctx.orgContext.youtube.connected
            ? `YouTube connected: "${ctx.orgContext.youtube.channelTitle ?? 'channel'}", ${ctx.orgContext.youtube.subscriberCount ?? 'n/a'} subscribers, analytics ${ctx.orgContext.youtube.hasAnalytics ? 'synced' : 'not synced'}.`
            : 'YouTube is not connected.',
        ),
        fact(
          ctx.orgContext.tiktok.connected
            ? `TikTok connected: "${ctx.orgContext.tiktok.displayName ?? 'account'}", follower stats ${ctx.orgContext.tiktok.hasStats ? 'available' : 'not granted'}.`
            : 'TikTok is not connected.',
        ),
        fact(
          ctx.orgContext.seo.latestCrawl
            ? `Latest SEO crawl: ${ctx.orgContext.seo.latestCrawl.hostname} — ${ctx.orgContext.seo.latestCrawl.pagesCrawled} pages, ${ctx.orgContext.seo.latestCrawl.issuesFound} issues, score ${ctx.orgContext.seo.latestCrawl.overallScore ?? 'n/a'}/100.`
            : `${ctx.orgContext.seo.websites} website(s) registered; no completed crawl yet.`,
        ),
        ...connections.map((c) => fact(`Connection status — ${c}`)),
      ],
      recommendations: [],
    };
  },
};

// --- youtube-analyst -----------------------------------------------

const youtubeAnalystCapability: Capability = {
  id: 'youtube-analyst',
  title: 'YouTube Analyst Agent',
  description:
    'Channel momentum, titles/descriptions/topics, publishing cadence, videos to remake.',
  keywords: [
    'youtube',
    'channel',
    'video',
    'videos',
    'subscriber',
    'views',
    'watch time',
    'remake',
    'thumbnail',
    'title',
    'momentum',
    'post this week',
  ],
  async run(ctx) {
    if (!ctx.orgContext.youtube.connected) {
      return needsPrereq(
        'youtube-analyst',
        'YouTube analysis',
        'Connect a YouTube channel from /app/integrations/youtube and run a sync.',
      );
    }
    const channel = await youtube.getPrimaryChannel(ctx.organizationId, ctx.db);
    if (!channel) {
      return needsPrereq(
        'youtube-analyst',
        'YouTube analysis',
        'Sync your YouTube channel so there is data to analyze.',
      );
    }
    const overview = await youtube.getChannelOverview(ctx.organizationId, ctx.db);

    if (ctx.model) {
      try {
        const res = await youtube.runYouTubeAnalyst(
          { db: ctx.db, model: ctx.model },
          { organizationId: ctx.organizationId, channelId: channel.id, trigger: 'growth-agent' },
        );
        return {
          capabilityId: 'youtube-analyst',
          status: 'ok',
          summary: res.analysis.dataCoverage,
          agentRunId: res.agentRunId,
          evidence: [
            metric(
              `Channel "${channel.title}": ${overview?.counts.videosSynced ?? 0} videos synced, analytics ${overview?.hasAnalytics ? 'available' : 'unavailable'}.`,
            ),
            ...res.analysis.findings.slice(0, 5).map((f) => rec(`${f.title}: ${f.detail}`)),
          ],
          recommendations: res.analysis.recommendations.slice(0, 6).map((r) => ({
            title: r.title,
            problem: r.title,
            whyItMatters: r.reasoning,
            howToFix: r.suggestedAction,
            expectedBenefit: r.expectedImpact,
            priority: mapPriority(r.priority),
            difficulty: mapEffort(r.effort),
            confidence: r.confidence,
            domain: 'YOUTUBE',
            affectedUrls: [],
            affectedRefs: [channel.channelId],
          })),
        };
      } catch (e) {
        log.warn({ err: String(e) }, 'youtube analyst failed; falling back to stored data');
      }
    }

    // No model (or it failed): use the latest persisted analysis + recommendations.
    const [latest, storedRecs] = await Promise.all([
      youtube.latestAnalystRun(ctx.organizationId, ctx.db),
      youtube.listYouTubeRecommendations(ctx.organizationId, ctx.db),
    ]);
    const analysis = latest?.output as {
      dataCoverage?: string;
      findings?: Array<{ title: string; detail: string }>;
    } | null;
    return {
      capabilityId: 'youtube-analyst',
      status: 'ok',
      summary: analysis?.dataCoverage
        ? `From the most recent YouTube analysis: ${analysis.dataCoverage}`
        : `Channel "${channel.title}" has ${overview?.counts.videosSynced ?? 0} videos synced. Run the YouTube Analyst (needs an AI key) for a full analysis.`,
      evidence: [
        metric(
          `Channel "${channel.title}": ${overview?.counts.videosSynced ?? 0} videos synced, analytics ${overview?.hasAnalytics ? 'available' : 'unavailable'}.`,
        ),
        ...(analysis?.findings ?? []).slice(0, 5).map((f) => rec(`${f.title}: ${f.detail}`)),
      ],
      recommendations: storedRecs.slice(0, 6).map((r) => ({
        title: r.title,
        problem: r.title,
        whyItMatters: r.reasoning,
        howToFix: r.implementationInstructions,
        expectedBenefit: r.expectedImpact,
        priority: mapPriority(r.priority),
        difficulty: mapEffort(r.effort),
        confidence: r.confidence,
        domain: 'YOUTUBE',
        affectedUrls: [],
        affectedRefs: r.subjectRef ? [r.subjectRef] : [],
      })),
    };
  },
};

// --- youtube-monetization ----------------------------------------

const youtubeMonetizationCapability: Capability = {
  id: 'youtube-monetization',
  title: 'YouTube monetization readiness',
  description:
    'Partner Program requirements, watch hours, and ways to earn more from the existing audience.',
  keywords: [
    'money',
    'monetize',
    'monetization',
    'revenue',
    'earn',
    'rpm',
    'cpm',
    'partner program',
    'ypp',
    'sponsorship',
    'make more money',
    'income',
  ],
  async run(ctx) {
    if (!ctx.orgContext.youtube.connected) {
      return needsPrereq(
        'youtube-monetization',
        'Monetization readiness',
        'Connect a YouTube channel to assess monetization readiness.',
      );
    }
    const channel = await youtube.getPrimaryChannel(ctx.organizationId, ctx.db);
    if (!channel)
      return needsPrereq(
        'youtube-monetization',
        'Monetization readiness',
        'Sync your YouTube channel first.',
      );

    const daily = await ctx.db.youTubeMetric.findMany({
      where: {
        organizationId: ctx.organizationId,
        subjectType: 'CHANNEL',
        subjectId: channel.channelId,
      },
      orderBy: { date: 'asc' },
    });
    const assessment = assessMonetization({
      subscriberCount: channel.subscriberCount,
      hiddenSubscriberCount: channel.hiddenSubscriberCount,
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
      analyticsSyncedThrough: channel.lastAnalyticsSyncAt,
    });

    const est = assessment.estimate;
    const recs: CapabilityRecommendation[] = [];
    for (const unmet of est.unmetThresholds) {
      recs.push({
        title: `Work toward: ${unmet}`,
        problem: `A YouTube Partner Program threshold is not yet met: ${unmet}.`,
        whyItMatters:
          'The Partner Program has hard eligibility thresholds; until they are met the channel cannot be accepted for ad revenue.',
        howToFix:
          'Focus publishing on formats that have historically earned the most watch time for this channel, and keep a consistent cadence. Track progress in YouTube Studio → Earn.',
        expectedBenefit:
          'Progress toward Partner Program eligibility. This is never a guarantee of acceptance or of revenue.',
        priority: 'medium',
        difficulty: 'large',
        confidence: est.confidence,
        domain: 'YOUTUBE',
        affectedUrls: [],
        affectedRefs: [channel.channelId],
      });
    }
    for (const unverified of est.unverified) {
      recs.push({
        title: `Confirm: ${unverified}`,
        problem: `This eligibility item cannot be read from the API and has not been confirmed: ${unverified}.`,
        whyItMatters: 'An unconfirmed requirement can silently block Partner Program acceptance.',
        howToFix:
          'Verify it in YouTube Studio → Settings / Earn, then record it in the Monetization page.',
        expectedBenefit: 'Removes an unknown from the eligibility picture.',
        priority: 'low',
        difficulty: 'trivial',
        confidence: 0.9,
        domain: 'YOUTUBE',
        affectedUrls: [],
        affectedRefs: [channel.channelId],
      });
    }
    recs.push({
      title: 'Diversify earnings beyond ad revenue',
      problem:
        'The question asks how to make more money from the existing audience, not only via the Partner Program.',
      whyItMatters:
        'Ad revenue depends on eligibility and RPM you do not control; audience-direct income (memberships, a product, sponsorships, an email list) is less gated.',
      howToFix:
        'Pick one audience-direct channel to test this quarter — channel memberships, a low-price digital product, or a sponsor outreach list built from your top videos — and add a single clear call to action to your most-viewed videos.',
      expectedBenefit:
        'A revenue stream that is not gated by Partner Program status. Not a guarantee of income.',
      priority: 'medium',
      difficulty: 'medium',
      confidence: 0.55,
      domain: 'YOUTUBE',
      affectedUrls: [],
      affectedRefs: [channel.channelId],
    });

    return {
      capabilityId: 'youtube-monetization',
      status: 'ok',
      summary: est.summary,
      evidence: [
        ...assessment.apiData.map((d) => ({
          statement: `${d.label}: ${
            d.status === 'available'
              ? (d.value ?? d.detail ?? 'available')
              : `unavailable${d.detail ? ` — ${d.detail}` : ''}`
          }`,
          kind: d.kind,
        })),
        ...est.metThresholds.map((t) => fact(`Met: ${t}`)),
        ...est.unmetThresholds.map((t) => fact(`Not yet met: ${t}`)),
        { statement: est.disclaimer, kind: 'prediction' as const },
      ],
      recommendations: recs.slice(0, 6),
    };
  },
};

// --- youtube-growth ------------------------------------------------

/**
 * The one capability that dispatches through Phase 4/5's Tool
 * Registry/Policy Engine/Tool Executor (`executeAgentTool`) rather than
 * calling a `youtube/*` function directly — Phase 6, Part 62's explicit
 * mandate to route new YouTube functionality through the existing
 * architecture instead of bypassing it. `youtube-analyst` and
 * `youtube-monetization` above are untouched (Part 122: backward
 * compatibility) — this is new surface area, not a replacement.
 */
const youtubeGrowthCapability: Capability = {
  id: 'youtube-growth',
  title: 'YouTube content opportunities & patterns',
  description:
    "Benchmarks recent videos against the channel's own history, detects content patterns, and surfaces evidence-backed content opportunities with a documented priority score.",
  keywords: [
    'opportunity',
    'opportunities',
    'content idea',
    'content pattern',
    'content calendar',
    'benchmark',
    'outperform',
    'underperform',
    'compare videos',
    'what should i post',
    'experiment',
  ],
  async run(ctx) {
    if (!ctx.orgContext.youtube.connected) {
      return needsPrereq(
        'youtube-growth',
        'YouTube content opportunities',
        'Connect a YouTube channel from /app/integrations/youtube and run a sync.',
      );
    }
    const toolCtx = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      db: ctx.db,
      agentRunId: ctx.agentRunId,
    };
    const [performanceEnv, patternsEnv, opportunitiesEnv] = await Promise.all([
      executeAgentTool(toolCtx, 'youtube.content.performance', { limit: 50 }),
      executeAgentTool(toolCtx, 'youtube.content.patterns', { limit: 50 }),
      executeAgentTool(toolCtx, 'youtube.content.opportunities', { regenerate: true }),
    ]);

    if (
      performanceEnv.status !== 'SUCCESS' &&
      patternsEnv.status !== 'SUCCESS' &&
      opportunitiesEnv.status !== 'SUCCESS'
    ) {
      const reason =
        opportunitiesEnv.error?.message ??
        performanceEnv.error?.message ??
        'No YouTube data is available yet to analyze.';
      return needsPrereq('youtube-growth', 'YouTube content opportunities', reason);
    }

    const benchmarks =
      performanceEnv.status === 'SUCCESS'
        ? ((performanceEnv.data as { benchmarks: youtube.VideoBenchmark[] }).benchmarks ?? [])
        : [];
    const patterns =
      patternsEnv.status === 'SUCCESS'
        ? ((patternsEnv.data as { patterns: youtube.ContentPattern[] }).patterns ?? [])
        : [];
    const opportunities =
      opportunitiesEnv.status === 'SUCCESS'
        ? ((opportunitiesEnv.data as { opportunities: Array<Record<string, unknown>> })
            .opportunities ?? [])
        : [];

    const outperforming = benchmarks.filter((b) => b.classification === 'OUTPERFORMING').length;
    const underperforming = benchmarks.filter((b) => b.classification === 'UNDERPERFORMING').length;

    const evidence = [
      metric(
        `${benchmarks.length} recent video(s) benchmarked against this channel's own comparable-format history: ${outperforming} outperforming, ${underperforming} underperforming.`,
      ),
      ...patterns.slice(0, 4).map((p) => rec(`${p.label}: ${p.observation}`)),
    ];

    const recs: CapabilityRecommendation[] = opportunities.slice(0, 6).map((o) => ({
      title: typeof o.title === 'string' ? o.title : 'Content opportunity',
      problem: typeof o.description === 'string' ? o.description : '',
      whyItMatters: Array.isArray(o.evidence)
        ? (o.evidence as Array<{ statement?: string }>)
            .map((e) => e.statement)
            .filter(Boolean)
            .join(' ')
        : '',
      howToFix: Array.isArray(o.recommendedActions)
        ? (o.recommendedActions as string[]).join(' ')
        : 'Review this opportunity in /app/youtube/opportunities.',
      expectedBenefit:
        "A content opportunity backed by this channel's own history — not a virality prediction or a guarantee.",
      priority:
        Number(o.priorityScore ?? 0) >= 0.7
          ? 'high'
          : Number(o.priorityScore ?? 0) >= 0.4
            ? 'medium'
            : 'low',
      difficulty: 'medium',
      confidence: o.confidence === 'HIGH' ? 0.85 : o.confidence === 'MEDIUM' ? 0.6 : 0.35,
      domain: 'YOUTUBE',
      affectedUrls: [],
      affectedRefs: Array.isArray(o.relatedVideoIds) ? (o.relatedVideoIds as string[]) : [],
    }));

    return {
      capabilityId: 'youtube-growth',
      status: 'ok',
      summary:
        opportunities.length > 0
          ? `${opportunities.length} content opportunit${opportunities.length === 1 ? 'y' : 'ies'} identified from this channel's own performance history, ranked by priority score.`
          : 'No content opportunities identified yet from the currently synced videos.',
      evidence,
      recommendations: recs,
    };
  },
};

// --- tiktok-analyst --------------------------------------------

const tiktokAnalystCapability: Capability = {
  id: 'tiktok-analyst',
  title: 'TikTok Analyst Agent',
  description: 'TikTok content ideas, caption/hashtag patterns, posting cadence, repurposing.',
  keywords: ['tiktok', 'short', 'shorts', 'reel', 'clip'],
  async run(ctx) {
    if (!ctx.orgContext.tiktok.connected) {
      return needsPrereq(
        'tiktok-analyst',
        'TikTok analysis',
        'Connect a TikTok account from /app/integrations/tiktok and run a sync.',
      );
    }
    const account = await tiktok.getPrimaryAccount(ctx.organizationId, ctx.db);
    if (!account)
      return needsPrereq('tiktok-analyst', 'TikTok analysis', 'Sync your TikTok account first.');

    if (ctx.model) {
      try {
        const res = await tiktok.runTikTokAnalyst(
          { db: ctx.db, model: ctx.model },
          { organizationId: ctx.organizationId, accountId: account.id, trigger: 'growth-agent' },
        );
        return {
          capabilityId: 'tiktok-analyst',
          status: 'ok',
          summary: res.analysis.dataCoverage,
          agentRunId: res.agentRunId,
          evidence: res.analysis.observations
            .slice(0, 5)
            .map((o) => rec(`${o.title}: ${o.detail}`)),
          recommendations: res.analysis.recommendations.slice(0, 6).map((r) => ({
            title: r.title,
            problem: r.title,
            whyItMatters: r.reasoning,
            howToFix: r.suggestedAction,
            expectedBenefit: r.expectedImpact,
            priority: mapPriority(r.priority),
            difficulty: mapEffort(r.effort),
            confidence: r.confidence,
            domain: 'TIKTOK',
            affectedUrls: [],
            affectedRefs: [account.openId],
          })),
        };
      } catch (e) {
        log.warn({ err: String(e) }, 'tiktok analyst failed; falling back to stored data');
      }
    }

    const storedRecs = await tiktok.listRecommendations(ctx.organizationId, ctx.db);
    return {
      capabilityId: 'tiktok-analyst',
      status: 'ok',
      summary: `TikTok account "${account.displayName ?? account.openId}" is synced. Run the TikTok Analyst (needs an AI key) for a full analysis.`,
      evidence: [
        fact(
          `TikTok account "${account.displayName ?? account.openId}" synced; follower stats ${ctx.orgContext.tiktok.hasStats ? 'available' : 'not granted'}.`,
        ),
      ],
      recommendations: storedRecs.slice(0, 6).map((r) => ({
        title: r.title,
        problem: r.title,
        whyItMatters: r.reasoning,
        howToFix: r.implementationInstructions,
        expectedBenefit: r.expectedImpact,
        priority: mapPriority(r.priority),
        difficulty: mapEffort(r.effort),
        confidence: r.confidence,
        domain: 'TIKTOK',
        affectedUrls: [],
        affectedRefs: r.subjectRef ? [r.subjectRef] : [],
      })),
    };
  },
};

// --- seo-agent ------------------------------------------------

const seoAgentCapability: Capability = {
  id: 'seo-agent',
  title: 'AI SEO Agent',
  description: 'Technical SEO problems, priorities, which pages to fix first, machine readability.',
  keywords: [
    'seo',
    'website',
    'site',
    'crawl',
    'canonical',
    'sitemap',
    'robots',
    'index',
    'indexable',
    'orphan',
    'technical seo',
    'page',
    'pages',
    'schema',
    'structured data',
  ],
  async run(ctx) {
    const latest = ctx.orgContext.seo.latestCrawl;
    if (!latest) {
      return needsPrereq(
        'seo-agent',
        'SEO analysis',
        ctx.orgContext.seo.websites === 0
          ? 'Add a website at /app/seo and run a crawl.'
          : 'Run a crawl on one of your websites so there is data to analyze.',
      );
    }
    const res = await seo.runSeoAgent(
      { db: ctx.db, model: ctx.model },
      {
        organizationId: ctx.organizationId,
        crawlId: latest.crawlId,
        question: ctx.message,
        goals: ctx.goals,
        trigger: 'growth-agent',
      },
    );
    const r = res.report;
    return {
      capabilityId: 'seo-agent',
      status: 'ok',
      summary: r.executiveSummary,
      agentRunId: res.agentRunId,
      evidence: [
        metric(
          `Crawl of ${r.hostname}: ${r.overview.pagesCrawled} pages, ${r.overview.totalIssues} issues, overall score ${r.overview.overallScore ?? 'n/a'}/100.`,
        ),
        metric(`Machine readability: ${r.aiReadability.overallScore}/100.`),
        ...(res.answer ? [rec(`Answer to "${ctx.message}": ${res.answer}`)] : []),
      ],
      recommendations: r.recommendations.slice(0, 8).map((rr) => ({
        title: rr.title,
        problem: rr.problem,
        whyItMatters: rr.whyItMatters,
        howToFix: rr.howToFix,
        expectedBenefit: rr.expectedBenefit,
        priority: rr.priority,
        difficulty: rr.difficulty,
        confidence: rr.confidence,
        domain: 'SEO',
        affectedUrls: rr.affectedPages,
        affectedRefs: [latest.websiteId],
      })),
    };
  },
};

// --- content-repurpose --------------------------------------

const contentRepurposeCapability: Capability = {
  id: 'content-repurpose',
  title: 'Content repurposing',
  description: 'Turn a YouTube video into a TikTok / short-form brief.',
  keywords: [
    'repurpose',
    'turn my youtube',
    'into tiktok',
    'into a short',
    'shorts from',
    'clip',
    'cross-post',
    'cross post',
    'adapt',
  ],
  async run(ctx) {
    if (!ctx.orgContext.youtube.connected) {
      return needsPrereq(
        'content-repurpose',
        'Repurposing',
        'Connect and sync a YouTube channel so there are videos to repurpose.',
      );
    }
    const page = await youtube.listVideosPage(
      ctx.organizationId,
      { limit: 5, sort: 'views' },
      ctx.db,
    );
    if (page.videos.length === 0) {
      return needsPrereq('content-repurpose', 'Repurposing', 'Sync your YouTube videos first.');
    }
    const top = page.videos[0]!;
    const recs: CapabilityRecommendation[] = page.videos.slice(0, 3).map((v) => ({
      title: `Repurpose "${v.title.slice(0, 70)}" as short-form`,
      problem: 'A well-performing long-form video is not being reused on short-form platforms.',
      whyItMatters:
        'Short-form clips reach a different audience surface and reuse work you have already done; the long-form video validates that the topic resonates.',
      howToFix: [
        `Pull 2–3 self-contained 20–45s moments from "${v.title.slice(0, 70)}" (the hook, the single most surprising point, the payoff).`,
        'Reframe to 9:16, add on-screen captions, and open with the conclusion in the first 2 seconds.',
        'Write a first-person caption and 3–5 specific hashtags; end with a question to prompt comments.',
        'Post natively (do not just link) and keep a consistent posting slot.',
      ].join(' '),
      expectedBenefit:
        'A new distribution surface for proven content. This is a reach/experiment play, not a guaranteed view count.',
      priority: 'medium',
      difficulty: 'small',
      confidence: 0.6,
      domain: 'CONTENT',
      affectedUrls: [],
      affectedRefs: [v.videoId],
    }));
    return {
      capabilityId: 'content-repurpose',
      status: 'ok',
      summary: `Your top synced video is "${top.title}" (${top.viewCount ?? 'n/a'} views). It is the best candidate to adapt into short-form.`,
      evidence: [
        metric(
          `Top video by views: "${top.title}" — ${top.viewCount ?? 'n/a'} views, ${top.durationSeconds ?? 'n/a'}s.`,
        ),
      ],
      recommendations: recs,
    };
  },
};

// --- growth-plan ------------------------------------------

const growthPlanCapability: Capability = {
  id: 'growth-plan',
  title: 'Cross-surface growth plan',
  description:
    'A time-boxed plan that sequences the highest-value work across YouTube, TikTok and SEO.',
  keywords: [
    'plan',
    '30-day',
    '30 day',
    'growth plan',
    'roadmap',
    'this month',
    'next 30 days',
    'quarter',
    'strategy',
  ],
  async run(ctx) {
    const recs = await ctx.db.recommendation.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 40,
    });
    if (recs.length === 0) {
      return {
        capabilityId: 'growth-plan',
        status: 'ok',
        summary:
          'There are no stored recommendations yet to sequence into a plan. Run the YouTube / TikTok / SEO analyses first, then ask again.',
        evidence: [fact('No recommendations have been generated for this organization yet.')],
        recommendations: [],
      };
    }
    const rank = (p: string) => ({ critical: 0, high: 1, medium: 2, low: 3 })[p] ?? 2;
    const sorted = [...recs].sort(
      (a, b) =>
        (b.priorityScore ?? 0) - (a.priorityScore ?? 0) || rank(a.priority) - rank(b.priority),
    );
    const weeks: string[][] = [[], [], [], []];
    sorted.forEach((r, i) => {
      const easy = r.effort === 'trivial' || r.effort === 'small';
      const wk =
        easy && i < 12 ? Math.min(1, Math.floor(i / 6)) : Math.min(3, 1 + Math.floor(i / 8));
      weeks[wk]!.push(`[${r.domain}] ${r.title}`);
    });
    return {
      capabilityId: 'growth-plan',
      status: 'ok',
      summary: `A 4-week plan sequencing ${sorted.length} stored recommendation(s): quick wins first, larger projects later.`,
      evidence: weeks.flatMap((items, i) =>
        items.length ? [rec(`Week ${i + 1}: ${items.slice(0, 6).join('; ')}`)] : [],
      ),
      recommendations: sorted.slice(0, 8).map((r) => ({
        title: r.title,
        problem: r.title,
        whyItMatters: r.explanation,
        howToFix: r.implementationInstructions,
        expectedBenefit: r.expectedImpact,
        priority: mapPriority(r.priority),
        difficulty: mapEffort(r.effort),
        confidence: r.confidence,
        domain: r.domain,
        affectedUrls: [],
        affectedRefs: r.subjectRef ? [r.subjectRef] : [],
      })),
    };
  },
};

// --- helpers -------------------------------------------------

function needsPrereq(id: CapabilityId, label: string, how: string): CapabilityResult {
  return {
    capabilityId: id,
    status: 'needs_prerequisite',
    summary: `${label} is unavailable: ${how}`,
    evidence: [],
    recommendations: [],
    note: how,
  };
}

function mapPriority(p: string): CapabilityRecommendation['priority'] {
  const s = p.toLowerCase();
  if (s.startsWith('crit')) return 'critical';
  if (s.startsWith('hi')) return 'high';
  if (s.startsWith('lo')) return 'low';
  return 'medium';
}
function mapEffort(e: string): CapabilityRecommendation['difficulty'] {
  const s = e.toLowerCase();
  if (s.startsWith('triv')) return 'trivial';
  if (s.startsWith('sm') || s === 'low') return 'small';
  if (s.startsWith('la') || s === 'high') return 'large';
  return 'medium';
}

export const CAPABILITIES: Capability[] = [
  orgContextCapability,
  youtubeAnalystCapability,
  youtubeMonetizationCapability,
  youtubeGrowthCapability,
  tiktokAnalystCapability,
  seoAgentCapability,
  contentRepurposeCapability,
  growthPlanCapability,
];

export const CAPABILITY_BY_ID = new Map<CapabilityId, Capability>(
  CAPABILITIES.map((c) => [c.id, c]),
);

export function describeCapabilities(): Array<{ id: string; title: string; description: string }> {
  return CAPABILITIES.map((c) => ({ id: c.id, title: c.title, description: c.description }));
}
