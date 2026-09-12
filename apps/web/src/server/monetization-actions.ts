'use server';

import { revalidatePath } from 'next/cache';
import { isAppError, monetization, usage } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function saveBusinessProfileAction(input: {
  niche?: string;
  audienceDescription?: string;
  offerings?: string;
  goals?: string;
  emailListSize?: string;
  hasWebsite?: boolean;
  sellsProducts?: boolean;
  doesSponsorships?: boolean;
  doesAffiliates?: boolean;
  doesConsulting?: boolean;
  hasMembership?: boolean;
  hasCourse?: boolean;
  twoStep?: boolean;
  noStrikes?: boolean;
  adsenseLinked?: boolean;
  regionEligible?: boolean;
  notes?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    await monetization.upsertBusinessProfile({
      organizationId: org.id,
      userId: user.id,
      niche: input.niche,
      audienceDescription: input.audienceDescription,
      offerings: (input.offerings ?? '')
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      goals: (input.goals ?? '')
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      emailListSize: input.emailListSize ? Number(input.emailListSize) : null,
      hasWebsite: input.hasWebsite,
      sellsProducts: input.sellsProducts,
      doesSponsorships: input.doesSponsorships,
      doesAffiliates: input.doesAffiliates,
      doesConsulting: input.doesConsulting,
      hasMembership: input.hasMembership,
      hasCourse: input.hasCourse,
      attestations: {
        twoStep: input.twoStep,
        noStrikes: input.noStrikes,
        adsenseLinked: input.adsenseLinked,
        regionEligible: input.regionEligible,
      },
      notes: input.notes,
    });
    revalidatePath('/app/monetization');
    return { ok: true, message: 'Business profile saved.' };
  } catch (e) {
    return toError(e);
  }
}

export async function runMonetizationScanAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    await usage.enforceAiUserLimit({
      organizationId: org.id,
      userId: user.id,
      scope: 'monetization',
    });
    await usage.enforceAiBudget({ organizationId: org.id });
    const res = await monetization.runMonetizationScanJob({
      organizationId: org.id,
      userId: user.id,
      trigger: 'ui',
    });
    revalidatePath('/app/monetization');
    return {
      ok: true,
      message: `Scan complete: ${res.opportunityIds.length} opportunit${res.opportunityIds.length === 1 ? 'y' : 'ies'}.${
        res.usedModel && !res.grounded
          ? ' (Model prose could not be grounded and was replaced.)'
          : ''
      }`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function updateOpportunityStatusAction(
  opportunityId: string,
  status: 'SUGGESTED' | 'IN_PROGRESS' | 'ACTIVE' | 'COMPLETED' | 'DISMISSED',
  reason?: string,
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    await monetization.updateOpportunityStatus({
      organizationId: org.id,
      userId: user.id,
      opportunityId,
      status,
      reason,
    });
    revalidatePath('/app/monetization');
    return { ok: true, message: `Moved to ${status.toLowerCase().replace('_', ' ')}.` };
  } catch (e) {
    return toError(e);
  }
}

export async function promoteOpportunityToTaskAction(opportunityId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    const task = await monetization.promoteOpportunityToTask({
      organizationId: org.id,
      userId: user.id,
      opportunityId,
    });
    revalidatePath('/app/monetization');
    revalidatePath('/app/tasks');
    return { ok: true, message: `Task created: "${task.title}".` };
  } catch (e) {
    return toError(e);
  }
}

export async function addRevenueEntryAction(input: {
  channel: string;
  source: string;
  amount: string;
  currency?: string;
  periodStart: string;
  periodEnd: string;
  isRecurring?: boolean;
  note?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    const amount = Number(input.amount);
    await monetization.addRevenueEntry({
      organizationId: org.id,
      userId: user.id,
      channel: input.channel as never,
      source: input.source,
      amount,
      currency: input.currency,
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      isRecurring: input.isRecurring,
      note: input.note,
    });
    revalidatePath('/app/monetization');
    return { ok: true, message: 'Revenue entry added.' };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteRevenueEntryAction(entryId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('monetization:manage');
    await monetization.deleteRevenueEntry({ organizationId: org.id, userId: user.id, entryId });
    revalidatePath('/app/monetization');
    return { ok: true, message: 'Entry removed (kept in history).' };
  } catch (e) {
    return toError(e);
  }
}
