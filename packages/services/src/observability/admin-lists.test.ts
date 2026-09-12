import { describe, expect, it, vi } from 'vitest';
import { listOAuthConnections, listUsers, maskId } from './admin-lists.js';

describe('maskId', () => {
  it('keeps a prefix + suffix and hides the middle', () => {
    expect(maskId('cus_1a2b3c4d5e6f7g8h')).toBe('cus_1a…7g8h');
    expect(maskId('short')).toBe('sh…');
    expect(maskId(null)).toBeNull();
  });
});

describe('listUsers', () => {
  it('paginates and shapes rows without any credential field', async () => {
    const db = {
      user: {
        findMany: vi.fn(async () => [
          {
            id: 'u1',
            email: 'a@example.com',
            name: 'A',
            emailVerified: new Date(),
            createdAt: new Date(),
            deletedAt: null,
            platformStaff: { level: 'SUPPORT' },
            _count: { memberships: 2 },
          },
        ]),
        count: vi.fn(async () => 1),
      },
    } as any;
    const res = await listUsers(db, { page: 1 });
    expect(res.rows[0]).toEqual({
      id: 'u1',
      email: 'a@example.com',
      name: 'A',
      emailVerified: true,
      staffLevel: 'SUPPORT',
      memberships: 2,
      deleted: false,
      createdAt: expect.any(String),
    });
    expect(res.pageCount).toBe(1);
  });
});

describe('listOAuthConnections', () => {
  it('never surfaces token / cipher material', async () => {
    const db = {
      oAuthConnection: {
        findMany: vi.fn(async () => [
          {
            id: 'c1',
            organizationId: 'org1',
            provider: 'YOUTUBE',
            displayName: 'Chan',
            scopes: ['a', 'b', 'c'],
            status: 'ACTIVE',
            expiresAt: null,
            lastRefreshedAt: new Date(),
            lastError: 'refresh failed: token=sk_live_abcdef123456',
            createdAt: new Date(),
            health: { ok: true, detail: null, quotaUnitsUsedToday: 10, lastCheckAt: new Date() },
          },
        ]),
        count: vi.fn(async () => 1),
      },
    } as any;
    const res = await listOAuthConnections(db, {});
    const row = res.rows[0]!;
    expect(row.scopeCount).toBe(3);
    expect(JSON.stringify(row)).not.toMatch(/cipher|accessToken|refreshToken/i);
    expect(row.lastError).not.toContain('sk_live_abcdef');
  });
});
