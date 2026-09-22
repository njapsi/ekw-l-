import { agent, missions, security } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Growth Agent jobs. The interactive chat runs inline in the web Route Handler
 * (streaming); this queue is for non-interactive turns (e.g. a scheduled
 * "weekly plan" message the agent answers for a user).
 *
 * Phase 10 reactivates this previously-idle queue (`docs/AGENT-RUNTIME.md`
 * §8) for Growth Mission background execution — `mission.sweep`/
 * `mission.tick`/`mission.daily.brief`/`mission.weekly.review` — rather than
 * standing up a second worker system for missions.
 */
export type AgentJob =
  | { type: 'turn'; organizationId: string; userId: string; conversationId?: string; message: string }
  | { type: 'mission.sweep' }
  | { type: 'mission.tick'; missionId: string }
  | { type: 'mission.daily.brief' }
  | { type: 'mission.weekly.review' };

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
  throw new Error(`unknown agent job: ${JSON.stringify(data)}`);
}
