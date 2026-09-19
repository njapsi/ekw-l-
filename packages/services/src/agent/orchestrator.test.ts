import { describe, expect, it, vi } from 'vitest';
import type { Capability, CapabilityResult } from './capabilities.js';
import { streamGrowthAgentTurn, type TurnEvent } from './orchestrator.js';
import { GrowthAgentResponse } from './schemas.js';

// --- fake db: empty reads, recorded writes -------------------------

function fakeDb(opts: { existingConvoOrg?: string } = {}) {
  const store = {
    conversations: [] as any[],
    messages: [] as any[],
    agentRuns: [] as any[],
    runUpdates: [] as any[],
    memory: [] as any[],
    audit: [] as any[],
  };
  const emptyFindFirst = vi.fn(async () => null);
  const zeroCount = vi.fn(async () => 0);
  const emptyFindMany = vi.fn(async () => []);
  return {
    store,
    // loadOrgContext
    youTubeChannel: { findFirst: emptyFindFirst },
    oAuthConnection: { findFirst: emptyFindFirst },
    tikTokAccount: { findFirst: emptyFindFirst },
    website: { findMany: emptyFindMany },
    crawl: { findFirst: emptyFindFirst },
    youTubeMetric: { count: zeroCount },
    task: { count: zeroCount, findMany: emptyFindMany },
    recommendation: { count: zeroCount, findMany: emptyFindMany },
    // No stored AI governance policy ⇒ defaults (ADR-0052).
    aiGovernancePolicy: { findUnique: emptyFindFirst },
    // conversations
    aIConversation: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (!opts.existingConvoOrg) return null;
        // simulate a conversation that belongs to a different org/user
        return where.organizationId === opts.existingConvoOrg && where.userId === 'owner'
          ? {
              id: where.id,
              organizationId: opts.existingConvoOrg,
              userId: 'owner',
              title: 'X',
              messages: [],
            }
          : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const c = { id: `conv_${store.conversations.length}`, messages: [], ...data };
        store.conversations.push(c);
        return c;
      }),
      update: vi.fn(async ({ data }: any) => {
        if (store.conversations[0]) Object.assign(store.conversations[0], data);
        return {};
      }),
    },
    aIMessage: {
      create: vi.fn(async ({ data }: any) => {
        const m = { id: `msg_${store.messages.length}`, ...data };
        store.messages.push(m);
        return m;
      }),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => {
        const r = { id: `run_${store.agentRuns.length}`, ...data };
        store.agentRuns.push(r);
        return r;
      }),
      update: vi.fn(async ({ data }: any) => {
        store.runUpdates.push(data);
        return {};
      }),
    },
    orgMemory: {
      findMany: emptyFindMany,
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        store.memory.push(data);
        return { id: `m${store.memory.length}`, ...data };
      }),
      update: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        store.audit.push(data);
        return {};
      }),
    },
  };
}

// --- fake capabilities -------------------------------------------

function cap(id: string, result: Partial<CapabilityResult>): Capability {
  return {
    id: id as never,
    title: id,
    description: id,
    keywords: [],
    run: async () => ({
      capabilityId: id as never,
      status: 'ok',
      summary: `${id} summary`,
      evidence: [],
      recommendations: [],
      ...result,
    }),
  };
}

