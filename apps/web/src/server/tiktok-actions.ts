'use server';

import { revalidatePath } from 'next/cache';
import { integrations, isAppError, tiktok, usage } from '@growth-agent/services';
import { requireActiveOrg, requirePermission } from '@/lib/auth';
import { analystConfigured, tiktokRedirectUri } from '@/lib/tiktok';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function disconnectTikTokAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const conn = await integrations.getConnectionForOrg(org.id, 'TIKTOK');
    if (!conn) return { ok: false, error: 'No TikTok connection to disconnect.' };
    await integrations.disconnectConnection(org.id, conn.id, user.id);
    revalidatePath('/app/integrations/tiktok');
    revalidatePath('/app/tiktok', 'layout');
    return { ok: true, message: 'TikTok disconnected.' };
  } catch (e) {
    return toError(e);
  }
}

export async function syncTikTokAction(
  facet: 'all' | 'account' | 'videos' = 'all',
): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('crawl:run');
    const conn = await integrations.getConnectionForOrg(org.id, 'TIKTOK');
    if (!conn) return { ok: false, error: 'Connect TikTok first.' };
    if (conn.status === 'REVOKED')
      return { ok: false, error: 'This TikTok account is disconnected.' };

    const redirectUri = await tiktokRedirectUri();
    const account = await tiktok.getPrimaryAccount(org.id).catch(() => null);

    const results = account
      ? await tiktok.runTikTokAccountSync({
          organizationId: org.id,
          connectionId: conn.id,
          redirectUri,
          accountId: account.id,
          facet,
        })
      : await tiktok.runTikTokFullSync({
          organizationId: org.id,
          connectionId: conn.id,
          redirectUri,
        });

    const items = results.reduce((s, r) => s + r.itemsProcessed, 0);
    const skips = results.filter((r) => r.skipped).map((r) => r.skipped);
    revalidatePath('/app/tiktok', 'layout');
    revalidatePath('/app/integrations/tiktok');
    return {
      ok: true,
      message: `Synced ${items} item(s).${skips.length ? ` Skipped: ${skips.join('; ')}.` : ''}`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function runTikTokAnalystAction(): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    if (!analystConfigured()) {
      return { ok: false, error: 'No AI provider configured. Set an API key to run the analyst.' };
    }
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'tiktok' });
    await usage.enforceAiBudget({ organizationId: org.id });
    const account = await tiktok.getPrimaryAccount(org.id);
    if (!account) return { ok: false, error: 'Sync an account first.' };
    const res = await tiktok.runTikTokAnalystJob({
      organizationId: org.id,
      accountId: account.id,
      trigger: 'dashboard',
    });
    revalidatePath('/app/tiktok', 'layout');
    return {
      ok: true,
      message: res.usedModel
        ? `Analysis complete: ${res.recommendationIds.length} recommendation(s), ${res.contentIdeaIds.length} idea(s).`
        : 'Not enough data yet — synced a minimal report.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function regenerateTikTokOpportunitiesAction(): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('agent:run');
    const account = await tiktok.getPrimaryAccount(org.id);
    if (!account) return { ok: false, error: 'Sync an account first.' };
    const videos = await tiktok.listVideosPage(org.id, { limit: 50, sort: 'recent' });
    const rows = videos.videos.map((v) => ({
      videoId: v.videoId,
      caption: v.caption,
      createTime: v.createTime,
      durationSec: v.durationSec,
      viewCount: v.viewCount ? BigInt(v.viewCount) : null,
      likeCount: v.likeCount ? BigInt(v.likeCount) : null,
      commentCount: v.commentCount ? BigInt(v.commentCount) : null,
      shareCount: v.shareCount ? BigInt(v.shareCount) : null,
      hashtags: v.hashtags,
    }));
    const drafts = tiktok.buildOpportunityDrafts(rows);
    const written = await tiktok.upsertOpportunities({
      organizationId: org.id,
      tikTokAccountId: account.id,
      drafts,
    });
    revalidatePath('/app/tiktok/opportunities');
    return {
      ok: true,
      message:
        written > 0
          ? `${written} content opportunit${written === 1 ? 'y' : 'ies'} identified.`
          : 'No new content opportunities from the currently synced videos.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function promoteTikTokOpportunityAction(opportunityId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    await tiktok.promoteTikTokOpportunityToTask({
      organizationId: org.id,
      userId: user.id,
      opportunityId,
    });
    revalidatePath('/app/tiktok/opportunities');
    revalidatePath('/app/tasks');
    return { ok: true, message: 'Added to Tasks.' };
  } catch (e) {
    return toError(e);
  }
}

export async function dismissTikTokOpportunityAction(opportunityId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    await tiktok.updateTikTokOpportunityStatus({
      organizationId: org.id,
      userId: user.id,
      opportunityId,
      status: 'DISMISSED',
    });
    revalidatePath('/app/tiktok/opportunities');
    return { ok: true, message: 'Dismissed.' };
  } catch (e) {
    return toError(e);
  }
}

