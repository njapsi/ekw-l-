'use server';

import { revalidatePath } from 'next/cache';
import {
  approvals,
  integrationSync,
  integrations,
  isAppError,
  rbac,
  security,
  usage,
  wordpress,
} from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { googleRedirectUri } from '@/lib/youtube';
import { tiktokRedirectUri } from '@/lib/tiktok';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

function toError(e: unknown, fallback = 'Something went wrong. Please try again.'): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: fallback };
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

function refresh() {
  revalidatePath('/app/integrations');
  revalidatePath('/app/integrations/wordpress');
  revalidatePath('/app/integrations/approvals');
}

// --- connection test -------------------------------------------------------

export interface TestConnectionResult {
  ok: boolean;
  title?: string;
  explanation?: string;
  recommendedAction?: string;
  referenceId?: string;
  error?: string;
}

/**
 * Run a real, read-only probe against a connected provider and persist the
 * result. Rate-limited because each call costs the org provider quota.
 */
export async function testConnectionAction(connectionId: string): Promise<TestConnectionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`connection-test:${org.id}:${user.id}`, 10, 300);
    if (rl) return rl;

    const conn = await integrations.requireConnection(org.id, connectionId);
    // Only used if the probe must refresh first; must match the registered URI.
    const redirectUri =
      conn.provider === 'TIKTOK' ? await tiktokRedirectUri() : await googleRedirectUri();
    const result = await integrations.testConnection(org.id, connectionId, redirectUri);

    refresh();
    return {
      ok: result.ok,
      title: result.diagnostic.title,
      explanation: result.diagnostic.explanation,
      recommendedAction: result.diagnostic.recommendedAction,
      referenceId: result.diagnostic.referenceId,
    };
  } catch (e) {
    return toError(e, 'Could not run the connection test. Please try again.');
  }
}

// --- sync ------------------------------------------------------------------

export async function syncNowAction(key: string, connectionRef: string): Promise<ActionResult> {
  try {
    // Same permission the existing per-provider "sync now" buttons use.
    const { user, org } = await requirePermission('crawl:run');
    if (!integrationSync.isSyncable(key))
      return { ok: false, error: 'This integration does not sync.' };
    const rl = await limited(`sync-now:${org.id}:${user.id}`, 6, 600);
    if (rl) return rl;
    const out = await integrationSync.runIntegrationSync({
      organizationId: org.id,
      key,
      connectionRef,
      trigger: 'MANUAL',
    });
    refresh();
    if (out.status === 'COMPLETED') {
      return {
        ok: true,
        message: `Synced ${out.items.toLocaleString('en-US')} item${out.items === 1 ? '' : 's'}.${out.detail ? ` ${out.detail}` : ''}`,
      };
    }
    if (out.status === 'SKIPPED')
      return { ok: true, message: 'A sync is already running for this connection.' };
    return { ok: false, error: `Sync failed: ${out.error ?? 'unknown error'}` };
  } catch (e) {
    return toError(e);
  }
}

// --- WordPress ---------------------------------------------------------------

export async function connectWordPressAction(input: {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`wp-connect:${org.id}:${user.id}`, 10, 900);
    if (rl) return rl;

    // A reconnect of an existing site does not consume a new account slot.
    const siteUrl = wordpress.normalizeSiteUrl(input.siteUrl);
    const existing = (await wordpress.listWordPressSites(org.id)).some(
      (s) => s.siteUrl === siteUrl,
    );
    if (!existing) {
      await usage.enforceUsage({ organizationId: org.id, meter: 'CONNECTED_ACCOUNTS', amount: 1 });
    }
    const site = await wordpress.connectWordPressSite({
      organizationId: org.id,
      userId: user.id,
      siteUrl,
      username: input.username,
      applicationPassword: input.applicationPassword,
    });
    // First content pull right away, so the page is not empty. A failure here
    // does not undo the (verified) connection; it is shown on the sync status.
    const sync = await integrationSync.runIntegrationSync({
      organizationId: org.id,
      key: 'WORDPRESS',
      connectionRef: site.id,
      trigger: 'MANUAL',
    });
    refresh();
    return {
      ok: true,
      message:
        sync.status === 'COMPLETED'
          ? `Connected ${site.siteName || site.siteUrl} and synced ${sync.items} posts/pages.`
          : `Connected ${site.siteName || site.siteUrl}, but the first sync failed: ${sync.error ?? 'unknown error'}`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function checkWordPressAction(siteId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`wp-check:${org.id}:${user.id}`, 10, 300);
    if (rl) return rl;
    const site = await wordpress.requireWordPressSite(org.id, siteId);
    const res = await wordpress.checkWordPressSite(site);
    refresh();
    return res.ok
      ? {
          ok: true,
          message: `Connection works. Detected capabilities: ${res.capabilities.join(', ') || 'none'}.`,
        }
      : {
          ok: false,
          error: res.authFailed
            ? 'WordPress rejected the application password. Reconnect with a new one.'
            : `Check failed: ${res.error ?? 'unknown error'}`,
        };
  } catch (e) {
    return toError(e);
  }
}

