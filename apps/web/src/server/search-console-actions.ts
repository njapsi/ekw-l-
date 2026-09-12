'use server';

import { revalidatePath } from 'next/cache';
import { integrations, isAppError, searchConsole, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { googleRedirectUri } from '@/lib/search-console';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

const DASHBOARD = '/app/seo/search-console';
const INTEGRATION = '/app/integrations/search-console';

export async function disconnectSearchConsoleAction(): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const conn = await integrations.getConnectionForOrg(org.id, 'GOOGLE_SEARCH_CONSOLE');
    if (!conn) return { ok: false, error: 'No Search Console connection to disconnect.' };
    await integrations.disconnectConnection(org.id, conn.id, user.id);
    revalidatePath(INTEGRATION);
    revalidatePath(DASHBOARD);
    return { ok: true, message: 'Search Console disconnected.' };
  } catch (e) {
    return toError(e);
  }
}

export async function syncPropertiesAction(): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('integration:manage');
    const conn = await integrations.getConnectionForOrg(org.id, 'GOOGLE_SEARCH_CONSOLE');
    if (!conn || conn.status === 'REVOKED') {
      return { ok: false, error: 'Connect Search Console first.' };
    }
    const n = await searchConsole.syncProperties(conn, await googleRedirectUri());
    revalidatePath(INTEGRATION);
    revalidatePath(DASHBOARD);
    return { ok: true, message: `Found ${n} propert${n === 1 ? 'y' : 'ies'}.` };
  } catch (e) {
    return toError(e);
  }
}

export async function selectPropertyAction(siteId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    await searchConsole.selectProperty(org.id, siteId, user.id);
    revalidatePath(DASHBOARD);
    revalidatePath(INTEGRATION);
    return { ok: true, message: 'Property selected.' };
  } catch (e) {
    return toError(e);
  }
}

export async function refreshPerformanceAction(rangeDays = 28): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await security.checkRateLimit({
      key: `gsc-refresh:${org.id}`,
      limit: 10,
      windowSec: 60,
    });
    if (!rl.ok) return { ok: false, error: 'Please wait a moment before refreshing again.' };

    const redirectUri = await googleRedirectUri();
    await searchConsole.refreshPerformance({
      organizationId: org.id,
      userId: user.id,
      redirectUri,
      rangeDays,
    });
    await searchConsole
      .refreshSitemaps({ organizationId: org.id, userId: user.id, redirectUri })
      .catch(() => undefined);
    revalidatePath(DASHBOARD);
    return { ok: true, message: 'Search Console data refreshed.' };
  } catch (e) {
    return toError(e);
  }
}

export async function inspectUrlAction(url: string): Promise<ActionResult & { data?: unknown }> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await security.checkRateLimit({
      key: `gsc-inspect:${org.id}`,
      limit: 30,
      windowSec: 60,
    });
    if (!rl.ok) return { ok: false, error: 'URL inspection is rate-limited. Try again shortly.' };

    const data = await searchConsole.inspectUrl({
      organizationId: org.id,
      userId: user.id,
      redirectUri: await googleRedirectUri(),
      url,
    });
    revalidatePath(DASHBOARD);
    return { ok: true, data };
  } catch (e) {
    return toError(e);
  }
}
