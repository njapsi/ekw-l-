import { describe, expect, it, vi } from 'vitest';
import { AgentGroundingError, runTikTokAnalyst } from './analyst.js';
import type { TikTokAnalysis } from './analyst-schema.js';

function account() {
  return {
    id: 'acc_1',
    organizationId: 'org_1',
    openId: 'open_1',
    displayName: 'Cara',
    username: 'cara',
    followerCount: 15_000n,
    likesCount: 500_000n,
    videoCountStat: 40,
    connection: { scopes: ['user.info.stats', 'video.list'] },
  };
}

function videos(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `v${i}`,
    caption: `tip ${i} #howto #beginner`,
    createTime: new Date(2026, 0, 1 + i * 2),
    durationSec: 30 + i,
    viewCount: BigInt(2000 + i * 210),
    likeCount: BigInt(120 + i),
    commentCount: BigInt(8 + i),
    shareCount: BigInt(3 + i),
    hashtags: ['howto', i % 2 ? 'beginner' : 'advanced'],
  }));
}

function fakeDb(videoCount: number) {
  const created: { agentRun: unknown[]; recommendation: unknown[]; contentIdea: unknown[] } = {
    agentRun: [],
    recommendation: [],
    contentIdea: [],
  };
  const runUpdates: unknown[] = [];
  return {
    created,
    runUpdates,
    tikTokAccount: { findFirst: vi.fn(async () => account()) },
    tikTokVideo: { findMany: vi.fn(async () => videos(videoCount)) },
    agentRun: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: `run_${created.agentRun.length}`, ...data };
        created.agentRun.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        runUpdates.push(data);
        return {};
      }),
    },
    recommendation: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: `rec_${created.recommendation.length}`, ...data };
        created.recommendation.push(row);
        return row;
      }),
    },
    contentIdea: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: `idea_${created.contentIdea.length}`, ...data };
        created.contentIdea.push(row);
        return row;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

const USAGE = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
  promptTokens: 500,
  completionTokens: 400,
  totalTokens: 900,
  estimatedCostUsd: 0.01,
};

function grounded(): TikTokAnalysis {
  return {
    accountName: 'Cara',
    dataCoverage: 'Analyzed synced videos; no time-series analytics (TikTok API limitation).',
    observations: [
      {
        id: 'o1',
        kind: 'observation',
        title: 'How-to content dominates',
        detail: 'Most analyzed videos use the #howto tag.',
        evidenceFactIds: ['videos.analyzed'],
        confidence: 0.7,
      },
    ],
    recommendations: [
      {
        id: 'r1',
        category: 'hashtags',
        title: 'Tighten the hashtag set',
        reasoning: 'The catalogue is consistently how-to.',
        suggestedAction: 'Standardize on three core hashtags plus one topical tag.',
        expectedImpact: 'Likely to improve topical clustering.',
        confidence: 0.5,
        effort: 'small',
        priority: 'medium',
        evidenceFactIds: ['videos.analyzed'],
      },
    ],
    contentIdeas: [
      {
        title: 'A "beginner mistakes" short',
        format: 'short',
        rationale: 'Pairs with the how-to cluster.',
        keywords: ['mistakes'],
        evidenceFactIds: ['videos.analyzed'],
      },
    ],
    captionIdeas: [],
    hashtagSuggestions: [],
    contentThemes: [],
    postingRecommendations: [],
    repurposingRecommendations: [],
    disclaimers: ['Directional, not guarantees.'],
  };
}

function hallucinated(): TikTokAnalysis {
  const a = grounded();
  a.recommendations[0]!.reasoning =
    'Your average watch time is 24.7 seconds and this guarantees virality.';
  a.recommendations[0]!.evidenceFactIds = ['videos.made_up'];
  return a;
}

describe('runTikTokAnalyst — safeguards', () => {
  it('returns a minimal report without a model call for thin data', async () => {
    const db = fakeDb(2);
    const model = { generateObject: vi.fn() };
    const res = await runTikTokAnalyst(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        accountId: 'acc_1',
      },
    );
    expect(model.generateObject).not.toHaveBeenCalled();
    expect(res.usedModel).toBe(false);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('persists a grounded analysis', async () => {
    const db = fakeDb(10);
    const model = { generateObject: vi.fn(async () => ({ object: grounded(), usage: USAGE })) };
    const res = await runTikTokAnalyst(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        accountId: 'acc_1',
      },
    );
    expect(res.grounded).toBe(true);
    expect(res.recommendationIds).toHaveLength(1);
    expect(res.contentIdeaIds).toHaveLength(1);
    expect(db.created.recommendation[0]).toMatchObject({ domain: 'TIKTOK' });
  });

  it('rejects hallucinated output and fails the run', async () => {
    const db = fakeDb(10);
    const model = { generateObject: vi.fn(async () => ({ object: hallucinated(), usage: USAGE })) };
    await expect(
      runTikTokAnalyst({ db: db as never, model }, { organizationId: 'org_1', accountId: 'acc_1' }),
    ).rejects.toBeInstanceOf(AgentGroundingError);
    expect(model.generateObject).toHaveBeenCalledTimes(2);
    expect(db.created.recommendation).toHaveLength(0);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"FAILED"');
  });
});
