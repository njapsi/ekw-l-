import { describe, expect, it, vi } from 'vitest';
import { analyzeProject } from './analyze.js';
import type { ContentAnalysis } from './schemas.js';

const LONG_SOURCE =
  'Consistency beats intensity when you are building a channel. ' +
  'The first thing I learned is that a predictable schedule earns trust with the algorithm and the audience. ' +
  'The second is that your thumbnail and title do most of the work before anyone watches. ' +
  'Third, batching production removes the friction that makes people quit. ' +
  'Finally, reviewing your retention graph each week tells you exactly where viewers drop off.';

function fakeDb(source = LONG_SOURCE, hasModel = true) {
  const project = {
    id: 'p1',
    organizationId: 'org_1',
    sourceType: 'MANUAL',
    sourceTitle: 'Lessons from a year of uploads',
    sourceDescription: null,
    sourceTranscript: null,
    sourceBody: source,
    sourceTags: ['youtube', 'growth'],
    sourceDurationSec: 600,
    analysis: null,
    deletedAt: null,
  };
  const runUpdates: any[] = [];
  const audit: any[] = [];
  const projectUpdates: any[] = [];
  return {
    project,
    runUpdates,
    audit,
    projectUpdates,
    repurposeProject: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === project.id && where.organizationId === project.organizationId ? project : null,
      ),
      update: vi.fn(async ({ data }: any) => {
        projectUpdates.push(data);
        Object.assign(project, data);
        return project;
      }),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => ({ id: 'run_1', ...data })),
      update: vi.fn(async ({ data }: any) => {
        runUpdates.push(data);
        return {};
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
    _hasModel: hasModel,
  };
}

const USAGE = {
  provider: 'anthropic' as const,
  model: 'claude',
  promptTokens: 100,
  completionTokens: 100,
  totalTokens: 200,
  estimatedCostUsd: 0.001,
};

function goodAnalysis(): ContentAnalysis {
  return {
    summary: 'A creator shares lessons from a year of consistent uploads.',
    contentType: 'essay',
    tone: 'reflective',
    topics: ['consistency', 'thumbnails', 'retention'],
    keyIdeas: [
      {
        id: 'k1',
        idea: 'A predictable schedule builds trust',
        sourceQuote: 'a predictable schedule earns trust',
      },
      { id: 'k2', idea: 'Thumbnail and title do the work before the watch' },
      { id: 'k3', idea: 'Batching removes friction' },
    ],
    audienceTakeaways: ['Show up on a schedule', 'Invest in packaging'],
    contentAngles: [
      {
        id: 'a1',
        angle: 'A short-form version of the top lesson',
        rationale: 'Reaches non-subscribers',
        keyIdeaIds: ['k1'],
      },
      {
        id: 'a2',
        angle: 'A written checklist',
        rationale: 'Search-friendly reference',
        keyIdeaIds: ['k1', 'k2', 'k3'],
      },
    ],
    keywords: ['channel growth', 'consistency'],
    disclaimers: [],
  };
}

describe('analyzeProject', () => {
  it('persists a grounded analysis + AgentRun and sets status ANALYZED', async () => {
    const db = fakeDb();
    const model = { generateObject: vi.fn(async () => ({ object: goodAnalysis(), usage: USAGE })) };
    const res = await analyzeProject(
      { db: db as never, model },
      { organizationId: 'org_1', projectId: 'p1' },
    );

    expect(res.usedModel).toBe(true);
    expect(res.grounded).toBe(true);
    expect(res.analysis.keyIdeas.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(db.projectUpdates)).toContain('"status":"ANALYZED"');
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
    expect(db.audit.some((a) => a.action === 'content.project.analyzed')).toBe(true);
  });

  it('drops a quote that is not verbatim in the source', async () => {
    const db = fakeDb();
    const a = goodAnalysis();
    a.keyIdeas[0]!.sourceQuote = 'this exact phrase is nowhere in the source at all';
    const model = { generateObject: vi.fn(async () => ({ object: a, usage: USAGE })) };
    const res = await analyzeProject(
      { db: db as never, model },
      { organizationId: 'org_1', projectId: 'p1' },
    );
    expect(res.analysis.keyIdeas[0]!.sourceQuote).toBeUndefined();
  });

  it('falls back to a deterministic analysis when the output guarantees an outcome', async () => {
    const db = fakeDb();
    const a = goodAnalysis();
    a.summary = 'This approach guarantees you will go viral within a month.';
    const model = { generateObject: vi.fn(async () => ({ object: a, usage: USAGE })) };
    const res = await analyzeProject(
      { db: db as never, model },
      { organizationId: 'org_1', projectId: 'p1' },
    );
    expect(res.grounded).toBe(false);
    expect(res.analysis.summary).not.toMatch(/guarantee/i);
  });

  it('produces a deterministic analysis with no model and no AgentRun', async () => {
    const db = fakeDb();
    const res = await analyzeProject(
      { db: db as never },
      { organizationId: 'org_1', projectId: 'p1' },
    );
    expect(res.usedModel).toBe(false);
    expect(res.agentRunId).toBeNull();
    expect(res.analysis.keyIdeas.length).toBeGreaterThan(0);
    expect(res.analysis.contentAngles.length).toBe(3);
  });
});
