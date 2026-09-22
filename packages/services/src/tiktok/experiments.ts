/**
 * TikTok experiments (Phase 7, mirroring `youtube/experiments.ts` exactly).
 * A controlled test the creator runs deliberately — never a forced "winner"
 * (§23: the AI must distinguish observed result / correlation / hypothesis /
 * conclusion). `evaluateExperiment` is the one place a conclusion is
 * decided, and it is a pure, documented comparison — never a model's
 * opinion.
 */
import { type Db, prisma } from '@growth-agent/db';
import type {
  TikTokExperimentConclusion,
  TikTokExperimentDirection,
  TikTokExperimentStatus,
} from '@growth-agent/db';
import { AppError } from '../errors.js';

export interface CreateExperimentInput {
  organizationId: string;
  tikTokAccountId: string;
  userId: string;
  hypothesis: string;
  variable: string;
  baseline: Record<string, unknown>;
  experimentNote: string;
  successMetric: string;
  expectedDirection: TikTokExperimentDirection;
  startDate: Date;
}

export async function createExperiment(input: CreateExperimentInput, db: Db = prisma) {
  return db.tikTokExperiment.create({
    data: {
      organizationId: input.organizationId,
      tikTokAccountId: input.tikTokAccountId,
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
  opts: { status?: TikTokExperimentStatus } = {},
  db: Db = prisma,
) {
  return db.tikTokExperiment.findMany({
    where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function setExperimentStatus(
  input: { organizationId: string; experimentId: string; status: TikTokExperimentStatus },
  db: Db = prisma,
) {
  const exp = await db.tikTokExperiment.findFirst({
    where: { id: input.experimentId, organizationId: input.organizationId },
  });
  if (!exp) throw AppError.notFound('Experiment');
  return db.tikTokExperiment.update({ where: { id: exp.id }, data: { status: input.status } });
}

/**
 * The minimum relative change below which a result is always INCONCLUSIVE,
 * regardless of direction — mirroring `youtube/experiments.ts`'s documented
 * 15% threshold rather than inventing a new one.
 */
const MEANINGFUL_CHANGE_RATIO = 0.15;

export interface ExperimentEvaluation {
  observedRatio: number | null;
  relativeChange: number | null;
  conclusion: TikTokExperimentConclusion;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function confidenceFromSample(n: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (n >= 8) return 'HIGH';
  if (n >= 3) return 'MEDIUM';
  return 'LOW';
}

export function evaluateExperiment(
  baselineValue: number,
  experimentValue: number,
  expectedDirection: TikTokExperimentDirection,
  sampleSize: number,
): ExperimentEvaluation {
  const confidence = confidenceFromSample(sampleSize);
  if (baselineValue === 0) {
    return { observedRatio: null, relativeChange: null, conclusion: 'INCONCLUSIVE', confidence };
  }
  const ratio = experimentValue / baselineValue;
  const relativeChange = ratio - 1;
  if (Math.abs(relativeChange) < MEANINGFUL_CHANGE_RATIO) {
    return { observedRatio: ratio, relativeChange, conclusion: 'INCONCLUSIVE', confidence };
  }
  const movedUp = relativeChange > 0;
  const matchesExpectation =
    (expectedDirection === 'INCREASE' && movedUp) || (expectedDirection === 'DECREASE' && !movedUp);
  return {
    observedRatio: ratio,
    relativeChange,
    conclusion: matchesExpectation ? 'SUPPORTED' : 'NOT_SUPPORTED',
    confidence,
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
  const exp = await db.tikTokExperiment.findFirst({
    where: { id: input.experimentId, organizationId: input.organizationId },
  });
  if (!exp) throw AppError.notFound('Experiment');

  const evaluation = evaluateExperiment(
    input.baselineValue,
    input.experimentValue,
    exp.expectedDirection,
    input.sampleSize,
  );

  return db.tikTokExperiment.update({
    where: { id: exp.id },
    data: {
      status: 'COMPLETED',
      endDate: input.endDate,
      conclusion: evaluation.conclusion,
      confidence: evaluation.confidence,
      result: {
        baselineValue: input.baselineValue,
        experimentValue: input.experimentValue,
        observedRatio: evaluation.observedRatio,
        relativeChange: evaluation.relativeChange,
        sampleSize: input.sampleSize,
      } as never,
    },
  });
}
