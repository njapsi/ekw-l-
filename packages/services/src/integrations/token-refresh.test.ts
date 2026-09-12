import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConnection } from '@growth-agent/db';
import { generateEncryptionKey, seal } from '../crypto/tokens.js';
import { ConnectionUnavailableError, withFreshAccessToken } from './connections.js';
import { registerProviderOAuth } from './oauth-token.js';

const KEY = generateEncryptionKey();
const refreshMock = vi.fn();
const revokeMock = vi.fn(async () => undefined);

function fakeDb() {
  const updates: unknown[] = [];
  return {
    updates,
    oAuthConnection: {
      update: vi.fn(async ({ data }: { data: unknown }) => {
        updates.push(data);
        return {};
      }),
      findUnique: vi.fn(async () => null),
    },
    integrationHealth: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
    },
  };
}

function connection(over: Partial<OAuthConnection> = {}): OAuthConnection {
  const acc = seal('old-access-token', KEY);
  const ref = seal('the-refresh-token', KEY);
  return {
    id: 'conn_1',
    organizationId: 'org_1',
    provider: 'YOUTUBE',
    externalAccountId: 'UC1',
    displayName: 'Chan',
    scopes: [],
    accessTokenCipher: acc.cipher,
    refreshTokenCipher: ref.cipher,
    tokenIv: acc.iv,
    tokenAuthTag: acc.authTag,
    refreshIv: ref.iv,
    refreshAuthTag: ref.authTag,
    keyId: acc.keyId,
    expiresAt: new Date(Date.now() - 60_000), // expired
    status: 'ACTIVE',
    lastRefreshedAt: null,
    lastError: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as OAuthConnection;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
  refreshMock.mockReset();
  registerProviderOAuth('YOUTUBE', { refresh: refreshMock, revoke: revokeMock });
});

describe('withFreshAccessToken (provider-dispatched refresh)', () => {
  it('refreshes an expired token via the provider, persists it, and calls fn with the new token', async () => {
    refreshMock.mockResolvedValue({ access_token: 'brand-new-token', expires_in: 3600 });
    const db = fakeDb();
    const got = await withFreshAccessToken(
      connection(),
      'https://app/callback',
      async (token) => token,
      db as never,
    );
    expect(got).toBe('brand-new-token');
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(db.updates)).toContain('"status":"ACTIVE"');
  });

  it('does not refresh a token that is still valid', async () => {
    const db = fakeDb();
    await withFreshAccessToken(
      connection({ expiresAt: new Date(Date.now() + 3_600_000) }),
      'https://app/callback',
      async (t) => t,
      db as never,
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('marks the connection ERROR and throws when the refresh fails', async () => {
    refreshMock.mockRejectedValue(new Error('invalid_grant'));
    const db = fakeDb();
    await expect(
      withFreshAccessToken(connection(), 'https://app/callback', async (t) => t, db as never),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(JSON.stringify(db.updates)).toContain('"status":"ERROR"');
  });

  it('refuses a REVOKED connection', async () => {
    await expect(
      withFreshAccessToken(
        connection({ status: 'REVOKED' }),
        'https://app/callback',
        async (t) => t,
        fakeDb() as never,
      ),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('throws when the token is expired and there is no refresh token', async () => {
    const db = fakeDb();
    await expect(
      withFreshAccessToken(
        connection({ refreshTokenCipher: null, refreshIv: null, refreshAuthTag: null }),
        'https://app/callback',
        async (t) => t,
        db as never,
      ),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(JSON.stringify(db.updates)).toContain('reconnection required');
  });

  it('dispatches to the correct provider implementation', async () => {
    const ttRefresh = vi.fn(async () => ({ access_token: 'tt-new', expires_in: 3600 }));
    registerProviderOAuth('TIKTOK', { refresh: ttRefresh, revoke: async () => undefined });
    await withFreshAccessToken(
      connection({ provider: 'TIKTOK' }),
      'https://app/callback',
      async (t) => t,
      fakeDb() as never,
    );
    expect(ttRefresh).toHaveBeenCalledOnce();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
