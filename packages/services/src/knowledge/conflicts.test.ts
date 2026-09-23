import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { detectConflictsForItem, listConflicts, resolveConflict } from './conflicts.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
});

describe('detectConflictsForItem', () => {
  it('flags two same-topic items whose content materially disagrees', async () => {
    await db.knowledgeItem.create({
      data: {
        id: 'a',
        organizationId: 'org_1',
        type: 'AUDIENCE_PROFILE',
        title: 'Our target market',
        content: 'Our target market is small business owners in the United States retail sector.',
        status: 'ACTIVE',
      },
    });
    await db.knowledgeItem.create({
      data: {
        id: 'b',
        organizationId: 'org_1',
        type: 'AUDIENCE_PROFILE',
        title: 'Our target market',
        content: 'Our target market is large enterprise finance departments in Europe entirely.',
        status: 'ACTIVE',
      },
    });
    const found = await detectConflictsForItem('org_1', 'a', asDb);
    expect(found).toBe(1);
    const conflicts = await listConflicts('org_1', 'OPEN', asDb);
    expect(conflicts).toHaveLength(1);
    // Both items are flagged, never silently resolved by picking one.
    const rowA = await db.knowledgeItem.findFirst({ where: { id: 'a' } });
    const rowB = await db.knowledgeItem.findFirst({ where: { id: 'b' } });
    expect(rowA?.status).toBe('CONFLICTED');
    expect(rowB?.status).toBe('CONFLICTED');
  });

  it('does not flag two unrelated items of the same type', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'PRODUCT', title: 'Widget line', content: 'We sell physical widgets in blue and red.', status: 'ACTIVE' },
    });
    await db.knowledgeItem.create({
      data: { id: 'b', organizationId: 'org_1', type: 'PRODUCT', title: 'Consulting service', content: 'We offer strategy consulting for enterprise clients.', status: 'ACTIVE' },
    });
    const found = await detectConflictsForItem('org_1', 'a', asDb);
    expect(found).toBe(0);
  });

  it('does not flag two items that agree, even on the same topic', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'BRAND_PROFILE', title: 'Brand voice', content: 'Our brand voice is friendly casual approachable warm.', status: 'ACTIVE' },
    });
    await db.knowledgeItem.create({
      data: { id: 'b', organizationId: 'org_1', type: 'BRAND_PROFILE', title: 'Brand voice', content: 'Our brand voice is friendly casual approachable warm and fun.', status: 'ACTIVE' },
    });
    const found = await detectConflictsForItem('org_1', 'a', asDb);
    expect(found).toBe(0);
  });

  it('is a no-op for a not-found or already-archived item', async () => {
    expect(await detectConflictsForItem('org_1', 'missing', asDb)).toBe(0);
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'PRODUCT', title: 'x', content: 'x', status: 'ARCHIVED' },
    });
    expect(await detectConflictsForItem('org_1', 'a', asDb)).toBe(0);
  });
});

describe('resolveConflict', () => {
  async function makeConflict(): Promise<{ id: string }> {
    await db.knowledgeItem.create({ data: { id: 'a', organizationId: 'org_1', type: 'AUDIENCE_PROFILE', title: 'x', content: 'x', status: 'CONFLICTED' } });
    await db.knowledgeItem.create({ data: { id: 'b', organizationId: 'org_1', type: 'AUDIENCE_PROFILE', title: 'y', content: 'y', status: 'CONFLICTED' } });
    const row = await db.knowledgeConflict.create({ data: { organizationId: 'org_1', topic: 'x', knowledgeAId: 'a', knowledgeBId: 'b' } });
    return { id: row.id as string };
  }

  it('keeping one side marks it VERIFIED and rejects the other', async () => {
    const conflict = await makeConflict();
    await resolveConflict('org_1', conflict.id, { resolution: 'A is correct', keepKnowledgeId: 'a', status: 'RESOLVED' }, 'user_1', asDb);
    expect((await db.knowledgeItem.findFirst({ where: { id: 'a' } }))?.status).toBe('VERIFIED');
    expect((await db.knowledgeItem.findFirst({ where: { id: 'b' } }))?.status).toBe('REJECTED');
  });

  it('resolving with no winner clears both back to ACTIVE, never guessing a verdict', async () => {
    const conflict = await makeConflict();
    await resolveConflict('org_1', conflict.id, { resolution: 'Both true in context', status: 'RESOLVED' }, 'user_1', asDb);
    expect((await db.knowledgeItem.findFirst({ where: { id: 'a' } }))?.status).toBe('ACTIVE');
    expect((await db.knowledgeItem.findFirst({ where: { id: 'b' } }))?.status).toBe('ACTIVE');
  });

  it('dismissing leaves both items CONFLICTED (no verdict recorded)', async () => {
    const conflict = await makeConflict();
    await resolveConflict('org_1', conflict.id, { resolution: 'skip', status: 'DISMISSED' }, 'user_1', asDb);
    expect((await db.knowledgeItem.findFirst({ where: { id: 'a' } }))?.status).toBe('CONFLICTED');
  });
});
