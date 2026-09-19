import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { getConnectionCenter, isProviderConfigured, summarizeCenter } from './center.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const FUTURE = new Date('2026-09-19T13:00:00.000Z');
const PAST = new Date('2026-09-19T11:00:00.000Z');

type OAuthRow = Record<string, unknown>;
type WebsiteRow = Record<string, unknown>;
type Row = Record<string, unknown>;

function oauthRow(over: Partial<OAuthRow> = {}): OAuthRow {
  return {
    id: 'conn_yt_1',
    provider: 'YOUTUBE',
    displayName: 'My Channel',
    externalAccountId: 'UC123',
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ],
    status: 'ACTIVE',
    expiresAt: FUTURE,
    lastError: null,
    refreshTokenCipher: 'cipher',
    createdAt: PAST,
    health: { ok: true, detail: 'connected', lastCheckAt: PAST },
    ...over,
  };
}

function fakeDb(rows: OAuthRow[] = [], websites: WebsiteRow[] = [], wpSites: Row[] = []): Db {
  const calls: Array<Record<string, unknown>> = [];
  const record = (out: unknown[]) =>
    vi.fn(async (args: { where: Record<string, unknown> }) => {
      calls.push(args.where);
      return out;
    });
  return {
    oAuthConnection: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push(args.where);
        return rows;
      }),
    },
    website: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push(args.where);
        return websites;
      }),
    },
    wordPressSite: { findMany: record(wpSites) },
    integrationSyncRun: { findMany: record([]) },
    youTubeSyncRun: { findMany: record([]) },
    tikTokSyncRun: { findMany: record([]) },
    searchConsoleSnapshot: { findMany: record([]) },
    __calls: calls,
  } as unknown as Db;
}

const ENV_KEYS = [
  'ENCRYPTION_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
] as const;

function configureAll() {
  for (const k of ENV_KEYS) vi.stubEnv(k, 'x');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isProviderConfigured', () => {
  it('needs both the Google client and an encryption key', () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'x');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'x');
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(isProviderConfigured('YOUTUBE')).toBe(false);
    vi.stubEnv('ENCRYPTION_KEY', 'x');
    expect(isProviderConfigured('YOUTUBE')).toBe(true);
  });

  it('treats the crawler as always configured and WordPress as needing only the encryption key', () => {
    expect(isProviderConfigured('WEBSITE')).toBe(true);
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(isProviderConfigured('WORDPRESS')).toBe(false);
    vi.stubEnv('ENCRYPTION_KEY', 'x');
    expect(isProviderConfigured('WORDPRESS')).toBe(true);
  });
});

