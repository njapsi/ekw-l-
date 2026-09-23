import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { acceptMemoryCandidate, listMemoryCandidates, proposeMemoryCandidate, rejectMemoryCandidate } from './candidates.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
});

describe('proposeMemoryCandidate', () => {
  it('does NOT automatically save a HIGH-importance statement — stays PENDING', async () => {
    const candidate = await proposeMemoryCandidate(
      {
        organizationId: 'org_1',
        content: 'Our target market changed to enterprise only.',
        proposedType: 'AUDIENCE_PROFILE',
        reason: 'chat',
        importance: 'HIGH',
        confidence: 0.95,
      },
      asDb,
    );
    expect(candidate.status).toBe('PENDING');
  });

  it('auto-accepts a LOW-importance, high-confidence, directly user-provided statement', async () => {
    const candidate = await proposeMemoryCandidate(
      {
        organizationId: 'org_1',
        content: 'We prefer a friendly tone.',
        proposedType: 'BRAND_PROFILE',
        reason: 'chat',
        classification: 'USER_PROVIDED',
        importance: 'LOW',
        confidence: 0.9,
      },
      asDb,
    );
    expect(candidate.status).toBe('AUTO_ACCEPTED');
    expect(candidate.resolvedKnowledgeId).toBeTruthy();
    const item = await db.knowledgeItem.findFirst({ where: { id: candidate.resolvedKnowledgeId! } });
    expect(item?.status).toBe('ACTIVE');
  });

  it('does not auto-accept a low-confidence statement even if otherwise low-stakes', async () => {
    const candidate = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'x', proposedType: 'GOAL', reason: 'chat', importance: 'LOW', confidence: 0.4 },
      asDb,
    );
    expect(candidate.status).toBe('PENDING');
  });

  it('supersedes an identical unreviewed candidate instead of creating a duplicate', async () => {
    const first = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'Same statement', proposedType: 'GOAL', reason: 'chat', importance: 'CRITICAL' },
      asDb,
    );
    const second = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'Same statement', proposedType: 'GOAL', reason: 'chat', importance: 'CRITICAL' },
      asDb,
    );
    expect(second.id).toBe(first.id);
    const pending = await listMemoryCandidates('org_1', 'PENDING', asDb);
    expect(pending).toHaveLength(1);
  });
});

describe('acceptMemoryCandidate / rejectMemoryCandidate', () => {
  it('accepting creates a real KnowledgeItem and marks the candidate ACCEPTED', async () => {
    const candidate = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'A durable fact', proposedType: 'STRATEGY', reason: 'chat', importance: 'HIGH' },
      asDb,
    );
    const resolved = await acceptMemoryCandidate('org_1', candidate.id, 'user_1', asDb);
    expect(resolved.status).toBe('ACCEPTED');
    expect(resolved.resolvedKnowledgeId).toBeTruthy();
  });

  it('rejecting never creates a KnowledgeItem', async () => {
    const candidate = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'A rejected statement', proposedType: 'STRATEGY', reason: 'chat', importance: 'HIGH' },
      asDb,
    );
    const resolved = await rejectMemoryCandidate('org_1', candidate.id, 'user_1', asDb);
    expect(resolved.status).toBe('REJECTED');
    expect(resolved.resolvedKnowledgeId).toBeFalsy();
    expect(db.knowledgeItem.rows).toHaveLength(0);
  });

  it('is idempotent — accepting an already-resolved candidate is a no-op, not a double-create', async () => {
    const candidate = await proposeMemoryCandidate(
      { organizationId: 'org_1', content: 'x', proposedType: 'STRATEGY', reason: 'chat', importance: 'HIGH' },
      asDb,
    );
    await acceptMemoryCandidate('org_1', candidate.id, 'user_1', asDb);
    const countBefore = db.knowledgeItem.rows.length;
    await acceptMemoryCandidate('org_1', candidate.id, 'user_1', asDb);
    expect(db.knowledgeItem.rows).toHaveLength(countBefore);
  });
});
