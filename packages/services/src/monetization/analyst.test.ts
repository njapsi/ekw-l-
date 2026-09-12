import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { runMonetizationScan } from './analyst.js';
import { MonetizationAnalysis } from './schemas.js';

interface FakeOpts {
  profile?: Record<string, unknown> | null;
  youtubeConnected?: boolean;
}

function fakeDb(opts: FakeOpts = {}) {
  const profile =
    opts.profile === undefined
      ? {
          id: 'bp1',
          organizationId: 'org_1',
          niche: 'landscape photography',
          audienceDescription: 'hobbyists',
          offerings: ['presets'],
          goals: ['make revenue from my channel'],
          emailListSize: 800,
          hasWebsite: true,
          sellsProducts: false,
          doesSponsorships: false,
          doesAffiliates: false,
          doesConsulting: false,
          hasMembership: false,
          hasCourse: false,
          attestations: null,
        }
      : opts.profile;

  const opportunities = new Map<string, any>();
  const agentRuns: any[] = [];
  const audit: any[] = [];
  let runSeq = 0;
  let oppSeq = 0;

  return {
    opportunities,
    agentRuns,
    audit,
    youTubeChannel: {
      findFirst: vi.fn(async () =>
        opts.youtubeConnected
          ? {
              channelId: 'yt1',
              title: 'Chan',
              subscriberCount: 5000,
              hiddenSubscriberCount: false,
              videoCount: 40,
              viewCount: 100000,
              lastAnalyticsSyncAt: null,
            }
          : null,
      ),
    },
    youTubeMetric: { findMany: vi.fn(async () => []) },
    oAuthConnection: {
      findFirst: vi.fn(async ({ where }: any) =>
        opts.youtubeConnected && where.provider === 'YOUTUBE'
          ? { status: 'ACTIVE', provider: 'YOUTUBE' }
          : null,
      ),
    },
    tikTokAccount: { findFirst: vi.fn(async () => null) },
    website: { findMany: vi.fn(async () => (profile ? [{ verified: true }] : [])) },
    crawl: { findFirst: vi.fn(async () => null) },
    businessProfile: { findUnique: vi.fn(async () => profile) },
    revenueEntry: { findMany: vi.fn(async () => []) },
    agentRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `run${++runSeq}`, ...data };
        agentRuns.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = agentRuns.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    monetizationOpportunity: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = `${where.organizationId_channel.organizationId}:${where.organizationId_channel.channel}`;
        return opportunities.get(key) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `op${++oppSeq}`, updatedAt: new Date(), ...data };
        opportunities.set(`${row.organizationId}:${row.channel}`, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const row of opportunities.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw new Error('no such opportunity');
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

const opts = { organizationId: 'org_1', userId: 'u1', trigger: 'test' };

function groundedModel() {
  return {
    generateObject: vi.fn(async () => ({
      object: MonetizationAnalysis.parse({
        overview: 'Your profile points to product and service income first.',
        overviewEvidenceRefs: ['s4'],
        channelNotes: [
          {
            channel: 'AFFILIATE',
            description: 'Add disclosed affiliate links to the resources you already recommend.',
            requiredActions: ['Join two affiliate programs', 'Add links to your top pages'],
            evidenceRefs: ['s4'],
          },
        ],
        disclaimers: ['Every potential and difficulty here is a labelled estimate.'],
      }),
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        estimatedCostUsd: 0.001,
        model: 'test-model',
        provider: 'test',
      },
    })),
  };
}

function hallucinatingModel() {
  return {
    generateObject: vi.fn(async () => ({
      object: MonetizationAnalysis.parse({
        overview: 'You will earn $50000 within 3 months — monetization is guaranteed.',
        overviewEvidenceRefs: ['s99'],
        channelNotes: [],
        disclaimers: [],
      }),
      usage: {
        promptTokens: 5,
        completionTokens: 5,
        estimatedCostUsd: 0,
        model: 'test-model',
        provider: 'test',
      },
    })),
  };
}

describe('runMonetizationScan', () => {
  it('throws when nothing is connected and there is no business profile', async () => {
    const db = fakeDb({ profile: null });
    await expect(runMonetizationScan({ db: db as never }, opts)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
  });

  it('persists deterministic opportunities and completes the AgentRun without a model', async () => {
    const db = fakeDb();
    const res = await runMonetizationScan({ db: db as never }, opts);
    expect(res.opportunityIds.length).toBeGreaterThan(0);
    expect(res.usedModel).toBe(false);
    expect(db.agentRuns[0].status).toBe('COMPLETED');
    expect(db.agentRuns[0].agent).toBe('monetization-analyst');
    expect(db.audit.some((a) => a.action === 'monetization.scan.completed')).toBe(true);
    for (const row of db.opportunities.values()) {
      expect(row.isEstimate).toBe(true);
      expect(typeof row.potential).toBe('string');
      expect(Number.isNaN(Number(row.potential))).toBe(true); // a label, not a number
      expect(['SUGGESTED', 'ACTIVE']).toContain(row.status);
    }
  });

  it('uses grounded model prose when it passes the grounding check', async () => {
    const db = fakeDb();
    const model = groundedModel();
    const res = await runMonetizationScan({ db: db as never, model: model as never }, opts);
    expect(res.usedModel).toBe(true);
    expect(res.grounded).toBe(true);
    expect(res.overview).toMatch(/product and service income/);
    const affiliate = db.opportunities.get('org_1:AFFILIATE');
    expect(affiliate?.description).toMatch(/disclosed affiliate links/);
  });

  it('drops hallucinated / guarantee-laden model prose and falls back to deterministic', async () => {
    const db = fakeDb();
    const model = hallucinatingModel();
    const res = await runMonetizationScan({ db: db as never, model: model as never }, opts);
    expect(res.usedModel).toBe(true);
    expect(res.grounded).toBe(false);
    expect(res.overview).not.toMatch(/guaranteed/i);
    expect(res.overview).not.toMatch(/\$50000/);
    expect(model.generateObject).toHaveBeenCalledTimes(2); // one retry, then dropped
  });

  it('re-running keeps a status the user already advanced', async () => {
    const db = fakeDb();
    await runMonetizationScan({ db: db as never }, opts);
    const affiliate = db.opportunities.get('org_1:AFFILIATE');
    expect(affiliate).toBeDefined();
    affiliate.status = 'DISMISSED';
    await runMonetizationScan({ db: db as never }, opts);
    expect(db.opportunities.get('org_1:AFFILIATE')?.status).toBe('DISMISSED');
  });
});
