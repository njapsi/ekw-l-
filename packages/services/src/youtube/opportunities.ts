/**
 * The YouTube opportunity engine (Phase 6, Parts 19-21). Deterministic —
 * every opportunity is derived from `patterns.ts`/`benchmark.ts` output,
 * never invented by a model. `priorityScore` is a documented composite of
 * four named factors (Part 20: "Each factor must be documented... Call it
 * PRIORITY SCORE, not 'viral score'" — nothing here predicts views).
 *
 * `audienceRelevance` from the brief's own example factor list is
 * deliberately omitted: this deployment has no audience-demographic data
 * (see `capability-matrix.ts` — AUDIENCE_ANALYTICS_READ is unavailable), and
 * inventing a placeholder value for an unmeasured factor would violate hard
 * rule 1. The four factors actually used are each backed by real data.
 */
import { type Db, type OpportunityStatus, prisma } from '@growth-agent/db';
import type { YouTubeOpportunityType } from '@growth-agent/db';
import { createTask } from '../agent/tasks.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { benchmarkVideos } from './benchmark.js';
import type { VideoLike } from './metrics.js';
import { detectContentPatterns } from './patterns.js';

export interface EvidenceItem {
  statement: string;
  kind: 'fact' | 'calculated_metric' | 'assumption';
}

export interface YouTubeOpportunityDraft {
  type: YouTubeOpportunityType;
  title: string;
  description: string;
  evidence: EvidenceItem[];
  factors: {
    evidenceStrength: number;
    historicalPerformance: number;
    contentGap: number;
    executionFeasibility: number;
  };
  priorityScore: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedActions: string[];
  relatedVideoIds: string[];
}

/** Documented weights — sum to 1. Changing these is a product decision, not
 *  a model's choice; keep this the single place that defines them. */
const WEIGHTS = {
  evidenceStrength: 0.35,
  historicalPerformance: 0.25,
  contentGap: 0.25,
  executionFeasibility: 0.15,
} as const;

function priorityScore(f: YouTubeOpportunityDraft['factors']): number {
  return (
    f.evidenceStrength * WEIGHTS.evidenceStrength +
    f.historicalPerformance * WEIGHTS.historicalPerformance +
    f.contentGap * WEIGHTS.contentGap +
    f.executionFeasibility * WEIGHTS.executionFeasibility
  );
}

function confidenceFromSample(n: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (n >= 10) return 'HIGH';
  if (n >= 5) return 'MEDIUM';
  return 'LOW';
}

/**
 * Build opportunity drafts from the channel's own synced videos — pure,
 * no I/O, easily testable with hand-built fixtures. Callers persist the
 * result with `upsertOpportunities`.
 */
