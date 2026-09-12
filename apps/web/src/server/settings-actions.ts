'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { prisma } from '@growth-agent/db';
import { isAppError, organizations, recordAudit, users } from '@growth-agent/services';
import { requirePermission, requireUser } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function updateProfileAction(input: {
  name?: string;
  timezone?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await users.updateProfile(user.id, input);
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function inviteMemberAction(input: {
  email: string;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}): Promise<ActionResult & { inviteUrl?: string }> {
  try {
    const { user, org } = await requirePermission('member:manage');
    const { token } = await organizations.inviteMember(user.id, org.id, input);
    const h = await headers();
    const origin = h.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    revalidatePath('/app/settings');
    return { ok: true, inviteUrl: `${origin}/invite/${token}` };
  } catch (e) {
    return toError(e);
  }
}

export async function changeRoleAction(input: {
  targetUserId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('member:manage');
    await organizations.updateMemberRole(user.id, org.id, input);
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function renameOrgAction(input: { name: string }): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('org:update');
    const name = input.name.trim();
    if (name.length < 2) return { ok: false, error: 'Name must be at least 2 characters.' };
    await prisma.organization.update({ where: { id: org.id }, data: { name } });
    await recordAudit({
      organizationId: org.id,
      actorId: user.id,
      action: 'organization.renamed',
      targetType: 'organization',
      targetId: org.id,
      metadata: { name },
    });
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

// --- Danger zone: deletion (FORENSIC-AUDIT M-2) --------------------------

export async function requestOrgDeletionAction(input: {
  confirm: string;
}): Promise<ActionResult & { purgeAt?: string }> {
  try {
    const { user, org } = await requirePermission('org:delete');
    if (input.confirm.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
      return { ok: false, error: 'The organization name did not match.' };
    }
    const state = await organizations.requestOrganizationDeletion({
      actorUserId: user.id,
      organizationId: org.id,
    });
    revalidatePath('/app/settings');
    return { ok: true, purgeAt: state.purgeAt ?? undefined };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelOrgDeletionAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('org:delete');
    await organizations.cancelOrganizationDeletion({
      actorUserId: user.id,
      organizationId: org.id,
    });
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function requestAccountDeletionAction(input: {
  confirm: string;
}): Promise<ActionResult & { purgeAt?: string }> {
  try {
    const user = await requireUser();
    if (input.confirm.trim().toUpperCase() !== 'DELETE') {
      return { ok: false, error: 'Type DELETE to confirm.' };
    }
    const state = await organizations.requestAccountDeletion(user.id);
    return { ok: true, purgeAt: state.purgeAt ?? undefined };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelAccountDeletionAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await organizations.cancelAccountDeletion(user.id);
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}
