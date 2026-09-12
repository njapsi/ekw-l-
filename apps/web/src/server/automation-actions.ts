'use server';

import { revalidatePath } from 'next/cache';
import { automation, isAppError } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface AutomationActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  automationId?: string;
}

function toError(e: unknown): AutomationActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

const TASK_TYPES = new Set(automation.AUTOMATION_TASK_TYPES as readonly string[]);
const CADENCES = new Set(automation.AUTOMATION_CADENCES as readonly string[]);

export interface AutomationFormInput {
  name: string;
  taskType: string;
  cadence: string;
  cronExpression?: string;
  hour?: number;
  minute?: number;
  weekday?: number;
  monthday?: number;
  config?: Record<string, unknown>;
  maxRetries?: number;
}

function normalize(input: AutomationFormInput) {
  if (!TASK_TYPES.has(input.taskType)) throw new Error('bad task type');
  if (!CADENCES.has(input.cadence)) throw new Error('bad cadence');
  return {
    name: input.name,
    taskType: input.taskType as never,
    cadence: input.cadence as never,
    cronExpression: input.cronExpression?.trim() || undefined,
    hour: numOrUndef(input.hour),
    minute: numOrUndef(input.minute),
    weekday: numOrUndef(input.weekday),
    monthday: numOrUndef(input.monthday),
    config: input.config ?? {},
    maxRetries: numOrUndef(input.maxRetries),
  };
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number | undefined);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export async function createAutomationAction(
  input: AutomationFormInput,
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    const rule = await automation.createAutomation({
      organizationId: org.id,
      userId: user.id,
      ...normalize(input),
    });
    revalidatePath('/app/automations');
    return { ok: true, automationId: rule.id, message: 'Automation created.' };
  } catch (e) {
    return toError(e);
  }
}

export async function updateAutomationAction(
  automationId: string,
  input: Partial<AutomationFormInput>,
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    await automation.updateAutomation({
      organizationId: org.id,
      userId: user.id,
      automationId,
      ...normalize({
        name: input.name ?? '',
        taskType: input.taskType ?? [...TASK_TYPES][0]!,
        cadence: input.cadence ?? 'WEEKLY',
        cronExpression: input.cronExpression,
        hour: input.hour,
        minute: input.minute,
        weekday: input.weekday,
        monthday: input.monthday,
        config: input.config,
        maxRetries: input.maxRetries,
      }),
    });
    revalidatePath('/app/automations');
    revalidatePath(`/app/automations/${automationId}`);
    return { ok: true, message: 'Automation updated.' };
  } catch (e) {
    return toError(e);
  }
}

export async function setAutomationStatusAction(
  automationId: string,
  status: 'ACTIVE' | 'PAUSED',
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    await automation.setAutomationStatus({
      organizationId: org.id,
      userId: user.id,
      automationId,
      status,
    });
    revalidatePath('/app/automations');
    revalidatePath(`/app/automations/${automationId}`);
    return {
      ok: true,
      message: status === 'ACTIVE' ? 'Automation resumed.' : 'Automation paused.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteAutomationAction(
  automationId: string,
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    await automation.deleteAutomation({ organizationId: org.id, userId: user.id, automationId });
    revalidatePath('/app/automations');
    return { ok: true, message: 'Automation deleted.' };
  } catch (e) {
    return toError(e);
  }
}

export async function runAutomationNowAction(
  automationId: string,
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    const res = await automation.runAutomationNowJob({
      organizationId: org.id,
      userId: user.id,
      automationId,
    });
    revalidatePath(`/app/automations/${automationId}`);
    if (res.status === 'SUCCEEDED') return { ok: true, message: res.summary ?? 'Run complete.' };
    if (res.status === 'SKIPPED') {
      return { ok: false, error: `Skipped: ${res.error ?? 'owner permission changed'}.` };
    }
    if (res.status === 'RETRY_SCHEDULED') {
      return { ok: false, error: `Run failed; a retry was scheduled. ${res.error ?? ''}`.trim() };
    }
    return { ok: false, error: res.error ?? `Run ended: ${res.status.toLowerCase()}.` };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelAutomationRunAction(
  automationId: string,
  runId: string,
): Promise<AutomationActionResult> {
  try {
    const { org, user } = await requirePermission('automation:manage');
    await automation.cancelRun({ organizationId: org.id, userId: user.id, runId });
    revalidatePath(`/app/automations/${automationId}`);
    return { ok: true, message: 'Run cancelled.' };
  } catch (e) {
    return toError(e);
  }
}