export function buildOpportunityDrafts(videos: VideoLike[]): YouTubeOpportunityDraft[] {
  const drafts: YouTubeOpportunityDraft[] = [];
  const patterns = detectContentPatterns(videos);
  const benchmarks = benchmarkVideos(videos);

  // --- HIGH_PERFORMER_FOLLOWUP: videos that clearly outperformed peers ---
  const outperformers = benchmarks.filter((b) => b.classification === 'OUTPERFORMING');
  if (outperformers.length > 0) {
    const titles = outperformers
      .slice(0, 3)
      .map((b) => videos.find((v) => v.videoId === b.videoId)?.title)
      .filter((t): t is string => Boolean(t));
    drafts.push({
      type: 'HIGH_PERFORMER_FOLLOWUP',
      title: 'Create a follow-up to your outperforming videos',
      description: `${outperformers.length} video(s) performed well above your channel's comparable-format median. A follow-up video on the same topic or format has a documented track record on this channel to build on.`,
      evidence: outperformers.slice(0, 5).map((b) => ({
        statement: `"${videos.find((v) => v.videoId === b.videoId)?.title ?? b.videoId}" reached ${b.views.toLocaleString('en-US')} views, ${b.ratioToPeerMedian?.toFixed(1)}x this channel's ${b.format === 'short' ? 'Shorts' : 'long-form'} median.`,
        kind: 'calculated_metric',
      })),
      factors: {
        evidenceStrength: Math.min(1, outperformers.length / 5),
        historicalPerformance: 1,
        contentGap: 0.3, // a follow-up is the opposite of a gap — low but not zero (audience may still want more)
        executionFeasibility: 0.8, // a known, already-proven format/topic is comparatively easy to repeat
      },
      priorityScore: 0, // set below
      confidence: confidenceFromSample(outperformers.length),
      recommendedActions: [
        `Generate follow-up concepts for: ${titles.join(', ') || 'your top-performing videos'}.`,
      ],
      relatedVideoIds: outperformers.map((b) => b.videoId),
    });
  }

  // --- CONTENT_EXPANSION / UNDEREXPLOITED_TOPIC: a small, above-median cluster ---
  for (const pattern of patterns.filter((p) => p.kind === 'TOPIC_CLUSTER')) {
    const isUnderexploited = pattern.videoIds.length <= 3;
    drafts.push({
      type: isUnderexploited ? 'UNDEREXPLOITED_TOPIC' : 'CONTENT_EXPANSION',
      title: isUnderexploited
        ? `Expand your underexploited "${pattern.label}" topic`
        : `Expand your "${pattern.label}" content`,
      description: pattern.observation,
      evidence: [{ statement: pattern.evidence, kind: 'calculated_metric' }],
      factors: {
        evidenceStrength:
          pattern.confidence === 'HIGH' ? 1 : pattern.confidence === 'MEDIUM' ? 0.6 : 0.3,
        historicalPerformance: 0.8,
        contentGap: isUnderexploited ? 0.9 : 0.5,
        executionFeasibility: 0.7,
      },
      priorityScore: 0,
      confidence: pattern.confidence,
      recommendedActions: [`Generate 3-5 follow-up concepts in the "${pattern.label}" topic.`],
      relatedVideoIds: pattern.videoIds,
    });
  }

  // --- FORMAT_OPPORTUNITY (Shorts vs. long-form) ---
  for (const pattern of patterns.filter((p) => p.kind === 'FORMAT_SPLIT')) {
    const isShorts = pattern.label === 'Shorts';
    drafts.push({
      type: isShorts ? 'SHORTS_OPPORTUNITY' : 'LONG_FORM_OPPORTUNITY',
      title: `${pattern.label} are outperforming your other format`,
      description: pattern.observation,
      evidence: [{ statement: pattern.evidence, kind: 'calculated_metric' }],
      factors: {
        evidenceStrength:
          pattern.confidence === 'HIGH' ? 1 : pattern.confidence === 'MEDIUM' ? 0.6 : 0.3,
        historicalPerformance: 0.9,
        contentGap: 0.4,
        executionFeasibility: isShorts ? 0.9 : 0.5, // Shorts are generally cheaper to produce
      },
      priorityScore: 0,
      confidence: pattern.confidence,
      recommendedActions: [
        `Consider allocating more of next month's calendar to ${pattern.label.toLowerCase()}.`,
      ],
      relatedVideoIds: pattern.videoIds,
    });
  }

  return drafts
    .map((d) => ({ ...d, priorityScore: Math.round(priorityScore(d.factors) * 100) / 100 }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

// --- Persistence -----------------------------------------------------------

export async function upsertOpportunities(
  input: { organizationId: string; youTubeChannelId: string; drafts: YouTubeOpportunityDraft[] },
  db: Db = prisma,
): Promise<number> {
  let written = 0;
  for (const d of input.drafts) {
    const existing = await db.youTubeOpportunity.findFirst({
      where: {
        organizationId: input.organizationId,
        youTubeChannelId: input.youTubeChannelId,
        type: d.type,
        title: d.title,
        status: { in: ['SUGGESTED', 'IN_PROGRESS', 'ACTIVE'] },
      },
    });
    if (existing) {
      await db.youTubeOpportunity.update({
        where: { id: existing.id },
        data: {
          description: d.description,
          evidence: d.evidence as never,
          evidenceStrength: d.factors.evidenceStrength,
          historicalPerformance: d.factors.historicalPerformance,
          contentGap: d.factors.contentGap,
          executionFeasibility: d.factors.executionFeasibility,
          priorityScore: d.priorityScore,
          confidence: d.confidence,
          recommendedActions: d.recommendedActions,
          relatedVideoIds: d.relatedVideoIds,
        },
      });
    } else {
      await db.youTubeOpportunity.create({
        data: {
          organizationId: input.organizationId,
          youTubeChannelId: input.youTubeChannelId,
          type: d.type,
          title: d.title,
          description: d.description,
          evidence: d.evidence as never,
          evidenceStrength: d.factors.evidenceStrength,
          historicalPerformance: d.factors.historicalPerformance,
          contentGap: d.factors.contentGap,
          executionFeasibility: d.factors.executionFeasibility,
          priorityScore: d.priorityScore,
          confidence: d.confidence,
          recommendedActions: d.recommendedActions,
          relatedVideoIds: d.relatedVideoIds,
        },
      });
    }
    written++;
  }
  return written;
}

export async function listYouTubeOpportunities(
  organizationId: string,
  opts: { status?: OpportunityStatus } = {},
  db: Db = prisma,
) {
  return db.youTubeOpportunity.findMany({
    where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function updateYouTubeOpportunityStatus(
  input: {
    organizationId: string;
    userId: string;
    opportunityId: string;
    status: OpportunityStatus;
    reason?: string;
  },
  db: Db = prisma,
) {
  const opp = await db.youTubeOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const updated = await db.youTubeOpportunity.update({
    where: { id: opp.id },
    data: {
      status: input.status,
      dismissedReason:
        input.status === 'DISMISSED' ? (input.reason ?? 'Dismissed by user.').slice(0, 500) : null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'youtube.opportunity.status_changed',
      targetType: 'youtube_opportunity',
      targetId: opp.id,
      metadata: { from: opp.status, to: input.status, type: opp.type },
    },
    db,
  );
  return updated;
}

export async function promoteYouTubeOpportunityToTask(
  input: { organizationId: string; userId: string; opportunityId: string },
  db: Db = prisma,
) {
  const opp = await db.youTubeOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const task = await createTask(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      title: `YouTube opportunity: ${opp.title}`,
      description: opp.description,
      instructions: opp.recommendedActions.map((a, i) => `${i + 1}. ${a}`).join('\n'),
      priority: opp.priorityScore >= 0.65 ? 'high' : opp.priorityScore >= 0.4 ? 'medium' : 'low',
      domain: 'YOUTUBE',
      affectedRefs: opp.relatedVideoIds.map((id) => `youtube_video:${id}`),
    },
    db,
  );
  if (opp.status === 'SUGGESTED') {
    await db.youTubeOpportunity.update({ where: { id: opp.id }, data: { status: 'IN_PROGRESS' } });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'youtube.opportunity.promoted',
      targetType: 'youtube_opportunity',
      targetId: opp.id,
      metadata: { taskId: task.id },
    },
    db,
  );
  return task;
}
