import { describe, expect, it, vi } from 'vitest';
import { AgentGroundingError, runYouTubeAnalyst } from './analyst.js';
import type { YouTubeAnalysis } from './analyst-schema.js';

// --- a minimal fake Prisma client -----------------------------------------

function makeChannel() {
  return {
    id: 'ch_1',
    organizationId: 'org_1',
    channelId: 'UC_abc',
    title: 'Test Channel',
    subscriberCount: 12_000n,
    hiddenSubscriberCount: false,
    viewCount: 2_000_000n,
    videoCount: 42,
  };
}

function makeVideos(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `v${i}`,
    title: `Episode ${i} — how to do the thing`,
    publishedAt: new Date(2026, 0, 1 + i * 3),
    durationSeconds: 600 + i * 10,
    viewCount: BigInt(1000 + i * 137),
    likeCount: BigInt(50 + i),
    commentCount: BigInt(5 + i),
    tags: ['tutorial', 'howto', i % 2 ? 'beginner' : 'advanced'],
  }));
}

function fakeDb(opts: { videos: number; metrics?: number }) {
  const created: {
    agentRun: unknown[];
    recommendation: unknown[];
    contentIdea: unknown[];
    auditLog: unknown[];
  } = {
    agentRun: [],
    recommendation: [],
    contentIdea: [],
    auditLog: [],
  };
  const runUpdates: unknown[] = [];
  return {
    created,
    runUpdates,
    youTubeChannel: { findFirst: vi.fn(async () => makeChannel()) },
    youTubeVideo: { findMany: vi.fn(async () => makeVideos(opts.videos)) },
    youTubeMetric: { findMany: vi.fn(async () => []) },
    agentRun: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        const row = { id: `run_${created.agentRun.length}`, ...(data as object) };
        created.agentRun.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        runUpdates.push(data);
        return {};
      }),
    },
    recommendation: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        const row = { id: `rec_${created.recommendation.length}`, ...(data as object) };
        created.recommendation.push(row);
        return row;
      }),
    },
    contentIdea: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        const row = { id: `idea_${created.contentIdea.length}`, ...(data as object) };
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
  promptTokens: 1200,
  completionTokens: 800,
  totalTokens: 2000,
  estimatedCostUsd: 0.02,
};

function groundedAnalysis(): YouTubeAnalysis {
  return {
    channelTitle: 'Test Channel',
    dataCoverage: 'Analyzed 12 videos; no time-series analytics were available.',
    findings: [
      {
        id: 'f1',
        kind: 'observation',
        title: 'Tutorial videos dominate the catalogue',
        detail:
          'Most analyzed videos are tagged as tutorials, and the median performance is steady across them.',
        evidenceFactIds: ['videos.analyzed', 'videos.medianViews'],
        confidence: 0.7,
      },
    ],
    recommendations: [
      {
        id: 'r1',
        category: 'titles',
        title: 'Lead titles with the concrete outcome',
        reasoning: 'Titles currently bury the outcome; the catalogue skews tutorial.',
        suggestedAction: 'Rewrite the next five titles to start with the result the viewer gets.',
        expectedImpact: 'Likely to lift click-through on browse and search surfaces.',
        confidence: 0.55,
        effort: 'small',
        priority: 'medium',
        evidenceFactIds: ['videos.analyzed'],
      },
    ],
    titleSuggestions: [],
    descriptionSuggestions: [],
    topicSuggestions: [
      {
        topic: 'Advanced follow-ups to the most-viewed tutorials',
        rationale: 'There is an established tutorial cluster to build on.',
        evidenceFactIds: ['videos.analyzed'],
      },
    ],
    publishingRecommendations: [],
    contentIdeas: [
      {
        title: 'A "common mistakes" companion to the top tutorial',
        format: 'long-form',
        rationale: 'Pairs with the existing tutorial cluster.',
        keywords: ['mistakes', 'tutorial'],
        evidenceFactIds: ['videos.analyzed'],
      },
    ],
    disclaimers: ['Recommendations are directional, not guarantees.'],
  };
}

function hallucinatedAnalysis(): YouTubeAnalysis {
  const a = groundedAnalysis();
  a.recommendations[0]!.reasoning =
    'Your average view duration is 7.3 minutes and this change guarantees a 40% CTR increase.';
  a.recommendations[0]!.evidenceFactIds = ['videos.made_up_stat'];
  return a;
}

describe('runYouTubeAnalyst — hallucination safeguards', () => {
  it('returns a deterministic minimal report without calling the model when data is thin', async () => {
    const db = fakeDb({ videos: 2 });
    const model = { generateObject: vi.fn() };
    const res = await runYouTubeAnalyst(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        channelId: 'ch_1',
      },
    );
    expect(model.generateObject).not.toHaveBeenCalled();
    expect(res.usedModel).toBe(false);
    expect(res.analysis.findings).toHaveLength(0);
    expect(res.analysis.disclaimers.join(' ')).toMatch(
      /not enough|Recommendations are never guarantees/i,
    );
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('persists recommendations and ideas when the output is grounded', async () => {
    const db = fakeDb({ videos: 12 });
    const model = {
      generateObject: vi.fn(async () => ({ object: groundedAnalysis(), usage: USAGE })),
    };
    const res = await runYouTubeAnalyst(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        channelId: 'ch_1',
      },
    );
    expect(res.grounded).toBe(true);
    expect(res.recommendationIds).toHaveLength(1);
    expect(res.contentIdeaIds).toHaveLength(1);
    expect(db.created.recommendation[0]).toMatchObject({ domain: 'YOUTUBE' });
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('rejects hallucinated output after a repair attempt and fails the run', async () => {
    const db = fakeDb({ videos: 12 });
    const model = {
      generateObject: vi.fn(async () => ({ object: hallucinatedAnalysis(), usage: USAGE })),
    };
    await expect(
      runYouTubeAnalyst({ db: db as never, model }, { organizationId: 'org_1', channelId: 'ch_1' }),
    ).rejects.toBeInstanceOf(AgentGroundingError);
    expect(model.generateObject).toHaveBeenCalledTimes(2); // initial + one repair
    expect(db.created.recommendation).toHaveLength(0);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"FAILED"');
  });

  it('accepts a corrected answer on the repair attempt', async () => {
    const db = fakeDb({ videos: 12 });
    const model = {
      generateObject: vi
        .fn()
        .mockResolvedValueOnce({ object: hallucinatedAnalysis(), usage: USAGE })
        .mockResolvedValueOnce({ object: groundedAnalysis(), usage: USAGE }),
    };
    const res = await runYouTubeAnalyst(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        channelId: 'ch_1',
      },
    );
    expect(model.generateObject).toHaveBeenCalledTimes(2);
    expect(res.grounded).toBe(true);
    expect(res.recommendationIds).toHaveLength(1);
  });
});
