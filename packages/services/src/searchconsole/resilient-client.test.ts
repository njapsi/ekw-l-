import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, OAuthConnection } from '@growth-agent/db';
import { ScAuthExpiredError } from './client.js';
import { ConnectionUnavailableError } from '../integrations/connections.js';

const h = vi.hoisted(() => ({
  withFreshAccessToken: vi.fn(
    async (_c: unknown, _u: unknown, fn: (t: string) => Promise<unknown>) => fn('tok'),
  ),
  listSitesCalls: { n: 0 },
}));

vi.mock('../integrations/connections.js', async () => {
  const actual = (await vi.importActual('../integrations/connections.js')) as Record<
    string,
    unknown
  >;
  return { ...actual, withFreshAccessToken: h.withFreshAccessToken };
});
vi.mock('./google-client.js', () => ({
  GoogleSearchConsoleClient: class {
    async listSites() {
      h.listSitesCalls.n++;
      if (h.listSitesCalls.n === 1) throw new ScAuthExpiredError();
      return { siteEntry: [{ siteUrl: 'sc-domain:x.com', permissionLevel: 'siteOwner' }] };
    }
  },
}));

const { ResilientSearchConsoleClient } = await import('./resilient-client.js');

const conn = { id: 'conn_1', status: 'ACTIVE' } as OAuthConnection;

beforeEach(() => {
  h.listSitesCalls.n = 0;
  vi.clearAllMocks();
});

describe('ResilientSearchConsoleClient', () => {
  it('on a 401 it marks the connection EXPIRED, refreshes and retries once', async () => {
    const db = {
      oAuthConnection: {
        update: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => ({ id: 'conn_1', status: 'EXPIRED' })),
      },
    } as unknown as Db;
    const client = new ResilientSearchConsoleClient(conn, 'https://app/cb', db);
    const res = await client.listSites();
    expect(res.siteEntry[0]!.siteUrl).toBe('sc-domain:x.com');
    expect(h.listSitesCalls.n).toBe(2);
    expect(db.oAuthConnection.update as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
    expect(h.withFreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('throws ConnectionUnavailableError if the connection vanished mid-retry', async () => {
    const db = {
      oAuthConnection: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    } as unknown as Db;
    const client = new ResilientSearchConsoleClient(conn, 'https://app/cb', db);
    await expect(client.listSites()).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });
});
