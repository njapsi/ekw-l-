'use server';

import { revalidatePath } from 'next/cache';
import { isAppError, research, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  researchId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

async function limited(key: string, limit: number, windowSec: number): Promise<ActionResult | null> {
  const rl = await security.checkRateLimit({ key, limit, windowSec });
  return rl.ok ? null : { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
}

export async function createResearchProjectAction(input: {
  question: string;
  objective?: string;
  scope?: string;
  config?: { seedUrls?: string[]; maxSources?: number };
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('research.run');
    const rl = await limited(`research-create:${org.id}:${user.id}`, 15, 3600);
    if (rl) return rl;
    const project = await research.createResearchProject(input, {
      organizationId: org.id,
      createdById: user.id,
    });
    revalidatePath('/app/research');
    return {
      ok: true,
      message:
        'Research started. It runs in the background — the status below updates as it progresses.',
      researchId: project.id,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelResearchProjectAction(researchId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('research.run');
    await research.cancelResearchProject(org.id, researchId, user.id);
    revalidatePath('/app/research');
    revalidatePath(`/app/research/${researchId}`);
    return { ok: true, message: 'Cancelled.' };
  } catch (e) {
    return toError(e);
  }
}
