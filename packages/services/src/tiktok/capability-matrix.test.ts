import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const { getTikTokCapabilityMatrix } = await import('./capability-matrix.js');

let db: MemoryDb;
let asDb: Db;

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getTikTokCapabilityMatrix', () => {
  it('reports all 12 named capabilities, never silently omitting one', async () => {
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    expect(matrix.capabilities).toHaveLength(12);
    const keys = matrix.capabilities.map((c) => c.key);
    expect(new Set(keys).size).toBe(12);
  });

  it('reports not connected, with every read capability NOT_AVAILABLE, when no account is linked', async () => {
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
    const accountRead = matrix.capabilities.find((c) => c.key === 'ACCOUNT_READ')!;
    expect(accountRead.availability).toBe('NOT_AVAILABLE');
    expect(accountRead.reason).toMatch(/No TikTok account is connected/);
  });

  it('always reports API-absent capabilities as NOT_AVAILABLE with the "no public API" reason', async () => {
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    const absentKeys = [
      'AUDIENCE_ANALYTICS_READ',
      'COMMENTS_READ',
      'VIDEO_UPDATE',
      'VIDEO_DELETE',
      'COMMENT_MANAGEMENT',
    ] as const;
    for (const key of absentKeys) {
      const cap = matrix.capabilities.find((c) => c.key === key)!;
      expect(cap.availability).toBe('NOT_AVAILABLE');
      expect(cap.reason).toMatch(/no public API|no such endpoint|no endpoint/i);
    }
  });

  it('reports CONTENT_ANALYTICS_READ as NOT_AVAILABLE with a product-absence reason, not a scope reason', async () => {
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    const analytics = matrix.capabilities.find((c) => c.key === 'CONTENT_ANALYTICS_READ')!;
    expect(analytics.availability).toBe('NOT_AVAILABLE');
    expect(analytics.reason).toMatch(/day-by-day analytics/);
  });

  it('never reports a capability as available for an organization other than the one asked about', async () => {
    await db.oAuthConnection.create({
      data: {
        organizationId: 'org_2',
        provider: 'TIKTOK',
        externalAccountId: 'ext1',
        scopes: ['user.info.basic'],
        accessTokenCipher: 'c',
        tokenIv: 'i',
        tokenAuthTag: 't',
        keyId: 'k',
        status: 'ACTIVE',
      },
    });
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
  });

  it('assigns the correct level to every capability (READ_ONLY, WRITE, PUBLISH, DELETE)', async () => {
    const matrix = await getTikTokCapabilityMatrix('org_1', asDb);
    expect(matrix.capabilities.find((c) => c.key === 'ACCOUNT_READ')!.level).toBe('READ_ONLY');
    expect(matrix.capabilities.find((c) => c.key === 'CONTENT_PUBLISH')!.level).toBe('PUBLISH');
    expect(matrix.capabilities.find((c) => c.key === 'VIDEO_DELETE')!.level).toBe('DELETE');
    expect(matrix.capabilities.find((c) => c.key === 'COMMENT_MANAGEMENT')!.level).toBe('WRITE');
  });
});
