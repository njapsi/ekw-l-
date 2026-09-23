'use server';

import { revalidatePath } from 'next/cache';
import { agent, isAppError, missions, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  missionId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

function refresh(missionId?: string) {
  revalidatePath('/app/missions');
  if (missionId) revalidatePath(`/app/missions/${missionId}`);
}

async function limited(key: string, limit: number, windowSec: number): Promise<ActionResult | null> {
  const rl = await security.checkRateLimit({ key, limit, windowSec });
  return rl.ok ? null : { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
}

export async function createMissionAction(input: {
  name: string;
  objective: string;
  description?: string;
  targetDate?: string;
  platforms?: string[];
  autonomyLevel?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    const rl = await limited(`mission-create:${org.id}:${user.id}`, 20, 3600);
    if (rl) return rl;
    const mission = await missions.createMission(
      {
        organizationId: org.id,
        userId: user.id,
        input: {
          name: input.name,
          objective: input.objective,
          description: input.description,
          targetDate: input.targetDate,
          platforms: input.platforms,
          autonomyLevel: input.autonomyLevel,
        },
      },
    );
    refresh();
    return { ok: true, message: 'Mission created as a draft.', missionId: mission.id };
  } catch (e) {
    return toError(e);
  }
}

export async function planMissionAction(missionId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    const rl = await limited(`mission-plan:${org.id}:${user.id}`, 20, 3600);
    if (rl) return rl;
    // Phase 11: knowledge-aware, model-refined planning when a provider is
    // configured — reuses the same env resolution the chat agent uses
    // (`growthAgentDepsFromEnv`), so planning degrades to fully
    // deterministic exactly as it always has when no provider is set.
    const deps = agent.growthAgentDepsFromEnv({ organizationId: org.id, actorId: user.id });
    const mission = await missions.planMission({
      organizationId: org.id,
      userId: user.id,
      missionId,
      model: deps.model,
      embeddingModel: deps.embeddingModel,
    });
    refresh(missionId);
    return {
      ok: true,
      message: `Plan generated: ${mission.taskCount} task(s) across the mission's milestones. Review it before activating.`,
      missionId: mission.id,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function activateMissionAction(missionId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    const mission = await missions.activateMission({ organizationId: org.id, userId: user.id, missionId });
    refresh(missionId);
    return { ok: true, message: 'Mission activated.', missionId: mission.id };
  } catch (e) {
    return toError(e);
  }
}

export async function pauseMissionAction(missionId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    await missions.pauseMission({ organizationId: org.id, userId: user.id, missionId });
    refresh(missionId);
    return { ok: true, message: 'Mission paused. No new actions will start.' };
  } catch (e) {
    return toError(e);
  }
}

export async function resumeMissionAction(missionId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    await missions.resumeMission({ organizationId: org.id, userId: user.id, missionId });
    refresh(missionId);
    return { ok: true, message: 'Mission resumed.' };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelMissionAction(missionId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    await missions.cancelMission({ organizationId: org.id, userId: user.id, missionId });
    refresh(missionId);
    return { ok: true, message: 'Mission cancelled. Its history is preserved.' };
  } catch (e) {
    return toError(e);
  }
}

/** The explicit "run this task now" trigger (§54) — for a task the
 *  autonomy level leaves for a human to start (e.g. an ASSISTED mission's
 *  prepared draft action). */
export async function runMissionTaskNowAction(missionId: string, taskId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('mission.manage');
    const rl = await limited(`mission-task-run:${org.id}:${user.id}`, 30, 3600);
    if (rl) return rl;
    const result = await missions.runMissionTaskManually({ organizationId: org.id, userId: user.id, missionId, taskId });
    refresh(missionId);
    if (result.outcome === 'ran_task') return { ok: true, message: `Ran: ${result.detail}` };
    return { ok: false, error: result.detail ?? 'This task could not be run right now.' };
  } catch (e) {
    return toError(e);
  }
}
