import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { retrieveKnowledge } from './retrieval.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.organization.create({ data: { id: 'org_2', name: 'Org 2', slug: 'org-2' } });
});

describe('retrieveKnowledge', () => {
  it('ranks a keyword match above an unrelated item, without any embedding model configured', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'AUDIENCE_PROFILE', title: 'Our audience', content: 'Small business owners in retail.', status: 'ACTIVE' },
    });
    await db.knowledgeItem.create({
      data: { id: 'b', organizationId: 'org_1', type: 'PRODUCT', title: 'Unrelated product line', content: 'Industrial fasteners for manufacturing.', status: 'ACTIVE' },
    });
    const results = await retrieveKnowledge('org_1', 'audience', {}, undefined, asDb);
    expect(results[0]?.id).toBe('a');
  });

  it('never returns another organization\'s knowledge — tenant isolation', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_2', type: 'BUSINESS_PROFILE', title: 'Secret plan', content: 'Confidential strategy details.', status: 'ACTIVE' },
    });
    const results = await retrieveKnowledge('org_1', 'secret plan', {}, undefined, asDb);
    expect(results).toHaveLength(0);
  });

  it('excludes ARCHIVED/REJECTED/EXPIRED items by default', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'PRODUCT', title: 'Old product', content: 'Old product details.', status: 'ARCHIVED' },
    });
    const results = await retrieveKnowledge('org_1', 'product', {}, undefined, asDb);
    expect(results.map((r) => r.id)).not.toContain('a');
  });

  it('does not rank purely by a single factor — a lower-importance keyword match can rank below a higher-importance one on the same topic', async () => {
    await db.knowledgeItem.create({
      data: { id: 'low', organizationId: 'org_1', type: 'GOAL', title: 'Growth goal', content: 'Grow revenue this year.', status: 'ACTIVE', importance: 'LOW', confidence: 0.3 },
    });
    await db.knowledgeItem.create({
      data: { id: 'high', organizationId: 'org_1', type: 'GOAL', title: 'Growth goal priority', content: 'Grow revenue this year is our top priority.', status: 'ACTIVE', importance: 'CRITICAL', confidence: 0.95 },
    });
    const results = await retrieveKnowledge('org_1', 'grow revenue', {}, undefined, asDb);
    const highIndex = results.findIndex((r) => r.id === 'high');
    const lowIndex = results.findIndex((r) => r.id === 'low');
    expect(highIndex).toBeLessThan(lowIndex);
  });

  it('scopes to a given mission plus org-level items, never another mission\'s items', async () => {
    await db.knowledgeItem.create({
      data: { id: 'org-item', organizationId: 'org_1', type: 'BUSINESS_PROFILE', title: 'General', content: 'General org knowledge.', status: 'ACTIVE', scope: 'ORGANIZATION' },
    });
    await db.knowledgeItem.create({
      data: { id: 'mission-a', organizationId: 'org_1', type: 'EXPERIMENT', title: 'A', content: 'Mission A learning.', status: 'ACTIVE', scope: 'MISSION', missionId: 'mission_a' },
    });
    await db.knowledgeItem.create({
      data: { id: 'mission-b', organizationId: 'org_1', type: 'EXPERIMENT', title: 'B', content: 'Mission B learning.', status: 'ACTIVE', scope: 'MISSION', missionId: 'mission_b' },
    });
    const results = await retrieveKnowledge('org_1', '', { missionId: 'mission_a', limit: 10 }, undefined, asDb);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('org-item');
    expect(ids).toContain('mission-a');
    expect(ids).not.toContain('mission-b');
  });

  it('with an empty query, still returns items ranked by importance/recency/confidence (no crash on empty keyword match)', async () => {
    await db.knowledgeItem.create({
      data: { id: 'a', organizationId: 'org_1', type: 'GOAL', title: 'x', content: 'x', status: 'ACTIVE' },
    });
    const results = await retrieveKnowledge('org_1', '', {}, undefined, asDb);
    expect(results).toHaveLength(1);
    expect(results[0]?.matchedVia).toContain('importance');
  });
});
