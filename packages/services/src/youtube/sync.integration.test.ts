import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEncryptionKey, seal } from '../crypto/tokens.js';
import { runYouTubeAnalyst } from './analyst.js';
import { FixturesYouTubeClient, type FixtureConfig } from './fixtures-client.js';
import { getChannelOverview, getPrimaryChannel, listVideosPage } from './read.js';
import { discoverChannels, syncAnalytics, syncVideos, type SyncContext } from './sync.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
// Probe at module load (top-level await), BEFORE tests are defined: the
// `maybe()` helper below is evaluated at collection time, so a probe inside
// `beforeAll` came too late and every test here was silently skipped — even
// in CI with a real database (Phase 2 finding).
let reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    )
  : false;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? generateEncryptionKey();
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

async function seedOrgWithConnection(tag: string) {
  const db = prisma!;
  const org = await db.organization.create({ data: { name: tag, slug: tag } });
  const t = seal('access', process.env.ENCRYPTION_KEY);
  const connection = await db.oAuthConnection.create({
    data: {
      organizationId: org.id,
      provider: 'YOUTUBE',
      externalAccountId: `${tag}-UC`,
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      accessTokenCipher: t.cipher,
      tokenIv: t.iv,
      tokenAuthTag: t.authTag,
      keyId: t.keyId,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { org, connection };
}

function ctxFor(
  org: { id: string },
  connection: { id: string; scopes: string[]; status: string },
): SyncContext {
  return {
    db: prisma!,
    organizationId: org.id,
    connection: {
      id: connection.id,
      scopes: connection.scopes,
      status: connection.status as never,
    },
  };
}

function fixtures(over: Partial<FixtureConfig> = {}): FixtureConfig {
  return {
    channels: [
      {
        channelId: 'UC_A',
        title: 'Channel A',
        uploadsPlaylistId: 'UU_A',
        subscriberCount: '5000',
        viewCount: '900000',
        videoCount: '3',
      },
    ],
    videos: [
      {
        videoId: 'a1',
        title: 'First how-to',
        publishedAt: '2026-01-01T00:00:00Z',
        tags: ['howto'],
        viewCount: '1000',
        likeCount: '50',
        commentCount: '5',
        durationIso: 'PT8M',
      },
      {
        videoId: 'a2',
        title: 'Second how-to',
        publishedAt: '2026-01-10T00:00:00Z',
        tags: ['howto'],
        viewCount: '4000',
        likeCount: '200',
        commentCount: '30',
        durationIso: 'PT10M',
      },
    ],
    ...over,
  };
}

describe('YouTube sync + isolation (integration)', () => {
  it('is skipped without a reachable database', () => {
    if (!reachable)
      console.warn('[integration] no DATABASE_URL — skipping YouTube integration tests');
    expect(true).toBe(true);
  });

  maybe()('discovers a channel, then incrementally syncs only new videos', async () => {
    const db = prisma!;
    const { org, connection } = await seedOrgWithConnection(`yt_inc_${Date.now()}`);
    try {
      const cfg = fixtures();
      let client = new FixturesYouTubeClient(cfg);
      const ctx = ctxFor(org, connection);

      const [channel] = await discoverChannels(client, ctx);
      expect(channel).toBeTruthy();

      const first = await syncVideos(client, ctx, channel!);
      expect(first.itemsProcessed).toBe(2);
      expect(await db.youTubeVideo.count({ where: { organizationId: org.id } })).toBe(2);

      // A newer video appears; re-sync must add exactly one row and no dupes.
      const refreshed = await db.youTubeChannel.findUniqueOrThrow({ where: { id: channel!.id } });
      cfg.videos.push({
        videoId: 'a3',
        title: 'Third how-to',
        publishedAt: '2026-02-01T00:00:00Z',
        tags: ['howto'],
        viewCount: '20',
        durationIso: 'PT5M',
      });
      client = new FixturesYouTubeClient(cfg);
      const second = await syncVideos(client, ctxFor(org, connection), refreshed);
      // 1 new + up to refreshRecent existing re-fetched, but total rows stay 3.
      expect(await db.youTubeVideo.count({ where: { organizationId: org.id } })).toBe(3);
      expect(second.itemsProcessed).toBeGreaterThanOrEqual(1);

      // Quota was accounted for.
      const health = await db.integrationHealth.findUnique({
        where: { oauthConnectionId: connection.id },
      });
      expect(health?.quotaUnitsUsedToday ?? 0).toBeGreaterThan(0);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('records missing analytics as skipped without writing rows', async () => {
    const db = prisma!;
    const { org, connection } = await seedOrgWithConnection(`yt_empty_${Date.now()}`);
    try {
      const client = new FixturesYouTubeClient(fixtures({ faults: new Set(['empty-analytics']) }));
      const ctx = ctxFor(org, connection);
      const [channel] = await discoverChannels(client, ctx);
      const res = await syncAnalytics(client, ctx, channel!);
      expect(res.skipped).toBeTruthy();
      expect(await db.youTubeMetric.count({ where: { organizationId: org.id } })).toBe(0);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('refuses to sync a disconnected connection', async () => {
    const db = prisma!;
    const { org, connection } = await seedOrgWithConnection(`yt_rev_${Date.now()}`);
    try {
      await db.oAuthConnection.update({
        where: { id: connection.id },
        data: { status: 'REVOKED' },
      });
      const client = new FixturesYouTubeClient(fixtures());
      await expect(
        discoverChannels(client, ctxFor(org, { ...connection, status: 'REVOKED' })),
      ).rejects.toThrow(/disconnected/i);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('marks a run FAILED on malformed API data', async () => {
    const db = prisma!;
    const { org, connection } = await seedOrgWithConnection(`yt_mal_${Date.now()}`);
    try {
      const good = new FixturesYouTubeClient(fixtures());
      const ctx = ctxFor(org, connection);
      const [channel] = await discoverChannels(good, ctx);
      const bad = new FixturesYouTubeClient(fixtures({ faults: new Set(['malformed-videos']) }));
      await expect(syncVideos(bad, ctx, channel!)).rejects.toThrow();
      const run = await db.youTubeSyncRun.findFirst({
        where: { youTubeChannelId: channel!.id, kind: 'VIDEOS' },
        orderBy: { startedAt: 'desc' },
      });
      expect(run?.status).toBe('FAILED');
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('isolates tenants — org A never sees org B data', async () => {
    const db = prisma!;
    const a = await seedOrgWithConnection(`yt_iso_a_${Date.now()}`);
    const b = await seedOrgWithConnection(`yt_iso_b_${Date.now()}`);
    try {
      const client = new FixturesYouTubeClient(fixtures());
      const [chA] = await discoverChannels(client, ctxFor(a.org, a.connection));
      await syncVideos(client, ctxFor(a.org, a.connection), chA!);

      // B has no YouTube data.
      expect(await getPrimaryChannel(b.org.id, db)).toBeNull();
      expect(await getChannelOverview(b.org.id, db)).toBeNull();
      const bVideos = await listVideosPage(b.org.id, {}, db);
      expect(bVideos.videos).toHaveLength(0);

      // A sees only its own.
      const aOverview = await getChannelOverview(a.org.id, db);
      expect(aOverview?.channel.channelId).toBe('UC_A');

      // The analyst refuses B's request for A's channel id.
      await expect(
        runYouTubeAnalyst(
          { db, model: { generateObject: async () => ({ object: {}, usage: {} }) } as never },
          { organizationId: b.org.id, channelId: chA!.id },
        ),
      ).rejects.toThrow(/not found/i);
    } finally {
      await db.organization.deleteMany({ where: { id: { in: [a.org.id, b.org.id] } } });
    }
  });

  maybe()('persists a grounded analyst run scoped to the org', async () => {
    const db = prisma!;
    const { org, connection } = await seedOrgWithConnection(`yt_an_${Date.now()}`);
    try {
      const cfg = fixtures({
        videos: Array.from({ length: 8 }, (_, i) => ({
          videoId: `g${i}`,
          title: `Guide ${i}`,
          publishedAt: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
          tags: ['guide', 'howto'],
          viewCount: String(500 + i * 90),
          likeCount: String(20 + i),
          commentCount: String(2 + i),
          durationIso: 'PT7M',
        })),
      });
      const client = new FixturesYouTubeClient(cfg);
      const ctx = ctxFor(org, connection);
      const [channel] = await discoverChannels(client, ctx);
      await syncVideos(client, ctx, channel!);

      const model = {
        generateObject: async () => ({
          object: {
            channelTitle: 'Channel A',
            dataCoverage: 'Analyzed the synced guide videos; no analytics.',
            findings: [],
            recommendations: [
              {
                id: 'r1',
                category: 'topics',
                title: 'Extend the guide series',
                reasoning: 'The catalogue is consistently guide-oriented.',
                suggestedAction: 'Plan three more entries in the same series.',
                expectedImpact: 'Likely to compound watch time across the series.',
                confidence: 0.5,
                effort: 'medium',
                priority: 'medium',
                evidenceFactIds: ['videos.analyzed'],
              },
            ],
            titleSuggestions: [],
            descriptionSuggestions: [],
            topicSuggestions: [],
            publishingRecommendations: [],
            contentIdeas: [],
            disclaimers: ['Directional, not a guarantee.'],
          },
          usage: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            promptTokens: 100,
            completionTokens: 100,
            totalTokens: 200,
            estimatedCostUsd: 0.001,
          },
        }),
      };
      const res = await runYouTubeAnalyst(
        { db, model: model as never },
        {
          organizationId: org.id,
          channelId: channel!.id,
        },
      );
      expect(res.grounded).toBe(true);
      expect(res.recommendationIds).toHaveLength(1);
      const rec = await db.recommendation.findFirst({
        where: { organizationId: org.id, domain: 'YOUTUBE' },
      });
      expect(rec?.organizationId).toBe(org.id);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });
});
