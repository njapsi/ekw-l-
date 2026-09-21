/**
 * YouTube experiments (Phase 6, Parts 41-42). A controlled test the creator
 * runs deliberately — never a forced "winner" (Part 42: "Do not force a
 * winner"). `evaluateExperiment` is the one place a conclusion is decided,
 * and it is a pure, documented comparison — never a model's opinion.
 */
import { type Db, prisma } from '@growth-agent/db';
import type {
  YouTubeExperimentConclusion,
  YouTubeExperimentDirection,
  YouTubeExperimentStatus,
} from '@growth-agent/db';
import { AppError } from '../errors.js';

export interface CreateExperimentInput {
  organizationId: string;
  youTubeChannelId: string;
  userId: string;
  hypothesis: string;
  variable: string;
  baseline: Record<string, unknown>;
  experimentNote: string;
  successMetric: string;
  expectedDirection: YouTubeExperimentDirection;
  startDate: Date;
}

export async function createExperiment(input: CreateExperimentInput, db: Db = prisma) {
  return db.youTubeExperiment.create({
    data: {
      organizationId: input.organizationId,
      youTubeChannelId: input.youTubeChannelId,
      hypothesis: input.hypothesis.slice(0, 2_000),
      variable: input.variable.slice(0, 200),
      baseline: input.baseline as never,
      experimentNote: input.experimentNote.slice(0, 2_000),
      successMetric: input.successMetric.slice(0, 200),
      expectedDirection: input.expectedDirection,
      startDate: input.startDate,
      status: 'PLANNED',
      createdById: input.userId,
    },
  });
}

export async function listExperiments(
  organizationId: string,
  opts: { status?: YouTubeExperimentStatus } = {},
  db: Db = prisma,
) {
  return db.youTubeExperiment.findMany({
    where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function setExperimentStatus(
  input: { organizationId: string; experimentId: string; status: YouTubeExperimentStatus },
  db: Db = prisma,
) {
  const exp = await db.youTubeExperiment.findFirst({
    where: { id: input.experimentId, organizationId: input.organizationId },
  });
  if (!exp) throw AppError.notFound('Experiment');
  return db.youTubeExperiment.update({ where: { id: exp.id }, data: { status: input.status } });
}

/**
 * The minimum relative change (Part 42's documented threshold, mirroring
 * `benchmark.ts`'s ±50%/±150% convention rather than inventing a new one)
 * before a result counts as SUPPORTED/NOT_SUPPORTED. Below this, the
 * change could plausibly be noise — INCONCLUSIVE, never a forced winner.
 */
const MEANINGFUL_CHANGE_RATIO = 0.15; // 15%

export interface ExperimentEvaluation {
  conclusion: YouTubeExperimentConclusion;
  changeRatio: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  explanation: string;
}

/**
 * Compare a baseline metric value to the post-experiment value. `sampleSize`
 * is however many data points (videos/days) the caller measured — Part 13's
 * confidence input; below 3, confidence is always LOW regardless of the
 * ratio (a single before/after point proves very little).
 */
export function evaluateExperiment(
  baselineValue: number,
  experimentValue: number,
  expectedDirection: YouTubeExperimentDirection,
  sampleSize: number,
): ExperimentEvaluation {
  if (baselineValue === 0) {
    return {
      conclusion: 'INCONCLUSIVE',
      changeRatio: null,
      confidence: 'LOW',
      explanation: 'The baseline value was zero, so a relative change cannot be computed.',
    };
  }
  const changeRatio = (experimentValue - baselineValue) / baselineValue;
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    sampleSize < 3 ? 'LOW' : sampleSize < 8 ? 'MEDIUM' : 'HIGH';

  if (Math.abs(changeRatio) < MEANINGFUL_CHANGE_RATIO) {
    return {
      conclusion: 'INCONCLUSIVE',
      changeRatio,
      confidence,
      explanation: `The change (${(changeRatio * 100).toFixed(1)}%) was smaller than the ${(MEANINGFUL_CHANGE_RATIO * 100).toFixed(0)}% threshold used to distinguish a real effect from normal variation.`,
    };
  }

  const movedInExpectedDirection =
    expectedDirection === 'INCREASE' ? changeRatio > 0 : changeRatio < 0;

  return {
    conclusion: movedInExpectedDirection ? 'SUPPORTED' : 'NOT_SUPPORTED',
    changeRatio,
    confidence,
    explanation: movedInExpectedDirection
      ? `The metric moved ${(changeRatio * 100).toFixed(1)}% in the hypothesized direction.`
      : `The metric moved ${(changeRatio * 100).toFixed(1)}%, opposite to the hypothesized direction.`,
  };
}

export async function completeExperiment(
  input: {
    organizationId: string;
    experimentId: string;
    baselineValue: number;
    experimentValue: number;
    sampleSize: number;
    endDate: Date;
  },
  db: Db = prisma,
) {
  const exp = await db.youTubeExperiment.findFirst({
    where: { id: input.experimentId, organizationId: input.organizationId },
  });
  if (!exp) throw AppError.notFound('Experiment');

  const evaluation = evaluateExperiment(
    input.baselineValue,
    input.experimentValue,
    exp.expectedDirection,
    input.sampleSize,
  );

  return db.youTubeExperiment.update({
    where: { id: exp.id },
    data: {
      status: 'COMPLETED',
      endDate: input.endDate,
      result: {
        baselineValue: input.baselineValue,
        experimentValue: input.experimentValue,
        sampleSize: input.sampleSize,
        changeRatio: evaluation.changeRatio,
        explanation: evaluation.explanation,
      } as never,
      conclusion: evaluation.conclusion,
      confidence: evaluation.confidence,
    },
  });
}
