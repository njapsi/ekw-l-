'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { apiKeys, governance, organizations, security, users } from '@growth-agent/services';
import {
  listUserSessions,
  revokeOtherSessions,
  revokeSessionByHandle,
  signIn,
  signOut,
  updateSession,
} from '@growth-agent/services/auth';
import { hasRecentAuth, requireActiveOrg, requirePermission, requireUser } from '@/lib/auth';
import { toActionError } from '@/lib/action-error';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  /** The change needs a fresh sign-in (Part 29 re-authentication). */
  reauth?: boolean;
}

const REAUTH: ActionResult = {
  ok: false,
  reauth: true,
  error: 'For your security, confirm it is you: we will email you a sign-in link, then try again.',
};

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

async function reqCtx() {
  const h = await headers();
  return { ip: security.clientIpFrom(h), userAgent: h.get('user-agent') };
}

async function limited(
  key: string,
  limit: number,
  windowSec: number,
): Promise<ActionResult | null> {
  const rl = await security.checkRateLimit({ key, limit, windowSec });
  return rl.ok
    ? null
    : { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
}

function refreshSettings() {
  revalidatePath('/app/settings', 'layout');
}

/**
 * Re-authentication by email: a fresh single-use sign-in link that lands back
 * on the settings page. Signing in through it sets a new `authAt`.
 */
export async function sendReauthLinkAction(returnTo: string): Promise<ActionResult> {
  const user = await requireUser();
  const path = returnTo.startsWith('/app/settings') ? returnTo : '/app/settings';
  const rl = await limited(`reauth:${user.id}`, 5, 3600);
  if (rl) return rl;
  await signIn('nodemailer', { email: user.email, redirect: false, callbackUrl: path });
  return {
    ok: true,
    message: `We sent a confirmation link to ${user.email}. Open it, then try again.`,
  };
}

// --- Profile ------------------------------------------------------------------

export async function updateProfileAction(input: {
  name?: string;
  timezone?: string;
  locale?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (input.timezone && !organizations.isValidTimeZone(input.timezone)) {
      return { ok: false, error: 'Unknown time zone. Use an IANA name such as America/Chicago.' };
    }
    await users.updateProfile(user.id, input);
    refreshSettings();
    return { ok: true, message: 'Saved.' };
  } catch (e) {
    return toActionError(e);
  }
}

// --- Organization ---------------------------------------------------------------

export async function updateOrgAction(input: {
  name?: string;
  slug?: string;
  timezone?: string;
  defaultLocale?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('organization.update');
    await organizations.updateOrganizationSettings(user.id, org.id, input);
    refreshSettings();
    revalidatePath('/app', 'layout');
    return { ok: true, message: 'Organization updated.' };
  } catch (e) {
    return toActionError(e);
  }
}

// --- Members & invitations ----------------------------------------------------

export async function inviteMemberAction(input: {
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER';
}): Promise<ActionResult & { inviteUrl?: string; emailed?: boolean }> {
  try {
    const { user, org } = await requirePermission('member.invite');
    const rl = await limited(`invite:${org.id}`, 30, 3600);
    if (rl) return rl;
    const res = await organizations.inviteMember(user.id, org.id, input, { appUrl: appUrl() });
    refreshSettings();
    return {
      ok: true,
      emailed: res.emailed,
      inviteUrl: `${appUrl()}/invite/${res.token}`,
      message: res.emailed
        ? `Invitation emailed to ${input.email}.`
        : 'Invitation created. Email delivery is not configured, so share the link below.',
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resendInvitationAction(
  invitationId: string,
): Promise<ActionResult & { inviteUrl?: string }> {
  try {
    const { user, org } = await requirePermission('member.invite');
    const rl = await limited(`invite:${org.id}`, 30, 3600);
    if (rl) return rl;
    const res = await organizations.resendInvitation(user.id, org.id, invitationId, {
      appUrl: appUrl(),
    });
    refreshSettings();
    return {
      ok: true,
      inviteUrl: `${appUrl()}/invite/${res.token}`,
      message: res.emailed
        ? 'Invitation re-sent. The previous link no longer works.'
        : 'New link created. The previous link no longer works.',
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('member.invite');
    await organizations.revokeInvitation(user.id, org.id, invitationId);
    refreshSettings();
    return { ok: true, message: 'Invitation revoked.' };
  } catch (e) {
    return toActionError(e);
  }
}

export async function changeRoleAction(input: {
  targetUserId: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER';
}): Promise<ActionResult> {
  try {
    const { user, org } = await requireActiveOrg();
    // Granting/removing OWNER is an ownership change: re-authenticate.
    if (input.role === 'OWNER' && !(await hasRecentAuth())) return REAUTH;
    await organizations.updateMemberRole(user.id, org.id, input);
    refreshSettings();
    return { ok: true, message: 'Role updated.' };
  } catch (e) {
    return toActionError(e);
  }
}

export async function removeMemberAction(targetUserId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requireActiveOrg();
    await organizations.removeMember(user.id, org.id, targetUserId);
    refreshSettings();
    return {
      ok: true,
      message: targetUserId === user.id ? 'You left the organization.' : 'Member removed.',
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function transferOwnershipAction(targetUserId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('ownership.transfer');
    if (!(await hasRecentAuth())) return REAUTH;
    await organizations.transferOwnership(user.id, org.id, targetUserId);
    refreshSettings();
    return { ok: true, message: 'Ownership transferred. You are now an admin.' };
  } catch (e) {
    return toActionError(e);
  }
}

// --- Security -------------------------------------------------------------------

export async function listSessionsAction() {
  const user = await requireUser();
  return listUserSessions(user.id, user.sessionId);
}

export async function revokeSessionAction(handle: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await revokeSessionByHandle(user.id, handle, user.sessionId, await reqCtx());
    refreshSettings();
    return { ok: true, message: 'That device was signed out.' };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const n = await revokeOtherSessions(user.id, user.sessionId, 'user_requested', await reqCtx());
    // sessionVersion was bumped (to end sessions from before session
    // tracking too); keep *this* browser signed in with a refreshed token.
    await updateSession({});
    refreshSettings();
    return {
      ok: true,
      message: `Signed out ${n} other session${n === 1 ? '' : 's'} (and any older sign-ins).`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

// --- API keys -----------------------------------------------------------------

export async function createApiKeyAction(input: {
  name: string;
  scopes: string[];
  expiresInDays: number | null;
}): Promise<ActionResult & { key?: string }> {
  try {
    const { user, org } = await requirePermission('api_key.create');
    const rl = await limited(`apikey-create:${org.id}`, 10, 3600);
    if (rl) return rl;
    const created = await apiKeys.createApiKey(user.id, org.id, {
      name: input.name,
      scopes: input.scopes as apiKeys.ApiScope[],
      expiresInDays: input.expiresInDays,
    });
    refreshSettings();
    return {
      ok: true,
      key: created.key,
      message: 'Copy this key now. It will not be shown again.',
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revokeApiKeyAction(keyId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('api_key.revoke');
    await apiKeys.revokeApiKey(user.id, org.id, keyId);
    refreshSettings();
    return { ok: true, message: 'Key revoked. Requests using it now fail.' };
  } catch (e) {
    return toActionError(e);
  }
}

// --- AI governance ------------------------------------------------------------

export async function updateGovernanceAction(policy: unknown): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('agent.configure');
    await governance.updateGovernancePolicy(user.id, org.id, policy);
    refreshSettings();
    return { ok: true, message: 'AI governance policy saved.' };
  } catch (e) {
    return toActionError(e);
  }
}

// --- Danger zone ------------------------------------------------------------------

export async function requestOrgDeletionAction(input: {
  confirm: string;
}): Promise<ActionResult & { purgeAt?: string }> {
  try {
    const { user, org } = await requirePermission('organization.delete');
    if (input.confirm.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
      return { ok: false, error: 'The organization name did not match.' };
    }
    if (!(await hasRecentAuth())) return REAUTH;
    const state = await organizations.requestOrganizationDeletion({
      actorUserId: user.id,
      organizationId: org.id,
    });
    refreshSettings();
    return { ok: true, purgeAt: state.purgeAt ?? undefined };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelOrgDeletionAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('organization.delete');
    await organizations.cancelOrganizationDeletion({
      actorUserId: user.id,
      organizationId: org.id,
    });
    refreshSettings();
    return { ok: true, message: 'Deletion cancelled.' };
  } catch (e) {
    return toActionError(e);
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
    if (!(await hasRecentAuth())) return REAUTH;
    const state = await organizations.requestAccountDeletion(user.id);
    return { ok: true, purgeAt: state.purgeAt ?? undefined };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelAccountDeletionAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await organizations.cancelAccountDeletion(user.id);
    refreshSettings();
    return { ok: true, message: 'Your account will not be deleted.' };
  } catch (e) {
    return toActionError(e);
  }
}

export async function deactivateAccountAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!(await hasRecentAuth())) return REAUTH;
    await users.deactivateAccount(user.id, await reqCtx());
    await signOut({ redirect: false });
    return {
      ok: true,
      message: 'Your account is deactivated. Sign in again any time to reactivate it.',
    };
  } catch (e) {
    return toActionError(e);
  }
}
