import { type Db, type IntegrationProvider, prisma } from '@growth-agent/db';
import { type SyncFacts, factsFor, getSyncFacts } from '../sync/status.js';
import { wordPressState } from '../wordpress/state.js';
import {
  INTEGRATIONS,
  type ConnectionDiagnostic,
  type ConnectionState,
  type IntegrationDescriptor,
  type IntegrationKey,
  type ResolvedCapability,
  actionFor,
  diagnoseConnection,
  isUsable,
  resolveCapabilities,
  resolveConnectionState,
} from './contract.js';

/**
 * The Connection Center read model (Phase 1, Part 8). One query pass produces
 * the unified state of every integration for an organization, so the UI never
 * has to re-derive status from four different shapes.
 *
 * Every field here is derived from persisted rows or deployment config —
 * nothing is synthesised. An integration with no data reports NOT_CONNECTED
 * and says so, rather than rendering zeros.
 */

/** Which of the five integration keys map onto an `OAuthConnection` row. */
const OAUTH_KEYS: Partial<Record<IntegrationKey, IntegrationProvider>> = {
  YOUTUBE: 'YOUTUBE',
  GOOGLE_SEARCH_CONSOLE: 'GOOGLE_SEARCH_CONSOLE',
  TIKTOK: 'TIKTOK',
};

export interface ConnectionCenterEntry {
  descriptor: IntegrationDescriptor;
  state: ConnectionState;
  diagnostic: ConnectionDiagnostic;
  capabilities: ResolvedCapability[];
  /**
   * Whether this deployment even has the credentials to offer this
   * integration. False means "the operator has not configured it", which is a
   * different problem from "the user has not connected it".
   */
  configured: boolean;
  /** Present only when something is actually connected. */
  connectionId: string | null;
  accountLabel: string | null;
  connectedAt: Date | null;
  /** Null when never probed — deliberately not coerced to a date. */
  lastCheckedAt: Date | null;
  scopes: string[];
  /** How many distinct accounts/properties are linked (websites can be many). */
  linkedCount: number;
  manageHref: string;
  /** Whether the unified sync framework can sync this integration. */
  syncable: boolean;
  sync: SyncFacts;
}

/** Deployment-level configuration, evaluated server-side only. */
export function isProviderConfigured(key: IntegrationKey): boolean {
  const encryption = Boolean(process.env.ENCRYPTION_KEY);
  switch (key) {
    case 'YOUTUBE':
    case 'GOOGLE_SEARCH_CONSOLE':
      return (
        encryption &&
        Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET)
      );
    case 'TIKTOK':
      return (
        encryption && Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET)
      );
    case 'WEBSITE':
      // The crawler needs no third-party credentials.
      return true;
    case 'WORDPRESS':
      // No app registration is involved; only the at-rest encryption key.
      return encryption;
  }
}

const MANAGE_HREF: Record<IntegrationKey, string> = {
  YOUTUBE: '/app/integrations/youtube',
  GOOGLE_SEARCH_CONSOLE: '/app/integrations/search-console',
  TIKTOK: '/app/integrations/tiktok',
  WEBSITE: '/app/seo',
  WORDPRESS: '/app/integrations/wordpress',
};

/**
 * Build the whole Connection Center for one organization.
 *
 * Tenant scoping: every query below filters on `organizationId`, which the
 * caller must take from the session (never from request input).
 */
