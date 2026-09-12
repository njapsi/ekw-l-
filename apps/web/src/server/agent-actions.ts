'use server';

import { revalidatePath } from 'next/cache';
import { agent, isAppError } from '@growth-agent/services';
import { requireActiveOrg, requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  taskId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

// --- conversations -------------------------------------------------

export async function renameConversationAction(
  conversationId: string,
  title: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requireActiveOrg();
    await agent.renameConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId,
      title,
    });
    revalidatePath('/app/agent', 'layout');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteConversationAction(conversationId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requireActiveOrg();
    await agent.deleteConversation({ organizationId: org.id, userId: user.id, conversationId });
    revalidatePath('/app/agent', 'layout');
    return { ok: true, message: 'Conversation deleted.' };
  } catch (e) {
    return toError(e);
  }
}

// --- tasks --------------------------------------------------------

export async function createTaskFromRecommendationAction(input: {
  recommendationId: string;
  conversationId?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('agent:run');
    const task = await agent.createTaskFromRecommendation({
      organizationId: org.id,
      userId: user.id,
      recommendationId: input.recommendationId,
      sourceConversationId: input.conversationId,
    });
    revalidatePath('/app/tasks');
    return { ok: true, message: `Task created: "${task.title}".`, taskId: task.id };
  } catch (e) {
    return toError(e);
  }
}

export async function createAdHocTaskAction(input: {
  title: string;
  instructions: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  affectedUrls?: string[];
  conversationId?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('agent:run');
    const task = await agent.createTask({
      organizationId: org.id,
      userId: user.id,
      title: input.title,
      instructions: input.instructions,
      priority: input.priority,
      affectedUrls: input.affectedUrls,
      sourceConversationId: input.conversationId,
    });
    revalidatePath('/app/tasks');
    return { ok: true, message: `Task created.`, taskId: task.id };
  } catch (e) {
    return toError(e);
  }
}

export async function updateTaskStatusAction(
  taskId: string,
  status: 'PENDING' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED',
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('agent:run');
    await agent.updateTaskStatus({ organizationId: org.id, userId: user.id, taskId, status });
    revalidatePath('/app/tasks');
    return { ok: true, message: `Task moved to ${status.toLowerCase().replace('_', ' ')}.` };
  } catch (e) {
    return toError(e);
  }
}

// --- memory (manual goals / preferences) --------------------------

export async function setGoalAction(input: {
  kind: 'USER_GOAL' | 'ORG_GOAL' | 'PREFERENCE';
  label: string;
  value: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('agent:run');
    const stored = await agent.rememberItem({
      organizationId: org.id,
      userId: input.kind === 'ORG_GOAL' ? null : user.id,
      kind: input.kind,
      label: input.label,
      value: input.value,
      sourceType: 'manual',
    });
    revalidatePath('/app/agent', 'layout');
    return stored
      ? { ok: true, message: 'Saved.' }
      : { ok: false, error: 'That could not be saved (empty or looked sensitive).' };
  } catch (e) {
    return toError(e);
  }
}
