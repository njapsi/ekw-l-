/**
 * Worker-facing job wrappers (Phase 10, §46) — dispatched from
 * `apps/worker/src/processors/agent.ts`, which reactivates the existing,
 * previously-idle `agent-run` BullMQ queue (`docs/AGENT-RUNTIME.md` §8)
 * rather than standing up a second worker system.
 */
import { type Db, prisma } from '@growth-agent/db';
import { runMissionSweep, runMissionTick } from './loop.js';
import { runDailyBriefSweep, runWeeklyReviewSweep } from './briefing.js';

export async function runMissionSweepJob(db: Db = prisma) {
  return runMissionSweep(db);
}

export async function runMissionTickJob(input: { missionId: string }, db: Db = prisma) {
  return runMissionTick(input.missionId, db);
}

/** Platform-wide daily brief sweep — no single "acting user" for a
 *  scheduled cross-org digest; see `briefing.ts::orgsWorthBriefing`'s own
 *  tenant-scope-ok comment. */
export async function runMissionDailyBriefJob(db: Db = prisma) {
  return runDailyBriefSweep(db);
}

export async function runMissionWeeklyReviewJob(db: Db = prisma) {
  return runWeeklyReviewSweep(db);
}
