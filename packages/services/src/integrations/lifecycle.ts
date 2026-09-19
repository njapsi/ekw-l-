/**
 * Token & credential lifecycle (Phase 1, Part 12). Runs as a repeatable
 * worker tick (`integrations` queue, every 15 min).
 *
 * Until now a token was only ever refreshed just-in-time, inside a user's
 * request or a sync — so a revoked refresh token was discovered at the worst
 * moment (mid-sync, or when the user opened a dashboard) and never announced.
 * This sweep:
 *
 *   1. Validates refresh tokens ahead of need — any OAuth connection whose
 *      access token is expired/expiring and was not refreshed in the last 6h
 *      is refreshed now. Success is silent; a rejected refresh token marks the
 *      connection ERROR and notifies whoever connected it, once per day.
 *   2. Announces connections that cannot recover (no refresh token, about to
 *      expire) before they break.
 *   3. Re-validates WordPress application passwords daily (they never expire,
 *      but can be revoked from wp-admin at any time).
 *   4. Key rotation: re-seals credentials still encrypted under
 *      `ENCRYPTION_KEY_PREVIOUS` and logs how many remain.
 *   5. Expires approval requests past their 7-day TTL.
 *
 * Every step is per-row isolated: one bad connection never stops the sweep.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { expirePendingActions } from '../approvals/index.js';
import { keyIdFor } from '../crypto/tokens.js';
import { createNotification } from '../notifications/index.js';
import { recordTokenLifecycle } from '../observability/metrics.js';
import { checkWordPressSite, resealWordPressCredential } from '../wordpress/connect.js';
import { refreshConnectionTokens, resealConnectionIfStale } from './connections.js';
import { INTEGRATIONS, type IntegrationKey } from './contract.js';
import { oauthRedirectUri, redirectKindFor } from './redirect.js';

const log = createLogger('integrations.lifecycle');

export const REFRESH_AHEAD_MS = 15 * 60 * 1000;
export const REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const WORDPRESS_RECHECK_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

export interface LifecycleReport {
  refreshed: number;
  refreshFailed: number;
  reauthWarned: number;
  wordpressChecked: number;
  wordpressFailed: number;
  resealed: number;
  staleRemaining: number;
  approvalsExpired: number;
}

function day(now: Date) {
  return now.toISOString().slice(0, 10);
}

function label(provider: string): string {
  return INTEGRATIONS[provider as IntegrationKey]?.label ?? provider;
}

async function notifyReauth(
  db: Db,
  args: {
    organizationId: string;
    userId: string | null;
    provider: string;
    ref: string;
    reason: string;
    dedupeKey: string;
    linkPath: string;
  },
) {
  await createNotification(
    {
      organizationId: args.organizationId,
      userId: args.userId,
      kind: 'integration.reauth_required',
      level: 'WARNING',
      title: `Reconnect ${label(args.provider)}`,
      body: `${args.reason} Until it is reconnected, ${label(args.provider)} data in Growth Agent will not refresh.`,
      linkPath: args.linkPath,
      dedupeKey: args.dedupeKey,
      sourceType: 'integration_connection',
      sourceId: args.ref,
    },
    db,
  );
}

export async function sweepTokenLifecycle(
  opts: { now?: Date; db?: Db } = {},
): Promise<LifecycleReport> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const report: LifecycleReport = {
    refreshed: 0,
    refreshFailed: 0,
    reauthWarned: 0,
    wordpressChecked: 0,
    wordpressFailed: 0,
    resealed: 0,
    staleRemaining: 0,
    approvalsExpired: 0,
  };

  // 1. Refresh-ahead. Cross-tenant by design (a platform sweep); every write
  // below targets the row's own id / organizationId.
  const due = await db.oAuthConnection.findMany({
    where: {
      status: { in: ['ACTIVE', 'EXPIRED'] },
      refreshTokenCipher: { not: null },
      expiresAt: { lt: new Date(now.getTime() + REFRESH_AHEAD_MS) },
      OR: [
        { lastRefreshedAt: null },
        { lastRefreshedAt: { lt: new Date(now.getTime() - REFRESH_MIN_INTERVAL_MS) } },
      ],
      organization: { deletionScheduledAt: null },
    },
    take: BATCH,
  });
  for (const conn of due) {
    try {
      await refreshConnectionTokens(conn, oauthRedirectUri(redirectKindFor(conn.provider)), db);
      report.refreshed += 1;
    } catch {
      // refreshConnectionTokens already marked the row ERROR with the reason.
      report.refreshFailed += 1;
      await notifyReauth(db, {
        organizationId: conn.organizationId,
        userId: conn.createdById,
        provider: conn.provider,
        ref: conn.id,
        reason: `${label(conn.provider)} refused to renew Growth Agent's access — usually because access was revoked in the account's security settings or the password changed.`,
        dedupeKey: `reauth:${conn.id}:${day(now)}`,
        linkPath: '/app/integrations',
      });
      report.reauthWarned += 1;
    }
  }

  // 2. Connections that cannot renew themselves and are about to lapse.
  const unrecoverable = await db.oAuthConnection.findMany({
    where: {
      status: { in: ['ACTIVE', 'EXPIRED'] },
      refreshTokenCipher: null,
      expiresAt: { lt: new Date(now.getTime() + REFRESH_AHEAD_MS) },
      organization: { deletionScheduledAt: null },
    },
    select: { id: true, organizationId: true, createdById: true, provider: true, expiresAt: true },
    take: BATCH,
  });
  for (const conn of unrecoverable) {
    await notifyReauth(db, {
      organizationId: conn.organizationId,
      userId: conn.createdById,
      provider: conn.provider,
      ref: conn.id,
      reason: `${label(conn.provider)} did not issue a renewable token for this connection, so its access ${conn.expiresAt && conn.expiresAt < now ? 'has expired' : 'expires shortly'}.`,
      dedupeKey: `reauth:${conn.id}:${conn.expiresAt?.toISOString() ?? 'none'}`,
      linkPath: '/app/integrations',
    });
    report.reauthWarned += 1;
  }

  // 3. WordPress re-validation.
  const sites = await db.wordPressSite.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { lastCheckAt: null },
        { lastCheckAt: { lt: new Date(now.getTime() - WORDPRESS_RECHECK_MS) } },
      ],
      organization: { deletionScheduledAt: null },
    },
    take: BATCH,
  });
  for (const site of sites) {
    const res = await checkWordPressSite(site, db);
    report.wordpressChecked += 1;
    if (!res.ok) report.wordpressFailed += 1;
    if (res.authFailed) {
      await notifyReauth(db, {
        organizationId: site.organizationId,
        userId: site.createdById,
        provider: 'WORDPRESS',
        ref: site.id,
        reason: `WordPress rejected the application password for ${site.siteUrl} — it was probably revoked in wp-admin.`,
        dedupeKey: `wp-reauth:${site.id}:${day(now)}`,
        linkPath: '/app/integrations/wordpress',
      });
      report.reauthWarned += 1;
    }
  }

  // 4. Key rotation re-seal (only meaningful during a rotation window).
  if (process.env.ENCRYPTION_KEY_PREVIOUS && process.env.ENCRYPTION_KEY) {
    const current = keyIdFor();
    const staleOAuth = await db.oAuthConnection.findMany({
      where: { keyId: { not: current }, accessTokenCipher: { not: '' } },
      take: BATCH,
    });
    for (const c of staleOAuth) {
      try {
        if (await resealConnectionIfStale(c, db)) report.resealed += 1;
      } catch (err) {
        log.warn(
          { connectionId: c.id, err: err instanceof Error ? err.message : String(err) },
          're-seal failed (sealed with an unknown key?)',
        );
      }
    }
    const staleWp = await db.wordPressSite.findMany({
      where: { keyId: { not: current }, credentialCipher: { not: '' } },
      take: BATCH,
    });
    for (const s of staleWp) {
      try {
        if (await resealWordPressCredential(s, db)) report.resealed += 1;
      } catch (err) {
        log.warn(
          { siteId: s.id, err: err instanceof Error ? err.message : String(err) },
          're-seal failed (sealed with an unknown key?)',
        );
      }
    }
    // tenant-scope-ok: platform key-rotation sweep — counts stale ciphertexts
    // across all orgs; returns a number, never tenant data.
    const [o, w] = await Promise.all([
      db.oAuthConnection.count({
        where: { keyId: { not: current }, accessTokenCipher: { not: '' } },
      }),
      db.wordPressSite.count({ where: { keyId: { not: current }, credentialCipher: { not: '' } } }),
    ]);
    report.staleRemaining = o + w;
    log.info({ resealed: report.resealed }, `${report.staleRemaining} stale credentials`);
  }

  // 5. Approval TTL.
  report.approvalsExpired = await expirePendingActions(now, db);

  recordTokenLifecycle('refreshed', report.refreshed);
  recordTokenLifecycle('refresh_failed', report.refreshFailed);
  recordTokenLifecycle('reauth_warned', report.reauthWarned);
  recordTokenLifecycle('resealed', report.resealed);
  return report;
}
