import { describe, expect, it, vi } from 'vitest';
import { generateAssets } from './generate.js';
import type { ContentAnalysis } from './schemas.js';

const ANALYSIS: ContentAnalysis = {
  summary: 'A creator shares lessons from a year of consistent uploads.',
  contentType: 'essay',
  tone: 'reflective',
  topics: ['consistency', 'thumbnails'],
  keyIdeas: [
    { id: 'k1', idea: 'A predictable schedule builds trust' },
    { id: 'k2', idea: 'Packaging does the work before the watch' },
    { id: 'k3', idea: 'Batching removes friction' },
  ],
  audienceTakeaways: ['Show up on a schedule'],
  contentAngles: [
    { id: 'a1', angle: 'Short-form version', rationale: 'Reach', keyIdeaIds: ['k1'] },
    { id: 'a2', angle: 'Written checklist', rationale: 'Search', keyIdeaIds: ['k1', 'k2', 'k3'] },
    { id: 'a3', angle: 'Beginner framing', rationale: 'Broaden', keyIdeaIds: ['k2'] },
  ],
  keywords: ['channel growth'],
  disclaimers: [],
};

function fakeDb(analysis: ContentAnalysis | null = ANALYSIS) {
  const project = {
    id: 'p1',
    organizationId: 'org_1',
    sourceTitle: 'A year of uploads',
    analysis,
    deletedAt: null,
    status: 'ANALYZED',
  };
  const assets: any[] = [];
  const versions: any[] = [];
  const audit: any[] = [];
  return {
    project,
    assets,
    versions,
    audit,
    repurposeProject: {
      findFirst: vi.fn(async () => project),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(project, data);
        return project;
      }),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => ({ id: 'run_1', ...data })),
      update: vi.fn(async () => ({})),
    },
    contentAsset: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `asset_${assets.length}`, currentVersionId: null, ...data };
        assets.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = assets.find((a) => a.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    contentAssetVersion: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `v_${versions.length}`, ...data };
        versions.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
  };
}

const USAGE = {
  provider: 'anthropic' as const,
  model: 'c',
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  estimatedCostUsd: 0,
};

describe('generateAssets', () => {
  it('creates one DRAFT asset + v1 version per requested single-type', async () => {
    const db = fakeDb();
    const res = await generateAssets(
      { db: db as never },
      {
        organizationId: 'org_1',
        userId: 'u1',
        projectId: 'p1',
        types: ['YT_TITLE_ALTERNATIVES', 'YT_DESCRIPTION', 'FAQ'],
      },
    );
    expect(res.usedModel).toBe(false);
    expect(res.assetIds).toHaveLength(3);
    expect(db.assets.every((a) => a.status === 'DRAFT')).toBe(true);
    expect(db.assets.every((a) => a.currentVersionId)).toBe(true);
    expect(db.versions.every((v) => v.versionNumber === 1 && v.editedById === null)).toBe(true);
    expect(db.audit.some((a) => a.action === 'content.assets.generated')).toBe(true);
  });

  it('produces up to MULTI_COUNT items for a multi type', async () => {
    const db = fakeDb();
    await generateAssets(
      { db: db as never },
      {
        organizationId: 'org_1',
        userId: 'u1',
        projectId: 'p1',
        types: ['SHORTS_IDEA'],
      },
    );
    expect(db.assets.length).toBeGreaterThanOrEqual(2);
    expect(db.assets.length).toBeLessThanOrEqual(3);
    expect(db.assets.every((a) => a.type === 'SHORTS_IDEA')).toBe(true);
  });

  it('uses the model when present and links createdByAgentRunId', async () => {
    const db = fakeDb();
    const model = {
      generateObject: vi.fn(async () => ({
        object: { body: 'A grounded description built on k1.', keyIdeaIds: ['k1'] },
        usage: USAGE,
      })),
    };
    const res = await generateAssets(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        userId: 'u1',
        projectId: 'p1',
        types: ['YT_DESCRIPTION'],
      },
    );
    expect(res.usedModel).toBe(true);
    expect(db.assets[0].createdByAgentRunId).toBe('run_1');
    expect(db.versions[0].body).toMatch(/grounded description/);
  });

  it('falls back to a template when the model output guarantees an outcome', async () => {
    const db = fakeDb();
    const model = {
      generateObject: vi.fn(async () => ({
        object: { body: 'This guarantees you will go viral.', keyIdeaIds: ['k1'] },
        usage: USAGE,
      })),
    };
    await generateAssets(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        userId: 'u1',
        projectId: 'p1',
        types: ['YT_DESCRIPTION'],
      },
    );
    expect(db.versions[0].body).not.toMatch(/guarantee/i);
  });

  it('auto-analyzes a project that has no analysis yet', async () => {
    const db = fakeDb(null);
    // give the project enough source text so deterministic analysis works
    (db.project as any).sourceBody =
      'A long enough body of source content with several sentences. Consistency matters. Packaging matters. Batching matters.';
    const res = await generateAssets(
      { db: db as never },
      {
        organizationId: 'org_1',
        userId: 'u1',
        projectId: 'p1',
        types: ['HOOK'],
      },
    );
    expect(res.assetIds.length).toBeGreaterThan(0);
    expect(db.project.analysis).toBeTruthy();
  });
});