export async function generateTikTokContentPlanAction(
  cadencePerWeek: number,
  weeks: number,
): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    const account = await tiktok.getPrimaryAccount(org.id);
    if (!account) return { ok: false, error: 'Sync an account first.' };
    const opportunities = await tiktok.listTikTokOpportunities(org.id, { status: 'SUGGESTED' });
    const drafts = tiktok.generateContentPlanDrafts({
      opportunities: opportunities.map((o) => ({
        type: o.type,
        title: o.title,
        description: o.description,
        evidence: o.evidence as never,
        factors: {
          evidenceStrength: o.evidenceStrength,
          historicalPerformance: o.historicalPerformance,
          contentGap: o.contentGap,
          executionFeasibility: o.executionFeasibility,
        },
        priorityScore: o.priorityScore,
        confidence: o.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
        recommendedActions: o.recommendedActions,
        relatedVideoIds: o.relatedVideoIds,
      })),
      cadencePerWeek,
      weeks,
      startDate: new Date(),
    });
    await tiktok.saveContentPlanEntries({
      organizationId: org.id,
      tikTokAccountId: account.id,
      userId: user.id,
      drafts,
    });
    revalidatePath('/app/tiktok/calendar');
    return { ok: true, message: `${drafts.length} content-plan slot(s) planned.` };
  } catch (e) {
    return toError(e);
  }
}

export async function createTikTokExperimentAction(input: {
  hypothesis: string;
  variable: string;
  successMetric: string;
  expectedDirection: 'INCREASE' | 'DECREASE';
  experimentNote: string;
}): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('agent:run');
    const account = await tiktok.getPrimaryAccount(org.id);
    if (!account) return { ok: false, error: 'Sync an account first.' };
    if (!input.hypothesis.trim() || !input.variable.trim() || !input.successMetric.trim()) {
      return { ok: false, error: 'Hypothesis, variable, and success metric are required.' };
    }
    await tiktok.createExperiment({
      organizationId: org.id,
      tikTokAccountId: account.id,
      userId: user.id,
      hypothesis: input.hypothesis,
      variable: input.variable,
      baseline: {},
      experimentNote: input.experimentNote,
      successMetric: input.successMetric,
      expectedDirection: input.expectedDirection,
      startDate: new Date(),
    });
    revalidatePath('/app/tiktok/experiments');
    return { ok: true, message: 'Experiment created.' };
  } catch (e) {
    return toError(e);
  }
}

// --- Publishing ---------------------------------------------------------

export interface DraftInput {
  sourceUrl: string;
  caption: string;
  hashtags: string;
  privacy: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

export async function createTikTokDraftAction(input: DraftInput): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('publish:external');
    const account = await tiktok.getPrimaryAccount(org.id);
    if (!account) return { ok: false, error: 'Sync a TikTok account first.' };
    await tiktok.createPublishDraft({
      organizationId: org.id,
      userId: user.id,
      accountId: account.id,
      sourceUrl: input.sourceUrl.trim(),
      caption: input.caption,
      hashtags: input.hashtags
        .split(/[\s,]+/)
        .map((h) => h.replace(/^#/, ''))
        .filter(Boolean),
      privacy: input.privacy,
      disableComment: input.disableComment,
      disableDuet: input.disableDuet,
      disableStitch: input.disableStitch,
    });
    revalidatePath('/app/tiktok/publishing');
    return { ok: true, message: 'Draft created. Review and approve it to publish.' };
  } catch (e) {
    return toError(e);
  }
}

export async function approveTikTokPublishAction(publishId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('publish:external');
    const conn = await integrations.getConnectionForOrg(org.id, 'TIKTOK');
    if (!conn) return { ok: false, error: 'TikTok is not connected.' };
    const res = await tiktok.approveTikTokPublish({
      organizationId: org.id,
      connectionId: conn.id,
      redirectUri: await tiktokRedirectUri(),
      userId: user.id,
      publishId,
      approve: true, // explicit — this action IS the approval
    });
    revalidatePath('/app/tiktok/publishing');
    return { ok: true, message: `Submitted to TikTok (status: ${res.status.toLowerCase()}).` };
  } catch (e) {
    return toError(e);
  }
}

export async function refreshTikTokStatusAction(publishRowId: string): Promise<ActionResult> {
  try {
    const { org } = await requireActiveOrg();
    const conn = await integrations.getConnectionForOrg(org.id, 'TIKTOK');
    if (!conn) return { ok: false, error: 'TikTok is not connected.' };
    const res = await tiktok.refreshTikTokPublishStatus({
      organizationId: org.id,
      connectionId: conn.id,
      redirectUri: await tiktokRedirectUri(),
      publishRowId,
    });
    revalidatePath('/app/tiktok/publishing');
    return { ok: true, message: `Status: ${res.status.toLowerCase()}.` };
  } catch (e) {
    return toError(e);
  }
}