describe('getConnectionCenter', () => {
  it('scopes every query to the organization', async () => {
    const db = fakeDb();
    await getConnectionCenter('org_1', NOW, db);
    const calls = (db as unknown as { __calls: Array<Record<string, unknown>> }).__calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const where of calls) expect(where.organizationId).toBe('org_1');
  });

  it('returns an entry for every known integration, connected or not', async () => {
    configureAll();
    const entries = await getConnectionCenter('org_1', NOW, fakeDb());
    expect(entries.map((e) => e.descriptor.key).sort()).toEqual([
      'GOOGLE_SEARCH_CONSOLE',
      'TIKTOK',
      'WEBSITE',
      'WORDPRESS',
      'YOUTUBE',
    ]);
  });

  it('reports a healthy YouTube connection as CONNECTED with its account label', async () => {
    configureAll();
    const entries = await getConnectionCenter('org_1', NOW, fakeDb([oauthRow()]));
    const yt = entries.find((e) => e.descriptor.key === 'YOUTUBE');
    expect(yt?.state).toBe('CONNECTED');
    expect(yt?.accountLabel).toBe('My Channel');
    expect(yt?.linkedCount).toBe(1);
    expect(yt?.lastCheckedAt).toEqual(PAST);
  });

  it('does not let a stale revoked row mask a live reconnected one', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      // findMany orders newest-first; the revoked row arrives first.
      fakeDb([oauthRow({ id: 'old', status: 'REVOKED' }), oauthRow({ id: 'new' })]),
    );
    const yt = entries.find((e) => e.descriptor.key === 'YOUTUBE');
    expect(yt?.state).toBe('CONNECTED');
    expect(yt?.connectionId).toBe('new');
    expect(yt?.linkedCount).toBe(1);
  });

  it('never claims a connection when the deployment is unconfigured', async () => {
    // TikTok credentials deliberately absent — the Phase 30 staging situation.
    vi.stubEnv('ENCRYPTION_KEY', 'x');
    vi.stubEnv('TIKTOK_CLIENT_KEY', '');
    vi.stubEnv('TIKTOK_CLIENT_SECRET', '');
    const entries = await getConnectionCenter('org_1', NOW, fakeDb());
    const tt = entries.find((e) => e.descriptor.key === 'TIKTOK');
    expect(tt?.configured).toBe(false);
    expect(tt?.state).toBe('NOT_CONNECTED');
    // The user must be told this is an operator problem, not their account.
    expect(tt?.diagnostic.explanation).toContain('operator setting');
    expect(tt?.diagnostic.action).toBe('NONE');
  });

  it('surfaces an expired connection as recoverable, not broken', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb([oauthRow({ expiresAt: PAST })]),
    );
    const yt = entries.find((e) => e.descriptor.key === 'YOUTUBE');
    expect(yt?.state).toBe('EXPIRED');
    expect(yt?.diagnostic.recommendedAction).toContain('No action needed');
  });

  it('demands reconnection when there is no refresh token to recover with', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb([oauthRow({ expiresAt: PAST, refreshTokenCipher: null })]),
    );
    const yt = entries.find((e) => e.descriptor.key === 'YOUTUBE');
    expect(yt?.state).toBe('REAUTH_REQUIRED');
    expect(yt?.diagnostic.action).toBe('RECONNECT');
  });

  it('reflects actually-granted scopes in the capability list', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      // Only the basic readonly scope — no analytics.
      fakeDb([oauthRow({ scopes: ['https://www.googleapis.com/auth/youtube.readonly'] })]),
    );
    const yt = entries.find((e) => e.descriptor.key === 'YOUTUBE');
    const analytics = yt?.capabilities.find((c) => c.id === 'youtube.get_analytics');
    expect(analytics?.usable).toBe(false);
    expect(analytics?.resolved).toBe('REQUIRES_SCOPE');
  });

  it('marks a website connected only once ownership is verified', async () => {
    configureAll();
    const unverified = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb(
        [],
        [{ id: 'w1', hostname: 'example.com', verified: false, verifiedAt: null, createdAt: PAST }],
      ),
    );
    const pending = unverified.find((e) => e.descriptor.key === 'WEBSITE');
    expect(pending?.state).toBe('CONNECTING');
    expect(pending?.linkedCount).toBe(0);
    expect(pending?.diagnostic.recommendedAction).toContain('verification');

    const verified = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb(
        [],
        [{ id: 'w1', hostname: 'example.com', verified: true, verifiedAt: PAST, createdAt: PAST }],
      ),
    );
    const live = verified.find((e) => e.descriptor.key === 'WEBSITE');
    expect(live?.state).toBe('CONNECTED');
    expect(live?.accountLabel).toBe('example.com');
    expect(live?.linkedCount).toBe(1);
  });

  it('reports WordPress as available but not connected until a site is linked', async () => {
    configureAll();
    const entries = await getConnectionCenter('org_1', NOW, fakeDb());
    const wp = entries.find((e) => e.descriptor.key === 'WORDPRESS');
    expect(wp?.configured).toBe(true);
    expect(wp?.descriptor.implemented).toBe(true);
    expect(wp?.state).toBe('NOT_CONNECTED');
  });

  it('resolves WordPress capabilities from the detected WordPress permissions', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb(
        [],
        [],
        [
          {
            id: 'wp1',
            siteUrl: 'https://blog.example.com',
            siteName: 'Blog',
            status: 'ACTIVE',
            detectedCapabilities: ['read', 'edit_posts'],
            lastError: null,
            lastCheckAt: PAST,
            lastCheckOk: true,
            createdAt: PAST,
          },
        ],
      ),
    );
    const wp = entries.find((e) => e.descriptor.key === 'WORDPRESS');
    expect(wp?.state).toBe('CONNECTED');
    expect(wp?.capabilities.find((c) => c.id === 'wordpress.create_draft')?.usable).toBe(true);
    const publish = wp?.capabilities.find((c) => c.id === 'wordpress.publish');
    expect(publish?.usable).toBe(false);
    expect(publish?.unavailableReason).toContain('publish_posts');
  });

  it('shows a WordPress site whose password was rejected as needing reconnection', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb(
        [],
        [],
        [
          {
            id: 'wp1',
            siteUrl: 'https://blog.example.com',
            siteName: null,
            status: 'EXPIRED',
            detectedCapabilities: ['read'],
            lastError: 'WordPress 401 incorrect_password',
            lastCheckAt: PAST,
            lastCheckOk: false,
            createdAt: PAST,
          },
        ],
      ),
    );
    const wp = entries.find((e) => e.descriptor.key === 'WORDPRESS');
    expect(wp?.state).toBe('REAUTH_REQUIRED');
    expect(wp?.diagnostic.action).toBe('RECONNECT');
  });

  it('keeps WordPress unavailable when the deployment has no encryption key', async () => {
    const entries = await getConnectionCenter('org_1', NOW, fakeDb());
    const wp = entries.find((e) => e.descriptor.key === 'WORDPRESS');
    expect(wp?.configured).toBe(false);
    expect(wp?.diagnostic.explanation).toContain('operator setting');
  });

  it('never exposes token ciphertext in the read model', async () => {
    configureAll();
    const entries = await getConnectionCenter('org_1', NOW, fakeDb([oauthRow()]));
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('cipher');
  });
});

describe('summarizeCenter', () => {
  it('counts attention-needing connections separately from never-connected ones', async () => {
    configureAll();
    const entries = await getConnectionCenter(
      'org_1',
      NOW,
      fakeDb([
        oauthRow(),
        oauthRow({ id: 'tt', provider: 'TIKTOK', expiresAt: PAST, refreshTokenCipher: null }),
      ]),
    );
    const summary = summarizeCenter(entries);
    expect(summary.connected).toBe(1);
    expect(summary.needsAttention).toBe(1); // the TikTok REAUTH_REQUIRED row
    expect(summary.available).toBe(5); // YT, GSC, TikTok, Website, WordPress
  });
});
