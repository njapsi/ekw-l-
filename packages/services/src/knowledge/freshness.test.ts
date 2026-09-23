import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { computeExpiry, markStaleKnowledge, resolveFreshnessPolicy, reverifyKnowledgeItem } from './freshness.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

describe('computeExpiry', () => {
  it('returns null for a permanent-record policy — never auto-expires', () => {
    expect(computeExpiry('permanent')).toBeNull();
  });

  it('computes a future date for a bounded policy, relative to the given `from`', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const expiry = computeExpiry('short', from);
    expect(expiry).toEqual(new Date('2026-01-15T00:00:00.000Z')); // +14 days
  });

  it('falls back to null for an unknown policy key rather than throwing', () => {
    expect(computeExpiry('not-a-real-policy')).toBeNull();
  });
});

describe('resolveFreshnessPolicy', () => {
  it('uses the type default when no override is given', () => {
    expect(resolveFreshnessPolicy('BUSINESS_PROFILE')).toBe('long');
  });

  it('honors a valid explicit override over the type default', () => {
    expect(resolveFreshnessPolicy('BUSINESS_PROFILE', 'short')).toBe('short');
  });

  it('ignores an invalid override and falls back to the type default', () => {
    expect(resolveFreshnessPolicy('BUSINESS_PROFILE', 'not-a-policy')).toBe('long');
  });
});

describe('markStaleKnowledge', () => {
  it('demotes an ACTIVE item past its expiresAt to STALE', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.knowledgeItem.create({
      data: {
        id: 'k1',
        organizationId: 'org_1',
        type: 'PERFORMANCE',
        title: 'Old data',
        content: 'x',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const count = await markStaleKnowledge('org_1', asDb);
    expect(count).toBe(1);
    const rows = await db.knowledgeItem.findMany({ where: { id: 'k1' } });
    expect(rows[0]?.status).toBe('STALE');
  });

  it('never touches an item with no expiresAt (a permanent record)', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.knowledgeItem.create({
      data: { id: 'k1', organizationId: 'org_1', type: 'LEARNING', title: 'x', content: 'x', status: 'ACTIVE', expiresAt: null },
    });
    const count = await markStaleKnowledge('org_1', asDb);
    expect(count).toBe(0);
  });

  it('does not touch an already-ARCHIVED item even if expired', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.knowledgeItem.create({
      data: {
        id: 'k1',
        organizationId: 'org_1',
        type: 'PERFORMANCE',
        title: 'x',
        content: 'x',
        status: 'ARCHIVED',
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const count = await markStaleKnowledge('org_1', asDb);
    expect(count).toBe(0);
  });
});

describe('reverifyKnowledgeItem', () => {
  it('sets lastVerifiedAt and clears STALE back to VERIFIED, resetting the freshness clock', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.knowledgeItem.create({
      data: {
        id: 'k1',
        organizationId: 'org_1',
        type: 'PERFORMANCE',
        title: 'x',
        content: 'x',
        status: 'STALE',
        freshnessPolicy: 'short',
      },
    });
    const updated = await reverifyKnowledgeItem('org_1', 'k1', asDb);
    expect(updated?.status).toBe('VERIFIED');
    expect(updated?.lastVerifiedAt).toBeInstanceOf(Date);
    expect(updated?.expiresAt).toBeInstanceOf(Date);
  });

  it('is a cross-tenant no-op — returns null rather than reaching another org\'s item', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.knowledgeItem.create({
      data: { id: 'k1', organizationId: 'org_other', type: 'PERFORMANCE', title: 'x', content: 'x' },
    });
    const updated = await reverifyKnowledgeItem('org_1', 'k1', asDb);
    expect(updated).toBeNull();
  });
});
