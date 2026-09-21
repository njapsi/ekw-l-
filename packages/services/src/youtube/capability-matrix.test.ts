import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const { getYouTubeCapabilityMatrix } = await import('./capability-matrix.js');

let db: MemoryDb;
let asDb: Db;

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getYouTubeCapabilityMatrix', () => {
  it('reports all 14 named capabilities, never silently omitting one', async () => {
    const matrix = await getYouTubeCapabilityMatrix('org_1', asDb);
    expect(matrix.capabilities).toHaveLength(14);
    const keys = matrix.capabilities.map((c) => c.key);
    expect(new Set(keys).size).toBe(14);
  });

  it('reports not connected, with every read capability unavailable, when no account is linked', async () => {
    const matrix = await getYouTubeCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
    const channelRead = matrix.capabilities.find((c) => c.key === 'CHANNEL_READ')!;
    expect(channelRead.available).toBe(false);
    expect(channelRead.reason).toMatch(/No YouTube account is connected/);
  });

  it('always reports every write-shaped capability as unavailable, connected or not, with the "never requested" reason', async () => {
    const matrix = await getYouTubeCapabilityMatrix('org_1', asDb);
    const writeKeys = [
      'VIDEO_CREATE',
      'VIDEO_UPDATE',
      'VIDEO_PUBLISH',
      'VIDEO_DELETE',
      'PLAYLIST_CREATE',
      'PLAYLIST_UPDATE',
      'PLAYLIST_DELETE',
    ] as const;
    for (const key of writeKeys) {
      const cap = matrix.capabilities.find((c) => c.key === key)!;
      expect(cap.available).toBe(false);
      expect(cap.reason).toMatch(/read-only YouTube scopes/);
    }
  });

  it('reports AUDIENCE_ANALYTICS_READ and TRAFFIC_ANALYTICS_READ as unavailable with a sync-gap reason, not a scope reason', async () => {
    const matrix = await getYouTubeCapabilityMatrix('org_1', asDb);
    const audience = matrix.capabilities.find((c) => c.key === 'AUDIENCE_ANALYTICS_READ')!;
    const traffic = matrix.capabilities.find((c) => c.key === 'TRAFFIC_ANALYTICS_READ')!;
    expect(audience.available).toBe(false);
    expect(audience.reason).toMatch(/not synced/);
    expect(traffic.available).toBe(false);
    expect(traffic.reason).toMatch(/not synced/);
  });

  it('never reports a capability as available for an organization other than the one asked about', async () => {
    await db.oAuthConnection.create({
      data: {
        organizationId: 'org_2',
        provider: 'YOUTUBE',
        externalAccountId: 'ext1',
        scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        accessTokenCipher: 'c',
        tokenIv: 'i',
        tokenAuthTag: 't',
        keyId: 'k',
        status: 'ACTIVE',
      },
    });
    const matrix = await getYouTubeCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
  });
});
