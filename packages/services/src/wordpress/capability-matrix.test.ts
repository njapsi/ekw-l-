import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const { getWordPressCapabilityMatrix } = await import('./capability-matrix.js');

let db: MemoryDb;
let asDb: Db;

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  vi.stubEnv('ENCRYPTION_KEY', 'x');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getWordPressCapabilityMatrix', () => {
  it('reports all 18 named capabilities, never silently omitting one', async () => {
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    expect(matrix.capabilities).toHaveLength(18);
    const keys = matrix.capabilities.map((c) => c.key);
    expect(new Set(keys).size).toBe(18);
  });

  it('reports not connected, with every capability NOT_AVAILABLE, when no site is linked', async () => {
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
    const siteRead = matrix.capabilities.find((c) => c.key === 'SITE_READ')!;
    expect(siteRead.availability).toBe('NOT_AVAILABLE');
    expect(siteRead.reason).toMatch(/No WordPress site is connected/);
  });

  it('always reports capabilities with no underlying API as NOT_AVAILABLE, connected or not', async () => {
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    const absentKeys = ['POST_DELETE', 'PAGE_DELETE', 'MEDIA_READ', 'MEDIA_UPLOAD', 'CATEGORY_READ', 'TAG_READ', 'COMMENT_READ'] as const;
    for (const key of absentKeys) {
      const c = matrix.capabilities.find((x) => x.key === key)!;
      expect(c.availability).toBe('NOT_AVAILABLE');
    }
  });

  it('reports SEO metadata capabilities as NOT_AVAILABLE with a plugin-assumption reason, never a scope reason', async () => {
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    const read = matrix.capabilities.find((c) => c.key === 'SEO_METADATA_READ')!;
    const update = matrix.capabilities.find((c) => c.key === 'SEO_METADATA_UPDATE')!;
    expect(read.availability).toBe('NOT_AVAILABLE');
    expect(read.reason).toMatch(/does not assume any particular SEO plugin/);
    expect(update.availability).toBe('NOT_AVAILABLE');
  });

  it('assigns the correct level to every capability', async () => {
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    expect(matrix.capabilities.find((c) => c.key === 'SITE_READ')!.level).toBe('READ_ONLY');
    expect(matrix.capabilities.find((c) => c.key === 'POST_PUBLISH')!.level).toBe('PUBLISH');
    expect(matrix.capabilities.find((c) => c.key === 'POST_DELETE')!.level).toBe('DELETE');
    expect(matrix.capabilities.find((c) => c.key === 'MEDIA_UPLOAD')!.level).toBe('WRITE');
  });

  it('never reports a capability as available for an organization other than the one asked about', async () => {
    await db.wordPressSite.create({
      data: {
        organizationId: 'org_2',
        siteUrl: 'https://blog.example.com',
        username: 'editor',
        credentialCipher: 'c',
        credentialIv: 'i',
        credentialAuthTag: 't',
        keyId: 'k',
        status: 'ACTIVE',
        detectedCapabilities: ['read', 'edit_posts', 'publish_posts'],
        lastCheckOk: true,
        lastCheckAt: new Date(),
      },
    });
    const matrix = await getWordPressCapabilityMatrix('org_1', asDb);
    expect(matrix.connected).toBe(false);
  });
});
