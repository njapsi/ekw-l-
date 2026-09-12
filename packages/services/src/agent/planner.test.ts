import { describe, expect, it, vi } from 'vitest';
import type { OrgContext } from './context.js';
import { keywordPlan, planTurn } from './planner.js';
import { TurnPlan } from './schemas.js';

function ctx(over: Partial<OrgContext> = {}): OrgContext {
  return {
    youtube: {
      connected: true,
      channelTitle: 'C',
      subscriberCount: '1000',
      videoCount: 20,
      lastSyncedAt: new Date(),
      hasAnalytics: true,
    },
    tiktok: { connected: true, displayName: 'T', hasStats: true, lastSyncedAt: new Date() },
    seo: {
      websites: 1,
      verifiedWebsites: 1,
      latestCrawl: {
        crawlId: 'c1',
        websiteId: 'w1',
        hostname: 'x.com',
        status: 'COMPLETED',
        pagesCrawled: 30,
        issuesFound: 10,
        overallScore: 70,
        finishedAt: new Date(),
      },
    },
    openTasks: 0,
    recentRecommendations: 0,
    ...over,
  };
}

describe('keywordPlan', () => {
  it('routes YouTube momentum questions to the YouTube analyst', () => {
    const p = keywordPlan('Why is my YouTube channel losing momentum?', ctx());
    expect(p.capabilities).toContain('youtube-analyst');
  });

  it('routes money questions to monetization + analyst', () => {
    const p = keywordPlan('How can I make more money from my existing audience?', ctx());
    expect(p.capabilities).toEqual(
      expect.arrayContaining(['youtube-monetization', 'youtube-analyst']),
    );
  });

  it('routes SEO questions to the SEO agent', () => {
    for (const q of [
      'What are the five biggest SEO problems?',
      'Which pages should I fix first?',
      'Analyze my website.',
    ]) {
      expect(keywordPlan(q, ctx()).capabilities).toContain('seo-agent');
    }
  });

  it('routes repurposing to content-repurpose', () => {
    expect(keywordPlan('Turn my YouTube video into TikTok content.', ctx()).capabilities).toContain(
      'content-repurpose',
    );
  });

  it('routes a 30-day plan to growth-plan plus every connected specialist', () => {
    const p = keywordPlan('Give me a 30-day growth plan.', ctx());
    expect(p.capabilities).toContain('growth-plan');
    expect(p.capabilities).toEqual(expect.arrayContaining(['youtube-analyst', 'seo-agent']));
  });

  it('flags missing prerequisites', () => {
    const p = keywordPlan(
      'Analyze my website.',
      ctx({ seo: { websites: 0, verifiedWebsites: 0, latestCrawl: null } }),
    );
    expect(p.missingPrerequisites.join(' ')).toMatch(/crawl/i);
  });

  it('falls back to whatever is connected when nothing matches', () => {
    const p = keywordPlan(
      'hello there',
      ctx({ tiktok: { connected: false, displayName: null, hasStats: false, lastSyncedAt: null } }),
    );
    expect(p.capabilities).toEqual(expect.arrayContaining(['seo-agent', 'youtube-analyst']));
    expect(p.capabilities).not.toContain('tiktok-analyst');
  });

  it('produces a valid TurnPlan', () => {
    expect(() => TurnPlan.parse(keywordPlan('anything', ctx()))).not.toThrow();
  });
});

describe('planTurn', () => {
  it('uses the keyword plan when there is no model', async () => {
    const p = await planTurn(
      {},
      { message: 'What are the biggest SEO problems?', context: ctx(), history: [] },
    );
    expect(p.capabilities).toContain('seo-agent');
  });

  it('merges the model plan and keeps the deterministic prerequisites', async () => {
    const model = {
      generateObject: vi.fn(async () => ({
        object: {
          intent: 'seo audit',
          capabilities: ['seo-agent'],
          rationale: 'Only SEO data is relevant.',
          missingPrerequisites: [],
        },
        usage: {
          provider: 'anthropic' as const,
          model: 'x',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
        },
      })),
    };
    const p = await planTurn(
      { model },
      {
        message: 'analyze my website',
        context: ctx({ seo: { websites: 1, verifiedWebsites: 0, latestCrawl: null } }),
        history: [],
      },
    );
    expect(p.capabilities).toEqual(['seo-agent']);
    expect(p.missingPrerequisites.join(' ')).toMatch(/crawl/i);
  });

  it('falls back to the keyword plan if the model throws', async () => {
    const model = {
      generateObject: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const p = await planTurn(
      { model },
      { message: 'youtube momentum', context: ctx(), history: [] },
    );
    expect(p.capabilities).toContain('youtube-analyst');
  });
});
