/**
 * Mission strategy memory (Phase 10, §18/§19) — the explicit Observation /
 * Hypothesis / Learning / Decision distinction. Deliberately its own table
 * (`MissionLearning`) rather than folded into `OrgMemory`: `OrgMemory.value`
 * is free prose for cross-turn goals/preferences, while a learning record is
 * structured, mission-scoped, and evidence-linked — the two serve different
 * readers (the chat agent's working memory vs. a mission's weekly review).
 *
 * Never converts a correlation into a fact: `recordLearning` takes the
 * caller's own `type`, it does not infer one, and `confidence` is required
 * so a low-confidence hypothesis is never displayed indistinguishably from a
 * confirmed learning.
 */
import { type Db, type MissionLearningType, prisma } from '@growth-agent/db';
import { recordMissionEvent } from './events.js';

export interface RecordLearningInput {
  organizationId: string;
  missionId: string;
  type: MissionLearningType;
  title: string;
  detail: string;
  evidence?: string[];
  confidence?: number;
  relatedTaskId?: string;
}

export async function recordMissionLearning(input: RecordLearningInput, db: Db = prisma) {
  const row = await db.missionLearning.create({
    data: {
      organizationId: input.organizationId,
      missionId: input.missionId,
      type: input.type,
      title: input.title.slice(0, 200),
      detail: input.detail.slice(0, 4_000),
      evidence: (input.evidence ?? []).slice(0, 20).map((e) => e.slice(0, 500)),
      confidence: input.confidence ?? 0.5,
      relatedTaskId: input.relatedTaskId ?? null,
    },
  });
  await recordMissionEvent(
    {
      missionId: input.missionId,
      organizationId: input.organizationId,
      type: 'LEARNING_RECORDED',
      metadata: { type: input.type, title: input.title },
    },
    db,
  );
  return row;
}

export async function listMissionLearnings(
  organizationId: string,
  missionId: string,
  db: Db = prisma,
) {
  return db.missionLearning.findMany({
    where: { organizationId, missionId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
