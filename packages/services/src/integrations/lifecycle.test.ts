import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const refreshConnectionTokens = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
const resealConnectionIfStale = vi.fn(async (..._a: unknown[]) => true);
const checkWordPressSite = vi.fn(async (..._a: unknown[]) => ({
  ok: true,
  capabilities: ['read'],
  error: null as string | null,
  authFailed: false,
}));

vi.mock('./connections.js', () => ({ refreshConnectionTokens, resealConnectionIfStale }));
vi.mock('../wordpress/connect.js', () => ({
  checkWordPressSite,
  resealWordPressCredential: vi.fn(async () => true),
}));

const { sweepTokenLifecycle } = await import('./lifecycle.js');

const NOW = new Date('2026-09-19T12:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
let db: MemoryDb;
let asDb: Db;

function conn(over: Record<string, unknown>) {
  return db.oAuthConnection.create({
    data: {
      organizationId: 'org_1',
      provider: 'YOUTUBE',
      status: 'ACTIVE',
      refreshTokenCipher: 'rc',
      expiresAt: mins(5),
      lastRefreshedAt: null,
      createdById: 'u1',
      keyId: 'k',
      accessTokenCipher: 'ac',
      ...over,
    },
  });
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  refreshConnectionTokens.mockClear();
  checkWordPressSite.mockClear();
});

describe('sweepTokenLifecycle', () => {
  it('refreshes tokens that are about to expire', async () => {
    await conn({});
    const r = await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(r.refreshed).toBe(1);
    expect(refreshConnectionTokens).toHaveBeenCalledTimes(1);
  });

  it('leaves tokens alone that are far from expiry or were refreshed recently', async () => {
    await conn({ expiresAt: mins(120) });
    await conn({ expiresAt: mins(-30), lastRefreshedAt: mins(-60) });
    const r = await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(r.refreshed).toBe(0);
    expect(refreshConnectionTokens).not.toHaveBeenCalled();
  });

  it('never touches revoked connections', async () => {
    await conn({ status: 'REVOKED' });
    await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(refreshConnectionTokens).not.toHaveBeenCalled();
  });

  it('warns whoever connected it when the refresh token is rejected — once per day', async () => {
    await conn({});
    refreshConnectionTokens.mockRejectedValue(new Error('invalid_grant'));
    await sweepTokenLifecycle({ now: NOW, db: asDb });
    await sweepTokenLifecycle({ now: new Date(NOW.getTime() + 1000), db: asDb });
    refreshConnectionTokens.mockReset();
    refreshConnectionTokens.mockResolvedValue({});
    const notes = db.notification.rows.filter((n) => n.kind === 'integration.reauth_required');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.userId).toBe('u1');
  });

  it('warns about connections that cannot renew themselves before they lapse', async () => {
    await conn({ refreshTokenCipher: null });
    const r = await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(r.reauthWarned).toBe(1);
    expect(refreshConnectionTokens).not.toHaveBeenCalled();
  });

  it('re-validates WordPress sites daily and warns on a revoked password', async () => {
    await db.wordPressSite.create({
      data: {
        organizationId: 'org_1',
        siteUrl: 'https://b.example.com',
        status: 'ACTIVE',
        lastCheckAt: new Date(NOW.getTime() - 2 * 86_400_000),
        createdById: 'u2',
      },
    });
    await db.wordPressSite.create({
      data: {
        organizationId: 'org_1',
        siteUrl: 'https://fresh.example.com',
        status: 'ACTIVE',
        lastCheckAt: NOW,
      },
    });
    checkWordPressSite.mockResolvedValueOnce({
      ok: false,
      capabilities: [],
      error: '401',
      authFailed: true,
    });
    const r = await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(r.wordpressChecked).toBe(1);
    expect(db.notification.rows.some((n) => n.userId === 'u2')).toBe(true);
  });

  it('expires approval requests past their TTL', async () => {
    await db.integrationActionRequest.create({
      data: { organizationId: 'org_1', expiresAt: new Date(NOW.getTime() - 1) },
    });
    const r = await sweepTokenLifecycle({ now: NOW, db: asDb });
    expect(r.approvalsExpired).toBe(1);
    expect(db.integrationActionRequest.rows[0]?.status).toBe('EXPIRED');
  });
});
