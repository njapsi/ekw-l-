/**
 * Reads + refreshes for the Search Console dashboard and the SEO agent. Every
 * displayed number is Google's own reported metric, captured into a
 * `SearchConsoleSnapshot` — nothing is synthesised. All reads are org-scoped.
 */
import { type Db, type SearchConsoleSite, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { addQuotaUsage, recordHealth } from '../integrations/health.js';
import { requireConnection } from '../integrations/connections.js';
import type { SearchConsoleClient, SearchAnalyticsDimension } from './client.js';
import { ResilientSearchConsoleClient } from './resilient-client.js';
import {
  type PerformanceSnapshotData,
  type SitemapsSnapshotData,
  type UrlInspectionSnapshotData,
} from './schemas.js';
import { getSelectedProperty, requireProperty } from './sites.js';

const log = createLogger('searchconsole.read');

/** GSC search-analytics lags ~2 days; query up to two days ago. */
function windowFor(rangeDays: number): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, rangeDays));
  return { startDate: iso(start), endDate: iso(end) };
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function clientFor(
  organizationId: string,
  connectionId: string,
  redirectUri: string,
  db: Db,
): Promise<SearchConsoleClient> {
  const conn = await requireConnection(organizationId, connectionId, db);
  if (conn.status === 'REVOKED') {
    throw new AppError('provider_unavailable', 'This Search Console account is disconnected.');
  }
  return new ResilientSearchConsoleClient(conn, redirectUri, db);
}

// --- performance -------------------------------------------------------

export interface RefreshPerformanceInput {
  organizationId: string;
  userId: string;
  redirectUri: string;
  /** Explicit property; defaults to the selected one. */
  siteId?: string;
  rangeDays?: number;
  db?: Db;
  /** Test seam. */
  client?: SearchConsoleClient;
}

const DIMENSION_KEYS: Array<[keyof PerformanceSnapshotData, SearchAnalyticsDimension[]]> = [
  ['byDate', ['date']],
  ['byQuery', ['query']],
  ['byPage', ['page']],
  ['byCountry', ['country']],
  ['byDevice', ['device']],
  ['bySearchAppearance', ['searchAppearance']],
];

export async function refreshPerformance(input: RefreshPerformanceInput): Promise<string> {
  const db = input.db ?? prisma;
  const rangeDays = input.rangeDays ?? 28;
  const site = input.siteId
    ? await requireProperty(input.organizationId, input.siteId, db)
    : await getSelectedProperty(input.organizationId, db);
  if (!site) throw AppError.notFound('Selected Search Console property');

  const client =
    input.client ??
    (await clientFor(input.organizationId, site.oauthConnectionId, input.redirectUri, db));
  const { startDate, endDate } = windowFor(rangeDays);

  const data: PerformanceSnapshotData = {
    rangeDays,
    totals: { clicks: 0, impressions: 0, ctr: null, position: null },
    byDate: [],
    byQuery: [],
    byPage: [],
    byCountry: [],
    byDevice: [],
    bySearchAppearance: [],
  };

  try {
    for (const [field, dimensions] of DIMENSION_KEYS) {
      const res = await client.querySearchAnalytics({
        siteUrl: site.siteUrl,
        startDate,
        endDate,
        dimensions,
        rowLimit: field === 'byQuery' || field === 'byPage' ? 250 : 100,
      });
      (data[field] as PerformanceSnapshotData['byDate']) = res.rows.map((r) => ({
        keys: r.keys,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));
    }
  } catch (err) {
    await recordHealth(
      site.oauthConnectionId,
      { ok: false, detail: err instanceof Error ? err.message : 'performance refresh failed' },
      db,
    );
    throw err;
  }

  // Totals from the byDate series (each row is a day).
  const clicks = data.byDate.reduce((s, r) => s + r.clicks, 0);
  const impressions = data.byDate.reduce((s, r) => s + r.impressions, 0);
  const weightedPos = data.byDate.reduce((s, r) => s + r.position * r.impressions, 0);
  data.totals = {
    clicks,
    impressions,
    // null (not 0) with no impressions — there is nothing to average, and
    // Google never reports a real position of 0 (positions start at 1).
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? weightedPos / impressions : null,
  };

  const snapshot = await db.searchConsoleSnapshot.create({
    data: {
      organizationId: input.organizationId,
      searchConsoleSiteId: site.id,
      kind: 'PERFORMANCE',
      rangeStart: new Date(startDate),
      rangeEnd: new Date(endDate),
      data: data as never,
    },
  });
  await db.searchConsoleSite.update({
    where: { id: site.id },
    data: { lastPerformanceAt: new Date(), lastSyncedAt: new Date() },
  });
  await addQuotaUsage(site.oauthConnectionId, DIMENSION_KEYS.length, db);
  await recordHealth(site.oauthConnectionId, { ok: true, detail: 'performance refreshed' }, db);
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'search_console.performance_refreshed',
      targetType: 'search_console_site',
      targetId: site.id,
      metadata: { rangeDays, impressions, clicks },
    },
    db,
  );
  log.info(
    { organizationId: input.organizationId, siteId: site.id, impressions, clicks },
    'refreshed Search Console performance',
  );
  return snapshot.id;
}

