'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { content, isAppError, usage } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  projectId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function createRepurposeProjectAction(input: {
  sourceKind: 'youtube_video' | 'video_url' | 'transcript' | 'manual';
  youTubeVideoId?: string;
  url?: string;
  title?: string;
  description?: string;
  transcript?: string;
  body?: string;
  name?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    let source: Parameters<typeof content.createRepurposeProject>[0]['source'];
    switch (input.sourceKind) {
      case 'youtube_video':
        if (!input.youTubeVideoId) return { ok: false, error: 'Pick a video.' };
        source = {
          kind: 'youtube_video',
          youTubeVideoId: input.youTubeVideoId,
          transcript: input.transcript,
        };
        break;
      case 'video_url':
        if (!input.url) return { ok: false, error: 'Enter a URL.' };
        source = {
          kind: 'video_url',
          url: input.url,
          title: input.title,
          description: input.description,
          transcript: input.transcript,
        };
        break;
      case 'transcript':
        source = { kind: 'transcript', title: input.title, transcript: input.transcript ?? '' };
        break;
      default:
        source = { kind: 'manual', title: input.title, body: input.body ?? '' };
    }
    const project = await content.createRepurposeProject({
      organizationId: org.id,
      userId: user.id,
      name: input.name,
      source,
    });
    revalidatePath('/app/content');
    return { ok: true, projectId: project.id, message: 'Project created.' };
  } catch (e) {
    return toError(e);
  }
}

export async function analyzeProjectAction(projectId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('content:manage');
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'content' });
    const res = await content.analyzeProjectJob({
      organizationId: org.id,
      projectId,
      trigger: 'ui',
    });
    revalidatePath(`/app/content/${projectId}`);
    return {
      ok: true,
      message: res.usedModel
        ? `Analyzed: ${res.analysis.keyIdeas.length} key ideas, ${res.analysis.contentAngles.length} angles.`
        : 'Analyzed (no AI provider — mechanical summary).',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function generateAssetsAction(
  projectId: string,
  types?: string[],
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    // Server-side limit enforcement — the browser is never trusted (ADR-0025).
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'content' });
    // Phase 13: reserve the full requested amount atomically *before* the job
    // runs (closes the check-then-act race `enforceUsage` alone has under
    // concurrent requests — §55/§56), then settle down to the actual count
    // once the job finishes (fewer assets than requested is a normal
    // per-type failure mode, not an error).
    const requestedAmount = types?.length || 1;
    const reservationKey = `content_gen_reserve:${projectId}:${randomUUID()}`;
    await usage.reserveUsage({
      organizationId: org.id,
      meter: 'CONTENT_GENERATIONS',
      amount: requestedAmount,
      idempotencyKey: reservationKey,
      actorId: user.id,
      subjectType: 'repurpose_project',
      subjectId: projectId,
    });
    let res: Awaited<ReturnType<typeof content.generateAssetsJob>>;
    try {
      res = await content.generateAssetsJob({
        organizationId: org.id,
        userId: user.id,
        projectId,
        types: types as never,
        trigger: 'ui',
      });
    } catch (e) {
      await usage.releaseUsageReservation({
        organizationId: org.id,
        meter: 'CONTENT_GENERATIONS',
        quantity: requestedAmount,
        idempotencyKey: reservationKey,
        reason: 'generation job failed before producing any assets',
      });
      throw e;
    }
    const unused = requestedAmount - res.assetIds.length;
    if (unused > 0) {
      await usage.releaseUsageReservation({
        organizationId: org.id,
        meter: 'CONTENT_GENERATIONS',
        quantity: unused,
        idempotencyKey: reservationKey,
        reason: 'fewer assets generated than requested',
      });
    }
    revalidatePath(`/app/content/${projectId}`);
    return {
      ok: true,
      message: `Generated ${res.assetIds.length} draft(s) across ${Object.keys(res.byType).length} type(s).`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function editAssetAction(input: {
  assetId: string;
  projectId: string;
  body: string;
  editSummary?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.editAsset({
      organizationId: org.id,
      userId: user.id,
      assetId: input.assetId,
      body: input.body,
      editSummary: input.editSummary,
    });
    revalidatePath(`/app/content/${input.projectId}`);
    return { ok: true, message: 'Saved a new version. Status reset to draft.' };
  } catch (e) {
    return toError(e);
  }
}

export async function approveAssetAction(
  assetId: string,
  projectId: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.approveAsset({ organizationId: org.id, userId: user.id, assetId });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: 'Approved.' };
  } catch (e) {
    return toError(e);
  }
}