export async function getConnectionCenter(
  organizationId: string,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<ConnectionCenterEntry[]> {
  const [oauthRows, websites, wpSites, syncFacts] = await Promise.all([
    db.oAuthConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        displayName: true,
        externalAccountId: true,
        scopes: true,
        status: true,
        expiresAt: true,
        lastError: true,
        refreshTokenCipher: true,
        createdAt: true,
        health: { select: { ok: true, detail: true, lastCheckAt: true } },
      },
    }),
    db.website.findMany({
      where: { organizationId },
      select: { id: true, hostname: true, verified: true, verifiedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.wordPressSite.findMany({
      where: { organizationId },
      select: {
        id: true,
        siteUrl: true,
        siteName: true,
        status: true,
        detectedCapabilities: true,
        lastError: true,
        lastCheckAt: true,
        lastCheckOk: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    getSyncFacts(organizationId, db),
  ]);

  return (Object.keys(INTEGRATIONS) as IntegrationKey[]).map((key): ConnectionCenterEntry => {
    const descriptor = INTEGRATIONS[key];
    const configured = isProviderConfigured(key);

    if (key === 'WEBSITE') return websiteEntry(descriptor, websites, configured);

    if (key === 'WORDPRESS') {
      const live = wpSites.filter((s) => s.status !== 'REVOKED');
      const site = live[0] ?? wpSites[0] ?? null;
      const state: ConnectionState = !configured
        ? 'NOT_CONNECTED'
        : site
          ? wordPressState(site, now)
          : 'NOT_CONNECTED';
      return {
        descriptor,
        state,
        diagnostic: configured
          ? diagnoseConnection({
              key,
              state,
              connectionId: site?.id ?? null,
              lastError: site?.lastError ?? null,
            })
          : unconfiguredDiagnostic(descriptor),
        capabilities: resolveCapabilities(descriptor, site?.detectedCapabilities ?? [], state),
        configured,
        connectionId: site?.id ?? null,
        accountLabel: site
          ? site.siteName
            ? `${site.siteName} (${site.siteUrl})`
            : site.siteUrl
          : null,
        connectedAt: site?.createdAt ?? null,
        lastCheckedAt: site?.lastCheckAt ?? null,
        scopes: site?.detectedCapabilities ?? [],
        linkedCount: live.length,
        manageHref: MANAGE_HREF.WORDPRESS,
        syncable: true,
        sync: factsFor(syncFacts, site?.id ?? null),
      };
    }

    const provider = OAUTH_KEYS[key];
    // Prefer the newest non-revoked row: a stale REVOKED row must not mask a
    // freshly reconnected account.
    const rows = provider ? oauthRows.filter((r) => r.provider === provider) : [];
    const row = rows.find((r) => r.status !== 'REVOKED') ?? rows[0] ?? null;

    const state: ConnectionState = !configured
      ? 'NOT_CONNECTED'
      : resolveConnectionState(
          row
            ? {
                status: row.status,
                expiresAt: row.expiresAt,
                lastError: row.lastError,
                hasRefreshToken: Boolean(row.refreshTokenCipher),
              }
            : null,
          row?.health ?? null,
          now,
        );

    const diagnostic = configured
      ? diagnoseConnection({
          key,
          state,
          connectionId: row?.id ?? null,
          lastError: row?.lastError ?? null,
          healthDetail: row?.health?.detail ?? null,
        })
      : unconfiguredDiagnostic(descriptor);

    return {
      descriptor,
      state,
      diagnostic,
      capabilities: resolveCapabilities(descriptor, row?.scopes ?? [], state),
      configured,
      connectionId: row?.id ?? null,
      accountLabel: row?.displayName ?? row?.externalAccountId ?? null,
      connectedAt: row?.createdAt ?? null,
      lastCheckedAt: row?.health?.lastCheckAt ?? null,
      scopes: row?.scopes ?? [],
      linkedCount: rows.filter((r) => r.status !== 'REVOKED').length,
      manageHref: MANAGE_HREF[key],
      syncable: true,
      sync: factsFor(syncFacts, row?.id ?? null),
    };
  });
}

type WebsiteRow = {
  id: string;
  hostname: string;
  verified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
};

/**
 * A website is "connected" once ownership is verified — that verification, not
 * a token, is what authorizes the crawler to touch it (hard rule 7).
 */
function websiteEntry(
  descriptor: IntegrationDescriptor,
  websites: WebsiteRow[],
  configured: boolean,
): ConnectionCenterEntry {
  const verified = websites.filter((w) => w.verified);
  const state: ConnectionState =
    verified.length > 0 ? 'CONNECTED' : websites.length > 0 ? 'CONNECTING' : 'NOT_CONNECTED';

  const first = verified[0] ?? websites[0] ?? null;
  const diagnostic =
    websites.length > 0 && verified.length === 0
      ? {
          state,
          category: 'CONFIG' as const,
          title: 'Website ownership not verified yet',
          explanation:
            'The site was added but ownership has not been confirmed. Growth Agent will not crawl a site until you prove you control it.',
          recommendedAction:
            'Publish the DNS TXT record or verification file shown on the site, then click "Check verification".',
          action: 'CONFIGURE' as const,
          technicalDetail: null,
          referenceId: 'we-conf-pending',
        }
      : diagnoseConnection({ key: 'WEBSITE', state });

  return {
    descriptor,
    state,
    diagnostic,
    capabilities: resolveCapabilities(descriptor, [], state),
    configured,
    connectionId: first?.id ?? null,
    accountLabel: first?.hostname ?? null,
    connectedAt: first?.createdAt ?? null,
    lastCheckedAt: verified[0]?.verifiedAt ?? null,
    scopes: [],
    linkedCount: verified.length,
    manageHref: MANAGE_HREF.WEBSITE,
    // Websites are crawled (a separate, metered flow), not "synced".
    syncable: false,
    sync: factsFor(new Map(), null),
  };
}

function unconfiguredDiagnostic(descriptor: IntegrationDescriptor): ConnectionDiagnostic {
  const notBuilt = !descriptor.implemented;
  return {
    state: 'NOT_CONNECTED',
    category: 'CONFIG',
    title: notBuilt
      ? `${descriptor.label} is not available yet`
      : `${descriptor.label} is not set up on this deployment`,
    explanation: notBuilt
      ? `Growth Agent does not have a ${descriptor.label} integration yet. Nothing is connected and no ${descriptor.label} data is used anywhere in the product.`
      : `This deployment is missing the credentials needed to talk to ${descriptor.label}, so connecting would fail. This is an operator setting, not something wrong with your account.`,
    recommendedAction: notBuilt
      ? 'No action available.'
      : `Ask an administrator to configure ${descriptor.label} (see ${descriptor.docsPath}).`,
    action: 'NONE',
    technicalDetail: null,
    referenceId: `${descriptor.key.slice(0, 2).toLowerCase()}-conf-noenv`,
  };
}

/** Summary counters for the Connection Center header. */
export function summarizeCenter(entries: ConnectionCenterEntry[]): {
  connected: number;
  needsAttention: number;
  available: number;
} {
  return {
    connected: entries.filter((e) => e.state === 'CONNECTED').length,
    needsAttention: entries.filter(
      (e) => e.configured && !isUsable(e.state) && actionFor(e.state) !== 'CONNECT',
    ).length,
    available: entries.filter((e) => e.configured && e.descriptor.implemented).length,
  };
}
