/**
 * TikTok Growth Agent tools (Phase 7, §24), dispatched through the Phase 5
 * Tool Executor exactly like the YouTube tools (`youtube-tools.ts`) and the
 * native integration tools — the brief's own explicit mandate not to
 * bypass the Tool Registry / Policy Engine / Orchestrator for this phase.
 * Every tool reuses an existing, already-tested `tiktok/*` function; nothing
 * here re-implements sync, analytics parsing, or benchmarking.
 *
 * Deliberately NOT implemented as separate tools (§24: "Only expose tools
 * whose underlying capability actually exists"):
 *   - `tiktok.content.idea.generate` / `.hook.generate` / `.caption.generate`
 *     / `.hashtags.generate` / `.script.generate` / `.brief.generate` —
 *     already covered by the Content Repurposing engine's `TIKTOK_IDEA` /
 *     `TIKTOK_CAPTION` deliverable types (`content/generate.ts`), plus the
 *     generic `SCRIPT`/`HOOK` types, which already accept a synced TikTok
 *     video as their source (`content/ingest.ts`). A second, TikTok-specific
 *     generation path would duplicate existing functionality (hard rule 9).
 *   - `tiktok.analytics.audience` — TikTok's public API exposes no audience
 *     -demographics endpoint at all (`capability-matrix.ts`,
 *     `AUDIENCE_ANALYTICS_READ` is always `NOT_AVAILABLE`); there is no
 *     underlying capability to wrap.
 *   - Separate `tiktok.report.weekly.generate` / `.monthly.generate` tools —
 *     the reporting engine's `TIKTOK` type has no weekly-vs-monthly
 *     distinction of its own; one `tiktok.report.generate` tool is offered
 *     instead, matching the YouTube tool set's equivalent choice.
 *   - `tiktok.video.update` / `.delete` / comment-management tools — no such
 *     TikTok API endpoint exists (`capability-matrix.ts`).
 *
 * `tiktok.content.publish.draft` is the one tool that touches the real,
 * already-audited Content Posting API flow (`publish.ts`) — but only ever
 * creates an `AWAITING_APPROVAL` draft. It never submits: submission needs a
 * human to click "Approve & publish" in the UI (`approveAndSubmit` requires
 * `approve: true`, which only that UI action supplies). Because
 * `publish:external` is an ADMIN+-only permission distinct from the
 * `agent:run` permission that lets any MEMBER use the agent at all, this
 * tool re-derives the caller's authorization from the database at call time
 * via `assertJobAuthorized` (the same "never trust a role carried in a
 * payload" convention `security/job-auth.ts` established for background
 * jobs) rather than assuming `agent:run` implies publish rights.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertJobAuthorized } from '../security/job-auth.js';
import { generateReportJob } from '../reports/jobs.js';
import { benchmarkVideos, compareVideos } from '../tiktok/benchmark.js';
import {
  generateContentPlanDrafts,
  saveContentPlanEntries,
  type ContentPlanEntryDraft,
} from '../tiktok/calendar.js';
import { createExperiment } from '../tiktok/experiments.js';
import type { TikTokVideoLike } from '../tiktok/metrics.js';
import {
  buildOpportunityDrafts,
  listTikTokOpportunities,
  upsertOpportunities,
} from '../tiktok/opportunities.js';
import { detectContentPatterns } from '../tiktok/patterns.js';
import { createPublishDraft } from '../tiktok/publish.js';
import { getAccountOverview, getPrimaryAccount } from '../tiktok/read.js';
import { assertCapabilityUsable, type IntegrationToolContext } from './integration-tools.js';

export const TIKTOK_TOOL_NAMES = [
  'tiktok.account.get',
  'tiktok.video.list',
  'tiktok.content.performance',
  'tiktok.content.compare',
  'tiktok.content.patterns',
  'tiktok.content.opportunities',
  'tiktok.content.calendar.generate',
  'tiktok.experiment.create',
  'tiktok.report.generate',
  'tiktok.content.publish.draft',
] as const;
export type TikTokToolName = (typeof TIKTOK_TOOL_NAMES)[number];

interface TikTokTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: TikTokToolName;
  description: string;
  input: I;
  kind: 'READ' | 'ANALYZE' | 'GENERATE' | 'CREATE' | 'ACTION';
  execute(ctx: IntegrationToolContext, input: z.infer<I>): Promise<unknown>;
}

async function requireAccount(ctx: IntegrationToolContext, capabilityId: string) {
  await assertCapabilityUsable(ctx, capabilityId);
  const account = await getPrimaryAccount(ctx.organizationId, ctx.db);
  if (!account) {
    throw new AppError(
      'validation_failed',
      'No TikTok account has been synced yet. Connect TikTok and run a sync first.',
    );
  }
  return account;
}

async function recentVideos(
  ctx: IntegrationToolContext,
  tikTokAccountId: string,
  limit: number,
): Promise<TikTokVideoLike[]> {
  return ctx.db.tikTokVideo.findMany({
    where: { tikTokAccountId },
    orderBy: { createTime: 'desc' },
    take: limit,
    select: {
      videoId: true,
      caption: true,
      createTime: true,
      durationSec: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      shareCount: true,
      hashtags: true,
    },
  });
}

// --- 1. Account overview ------------------------------------------------

const accountGet: TikTokTool<z.ZodObject<Record<string, never>>> = {
  name: 'tiktok.account.get',
  description:
    'The connected TikTok account: display name, follower/likes/video counts (when granted), posting cadence, and hashtag themes.',
  input: z.object({}),
  kind: 'READ',
  async execute(ctx) {
    await assertCapabilityUsable(ctx, 'tiktok.get_profile');
    const overview = await getAccountOverview(ctx.organizationId, ctx.db);
    if (!overview) {
      throw new AppError('validation_failed', 'No TikTok account has been synced yet.');
    }
    return overview;
  },
};

// --- 2. Video list --------------------------------------------------------

const VideoListInput = z.object({
  limit: z.number().int().min(1).max(50).default(25),
  sort: z.enum(['recent', 'views']).default('recent'),
});
const videoList: TikTokTool<typeof VideoListInput> = {
  name: 'tiktok.video.list',
  description:
    'Synced videos for the connected TikTok account, most recent or highest-viewed first.',
  input: VideoListInput,
  kind: 'READ',
  async execute(ctx, input) {
    await assertCapabilityUsable(ctx, 'tiktok.get_videos');
    const account = await requireAccount(ctx, 'tiktok.get_videos');
    const videos = await recentVideos(ctx, account.id, input.limit);
    return {
      videos:
        input.sort === 'views'
          ? [...videos].sort((a, b) => Number((b.viewCount ?? 0n) - (a.viewCount ?? 0n)))
          : videos,
    };
  },
};

// --- 3. Content performance (benchmark) ----------------------------------

const PerformanceInput = z.object({ limit: z.number().int().min(5).max(200).default(50) });
const contentPerformance: TikTokTool<typeof PerformanceInput> = {
  name: 'tiktok.content.performance',
  description:
    "Classifies each of the account's recent videos as OUTPERFORMING/TYPICAL/UNDERPERFORMING/INSUFFICIENT_DATA against the account's own comparable-duration history (never a global TikTok average) — documented fixed thresholds, not a model guess.",
  input: PerformanceInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const account = await requireAccount(ctx, 'tiktok.get_videos');
    const videos = await recentVideos(ctx, account.id, input.limit);
    return { benchmarks: benchmarkVideos(videos) };
  },
};

// --- 4. Content compare ---------------------------------------------------

const CompareInput = z.object({ videoIds: z.array(z.string().min(1)).min(2).max(20) });
const contentCompare: TikTokTool<typeof CompareInput> = {
  name: 'tiktok.content.compare',
  description: 'Side-by-side benchmark comparison for a specific, caller-chosen set of videos.',
  input: CompareInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    await assertCapabilityUsable(ctx, 'tiktok.get_videos');
    const rows = await ctx.db.tikTokVideo.findMany({
      where: { organizationId: ctx.organizationId, videoId: { in: input.videoIds } },
      select: {
        videoId: true,
        caption: true,
        createTime: true,
        durationSec: true,
        viewCount: true,
        likeCount: true,
        commentCount: true,
        shareCount: true,
        hashtags: true,
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

// --- 5. Content patterns ---------------------------------------------------

const contentPatterns: TikTokTool<typeof PerformanceInput> = {
  name: 'tiktok.content.patterns',
  description:
    "Hashtag-cluster and duration-split patterns detected across the account's recent videos, each with concrete evidence — never a causal claim.",
  input: PerformanceInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const account = await requireAccount(ctx, 'tiktok.get_videos');
    const videos = await recentVideos(ctx, account.id, input.limit);
    return { patterns: detectContentPatterns(videos) };
  },
};

// --- 6. Content opportunities ----------------------------------------------

const OpportunitiesInput = z.object({
  regenerate: z.boolean().default(false),
  limit: z.number().int().min(5).max(200).default(50),
});
const contentOpportunities: TikTokTool<typeof OpportunitiesInput> = {
  name: 'tiktok.content.opportunities',
  description:
    'Evidence-backed content opportunities for the TikTok account, each with a documented PRIORITY SCORE (never a virality prediction) — regenerates from the latest synced videos when `regenerate` is true, otherwise returns the last-computed list.',
  input: OpportunitiesInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const account = await requireAccount(ctx, 'tiktok.get_videos');
    if (input.regenerate) {
      const videos = await recentVideos(ctx, account.id, input.limit);
      const drafts = buildOpportunityDrafts(videos);
      await upsertOpportunities(
        { organizationId: ctx.organizationId, tikTokAccountId: account.id, drafts },
        ctx.db,
      );
    }
    const opportunities = await listTikTokOpportunities(ctx.organizationId, {}, ctx.db);
    return { opportunities };
  },
};

// --- 7. Content calendar generation -----------------------------------------

const CalendarInput = z.object({
  cadencePerWeek: z.number().int().min(1).max(21).default(3),
  weeks: z.number().int().min(1).max(12).default(4),
  save: z.boolean().default(false),
});
const calendarGenerate: TikTokTool<typeof CalendarInput> = {
  name: 'tiktok.content.calendar.generate',
  description:
    "Builds a content plan from the account's current opportunities at the requested cadence. Never schedules a real TikTok publish — a plan entry is a plan, always starting at status IDEA.",
  input: CalendarInput,
  kind: 'GENERATE',
  async execute(ctx, input) {
    const account = await requireAccount(ctx, 'tiktok.get_videos');
    const opportunities = await listTikTokOpportunities(
      ctx.organizationId,
      { status: 'SUGGESTED' },
      ctx.db,
    );
    const drafts: ContentPlanEntryDraft[] = generateContentPlanDrafts({
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
        throw new AppError(
          'validation_failed',
          'A signed-in user is required to save a content plan.',
        );
      await saveContentPlanEntries(
        {
          organizationId: ctx.organizationId,
          tikTokAccountId: account.id,
          userId: ctx.userId,
          drafts,
        },
        ctx.db,
      );
    }
    return { entries: drafts, saved: input.save };
  },
};

// --- 8. Experiment creation --------------------------------------------------

const ExperimentInput = z.object({
  hypothesis: z.string().min(1).max(2_000),
  variable: z.string().min(1).max(200),
  successMetric: z.string().min(1).max(200),
  expectedDirection: z.enum(['INCREASE', 'DECREASE']),
  baseline: z.record(z.string(), z.unknown()).default({}),
  experimentNote: z.string().min(1).max(2_000),
});
const experimentCreate: TikTokTool<typeof ExperimentInput> = {
  name: 'tiktok.experiment.create',
  description:
    'Creates a planned TikTok experiment (hypothesis, variable, success metric, expected direction). Never auto-concludes — a conclusion is only ever set from real before/after measurements.',
  input: ExperimentInput,
  kind: 'CREATE',
  async execute(ctx, input) {
    const account = await requireAccount(ctx, 'tiktok.get_profile');
    if (!ctx.userId)
      throw new AppError(
        'validation_failed',
        'A signed-in user is required to create an experiment.',
      );
    return createExperiment(
      {
        organizationId: ctx.organizationId,
        tikTokAccountId: account.id,
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

// --- 9. Report generation ---------------------------------------------------

const reportGenerate: TikTokTool<z.ZodObject<Record<string, never>>> = {
  name: 'tiktok.report.generate',
  description:
    'Generates a TikTok growth report (executive summary, key metrics, problems, opportunities, recommendations, priority actions, historical changes) from currently connected data — the same reporting engine every other report type uses.',
  input: z.object({}),
  kind: 'GENERATE',
  async execute(ctx) {
    await assertCapabilityUsable(ctx, 'tiktok.get_profile');
    if (!ctx.userId)
      throw new AppError('validation_failed', 'A signed-in user is required to generate a report.');
    return generateReportJob(
      { organizationId: ctx.organizationId, userId: ctx.userId, type: 'TIKTOK' },
      ctx.db,
    );
  },
};

// --- 10. Publish draft (proposal only — never submits) -----------------------

const PublishDraftInput = z.object({
  sourceUrl: z.string().url(),
  caption: z.string().min(1).max(2_200),
  hashtags: z.array(z.string().min(1)).max(30).default([]),
  privacy: z
    .enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
    .default('SELF_ONLY'),
});
const publishDraft: TikTokTool<typeof PublishDraftInput> = {
  name: 'tiktok.content.publish.draft',
  description:
    'Creates a TikTok publish draft awaiting human approval. This tool NEVER submits to TikTok — a person must explicitly approve the draft in the UI before anything is sent. Requires the video.publish scope and the publish:external permission.',
  input: PublishDraftInput,
  kind: 'ACTION',
  async execute(ctx, input) {
    if (!ctx.userId)
      throw new AppError('validation_failed', 'A signed-in user is required to draft a publish.');
    // publish:external is an ADMIN+-only permission, distinct from the
    // agent:run permission that lets any MEMBER reach this tool at all —
    // re-derive it from the database rather than assuming agent:run implies it.
    await assertJobAuthorized(
      { organizationId: ctx.organizationId, actorUserId: ctx.userId },
      'publish:external',
      ctx.db,
    );
    // Not gated on `assertCapabilityUsable(ctx, 'tiktok.publish')`: that
    // capability's contract baseline is REQUIRES_PROVIDER_APPROVAL, which
    // never resolves to usable even with the scope granted (it exists for
    // the Connection Center's display, not as a functional gate) — the real
    // scope check happens inside `createPublishDraft` itself, exactly like
    // the existing `createTikTokDraftAction` Server Action already relies on.
    const account = await getPrimaryAccount(ctx.organizationId, ctx.db);
    if (!account) {
      throw new AppError(
        'validation_failed',
        'No TikTok account has been synced yet. Connect TikTok and run a sync first.',
      );
    }
    return createPublishDraft(
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        accountId: account.id,
        sourceUrl: input.sourceUrl,
        caption: input.caption,
        hashtags: input.hashtags,
        privacy: input.privacy,
      },
      ctx.db,
    );
  },
};

export const TIKTOK_TOOLS: Record<TikTokToolName, TikTokTool> = {
  'tiktok.account.get': accountGet,
  'tiktok.video.list': videoList,
  'tiktok.content.performance': contentPerformance,
  'tiktok.content.compare': contentCompare,
  'tiktok.content.patterns': contentPatterns,
  'tiktok.content.opportunities': contentOpportunities,
  'tiktok.content.calendar.generate': calendarGenerate,
  'tiktok.experiment.create': experimentCreate,
  'tiktok.report.generate': reportGenerate,
  'tiktok.content.publish.draft': publishDraft,
};

/** Validate input, run the tool. Unknown names are refused, never guessed —
 *  the same convention as `integration-tools.ts`'s `runIntegrationTool`. */
export async function runTikTokTool(
  name: string,
  ctx: IntegrationToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (TIKTOK_TOOLS as Record<string, TikTokTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      `Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return tool.execute(ctx, parsed.data);
}