// --- sitemaps --------------------------------------------------------

export async function refreshSitemaps(input: {
  organizationId: string;
  userId: string;
  redirectUri: string;
  siteId?: string;
  db?: Db;
  client?: SearchConsoleClient;
}): Promise<string> {
  const db = input.db ?? prisma;
  const site = input.siteId
    ? await requireProperty(input.organizationId, input.siteId, db)
    : await getSelectedProperty(input.organizationId, db);
  if (!site) throw AppError.notFound('Selected Search Console property');
  const client =
    input.client ??
    (await clientFor(input.organizationId, site.oauthConnectionId, input.redirectUri, db));

  const raw = await client.listSitemaps(site.siteUrl);
  const num = (v: string | number | undefined): number => {
    const n = typeof v === 'string' ? Number(v) : (v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const data: SitemapsSnapshotData = {
    sitemaps: raw.map((s) => ({
      path: s.path,
      lastSubmitted: s.lastSubmitted ?? null,
      lastDownloaded: s.lastDownloaded ?? null,
      isPending: Boolean(s.isPending),
      isSitemapsIndex: Boolean(s.isSitemapsIndex),
      type: s.type ?? null,
      warnings: num(s.warnings),
      errors: num(s.errors),
      contents: (s.contents ?? []).map((c) => ({
        type: c.type ?? 'web',
        submitted: num(c.submitted),
        indexed: num(c.indexed),
      })),
    })),
  };

  const snapshot = await db.searchConsoleSnapshot.create({
    data: {
      organizationId: input.organizationId,
      searchConsoleSiteId: site.id,
      kind: 'SITEMAPS',
      data: data as never,
    },
  });
  await db.searchConsoleSite.update({ where: { id: site.id }, data: { lastSyncedAt: new Date() } });
  await addQuotaUsage(site.oauthConnectionId, 1, db);
  return snapshot.id;
}

// --- URL inspection (quota-scarce; on demand only) ----------------

export async function inspectUrl(input: {
  organizationId: string;
  userId: string;
  redirectUri: string;
  url: string;
  siteId?: string;
  db?: Db;
  client?: SearchConsoleClient;
}): Promise<UrlInspectionSnapshotData> {
  const db = input.db ?? prisma;
  const site = input.siteId
    ? await requireProperty(input.organizationId, input.siteId, db)
    : await getSelectedProperty(input.organizationId, db);
  if (!site) throw AppError.notFound('Selected Search Console property');

  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    throw AppError.validation('Enter a full URL, including https://');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw AppError.validation('Only http/https URLs can be inspected.');
  }

  const client =
    input.client ??
    (await clientFor(input.organizationId, site.oauthConnectionId, input.redirectUri, db));
  const res = await client.inspectUrl(site.siteUrl, target.toString());
  const r = res.inspectionResult?.indexStatusResult ?? {};
  const data: UrlInspectionSnapshotData = {
    url: target.toString(),
    verdict: r.verdict ?? null,
    coverageState: r.coverageState ?? null,
    robotsTxtState: r.robotsTxtState ?? null,
    indexingState: r.indexingState ?? null,
    lastCrawlTime: r.lastCrawlTime ?? null,
    pageFetchState: r.pageFetchState ?? null,
    googleCanonical: r.googleCanonical ?? null,
    userCanonical: r.userCanonical ?? null,
    crawledAs: r.crawledAs ?? null,
    referringUrls: r.referringUrls ?? [],
    mobileUsabilityVerdict: res.inspectionResult?.mobileUsabilityResult?.verdict ?? null,
    richResultsVerdict: res.inspectionResult?.richResultsResult?.verdict ?? null,
  };

  const existing = await db.searchConsoleSnapshot.findFirst({
    where: { searchConsoleSiteId: site.id, kind: 'URL_INSPECTION', subjectUrl: data.url },
  });
  if (existing) {
    await db.searchConsoleSnapshot.update({
      where: { id: existing.id },
      data: { data: data as never, capturedAt: new Date() },
    });
  } else {
    await db.searchConsoleSnapshot.create({
      data: {
        organizationId: input.organizationId,
        searchConsoleSiteId: site.id,
        kind: 'URL_INSPECTION',
        subjectUrl: data.url,
        data: data as never,
      },
    });
  }
  await addQuotaUsage(site.oauthConnectionId, 1, db);
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'search_console.url_inspected',
      targetType: 'search_console_site',
      targetId: site.id,
      metadata: { verdict: data.verdict, coverageState: data.coverageState },
    },
    db,
  );
  return data;
}

