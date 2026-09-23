import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import {
  archiveKnowledgeItem,
  createKnowledgeItem,
  deleteKnowledgeItem,
  getKnowledgeItem,
  updateKnowledgeItem,
  verifyKnowledgeItem,
} from './items.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
});

describe('createKnowledgeItem', () => {
  it('defaults to DRAFT status and the type\'s default freshness policy', async () => {
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'Our business', content: 'We sell widgets.' },
      { organizationId: 'org_1' },
      asDb,
    );
    expect(item.status).toBe('DRAFT');
    expect(item.freshnessPolicy).toBe('long');
    expect(item.expiresAt).toBeInstanceOf(Date);
  });

  it('never sets VERIFIED on creation, even for a directly user-provided item', async () => {
    const item = await createKnowledgeItem(
      { type: 'AUDIENCE_PROFILE', title: 'Audience', content: 'SMBs', classification: 'USER_PROVIDED', status: 'ACTIVE' },
      { organizationId: 'org_1' },
      asDb,
    );
    expect(item.status).not.toBe('VERIFIED');
  });

  it('creates a source row when `source` is given and links primarySourceId', async () => {
    const item = await createKnowledgeItem(
      {
        type: 'RESEARCH',
        title: 'Findings',
        content: 'x',
        source: { type: 'WEB_RESEARCH', url: 'https://example.com/a' },
      },
      { organizationId: 'org_1' },
      asDb,
    );
    expect(item.primarySourceId).toBeTruthy();
    const source = await db.knowledgeSource.findFirst({ where: { id: item.primarySourceId! } });
    expect(source?.url).toBe('https://example.com/a');
    expect(source?.trustLevel).toBe('LOW'); // WEB_RESEARCH per trustLevelFor
  });
});

describe('getKnowledgeItem', () => {
  it('throws resource_not_found for another organization\'s item — tenant isolation', async () => {
    await db.organization.create({ data: { id: 'org_2', name: 'Org 2', slug: 'org-2' } });
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'x', content: 'x' },
      { organizationId: 'org_2' },
      asDb,
    );
    await expect(getKnowledgeItem('org_1', item.id, asDb)).rejects.toThrow(/not found/i);
  });
});

describe('verifyKnowledgeItem', () => {
  it('is the only function that sets status to VERIFIED', async () => {
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'x', content: 'x' },
      { organizationId: 'org_1' },
      asDb,
    );
    const verified = await verifyKnowledgeItem('org_1', item.id, 'user_1', asDb);
    expect(verified.status).toBe('VERIFIED');
    expect(verified.lastVerifiedAt).toBeInstanceOf(Date);
  });
});

describe('archiveKnowledgeItem / deleteKnowledgeItem', () => {
  it('archive sets status without deleting the row', async () => {
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'x', content: 'x' },
      { organizationId: 'org_1' },
      asDb,
    );
    const archived = await archiveKnowledgeItem('org_1', item.id, 'user_1', asDb);
    expect(archived.status).toBe('ARCHIVED');
    expect(await getKnowledgeItem('org_1', item.id, asDb)).toBeTruthy();
  });

  it('delete actually removes the row', async () => {
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'x', content: 'x' },
      { organizationId: 'org_1' },
      asDb,
    );
    await deleteKnowledgeItem('org_1', item.id, 'user_1', asDb);
    await expect(getKnowledgeItem('org_1', item.id, asDb)).rejects.toThrow();
  });
});

describe('updateKnowledgeItem', () => {
  it('updates only the given fields, leaving the rest untouched', async () => {
    const item = await createKnowledgeItem(
      { type: 'BUSINESS_PROFILE', title: 'Old title', content: 'x', importance: 'LOW' },
      { organizationId: 'org_1' },
      asDb,
    );
    const updated = await updateKnowledgeItem('org_1', item.id, { title: 'New title' }, 'user_1', asDb);
    expect(updated.title).toBe('New title');
    expect(updated.importance).toBe('LOW');
  });
});
