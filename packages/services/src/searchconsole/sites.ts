/**
 * Property discovery / selection / verification-status for a connected Google
 * Search Console account. Every read and write is scoped by `organizationId`.
 */
import {
  type Db,
  type OAuthConnection,
  type SearchConsolePermission,
  type SearchConsolePropertyType,
  prisma,
} from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { runInTransaction } from '../db-tx.js';
import { AppError } from '../errors.js';
import { recordHealth } from '../integrations/health.js';
import { registrableDomain } from '../seo/url.js';
import { ResilientSearchConsoleClient } from './resilient-client.js';

const log = createLogger('searchconsole.sites');

/** Map Google's `permissionLevel` string onto our enum. */
export function mapPermission(level: string | undefined): SearchConsolePermission {
  switch (level) {
    case 'siteOwner':
      return 'SITE_OWNER';
    case 'siteFullUser':
      return 'SITE_FULL_USER';
    case 'siteRestrictedUser':
      return 'SITE_RESTRICTED_USER';
    case 'siteUnverifiedUser':
      return 'SITE_UNVERIFIED_USER';
    default:
      return 'UNKNOWN';
  }
}

/** Derive `{ propertyType, hostname }` from a GSC property id. */
export function describeProperty(siteUrl: string): {
  propertyType: SearchConsolePropertyType;
  hostname: string;
} {
  if (siteUrl.startsWith('sc-domain:')) {
    const host = siteUrl.slice('sc-domain:'.length).toLowerCase().replace(/\.$/, '');
    return { propertyType: 'DOMAIN', hostname: registrableDomain(host) || host };
  }
  try {
    const u = new URL(siteUrl);
    return { propertyType: 'URL_PREFIX', hostname: u.hostname.toLowerCase() };
  } catch {
    return { propertyType: 'URL_PREFIX', hostname: siteUrl.toLowerCase() };
  }
}

/**
 * Fetch the account's property list from Google and reconcile it with our
 * `SearchConsoleSite` rows for this org. Properties no longer returned are kept
 * but marked `verified: false` (so history / a re-grant is graceful).
 */
export async function syncProperties(
  connection: OAuthConnection,
  redirectUri: string,
  db: Db = prisma,
): Promise<number> {
  const client = new ResilientSearchConsoleClient(connection, redirectUri, db);
  let entries: Array<{ siteUrl: string; permissionLevel?: string }>;
  try {
    const res = await client.listSites();
    entries = res.siteEntry;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'listSites failed';
    await recordHealth(connection.id, { ok: false, detail: message }, db);
    throw err;
  }

  const now = new Date();
  const seen = new Set<string>();
  for (const e of entries) {
    seen.add(e.siteUrl);
    const permissionLevel = mapPermission(e.permissionLevel);
    const { propertyType, hostname } = describeProperty(e.siteUrl);
    await db.searchConsoleSite.upsert({
      where: {
        organizationId_siteUrl: { organizationId: connection.organizationId, siteUrl: e.siteUrl },
      },
      create: {
        organizationId: connection.organizationId,
        oauthConnectionId: connection.id,
        siteUrl: e.siteUrl,
        propertyType,
        hostname,
        permissionLevel,
        verified: permissionLevel !== 'SITE_UNVERIFIED_USER',
        lastSyncedAt: now,
      },
      update: {
        oauthConnectionId: connection.id,
        propertyType,
        hostname,
        permissionLevel,
        verified: permissionLevel !== 'SITE_UNVERIFIED_USER',
        lastSyncedAt: now,
      },
    });
  }

  // Properties the account can no longer see.
  await db.searchConsoleSite.updateMany({
    where: {
      organizationId: connection.organizationId,
      oauthConnectionId: connection.id,
      siteUrl: { notIn: [...seen] },
    },
    data: { verified: false, permissionLevel: 'UNKNOWN' },
  });

  await recordHealth(connection.id, { ok: true, detail: `${entries.length} properties` }, db);
  log.info(
    { organizationId: connection.organizationId, properties: entries.length },
    'synced Search Console properties',
  );
  return entries.length;
}

export async function listProperties(organizationId: string, db: Db = prisma) {
  return db.searchConsoleSite.findMany({
    where: { organizationId },
    orderBy: [{ isSelected: 'desc' }, { siteUrl: 'asc' }],
  });
}

export async function getSelectedProperty(organizationId: string, db: Db = prisma) {
  return db.searchConsoleSite.findFirst({ where: { organizationId, isSelected: true } });
}

/** Resolve a property by id and assert it belongs to the org. */
export async function requireProperty(organizationId: string, siteId: string, db: Db = prisma) {
  const site = await db.searchConsoleSite.findFirst({ where: { id: siteId, organizationId } });
  if (!site) throw AppError.notFound('Search Console property');
  return site;
}

export async function selectProperty(
  organizationId: string,
  siteId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const site = await requireProperty(organizationId, siteId, db);
  await runInTransaction(db, async (tx) => {
    await tx.searchConsoleSite.updateMany({
      where: { organizationId, isSelected: true },
      data: { isSelected: false },
    });
    await tx.searchConsoleSite.update({ where: { id: site.id }, data: { isSelected: true } });
  });
  await recordAudit(
    {
      organizationId,
      actorId: userId,
      action: 'search_console.property_selected',
      targetType: 'search_console_site',
      targetId: site.id,
      metadata: { siteUrl: site.siteUrl },
    },
    db,
  );
}

/** Shape mirroring `youtube.getConnectionSummary`. */
export async function getConnectionSummary(organizationId: string, db: Db = prisma) {
  const conn = await db.oAuthConnection.findFirst({
    where: { organizationId, provider: 'GOOGLE_SEARCH_CONSOLE' },
    include: { health: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!conn) return null;
  return {
    id: conn.id,
    status: conn.status,
    displayName: conn.displayName,
    scopes: conn.scopes,
    lastRefreshedAt: conn.lastRefreshedAt,
    lastError: conn.lastError,
    health: conn.health
      ? {
          ok: conn.health.ok,
          detail: conn.health.detail,
          quotaUnitsUsedToday: conn.health.quotaUnitsUsedToday,
          lastCheckAt: conn.health.lastCheckAt,
        }
      : null,
  };
}
