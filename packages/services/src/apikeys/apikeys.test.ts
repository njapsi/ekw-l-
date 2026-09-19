import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Role } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  requireScope,
  revokeApiKey,
} from './index.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

let db: MemoryDb;
let asDb: Db;

async function member(userId: string, role: Role, org = 'org_1') {
  return db.membership.create({ data: { userId, organizationId: org, role, status: 'ACTIVE' } });
}

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await member('admin', 'ADMIN');
});

describe('API keys', () => {
  it('shows the full key once and stores only a hash', async () => {
    const created = await createApiKey(
      'admin',
      'org_1',
      { name: 'CI', scopes: ['seo:read'] },
      asDb,
    );
    expect(created.key).toMatch(/^ga_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const secret = created.key.split('_').slice(2).join('_');
    expect(JSON.stringify(db.apiKey.rows)).not.toContain(secret);
    // The list query never selects the hash (the in-memory DB ignores
    // `select`, so assert on the query itself).
    const spy = vi.spyOn(db.apiKey, 'findMany');
    await listApiKeys('admin', 'org_1', asDb);
    const select = (spy.mock.calls[0]?.[0] as { select?: Record<string, unknown> })?.select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('secretHash');
  });

  it('authenticates a valid key to its organization and scopes', async () => {
    const { key } = await createApiKey(
      'admin',
      'org_1',
      { name: 'CI', scopes: ['seo:read'] },
      asDb,
    );
    const p = await authenticateApiKey(key, asDb);
    expect(p.organizationId).toBe('org_1');
    expect(() => requireScope(p, 'seo:read')).not.toThrow();
    expect(() => requireScope(p, 'content:write')).toThrow(/lacks the "content:write" scope/);
  });

  it('rejects malformed, wrong-secret, revoked and expired keys with one generic error', async () => {
    const { key, id } = await createApiKey(
      'admin',
      'org_1',
      { name: 'CI', scopes: ['seo:read'], expiresInDays: 1 },
      asDb,
    );
    const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    for (const bad of ['nope', '', tampered]) {
      await expect(authenticateApiKey(bad, asDb)).rejects.toThrow('Invalid or expired API key.');
    }
    await expect(
      authenticateApiKey(key, asDb, new Date(Date.now() + 2 * 86_400_000)),
    ).rejects.toThrow('Invalid or expired API key.');
    await revokeApiKey('admin', 'org_1', id, asDb);
    await expect(authenticateApiKey(key, asDb)).rejects.toThrow('Invalid or expired API key.');
  });

  it('a key cannot grant more than its creator can do', async () => {
    await member('mgr', 'MANAGER');
    await expect(
      createApiKey('mgr', 'org_1', { name: 'x', scopes: ['seo:read'] }, asDb),
    ).rejects.toThrow();
  });

  it('dies when its creator is demoted or removed', async () => {
    const { key } = await createApiKey(
      'admin',
      'org_1',
      { name: 'CI', scopes: ['integrations:manage'] },
      asDb,
    );
    await db.membership.update({
      where: { userId_organizationId: { userId: 'admin', organizationId: 'org_1' } },
      data: { role: 'MEMBER' },
    });
    await expect(authenticateApiKey(key, asDb)).rejects.toThrow('Invalid or expired API key.');
  });

  it('cannot be revoked from another organization', async () => {
    const { id } = await createApiKey('admin', 'org_1', { name: 'CI', scopes: ['seo:read'] }, asDb);
    await member('admin2', 'ADMIN', 'org_2');
    await expect(revokeApiKey('admin2', 'org_2', id, asDb)).rejects.toThrow(/not found/);
    expect(db.apiKey.rows[0]?.revokedAt).toBeNull();
  });

  it('records creation as a security event', async () => {
    await createApiKey('admin', 'org_1', { name: 'CI', scopes: ['seo:read'] }, asDb);
    expect(db.securityEvent.rows.some((e) => e.type === 'API_KEY_CREATED')).toBe(true);
  });
});
