/**
 * YouTube Growth Agent tools (Phase 6, Part 62), dispatched through the
 * Phase 5 Tool Executor exactly like native and research tools — the brief's
 * own explicit mandate not to bypass the Tool Registry / Policy Engine /
 * Orchestrator for this phase. Each tool reuses an existing, already-tested
 * `youtube/*` function; nothing here re-implements sync, analytics parsing,
 * or benchmarking. A capability-backed tool calls the same
 * `assertCapabilityUsable` gate `integration-tools.ts`'s own tools use —
 * one authorization mechanism, not a second one for YouTube.
 *
 * Deliberately NOT implemented as separate tools (Part 62: "Only implement
 * tools supported by actual APIs and existing architecture"):
 *   - `youtube.content.idea.generate` / `.title.generate` /
 *     `.description.generate` / `.script.generate` / `.brief.generate` —
 *     already fully covered by the Content Repurposing engine
 *     (`content/generate.ts`'s 13 deliverable types, including
 *     `YT_TITLE_ALTERNATIVES`/`YT_DESCRIPTION`/`YT_CHAPTERS`/`SCRIPT`/
 *     `HOOK`), which already accepts a synced YouTube video as its source
 *     (`content/ingest.ts`). Adding a second, YouTube-specific generation
 *     path would duplicate existing functionality (hard rule 9).
 *   - Any `VIDEO_CREATE`/`VIDEO_UPDATE`/`VIDEO_PUBLISH`/`VIDEO_DELETE`/
 *     `PLAYLIST_*` write tool — this deployment never requests a write
 *     scope (`integrations/google.ts`), so no such tool could ever
 *     succeed; see `capability-matrix.ts`.
 *   - Separate `youtube.report.weekly.generate` / `.monthly.generate` tools
 *     — the reporting engine's `YOUTUBE` report type has no
 *     weekly-vs-monthly distinction of its own (it always reports "since
 *     the last report"); cadence is an automation-schedule concern, not a
 *     tool-shape concern. One `youtube.report.generate` tool is offered
 *     instead, a disclosed adaptation of the brief's suggested names.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import { generateReportJob } from '../reports/jobs.js';
import { benchmarkVideos, compareVideos } from '../youtube/benchmark.js';
import {
  generateCalendarDrafts,
  saveCalendarEntries,
  type CalendarEntryDraft,
} from '../youtube/calendar.js';
import { createExperiment } from '../youtube/experiments.js';
import { windowTotals, growthDelta, type VideoLike } from '../youtube/metrics.js';
import {
  buildOpportunityDrafts,
  listYouTubeOpportunities,
  upsertOpportunities,
} from '../youtube/opportunities.js';
import { detectContentPatterns } from '../youtube/patterns.js';
import { getChannelOverview, getPrimaryChannel, listVideosPage } from '../youtube/read.js';
import { assertCapabilityUsable, type IntegrationToolContext } from './integration-tools.js';

export const YOUTUBE_TOOL_NAMES = [
  'youtube.channel.get',
  'youtube.channel.analytics',
  'youtube.video.list',
  'youtube.content.performance',
  'youtube.content.compare',
  'youtube.content.patterns',
  'youtube.content.opportunities',
  'youtube.content.calendar.generate',
  'youtube.experiment.create',
  'youtube.report.generate',
] as const;
export type YouTubeToolName = (typeof YOUTUBE_TOOL_NAMES)[number];

interface YouTubeTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: YouTubeToolName;
  description: string;
  input: I;
  kind: 'READ' | 'ANALYZE' | 'GENERATE' | 'CREATE';
  execute(ctx: IntegrationToolContext, input: z.infer<I>): Promise<unknown>;
}

async function requireChannel(ctx: IntegrationToolContext, capabilityId: string) {
  await assertCapabilityUsable(ctx, capabilityId);
  const channel = await getPrimaryChannel(ctx.organizationId, ctx.db);
  if (!channel) {
    throw new AppError(
      'validation_failed',
      'No YouTube channel has been synced yet. Connect YouTube and run a sync first.',
    );
  }
  return channel;
}

async function recentVideos(
  ctx: IntegrationToolContext,
  channelId: string,
  limit: number,
): Promise<VideoLike[]> {
  const rows = await ctx.db.youTubeVideo.findMany({
    where: { youTubeChannelId: channelId },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: {
      videoId: true,
      title: true,
      publishedAt: true,
      durationSeconds: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      tags: true,
    },
  });
  return rows;
}

// --- 1. Channel overview -----------------------------------------------

const channelGet: YouTubeTool<z.ZodObject<Record<string, never>>> = {
  name: 'youtube.channel.get',
  description:
    'The connected YouTube channel: title, subscriber/view/video counts, and last-28-days/last-365-days totals when analytics have been synced.',
  input: z.object({}),
  kind: 'READ',
  async execute(ctx) {
    await assertCapabilityUsable(ctx, 'youtube.get_channel');
    const overview = await getChannelOverview(ctx.organizationId, ctx.db);
    if (!overview) {
      throw new AppError('validation_failed', 'No YouTube channel has been synced yet.');
    }
    return overview;
  },
};

// --- 2. Channel analytics (date-range aware, Part 10) -------------------

const RANGE_DAYS: Record<string, number> = {
  LAST_7_DAYS: 7,
  LAST_28_DAYS: 28,
  LAST_30_DAYS: 30,
  LAST_90_DAYS: 90,
  LAST_365_DAYS: 365,
};
const ChannelAnalyticsInput = z.object({
  range: z
    .enum(['LAST_7_DAYS', 'LAST_28_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'LAST_365_DAYS'])
    .default('LAST_28_DAYS'),
  compareToPrevious: z.boolean().default(false),
});
const channelAnalytics: YouTubeTool<typeof ChannelAnalyticsInput> = {
  name: 'youtube.channel.analytics',
  description:
    "Views, watch time, and net subscribers for a channel-level date range, from synced YouTube Analytics data (Pacific-time reporting days, per YouTube's own boundary — never the viewer's local timezone). Optionally compares to the immediately preceding period of the same length.",
  input: ChannelAnalyticsInput,
  kind: 'READ',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_analytics');
    const days = RANGE_DAYS[input.range] ?? 28;
    const daily = await ctx.db.youTubeMetric.findMany({
      where: {
        organizationId: ctx.organizationId,
        subjectType: 'CHANNEL',
        subjectId: channel.channelId,
      },
      orderBy: { date: 'asc' },
    });
    if (daily.length === 0) {
      return {
        available: false,
        reason: 'Analytics have not been synced for this channel yet.',
      };
    }
    const dl = daily.map((d) => ({
      date: d.date,
      views: d.views,
      estimatedMinutesWatched: d.estimatedMinutesWatched,
      likes: d.likes,
      comments: d.comments,
      shares: d.shares,
      subscribersGained: d.subscribersGained,
      subscribersLost: d.subscribersLost,
      estimatedRevenue: d.estimatedRevenue ? Number(d.estimatedRevenue) : null,
    }));
    const current = windowTotals(dl, days);
    if (!input.compareToPrevious) {
      return { available: true, range: input.range, current };
    }
    const currentAndPrevious = windowTotals(dl, days * 2);
    const previous: typeof current = {
      ...currentAndPrevious,
      views: currentAndPrevious.views - current.views,
      minutesWatched: currentAndPrevious.minutesWatched - current.minutesWatched,
      watchHours: currentAndPrevious.watchHours - current.watchHours,
      netSubscribers: currentAndPrevious.netSubscribers - current.netSubscribers,
      subscribersGained: currentAndPrevious.subscribersGained - current.subscribersGained,
      subscribersLost: currentAndPrevious.subscribersLost - current.subscribersLost,
    };
    return {
      available: true,
      range: input.range,
      current,
      previous,
      delta: growthDelta(current, previous),
    };
  },
};

// --- 3. Video list --------------------------------------------------------

const VideoListInput = z.object({
  limit: z.number().int().min(1).max(50).default(25),
  sort: z.enum(['recent', 'views']).default('recent'),
});
const videoList: YouTubeTool<typeof VideoListInput> = {
  name: 'youtube.video.list',
  description: 'Synced videos for the connected channel, most recent or highest-viewed first.',
  input: VideoListInput,
  kind: 'READ',
  async execute(ctx, input) {
    await assertCapabilityUsable(ctx, 'youtube.get_videos');
    return listVideosPage(ctx.organizationId, { limit: input.limit, sort: input.sort }, ctx.db);
  },
};

// --- 4. Content performance (benchmark) ----------------------------------

const PerformanceInput = z.object({ limit: z.number().int().min(5).max(200).default(50) });
const contentPerformance: YouTubeTool<typeof PerformanceInput> = {
  name: 'youtube.content.performance',
  description:
    "Classifies each of the channel's recent videos as OUTPERFORMING/TYPICAL/UNDERPERFORMING/INSUFFICIENT_DATA against the channel's own comparable-format history (never a global YouTube average) — documented fixed thresholds, not a model guess.",
  input: PerformanceInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_videos');
    const videos = await recentVideos(ctx, channel.id, input.limit);
    return { benchmarks: benchmarkVideos(videos) };
  },
};

// --- 5. Content compare ---------------------------------------------------

const CompareInput = z.object({ videoIds: z.array(z.string().min(1)).min(2).max(20) });
const contentCompare: YouTubeTool<typeof CompareInput> = {
  name: 'youtube.content.compare',
  description: 'Side-by-side benchmark comparison for a specific, caller-chosen set of videos.',
  input: CompareInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    await assertCapabilityUsable(ctx, 'youtube.get_videos');
    const rows = await ctx.db.youTubeVideo.findMany({
      where: { organizationId: ctx.organizationId, videoId: { in: input.videoIds } },
      select: {
        videoId: true,
        title: true,
        publishedAt: true,
        durationSeconds: true,
        viewCount: true,
        likeCount: true,
        commentCount: true,
        tags: true,
      },
    });
    if (rows.length === 0) {
      throw new AppError(
        'validation_failed',
        'None of the requested video ids are synced for this organization.',
      );
    }
    return { comparisons: compareVideos(rows) };
  },
};

// --- 6. Content patterns ---------------------------------------------------

const contentPatterns: YouTubeTool<typeof PerformanceInput> = {
  name: 'youtube.content.patterns',
  description:
    "Topic-cluster and format-split patterns detected across the channel's recent videos, each with concrete evidence — never a causal claim.",
  input: PerformanceInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_videos');
    const videos = await recentVideos(ctx, channel.id, input.limit);
    return { patterns: detectContentPatterns(videos) };
  },
};

// --- 7. Content opportunities ----------------------------------------------

const OpportunitiesInput = z.object({
  regenerate: z.boolean().default(false),
  limit: z.number().int().min(5).max(200).default(50),
});
const contentOpportunities: YouTubeTool<typeof OpportunitiesInput> = {
  name: 'youtube.content.opportunities',
  description:
    'Evidence-backed content opportunities for the channel, each with a documented PRIORITY SCORE (never a virality prediction) — regenerates from the latest synced videos when `regenerate` is true, otherwise returns the last-computed list.',
  input: OpportunitiesInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_videos');
    if (input.regenerate) {
      const videos = await recentVideos(ctx, channel.id, input.limit);
      const drafts = buildOpportunityDrafts(videos);
      await upsertOpportunities(
        { organizationId: ctx.organizationId, youTubeChannelId: channel.id, drafts },
        ctx.db,
      );
    }
    const opportunities = await listYouTubeOpportunities(ctx.organizationId, {}, ctx.db);
    return { opportunities };
  },
};

// --- 8. Content calendar generation -----------------------------------------

const CalendarInput = z.object({
  cadencePerWeek: z.number().int().min(1).max(14).default(2),
  weeks: z.number().int().min(1).max(12).default(4),
  save: z.boolean().default(false),
});
const calendarGenerate: YouTubeTool<typeof CalendarInput> = {
  name: 'youtube.content.calendar.generate',
  description:
    "Builds a content calendar from the channel's current opportunities at the requested cadence. Never schedules a real YouTube publish — a calendar entry is a plan, always starting at status IDEA.",
  input: CalendarInput,
  kind: 'GENERATE',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_videos');
    const opportunities = await listYouTubeOpportunities(
      ctx.organizationId,
      { status: 'SUGGESTED' },
      ctx.db,
    );
    const drafts: CalendarEntryDraft[] = generateCalendarDrafts({
      opportunities: opportunities.map((o) => ({
        type: o.type,
        title: o.title,
        description: o.description,
        evidence: o.evidence as never,
        factors: {
          evidenceStrength: o.evidenceStrength,
          historicalPerformance: o.historicalPerformance,
          contentGap: o.contentGap,
          executionFeasibility: o.executionFeasibility,
        },
        priorityScore: o.priorityScore,
        confidence: o.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
        recommendedActions: o.recommendedActions,
        relatedVideoIds: o.relatedVideoIds,
      })),
      cadencePerWeek: input.cadencePerWeek,
      weeks: input.weeks,
      startDate: new Date(),
    });
    if (input.save) {
      if (!ctx.userId)
        throw new AppError('validation_failed', 'A signed-in user is required to save a calendar.');
      await saveCalendarEntries(
        {
          organizationId: ctx.organizationId,
          youTubeChannelId: channel.id,
          userId: ctx.userId,
          drafts,
        },
        ctx.db,
      );
    }
    return { entries: drafts, saved: input.save };
  },
};

// --- 9. Experiment creation --------------------------------------------------

const ExperimentInput = z.object({
  hypothesis: z.string().min(1).max(2_000),
  variable: z.string().min(1).max(200),
  successMetric: z.string().min(1).max(200),
  expectedDirection: z.enum(['INCREASE', 'DECREASE']),
  baseline: z.record(z.string(), z.unknown()).default({}),
  experimentNote: z.string().min(1).max(2_000),
});
const experimentCreate: YouTubeTool<typeof ExperimentInput> = {
  name: 'youtube.experiment.create',
  description:
    'Creates a planned YouTube experiment (hypothesis, variable, success metric, expected direction). Never auto-concludes — a conclusion is only ever set from real before/after measurements.',
  input: ExperimentInput,
  kind: 'CREATE',
  async execute(ctx, input) {
    const channel = await requireChannel(ctx, 'youtube.get_channel');
    if (!ctx.userId)
      throw new AppError(
        'validation_failed',
        'A signed-in user is required to create an experiment.',
      );
    return createExperiment(
      {
        organizationId: ctx.organizationId,
        youTubeChannelId: channel.id,
        userId: ctx.userId,
        hypothesis: input.hypothesis,
        variable: input.variable,
        baseline: input.baseline,
        experimentNote: input.experimentNote,
        successMetric: input.successMetric,
        expectedDirection: input.expectedDirection,
        startDate: new Date(),
      },
      ctx.db,
    );
  },
};

// --- 10. Report generation ---------------------------------------------------

const reportGenerate: YouTubeTool<z.ZodObject<Record<string, never>>> = {
  name: 'youtube.report.generate',
  description:
    'Generates a YouTube growth report (executive summary, key metrics, problems, opportunities, recommendations, priority actions, historical changes) from currently connected data — the same reporting engine every other report type uses.',
  input: z.object({}),
  kind: 'GENERATE',
  async execute(ctx) {
    await assertCapabilityUsable(ctx, 'youtube.get_channel');
    if (!ctx.userId)
      throw new AppError('validation_failed', 'A signed-in user is required to generate a report.');
    return generateReportJob(
      { organizationId: ctx.organizationId, userId: ctx.userId, type: 'YOUTUBE' },
      ctx.db,
    );
  },
};

export const YOUTUBE_TOOLS: Record<YouTubeToolName, YouTubeTool> = {
  'youtube.channel.get': channelGet,
  'youtube.channel.analytics': channelAnalytics,
  'youtube.video.list': videoList,
  'youtube.content.performance': contentPerformance,
  'youtube.content.compare': contentCompare,
  'youtube.content.patterns': contentPatterns,
  'youtube.content.opportunities': contentOpportunities,
  'youtube.content.calendar.generate': calendarGenerate,
  'youtube.experiment.create': experimentCreate,
  'youtube.report.generate': reportGenerate,
};

/** Validate input, run the tool. Unknown names are refused, never guessed —
 *  the same convention as `integration-tools.ts`'s `runIntegrationTool`. */
export async function runYouTubeTool(
  name: string,
  ctx: IntegrationToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (YOUTUBE_TOOLS as Record<string, YouTubeTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      `Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return tool.execute(ctx, parsed.data);
}