const CAPS = new Map<string, Capability>([
  [
    'org-context',
    cap('org-context', { evidence: [{ statement: 'YouTube is not connected.', kind: 'fact' }] }),
  ],
  [
    'seo-agent',
    cap('seo-agent', {
      summary: 'The site scores 64/100 with metadata and indexability issues.',
      evidence: [
        {
          statement: 'Crawl of x.com: 30 pages, 10 issues, overall score 64/100.',
          kind: 'calculated_metric',
        },
        { statement: 'Machine readability: 71/100.', kind: 'calculated_metric' },
      ],
      recommendations: [
        {
          title: 'Add unique titles',
          problem: 'Some pages have no title.',
          whyItMatters: 'Titles label pages for search and AI.',
          howToFix: 'Write a descriptive title per page.',
          expectedBenefit: 'Clearer labelling. Not a ranking guarantee.',
          priority: 'high',
          difficulty: 'small',
          confidence: 0.9,
          domain: 'SEO',
          affectedUrls: ['https://x.com/a'],
          affectedRefs: ['w1'],
        },
      ],
    }),
  ],
  [
    'tiktok-analyst',
    cap('tiktok-analyst', {
      status: 'needs_prerequisite',
      summary: 'TikTok not connected',
      note: 'Connect a TikTok account.',
    }),
  ],
]);

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('streamGrowthAgentTurn', () => {
  it('plans, runs capabilities, synthesizes deterministically and persists (no model)', async () => {
    const db = fakeDb();
    const events = await collect(
      streamGrowthAgentTurn(
        { db: db as never, capabilities: CAPS },
        {
          organizationId: 'org_1',
          userId: 'u1',
          message: 'What are the biggest SEO problems, and how is my TikTok doing?',
        },
      ),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types).toContain('token');
    expect(types.at(-1)).toBe('done');

    const done = events.find((e): e is Extract<TurnEvent, { type: 'done' }> => e.type === 'done')!;
    // structured blocks, and NO chain-of-thought
    const blockKeys = Object.keys(done.blocks);
    expect(blockKeys).toEqual(
      expect.arrayContaining([
        'analysisSummary',
        'evidence',
        'decisions',
        'recommendations',
        'proposedActions',
        'disclaimers',
      ]),
    );
    expect(blockKeys.some((k) => /think|reason|chain.?of.?thought|scratch/i.test(k))).toBe(false);
    expect(() => GrowthAgentResponse.parse(done.blocks)).not.toThrow();
    expect(done.blocks.recommendations[0]?.title).toBe('Add unique titles');
    // create_task actions proposed for recommendations
    expect(done.blocks.proposedActions.some((a) => a.kind === 'create_task')).toBe(true);
    // the blocked capability appears as a decision line
    expect(done.blocks.decisions.join(' ')).toMatch(/Connect a TikTok account/);
    // disclaimers never promise rankings
    expect(done.blocks.disclaimers.join(' ')).toMatch(/does not predict or guarantee/i);

    // persistence
    expect(db.store.conversations).toHaveLength(1);
    expect(db.store.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    expect(db.store.messages[1].blocks).toBeTruthy();
    expect(JSON.stringify(db.store.runUpdates)).toContain('"status":"COMPLETED"');
    expect(db.store.audit.some((a) => a.action === 'agent.turn.completed')).toBe(true);
  });

  it('merges a grounded model synthesis', async () => {
    const db = fakeDb();
    const grounded = {
      analysisSummary: 'Your site has fixable metadata and indexability issues.',
      analysisSummaryEvidenceRefs: ['e2'],
      evidence: [],
      decisions: ['Used seo-agent because the question is about SEO.'],
      recommendations: [
        {
          title: 'Add unique titles',
          problem: 'Some pages lack a title.',
          whyItMatters: 'Titles are the primary label.',
          howToFix: 'Write one per page.',
          expectedBenefit: 'Clearer labelling.',
          priority: 'high',
          difficulty: 'small',
          confidence: 0.9,
          domain: 'SEO',
          affectedUrls: [],
          affectedRefs: [],
          evidenceRefs: ['e2'],
        },
      ],
      proposedActions: [],
      disclaimers: ['This is diagnostic and not a prediction of rankings.'],
    };
    const model = {
      generateObject: vi.fn(async () => ({
        object: grounded,
        usage: {
          provider: 'anthropic' as const,
          model: 'x',
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
          estimatedCostUsd: 0.001,
        },
      })),
    };
    const events = await collect(
      streamGrowthAgentTurn(
        { db: db as never, capabilities: CAPS, model },
        { organizationId: 'org_1', userId: 'u1', message: 'seo problems?' },
      ),
    );
    const done = events.find((e): e is Extract<TurnEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.blocks.analysisSummary).toMatch(/fixable metadata/);
    expect(JSON.stringify(db.store.runUpdates)).toContain('"grounded":true');
  });

  it('drops an ungrounded model synthesis and falls back to deterministic assembly', async () => {
    const db = fakeDb();
    const bad = {
      analysisSummary: 'Fixing titles will grow organic traffic 300% next month.',
      analysisSummaryEvidenceRefs: ['made_up'],
      evidence: [],
      decisions: [],
      recommendations: [],
      proposedActions: [],
      disclaimers: [],
    };
    const model = {
      generateObject: vi.fn(async () => ({
        object: bad,
        usage: {
          provider: 'anthropic' as const,
          model: 'x',
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
          estimatedCostUsd: 0,
        },
      })),
    };
    const events = await collect(
      streamGrowthAgentTurn(
        { db: db as never, capabilities: CAPS, model },
        { organizationId: 'org_1', userId: 'u1', message: 'seo problems?' },
      ),
    );
    const done = events.find((e): e is Extract<TurnEvent, { type: 'done' }> => e.type === 'done')!;
    // synthesis makes an initial call + one repair attempt (planner/memory also use the model)
    expect(model.generateObject.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(done.blocks.analysisSummary).not.toMatch(/300%/);
    expect(done.blocks.recommendations[0]?.title).toBe('Add unique titles'); // deterministic
    expect(JSON.stringify(db.store.runUpdates)).toContain('"grounded":false');
  });

  it('refuses a conversation that belongs to another org', async () => {
    const db = fakeDb({ existingConvoOrg: 'org_other' });
    const events = await collect(
      streamGrowthAgentTurn(
        { db: db as never, capabilities: CAPS },
        { organizationId: 'org_1', userId: 'u1', conversationId: 'conv_x', message: 'hi' },
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Conversation not found.' });
    expect(db.store.messages).toHaveLength(0);
  });

  it('rejects an empty message', async () => {
    const db = fakeDb();
    const events = await collect(
      streamGrowthAgentTurn(
        { db: db as never, capabilities: CAPS },
        { organizationId: 'org_1', userId: 'u1', message: '   ' },
      ),
    );
    expect(events).toEqual([{ type: 'error', message: 'Empty message.' }]);
  });
});