// --- snapshot helpers ----------------------------------------------

export async function latestSnapshot(
  organizationId: string,
  siteId: string,
  kind: 'PERFORMANCE' | 'SITEMAPS',
  db: Db = prisma,
) {
  return db.searchConsoleSnapshot.findFirst({
    where: { organizationId, searchConsoleSiteId: siteId, kind },
    orderBy: { capturedAt: 'desc' },
  });
}

export async function listInspections(organizationId: string, siteId: string, db: Db = prisma) {
  return db.searchConsoleSnapshot.findMany({
    where: { organizationId, searchConsoleSiteId: siteId, kind: 'URL_INSPECTION' },
    orderBy: { capturedAt: 'desc' },
    take: 20,
  });
}

// --- dashboard ----------------------------------------------------

export async function getDashboard(organizationId: string, db: Db = prisma) {
  const connection = await getConnectionSummarySafe(organizationId, db);
  if (!connection) return { connection: null, property: null } as const;

  const property = await getSelectedProperty(organizationId, db);
  if (!property) return { connection, property: null } as const;

  const [perf, sitemaps, inspections] = await Promise.all([
    latestSnapshot(organizationId, property.id, 'PERFORMANCE', db),
    latestSnapshot(organizationId, property.id, 'SITEMAPS', db),
    listInspections(organizationId, property.id, db),
  ]);

  return {
    connection,
    property: {
      id: property.id,
      siteUrl: property.siteUrl,
      propertyType: property.propertyType,
      hostname: property.hostname,
      permissionLevel: property.permissionLevel,
      verified: property.verified,
      lastPerformanceAt: property.lastPerformanceAt,
    },
    performance: perf
      ? {
          capturedAt: perf.capturedAt,
          rangeStart: perf.rangeStart,
          rangeEnd: perf.rangeEnd,
          data: perf.data as unknown as PerformanceSnapshotData,
        }
      : null,
    sitemaps: sitemaps
      ? { capturedAt: sitemaps.capturedAt, data: sitemaps.data as unknown as SitemapsSnapshotData }
      : null,
    inspections: inspections.map((s) => ({
      capturedAt: s.capturedAt,
      data: s.data as unknown as UrlInspectionSnapshotData,
    })),
  } as const;
}

async function getConnectionSummarySafe(organizationId: string, db: Db) {
  const { getConnectionSummary } = await import('./sites.js');
  return getConnectionSummary(organizationId, db);
}

// --- agent seam --------------------------------------------------

/** The selected property whose hostname matches `hostname`, + its latest PERFORMANCE snapshot. */
export async function getPerformanceForAgent(
  organizationId: string,
  hostname: string,
  db: Db = prisma,
): Promise<{
  property: SearchConsoleSite;
  performance: PerformanceSnapshotData;
  capturedAt: Date;
  dataThrough: Date | null;
} | null> {
  const host = hostname.toLowerCase();
  const property = await db.searchConsoleSite.findFirst({
    where: {
      organizationId,
      isSelected: true,
      verified: true,
      OR: [{ hostname: host }, { hostname: { endsWith: `.${host}` } }],
    },
  });
  if (!property) return null;
  const snap = await latestSnapshot(organizationId, property.id, 'PERFORMANCE', db);
  if (!snap) return null;
  return {
    property,
    performance: snap.data as unknown as PerformanceSnapshotData,
    capturedAt: snap.capturedAt,
    dataThrough: snap.rangeEnd,
  };
}

export async function getSitemapsForAgent(
  organizationId: string,
  siteId: string,
  db: Db = prisma,
): Promise<SitemapsSnapshotData | null> {
  const snap = await latestSnapshot(organizationId, siteId, 'SITEMAPS', db);
  return snap ? (snap.data as unknown as SitemapsSnapshotData) : null;
}
