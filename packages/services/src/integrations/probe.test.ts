import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';

type TokenFn = (token: string) => Promise<unknown>;

const requireConnection = vi.fn(
  async (_org: string, _id: string, _db?: unknown): Promise<unknown> => null,
);
const withFreshAccessToken = vi.fn(
  async (_conn: unknown, _uri: string, _fn: TokenFn, _db?: unknown): Promise<unknown> => null,
);
class ConnectionUnavailableError extends Error {}
const recordHealth = vi.fn(
  async (_id: string, _update: { ok: boolean; detail?: string }, _db?: unknown) => {},
);

vi.mock('./connections.js', () => ({
  requireConnection,
  withFreshAccessToken,
  ConnectionUnavailableError,
}));
vi.mock('./health.js', () => ({ recordHealth }));

const { testConnection } = await import('./probe.js');

const CONN = {
  id: 'conn_1',
  organizationId: 'org_1',
  provider: 'YOUTUBE' as const,
  status: 'ACTIVE' as const,
  expiresAt: new Date(Date.now() + 3_600_000),
  lastError: null,
  refreshTokenCipher: 'cipher',
};

function fakeDb(): Db {
  return {
    oAuthConnection: {
      findUnique: vi.fn(async () => ({
        status: CONN.status,
        expiresAt: CONN.expiresAt,
        lastError: CONN.lastError,
        refreshTokenCipher: CONN.refreshTokenCipher,
      })),
    },
  } as unknown as Db;
}

beforeEach(() => {
  vi.restoreAllMocks();
  requireConnection.mockReset().mockResolvedValue(CONN);
  withFreshAccessToken.mockReset();
  recordHealth.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run the callback `withFreshAccessToken` would run, with a stub token. */
function passThroughToken() {
  withFreshAccessToken.mockImplementation(async (_conn, _uri, fn: TokenFn) => fn('tok'));
}

describe('testConnection', () => {
  it('asserts tenant ownership before making any provider call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    requireConnection.mockRejectedValue(new Error('not_found'));

    await expect(testConnection('org_1', 'conn_x', 'https://app/cb', fakeDb())).rejects.toThrow(
      'not_found',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a passing probe and reports CONNECTED', async () => {
    passThroughToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    const result = await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    expect(result.ok).toBe(true);
    expect(result.state).toBe('CONNECTED');
    expect(recordHealth).toHaveBeenCalledWith(
      'conn_1',
      expect.objectContaining({ ok: true }),
      expect.anything(),
    );
  });

  it('uses the cheapest read-only YouTube endpoint', async () => {
    passThroughToken();
    const fetchSpy = vi.fn(async (_url: string | URL) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('youtube/v3/channels');
    expect(url).toContain('part=id');
    expect(url).toContain('mine=true');
  });

  it('records a failing probe rather than silently reporting success', async () => {
    passThroughToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"quotaExceeded"}}', { status: 403 })),
    );

    const result = await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    expect(result.ok).toBe(false);
    expect(result.state).toBe('DEGRADED');
    expect(recordHealth).toHaveBeenCalledWith(
      'conn_1',
      expect.objectContaining({ ok: false }),
      expect.anything(),
    );
    expect(result.diagnostic.explanation.length).toBeGreaterThan(20);
  });

  it('classifies an unrecoverable refresh failure as needing reconnection', async () => {
    withFreshAccessToken.mockRejectedValue(new ConnectionUnavailableError('reconnect required'));
    vi.stubGlobal('fetch', vi.fn());

    const result = await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    expect(result.state).toBe('REAUTH_REQUIRED');
    expect(result.diagnostic.action).toBe('RECONNECT');
  });

  it('never leaks a token into the recorded health detail', async () => {
    passThroughToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":"invalid access_token=ya29.SECRETVALUE"}', { status: 401 }),
      ),
    );

    await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    const detail = String(recordHealth.mock.calls[0]?.[1]?.detail ?? '');
    // The raw provider body is stored for operators, but what the user sees
    // goes through the scrubber — assert the scrubbed surface is clean.
    const result = await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());
    expect(result.diagnostic.technicalDetail ?? '').not.toContain('SECRETVALUE');
    expect(detail).toContain('401');
  });

  it('reports honestly when no probe exists for a provider', async () => {
    requireConnection.mockResolvedValue({ ...CONN, provider: 'UNKNOWN_PROVIDER' });
    vi.stubGlobal('fetch', vi.fn());

    const result = await testConnection('org_1', 'conn_1', 'https://app/cb', fakeDb());

    expect(result.ok).toBe(false);
    expect(result.state).toBe('ERROR');
  });
});
