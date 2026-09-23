import { agent, knowledge, missions, research, security } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Growth Agent jobs. The interactive chat runs inline in the web Route Handler
 * (streaming); this queue is for non-interactive turns (e.g. a scheduled
 * "weekly plan" message the agent answers for a user).
 *
 * Phase 10 reactivates this previously-idle queue (`docs/AGENT-RUNTIME.md`
 * §8) for Growth Mission background execution — `mission.sweep`/
 * `mission.tick`/`mission.daily.brief`/`mission.weekly.review`. Phase 11
 * adds the knowledge-maintenance sweeps and research-project execution to
 * the SAME queue, rather than standing up a second worker system.
 */
export type AgentJob =
  | { type: 'turn'; organizationId: string; userId: string; conversationId?: string; message: string }
  | { type: 'mission.sweep' }
  | { type: 'mission.tick'; missionId: string }
  | { type: 'mission.daily.brief' }
  | { type: 'mission.weekly.review' }
  | { type: 'knowledge.freshness.check' }
  | { type: 'knowledge.conflict.detect' }
  | { type: 'memory.expire' }
  | { type: 'research.execute'; organizationId: string; researchProjectId: string }
  | { type: 'research.dispatch.sweep' }
  | { type: 'research.cleanup' };

export async function processAgentJob(job: Job<AgentJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'agent job');
  if (data.type === 'turn') {
    // Re-derive authorization now, from the database (Phase 2, Part 22).
    await security.assertJobAuthorized(
      { organizationId: data.organizationId, actorUserId: data.userId, jobId: job.id },
      'agent.run',
    );
    const res = await agent.runGrowthAgentTurnJob({
      organizationId: data.organizationId,
      userId: data.userId,
      conversationId: data.conversationId,
      message: data.message,
      trigger: 'worker',
    });
    return { conversationId: res.conversationId, agentRunId: res.agentRunId };
  }
  if (data.type === 'mission.sweep') {
    return missions.runMissionSweepJob();
  }
  if (data.type === 'mission.tick') {
    return missions.runMissionTickJob({ missionId: data.missionId });
  }
  if (data.type === 'mission.daily.brief') {
    return missions.runMissionDailyBriefJob();
  }
  if (data.type === 'mission.weekly.review') {
    return missions.runMissionWeeklyReviewJob();
  }
  if (data.type === 'knowledge.freshness.check') {
    return knowledge.runKnowledgeFreshnessSweepJob();
  }
  if (data.type === 'knowledge.conflict.detect') {
    return knowledge.runKnowledgeConflictSweepJob();
  }
  if (data.type === 'memory.expire') {
    return knowledge.runMemoryCandidateExpirySweepJob();
  }
  if (data.type === 'research.execute') {
    const deps = agent.growthAgentDepsFromEnv({ organizationId: data.organizationId });
    return research.runResearchProjectJob(
      { organizationId: data.organizationId, researchProjectId: data.researchProjectId },
      { model: deps.model },
    );
  }
  if (data.type === 'research.dispatch.sweep') {
    // No single org here — the deps model is resolved without a usage sink
    // (per-project usage is metered inside `runResearchProject` itself via
    // `RESEARCH_CALLS`, scoped to each project's own organizationId).
    const deps = agent.growthAgentDepsFromEnv();
    return research.runResearchDispatchSweepJob({ model: deps.model });
  }
  if (data.type === 'research.cleanup') {
    return research.runResearchCleanupSweepJob();
  }
  throw new Error(`unknown agent job: ${JSON.stringify(data)}`);
}
