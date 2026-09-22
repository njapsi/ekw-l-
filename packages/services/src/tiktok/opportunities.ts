/**
 * The TikTok opportunity engine (Phase 7, mirroring `youtube/opportunities.ts`
 * exactly). Deterministic — every opportunity is derived from
 * `patterns.ts`/`benchmark.ts` output, never invented by a model.
 * `priorityScore` is a documented composite of four named factors — never a
 * "viral score" (§15 explicitly forbids promising virality).
 *
 * `audienceRelevance` from the brief's own example factor list is
 * deliberately omitted, same reason as YouTube: this deployment has no
 * TikTok audience-demographic data (`capability-matrix.ts` —
 * `AUDIENCE_ANALYTICS_READ` is `NOT_AVAILABLE`, and TikTok's public API has
 * no such endpoint at all), and inventing a placeholder value for an
 * unmeasured factor would fabricate data (hard rule 1).
 */
import { type Db, type OpportunityStatus, prisma } from '@growth-agent/db';
import type { TikTokOpportunityType } from '@growth-agent/db';
import { createTask } from '../agent/tasks.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { benchmarkVideos } from './benchmark.js';
import type { TikTokVideoLike } from './metrics.js';
import { detectContentPatterns } from './patterns.js';

export interface EvidenceItem {
  statement: string;
  kind: 'fact' | 'calculated_metric' | 'assumption';
}

