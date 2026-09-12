import { describe, expect, it } from 'vitest';
import { buildOpportunities, PRIORITY_MODEL_NOTE } from './engine.js';
import type { MonetizationSignals } from './signals.js';

function signals(over: Partial<MonetizationSignals> = {}): MonetizationSignals {
  return {
    youtube: {
      connected: false,
      channelTitle: null,
      subscriberCount: null,
      hiddenSubscriberCount: false,
      videoCount: null,
      viewCount: null,
      hasAnalytics: false,
      assessment: null,
      ...(over.youtube ?? {}),
    },
    tiktok: {
      connected: false,
      displayName: null,
      followerCount: null,
      hasStats: false,
      ...(over.tiktok ?? {}),
    },
    seo: { websites: 0, verifiedWebsites: 0, hasCompletedCrawl: false, ...(over.seo ?? {}) },
    business: {
      profileExists: false,
      niche: null,
      audienceDescription: null,
      offerings: [],
      goals: [],
      emailListSize: null,
      hasWebsite: false,
      sellsProducts: false,
      doesSponsorships: false,
      doesAffiliates: false,
      doesConsulting: false,
      hasMembership: false,
      hasCourse: false,
      ...(over.business ?? {}),
    },
    revenue: {
      entryCount: 0,
      channelsWithRevenue: [],
      last12moTotalByCurrency: {},
      ...(over.revenue ?? {}),
    },
    largestAudience: over.largestAudience ?? null,
  };
}

function ypAssessment(over: {
  unmet?: string[];
  unverified?: string[];
  met?: string[];
}): MonetizationSignals['youtube']['assessment'] {
  return {
    official: [],
    apiData: {},
    userProvided: {},
    estimate: {
      metThresholds: over.met ?? [],
      unmetThresholds: over.unmet ?? [],
      unverified: over.unverified ?? [],
      summary: 'x',
      disclaimer: 'x',
      confidence: 0.5,
    },
  } as never;
}

describe('monetization opportunity engine', () => {
  it('every opportunity carries the seven required fields plus a priority score', () => {
    const drafts = buildOpportunities(
      signals({
        youtube: { connected: true, subscriberCount: 25_000, videoCount: 80 } as never,
        business: { profileExists: true, niche: 'photography', goals: ['make money'] } as never,
        largestAudience: 25_000,
      }),
    );
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.title).toBeTruthy(); // Opportunity
      expect(Array.isArray(d.evidence)).toBe(true); // Evidence
      expect(['strong', 'moderate', 'weak', 'unknown']).toContain(d.audienceFit); // Audience fit
      expect(['low', 'medium', 'high']).toContain(d.difficulty); // Estimated difficulty
      expect(['Low', 'Moderate', 'High']).toContain(d.potential); // Estimated potential
      expect(d.requiredActions.length).toBeGreaterThan(0); // Required action
      expect(d.confidence).toBeGreaterThanOrEqual(0); // Confidence
      expect(d.confidence).toBeLessThanOrEqual(1);
      expect(typeof d.priorityScore).toBe('number');
    }
  });

  it('potential is a relative label, never a currency figure, and the basis says so', () => {
    const drafts = buildOpportunities(
      signals({ largestAudience: 5_000, business: { profileExists: true, niche: 'x' } as never }),
    );
    for (const d of drafts) {
      expect(d.potential).toMatch(/^(Low|Moderate|High)$/);
      expect(d.potentialBasis.toLowerCase()).toContain('estimate');
      expect(d.potentialBasis).toMatch(/not a revenue figure/i);
    }
  });

  it('PLATFORM_MONETIZATION never claims the creator qualifies', () => {
    const ready = buildOpportunities(
      signals({
        youtube: {
          connected: true,
          subscriberCount: 200_000,
          assessment: ypAssessment({ met: ['1,000 subscribers', '4,000 watch hours'] }),
        } as never,
        largestAudience: 200_000,
      }),
    );
    const pm = ready.find((d) => d.channel === 'PLATFORM_MONETIZATION');
    expect(pm).toBeDefined();
    const blob = `${pm!.description} ${pm!.evidence.map((e) => e.statement).join(' ')} ${pm!.requiredActions.join(' ')}`;
    // No affirmative qualification claim ...
    expect(blob).not.toMatch(/you (now )?qualify for|you are eligible|you meet all/i);
    // ... and it explicitly defers the decision to YouTube.
    expect(blob).toMatch(
      /YouTube (makes|will make) the (eligibility )?decision|decided by YouTube/i,
    );
    expect(blob).toMatch(/does not confirm/i);
  });

  it('PLATFORM_MONETIZATION stays "potential" when criteria are unmet or unverifiable', () => {
    const notReady = buildOpportunities(
      signals({
        youtube: {
          connected: true,
          subscriberCount: 300,
          assessment: ypAssessment({
            unmet: ['1,000 subscribers'],
            unverified: ['No active strikes'],
          }),
        } as never,
        largestAudience: 300,
      }),
    );
    const pm = notReady.find((d) => d.channel === 'PLATFORM_MONETIZATION');
    expect(pm?.readiness).toBe('potential');
    expect(pm?.requiredActions.join(' ')).toMatch(/YouTube Studio/i);
  });

  it('is deterministic — same signals give the same drafts', () => {
    const s = signals({
      youtube: { connected: true, subscriberCount: 12_345 } as never,
      largestAudience: 12_345,
      business: { profileExists: true, niche: 'cooking', doesAffiliates: true } as never,
    });
    expect(JSON.stringify(buildOpportunities(s))).toEqual(JSON.stringify(buildOpportunities(s)));
  });

  it('drafts are returned sorted by descending priority score', () => {
    const drafts = buildOpportunities(
      signals({
        youtube: { connected: true, subscriberCount: 50_000 } as never,
        largestAudience: 50_000,
        business: {
          profileExists: true,
          niche: 'finance',
          goals: ['revenue'],
          hasWebsite: true,
        } as never,
      }),
    );
    const scores = drafts.map((d) => d.priorityScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('a larger, better-fit audience does not lower an otherwise-identical opportunity score', () => {
    const small = buildOpportunities(
      signals({
        youtube: { connected: true, subscriberCount: 1_500 } as never,
        largestAudience: 1_500,
        business: { profileExists: true, niche: 'x' } as never,
      }),
    ).find((d) => d.channel === 'AFFILIATE');
    const large = buildOpportunities(
      signals({
        youtube: { connected: true, subscriberCount: 500_000 } as never,
        largestAudience: 500_000,
        business: { profileExists: true, niche: 'x' } as never,
      }),
    ).find((d) => d.channel === 'AFFILIATE');
    expect(large!.priorityScore).toBeGreaterThanOrEqual(small!.priorityScore);
  });

  it('exposes a human-readable priority model note that is not an income estimate', () => {
    expect(PRIORITY_MODEL_NOTE).toMatch(/not an income estimate/i);
  });
});