export async function disconnectWordPressAction(siteId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const res = await wordpress.disconnectWordPressSite(org.id, siteId, user.id);
    refresh();
    return {
      ok: true,
      message: res.revokedUpstream
        ? 'Disconnected, and the application password was revoked on the site.'
        : 'Disconnected. The application password could not be revoked automatically — delete it in WordPress under Users → Profile → Application Passwords.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function createWordPressDraftAction(input: {
  siteId: string;
  kind: 'posts' | 'pages';
  title: string;
  content: string;
  excerpt?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    const rl = await limited(`wp-draft:${org.id}:${user.id}`, 20, 3600);
    if (rl) return rl;
    const res = await wordpress.createDraft(
      { organizationId: org.id, siteId: input.siteId, actorId: user.id },
      {
        kind: input.kind,
        title: input.title,
        content: input.content,
        excerpt: input.excerpt || undefined,
      },
    );
    await integrationSync.runIntegrationSync({
      organizationId: org.id,
      key: 'WORDPRESS',
      connectionRef: input.siteId,
      trigger: 'MANUAL',
    });
    refresh();
    return { ok: true, message: `Draft #${res.wpId} created in WordPress. It is not published.` };
  } catch (e) {
    return toError(e);
  }
}

/** Ask for a WRITE / PUBLISH change. Creates a pending approval only. */
export async function requestWordPressChangeAction(input: {
  siteId: string;
  capabilityId: 'wordpress.update_post' | 'wordpress.publish';
  payload: Record<string, unknown>;
  summary: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    const rl = await limited(`wp-request:${org.id}:${user.id}`, 30, 3600);
    if (rl) return rl;
    await approvals.requestIntegrationAction({
      organizationId: org.id,
      requestedById: user.id,
      source: 'USER',
      capabilityId: input.capabilityId,
      connectionRef: input.siteId,
      payload: input.payload,
      summary: input.summary,
    });
    refresh();
    return {
      ok: true,
      message:
        'Request sent for approval. Nothing changes on WordPress until an admin approves it.',
    };
  } catch (e) {
    return toError(e);
  }
}

// --- approvals ---------------------------------------------------------------

export async function decideApprovalAction(
  requestId: string,
  decision: 'approve' | 'reject',
): Promise<ActionResult> {
  try {
    // Approving sends a change to an external system: ADMIN+ (`publish:external`).
    const { user, org } = await requirePermission('publish:external');
    const row = await approvals.decideActionRequest({
      organizationId: org.id,
      deciderId: user.id,
      requestId,
      decision,
    });
    refresh();
    if (decision === 'reject')
      return { ok: true, message: 'Request rejected. Nothing was changed.' };
    return row.status === 'EXECUTED'
      ? { ok: true, message: 'Approved and applied.' }
      : { ok: false, error: `Approved, but applying it failed: ${row.error ?? 'unknown error'}` };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelApprovalAction(requestId: string): Promise<ActionResult> {
  try {
    const ctx = await requirePermission('content:manage');
    await approvals.cancelActionRequest({
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      requestId,
      isAdmin: rbac.roleHasPermission(ctx.org.role, 'approval.cancel_others'),
    });
    refresh();
    return { ok: true, message: 'Request cancelled.' };
  } catch (e) {
    return toError(e);
  }
}