export async function scheduleAssetAction(
  assetId: string,
  projectId: string,
  scheduledForIso: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    const when = new Date(scheduledForIso);
    if (Number.isNaN(when.getTime())) return { ok: false, error: 'Invalid date/time.' };
    await content.scheduleAsset({
      organizationId: org.id,
      userId: user.id,
      assetId,
      scheduledFor: when,
    });
    revalidatePath(`/app/content/${projectId}`);
    return {
      ok: true,
      message: `Scheduled for ${when.toLocaleString()}. The engine will not publish it — you do.`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function unscheduleAssetAction(
  assetId: string,
  projectId: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.unscheduleAsset({ organizationId: org.id, userId: user.id, assetId });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: 'Unscheduled.' };
  } catch (e) {
    return toError(e);
  }
}

export async function markPublishedAction(
  assetId: string,
  projectId: string,
  target?: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.markAssetPublished({ organizationId: org.id, userId: user.id, assetId, target });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: 'Marked as published. (You published it — the engine did not.)' };
  } catch (e) {
    return toError(e);
  }
}

export async function markFailedAction(
  assetId: string,
  projectId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.markAssetFailed({
      organizationId: org.id,
      userId: user.id,
      assetId,
      reason: reason || 'Marked failed by user.',
    });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: 'Marked as failed.' };
  } catch (e) {
    return toError(e);
  }
}

export async function resetAssetAction(assetId: string, projectId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.resetAssetToDraft({ organizationId: org.id, userId: user.id, assetId });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: 'Reset to draft.' };
  } catch (e) {
    return toError(e);
  }
}

export async function revertAssetAction(
  assetId: string,
  projectId: string,
  versionNumber: number,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    await content.revertAsset({ organizationId: org.id, userId: user.id, assetId, versionNumber });
    revalidatePath(`/app/content/${projectId}`);
    return { ok: true, message: `Reverted to v${versionNumber} (as a new version).` };
  } catch (e) {
    return toError(e);
  }
}

export async function regenerateAssetAction(input: {
  assetId: string;
  projectId: string;
  instructions?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    // Server-side limit enforcement — the browser is never trusted (ADR-0025).
    // Same three-call metering pattern as generateAssetsAction above: this
    // also calls deps.model.generateObject under the hood and was previously
    // missing all of it (master instruction hard rule 11). Phase 13: an
    // atomic reservation (amount is always exactly 1 here, so there's no
    // partial-settle case — either the job produces the one regenerated
    // version, or it throws and the reservation is released in full).
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'content' });
    const reservationKey = `content_regen_reserve:${input.assetId}:${randomUUID()}`;
    await usage.reserveUsage({
      organizationId: org.id,
      meter: 'CONTENT_GENERATIONS',
      amount: 1,
      idempotencyKey: reservationKey,
      actorId: user.id,
      subjectType: 'content_asset',
      subjectId: input.assetId,
    });
    try {
      await content.regenerateAssetJob({
        organizationId: org.id,
        userId: user.id,
        assetId: input.assetId,
        instructions: input.instructions,
      });
    } catch (e) {
      await usage.releaseUsageReservation({
        organizationId: org.id,
        meter: 'CONTENT_GENERATIONS',
        quantity: 1,
        idempotencyKey: reservationKey,
        reason: 'regeneration failed',
      });
      throw e;
    }
    revalidatePath(`/app/content/${input.projectId}`);
    return { ok: true, message: 'Regenerated as a new version.' };
  } catch (e) {
    return toError(e);
  }
}
