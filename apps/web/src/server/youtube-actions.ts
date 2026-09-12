'use server';

import { revalidatePath } from 'next/cache';
import { integrations, isAppError, usage, users, youtube } from '@growth-agent/services';
import { requireActiveOrg, requirePermission } from '@/lib/auth';
import { analystConfigured, googleRedirectUri } from '@/lib/youtube';

const ATTESTATION_KEY = 'youtube.monetization.attestations';
export type MonetizationAttestations = Partial<
  Record<'twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', boolean>
>;

export async function getMonetizationAttestations(): Promise<MonetizationAttestations> {
  const { user } = await requireActiveOrg();
  return (await users.getPreference<MonetizationAttestations>(user.id, ATTESTATION_KEY)) ?? {};
}

export async function setMonetizationAttestationsAction(
  input: MonetizationAttestations,
): Promise<ActionResult> {
  try {
    const { user } = await requireActiveOrg();
    const clean: MonetizationAttestations = {};
    for (const k of ['twoStep', 'noStrikes', 'adsenseLinked', 'regionEligible'] as const) {
      if (typeof input[k] === 'boolean') clean[k] = input[k];
    }
    await users.setPreference(user.id, ATTESTATION_KEY, clean);
    revalidatePath('/app/youtube/monetization');
    return { ok: true, message: 'Saved.' };
  } catch (e) {
    return toError(e);
  }
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function disconnectYouTubeAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const conn = await integrations.getConnectionForOrg(org.id, 'YOUTUBE');
    if (!conn) return { ok: false, error: 'No YouTube connection to disconnect.' };
    await integrations.disconnectConnection(org.id, conn.id, user.id);
    revalidatePath('/app/integrations/youtube');
    revalidatePath('/app/youtube', 'layout');
    return { ok: true, message: 'YouTube disconnected.' };
  } catch (e) {
    return toError(e);
  }
}

/**
 * Runs a bounded sync inline (one channel: ~5–15 API calls, seconds). The same
 * `youtube.runYouTube*` functions are also registered as worker jobs
 * (apps/worker) for when volume needs offloading.
 */
export async function syncYouTubeAction(
  facet: 'all' | 'channel' | 'videos' | 'analytics' = 'all',
): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('crawl:run');
    const conn = await integrations.getConnectionForOrg(org.id, 'YOUTUBE');
    if (!conn) return { ok: false, error: 'Connect YouTube first.' };
    if (conn.status === 'REVOKED')
      return { ok: false, error: 'This YouTube account is disconnected.' };

    const redirectUri = await googleRedirectUri();
    const channel = await youtube.getPrimaryChannel(org.id).catch(() => null);

    let results;
    if (channel) {
      results = await youtube.runYouTubeChannelSync({
        organizationId: org.id,
        connectionId: conn.id,
        redirectUri,
        channelId: channel.id,
        facet,
      });
    } else {
      results = await youtube.runYouTubeFullSync({
        organizationId: org.id,
        connectionId: conn.id,
        redirectUri,
      });
    }

    const items = results.reduce((s, r) => s + r.itemsProcessed, 0);
    const quota = results.reduce((s, r) => s + r.quotaUnitsSpent, 0);
    revalidatePath('/app/youtube', 'layout');
    revalidatePath('/app/integrations/youtube');
    return { ok: true, message: `Synced ${items} item(s) using ${quota} quota unit(s).` };
  } catch (e) {
    return toError(e);
  }
}

export async function runAnalystAction(): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    if (!analystConfigured()) {
      return { ok: false, error: 'No AI provider configured. Set an API key to run the analyst.' };
    }
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'youtube' });
    await usage.enforceAiBudget({ organizationId: org.id });
    const channel = await youtube.getPrimaryChannel(org.id);
    if (!channel) return { ok: false, error: 'Sync a channel first.' };

    const res = await youtube.runYouTubeAnalystJob({
      organizationId: org.id,
      channelId: channel.id,
      trigger: 'dashboard',
    });
    revalidatePath('/app/youtube', 'layout');
    return {
      ok: true,
      message: res.usedModel
        ? `Analysis complete: ${res.recommendationIds.length} recommendation(s), ${res.contentIdeaIds.length} idea(s).`
        : 'Not enough data yet for a full analysis — synced a minimal report.',
    };
  } catch (e) {
    return toError(e);
  }
}