export interface TikTokOpportunityDraft {
  type: TikTokOpportunityType;
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

function priorityScore(f: TikTokOpportunityDraft['factors']): number {
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
 * Build opportunity drafts from the account's own synced videos — pure, no
 * I/O, easily testable with hand-built fixtures. Callers persist the result
 * with `upsertOpportunities`.
 */
export function buildOpportunityDrafts(videos: TikTokVideoLike[]): TikTokOpportunityDraft[] {
  const drafts: TikTokOpportunityDraft[] = [];
  const patterns = detectContentPatterns(videos);
  const benchmarks = benchmarkVideos(videos);

  // --- HIGH_PERFORMER_FOLLOWUP: videos that clearly outperformed peers ---
  const outperformers = benchmarks.filter((b) => b.classification === 'OUTPERFORMING');
  if (outperformers.length > 0) {
    const captions = outperformers
      .slice(0, 3)
      .map((b) => videos.find((v) => v.videoId === b.videoId)?.caption)
      .filter((c): c is string => Boolean(c));
    drafts.push({
      type: 'HIGH_PERFORMER_FOLLOWUP',
      title: 'Create a follow-up to your outperforming videos',
      description: `${outperformers.length} video(s) performed well above your account's comparable-duration median. A follow-up on the same topic or format has a documented track record on this account to build on.`,
      evidence: outperformers.slice(0, 5).map((b) => ({
        statement: `"${(videos.find((v) => v.videoId === b.videoId)?.caption ?? b.videoId).slice(0, 80)}" reached ${b.views.toLocaleString('en-US')} views, ${b.ratioToPeerMedian?.toFixed(1)}x this account's ${b.format} median.`,
        kind: 'calculated_metric',
      })),
      factors: {
        evidenceStrength: Math.min(1, outperformers.length / 5),
        historicalPerformance: 1,
        contentGap: 0.3,
        executionFeasibility: 0.8,
      },
      priorityScore: 0,
      confidence: confidenceFromSample(outperformers.length),
      recommendedActions: [
        `Generate follow-up concepts for: ${captions.join(', ') || 'your top-performing videos'}.`,
      ],
      relatedVideoIds: outperformers.map((b) => b.videoId),
    });
  }

  // --- CONTENT_EXPANSION / UNDEREXPLOITED_TOPIC: hashtag clusters ---
  for (const pattern of patterns.filter((p) => p.kind === 'HASHTAG_CLUSTER')) {
    const isUnderexploited = pattern.videoIds.length <= 3;
    drafts.push({
      type: isUnderexploited ? 'UNDEREXPLOITED_TOPIC' : 'CONTENT_EXPANSION',
      title: isUnderexploited
        ? `Expand your underexploited "${pattern.label}" content`
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
      recommendedActions: [`Generate 3-5 follow-up video concepts using ${pattern.label}.`],
      relatedVideoIds: pattern.videoIds,
    });
  }

  // --- SHORT/EXTENDED format opportunity ---
  for (const pattern of patterns.filter((p) => p.kind === 'DURATION_SPLIT')) {
    const isShort = pattern.label.startsWith('Short-form');
    drafts.push({
      type: isShort ? 'SHORT_FORMAT_OPPORTUNITY' : 'EXTENDED_FORMAT_OPPORTUNITY',
      title: `${pattern.label} videos are outperforming your other duration bucket`,
      description: pattern.observation,
      evidence: [{ statement: pattern.evidence, kind: 'calculated_metric' }],
      factors: {
        evidenceStrength:
          pattern.confidence === 'HIGH' ? 1 : pattern.confidence === 'MEDIUM' ? 0.6 : 0.3,
        historicalPerformance: 0.9,
        contentGap: 0.4,
        executionFeasibility: isShort ? 0.9 : 0.5,
      },
      priorityScore: 0,
      confidence: pattern.confidence,
      recommendedActions: [
        `Consider allocating more of next month's calendar to ${isShort ? 'short-form (<=60s)' : 'extended (>60s)'} videos.`,
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
  input: { organizationId: string; tikTokAccountId: string; drafts: TikTokOpportunityDraft[] },
  db: Db = prisma,
): Promise<number> {
  let written = 0;
  for (const d of input.drafts) {
    const existing = await db.tikTokOpportunity.findFirst({
      where: {
        organizationId: input.organizationId,
        tikTokAccountId: input.tikTokAccountId,
        type: d.type,
        title: d.title,
        status: { in: ['SUGGESTED', 'IN_PROGRESS', 'ACTIVE'] },
      },
    });
    if (existing) {
      await db.tikTokOpportunity.update({
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
      await db.tikTokOpportunity.create({
        data: {
          organizationId: input.organizationId,
          tikTokAccountId: input.tikTokAccountId,
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

export async function listTikTokOpportunities(
  organizationId: string,
  opts: { status?: OpportunityStatus } = {},
  db: Db = prisma,
) {
  return db.tikTokOpportunity.findMany({
    where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function updateTikTokOpportunityStatus(
  input: {
    organizationId: string;
    userId: string;
    opportunityId: string;
    status: OpportunityStatus;
    reason?: string;
  },
  db: Db = prisma,
) {
  const opp = await db.tikTokOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const updated = await db.tikTokOpportunity.update({
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
      action: 'tiktok.opportunity.status_changed',
      targetType: 'tiktok_opportunity',
      targetId: opp.id,
      metadata: { from: opp.status, to: input.status, type: opp.type },
    },
    db,
  );
  return updated;
}

export async function promoteTikTokOpportunityToTask(
  input: { organizationId: string; userId: string; opportunityId: string },
  db: Db = prisma,
) {
  const opp = await db.tikTokOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
  });
  if (!opp) throw AppError.notFound('Opportunity');

  const task = await createTask(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      title: `TikTok opportunity: ${opp.title}`,
      description: opp.description,
      instructions: opp.recommendedActions.map((a, i) => `${i + 1}. ${a}`).join('\n'),
      priority: opp.priorityScore >= 0.65 ? 'high' : opp.priorityScore >= 0.4 ? 'medium' : 'low',
      domain: 'TIKTOK',
      affectedRefs: opp.relatedVideoIds.map((id) => `tiktok_video:${id}`),
    },
    db,
  );
  if (opp.status === 'SUGGESTED') {
    await db.tikTokOpportunity.update({ where: { id: opp.id }, data: { status: 'IN_PROGRESS' } });
  }
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'tiktok.opportunity.promoted',
      targetType: 'tiktok_opportunity',
      targetId: opp.id,
      metadata: { taskId: task.id },
    },
    db,
  );
  return task;
}
