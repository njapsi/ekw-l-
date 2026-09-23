import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { assembleAgentContext, summarizeAgentContext } from './context-assembly.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.user.create({ data: { id: 'user_1', email: 'u@example.com' } });
});

describe('assembleAgentContext', () => {
  it('composes org context, memory, and retrieved knowledge into one object', async () => {
    await db.knowledgeItem.create({
      data: {
        id: 'k1',
        organizationId: 'org_1',
        type: 'BUSINESS_PROFILE',
        title: 'Our business',
        content: 'We sell widgets to small businesses.',
        status: 'ACTIVE',
        importance: 'HIGH',
      },
    });
    const ctx = await assembleAgentContext({ organizationId: 'org_1', userId: 'user_1', goal: 'widgets' }, asDb);
    expect(ctx.relevantKnowledge.map((k) => k.id)).toContain('k1');
    expect(ctx.usedSources).toContain('Your stored business knowledge');
    expect(ctx.currentData).toBeDefined();
    expect(ctx.relevantMemory).toBeDefined();
  });

  it('degrades gracefully (empty arrays, no throw) when the knowledge/research reads fail', async () => {
    // A db missing the Phase 11 models entirely (an older fixture/environment)
    // must not crash the whole context assembly — only lose the enhancement.
    const brokenDb = { ...asDb } as Db;
    delete (brokenDb as unknown as Record<string, unknown>).knowledgeItem;
    delete (brokenDb as unknown as Record<string, unknown>).researchProject;
    delete (brokenDb as unknown as Record<string, unknown>).missionLearning;
    const ctx = await assembleAgentContext({ organizationId: 'org_1', userId: 'user_1', goal: 'anything' }, brokenDb);
    expect(ctx.relevantKnowledge).toEqual([]);
    expect(ctx.recentResearch).toEqual([]);
    expect(ctx.historicalLearning).toEqual([]);
  });

  it('includes a mission summary only when a real, org-scoped mission is found', async () => {
    await db.growthMission.create({
      data: { id: 'm1', organizationId: 'org_1', createdById: 'user_1', name: 'Grow traffic', description: 'x', objective: 'Grow organic traffic', successMetrics: [], limits: {} },
    });
    const ctx = await assembleAgentContext(
      { organizationId: 'org_1', userId: 'user_1', goal: 'x', missionId: 'm1' },
      asDb,
    );
    expect(ctx.mission?.name).toBe('Grow traffic');
  });

  it('never surfaces another organization\'s knowledge in relevantKnowledge', async () => {
    await db.organization.create({ data: { id: 'org_2', name: 'Org2', slug: 'org-2' } });
    await db.knowledgeItem.create({
      data: { id: 'k2', organizationId: 'org_2', type: 'BUSINESS_PROFILE', title: 'Secret', content: 'Confidential.', status: 'ACTIVE' },
    });
    const ctx = await assembleAgentContext({ organizationId: 'org_1', userId: 'user_1', goal: 'secret' }, asDb);
    expect(ctx.relevantKnowledge.map((k) => k.id)).not.toContain('k2');
  });
});

describe('summarizeAgentContext', () => {
  it('prefixes each knowledge line with its classification and confidence so a hypothesis reads distinctly from a fact', () => {
    const ctx = {
      organizationId: 'org_1',
      userId: 'user_1',
      goal: 'x',
      mission: null,
      preferences: [],
      goals: [],
      currentData: {} as never,
      relevantKnowledge: [
        { id: 'k1', title: 'Claim', summary: 'A hypothesis', content: 'A hypothesis', type: 'GROWTH_INSIGHT' as never, classification: 'HYPOTHESIS', confidence: 0.4, importance: 'MEDIUM', status: 'ACTIVE', score: 1, matchedVia: [] },
      ],
      relevantMemory: { userGoals: [], orgGoals: [], preferences: [], activeProjects: [], pastRecommendations: [], completedTasks: [] },
      recentResearch: [],
      historicalLearning: [],
      usedSources: [],
    };
    const text = summarizeAgentContext(ctx);
    expect(text).toContain('[HYPOTHESIS, confidence 0.40]');
  });

  it('truncates to the given character budget rather than dumping the whole knowledge base', () => {
    const ctx = {
      organizationId: 'org_1',
      userId: 'user_1',
      goal: 'x',
      mission: null,
      preferences: [],
      goals: [],
      currentData: {} as never,
      relevantKnowledge: Array.from({ length: 50 }, (_, i) => ({
        id: `k${i}`,
        title: `Item ${i}`,
        summary: 'x'.repeat(200),
        content: 'x'.repeat(200),
        type: 'GROWTH_INSIGHT' as never,
        classification: 'FACT' as const,
        confidence: 0.9,
        importance: 'MEDIUM',
        status: 'ACTIVE',
        score: 1,
        matchedVia: [],
      })),
      relevantMemory: { userGoals: [], orgGoals: [], preferences: [], activeProjects: [], pastRecommendations: [], completedTasks: [] },
      recentResearch: [],
      historicalLearning: [],
      usedSources: [],
    };
    const text = summarizeAgentContext(ctx, 500);
    expect(text.length).toBeLessThanOrEqual(501);
  });
});
