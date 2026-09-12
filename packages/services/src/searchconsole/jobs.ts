/**
 * Search Console orchestration entry points — called inline by the web Server
 * Actions and by the `search-console-sync` worker queue.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { getConnectionForOrg } from '../integrations/connections.js';
import { refreshPerformance, refreshSitemaps } from './read.js';
import { syncProperties } from './sites.js';

const log = createLogger('searchconsole.jobs');

export interface SearchConsoleSyncInput {
  organizationId: string;
  redirectUri: string;
  /** Defaults to the org's GSC connection. */
  connectionId?: string;
  rangeDays?: number;
  /** Skip performance/sitemaps (just refresh the property list). */
  propertiesOnly?: boolean;
  db?: Db;
}

export async function runSearchConsoleSyncJob(input: SearchConsoleSyncInput): Promise<{
  properties: number;
  performanceSnapshotId: string | null;
  sitemapsSnapshotId: string | null;
}> {
  const db = input.db ?? prisma;
  const conn = input.connectionId
    ? await db.oAuthConnection.findUnique({ where: { id: input.connectionId } })
    : await getConnectionForOrg(input.organizationId, 'GOOGLE_SEARCH_CONSOLE', db);
  if (!conn || conn.organizationId !== input.organizationId) {
    throw AppError.notFound('Search Console connection');
  }
  if (conn.status === 'REVOKED') {
    throw new AppError('provider_unavailable', 'This Search Console account is disconnected.');
  }

  const properties = await syncProperties(conn, input.redirectUri, db);

  let performanceSnapshotId: string | null = null;
  let sitemapsSnapshotId: string | null = null;
  if (!input.propertiesOnly) {
    const selected = await db.searchConsoleSite.findFirst({
      where: { organizationId: input.organizationId, isSelected: true },
    });
    if (selected) {
      performanceSnapshotId = await refreshPerformance({
        organizationId: input.organizationId,
        userId: 'system',
        redirectUri: input.redirectUri,
        siteId: selected.id,
        rangeDays: input.rangeDays,
        db,
      });
      sitemapsSnapshotId = await refreshSitemaps({
        organizationId: input.organizationId,
        userId: 'system',
        redirectUri: input.redirectUri,
        siteId: selected.id,
        db,
      }).catch((err) => {
        log.warn({ err: String(err) }, 'sitemaps refresh failed during sync (continuing)');
        return null;
      });
    }
  }

  log.info(
    { organizationId: input.organizationId, properties, hasPerf: Boolean(performanceSnapshotId) },
    'search console sync complete',
  );
  return { properties, performanceSnapshotId, sitemapsSnapshotId };
}
