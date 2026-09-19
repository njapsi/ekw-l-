import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { generateEncryptionKey, seal } from '../crypto/tokens.js';
import { runTikTokAnalyst } from './analyst.js';
import { FixturesTikTokClient, type TikTokFixtureConfig } from './fixtures-client.js';
import { createPublishDraft } from './publish.js';
import { getAccountOverview, getPrimaryAccount, listVideosPage } from './read.js';
import { type TikTokSyncContext, discoverAccount, syncVideos } from './sync.js';

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

async function seed(tag: string, scopes = ['user.info.stats', 'video.list', 'video.publish']) {
  const db = prisma!;
  const org = await db.organization.create({ data: { name: tag, slug: tag } });
  const t = seal('access', process.env.ENCRYPTION_KEY);
  const connection = await db.oAuthConnection.create({
    data: {
      organizationId: org.id,
      provider: 'TIKTOK',
      externalAccountId: `${tag}-open`,
      scopes,
      accessTokenCipher: t.cipher,
      tokenIv: t.iv,
      tokenAuthTag: t.authTag,
      keyId: t.keyId,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const user = await db.user.create({ data: { email: `${tag}@example.com` } });
  return { org, connection, user };
}

function ctx(
  org: { id: string },
  connection: { id: string; scopes: string[]; status: string },
): TikTokSyncContext {
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

function fixtures(over: Partial<TikTokFixtureConfig> = {}): TikTokFixtureConfig {
  return {
    user: {
      openId: 'open_A',
      username: 'cara',
      displayName: 'Cara',
      followerCount: 9000,
      likesCount: 120000,
      videoCount: 3,
    },
    videos: [
      {
        id: 't1',
        description: 'first #howto',
        createTime: 1_760_000_000,
        viewCount: 1000,
        likeCount: 40,
        commentCount: 5,
        shareCount: 2,
      },
      {
        id: 't2',
        description: 'second #howto',
        createTime: 1_760_500_000,
        viewCount: 5000,
        likeCount: 300,
        commentCount: 20,
        shareCount: 15,
      },
    ],
    ...over,
  };
}

describe('TikTok sync + isolation (integration)', () => {
  it('is skipped without a reachable database', () => {
    if (!reachable)
      console.warn('[integration] no DATABASE_URL — skipping TikTok integration tests');
    expect(true).toBe(true);
  });

  maybe()('discovers an account and incrementally syncs only new videos', async () => {
    const db = prisma!;
    const { org, connection } = await seed(`tt_inc_${Date.now()}`);
    try {
      const cfg = fixtures();
      let client = new FixturesTikTokClient(cfg);
      const account = await discoverAccount(client, ctx(org, connection));
      expect(account.followerCount).toBe(9000n);

      const first = await syncVideos(client, ctx(org, connection), account);
      expect(first.itemsProcessed).toBe(2);
      expect(await db.tikTokVideo.count({ where: { organizationId: org.id } })).toBe(2);

      const refreshed = await db.tikTokAccount.findUniqueOrThrow({ where: { id: account.id } });
      cfg.videos.push({
        id: 't3',
        description: 'third #howto',
        createTime: 1_761_000_000,
        viewCount: 20,
      });
      client = new FixturesTikTokClient(cfg);
      const second = await syncVideos(client, ctx(org, connection), refreshed);
      expect(second.itemsProcessed).toBe(1);
      expect(await db.tikTokVideo.count({ where: { organizationId: org.id } })).toBe(3);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('skips video sync when the video.list scope was not granted', async () => {
    const db = prisma!;
    const { org, connection } = await seed(`tt_noscope_${Date.now()}`, ['user.info.basic']);
    try {
      const client = new FixturesTikTokClient(fixtures());
      const account = await discoverAccount(client, ctx(org, connection));
      const res = await syncVideos(client, ctx(org, connection), account);
      expect(res.skipped).toMatch(/video.list/);
      expect(await db.tikTokVideo.count({ where: { organizationId: org.id } })).toBe(0);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('records missing videos as skipped without writing rows', async () => {
    const db = prisma!;
    const { org, connection } = await seed(`tt_empty_${Date.now()}`);
    try {
      const client = new FixturesTikTokClient(fixtures({ faults: new Set(['empty']) }));
      const account = await discoverAccount(client, ctx(org, connection));
      const res = await syncVideos(client, ctx(org, connection), account);
      expect(res.skipped).toBeTruthy();
      expect(await db.tikTokVideo.count({ where: { organizationId: org.id } })).toBe(0);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('refuses to sync a disconnected connection', async () => {
    const db = prisma!;
    const { org, connection } = await seed(`tt_rev_${Date.now()}`);
    try {
      await db.oAuthConnection.update({
        where: { id: connection.id },
        data: { status: 'REVOKED' },
      });
      const client = new FixturesTikTokClient(fixtures());
      await expect(
        discoverAccount(client, ctx(org, { ...connection, status: 'REVOKED' })),
      ).rejects.toThrow(/disconnected/i);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('marks a run FAILED on malformed API data', async () => {
    const db = prisma!;
    const { org, connection } = await seed(`tt_mal_${Date.now()}`);
    try {
      const good = new FixturesTikTokClient(fixtures());
      const account = await discoverAccount(good, ctx(org, connection));
      const bad = new FixturesTikTokClient(fixtures({ faults: new Set(['malformed-videos']) }));
      await expect(syncVideos(bad, ctx(org, connection), account)).rejects.toThrow();
      const run = await db.tikTokSyncRun.findFirst({
        where: { tikTokAccountId: account.id, kind: 'VIDEOS' },
        orderBy: { startedAt: 'desc' },
      });
      expect(run?.status).toBe('FAILED');
    } finally {
      await db.organization.delete({ where: { id: org.id } });
    }
  });

  maybe()('isolates tenants — org A never sees org B data', async () => {
    const db = prisma!;
    const a = await seed(`tt_iso_a_${Date.now()}`);
    const b = await seed(`tt_iso_b_${Date.now()}`);
    try {
      const client = new FixturesTikTokClient(fixtures());
      const accA = await discoverAccount(client, ctx(a.org, a.connection));
      await syncVideos(client, ctx(a.org, a.connection), accA);

      expect(await getPrimaryAccount(b.org.id, db)).toBeNull();
      expect(await getAccountOverview(b.org.id, db)).toBeNull();
      expect((await listVideosPage(b.org.id, {}, db)).videos).toHaveLength(0);
      expect((await getAccountOverview(a.org.id, db))?.account.openId).toBe('open_A');

      await expect(
        runTikTokAnalyst(
          { db, model: { generateObject: async () => ({ object: {}, usage: {} }) } as never },
          { organizationId: b.org.id, accountId: accA.id },
        ),
      ).rejects.toThrow(/not found/i);
    } finally {
      await db.organization.deleteMany({ where: { id: { in: [a.org.id, b.org.id] } } });
    }
  });

  maybe()('persists the duplicate-publish guard in the database', async () => {
    const db = prisma!;
    const { org, connection, user } = await seed(`tt_pub_${Date.now()}`);
    try {
      const account = await discoverAccount(
        new FixturesTikTokClient(fixtures()),
        ctx(org, connection),
      );
      const input = {
        organizationId: org.id,
        userId: user.id,
        accountId: account.id,
        sourceUrl: 'https://cdn.example.com/x.mp4',
        caption: 'hello world',
        hashtags: ['a', 'b'],
        privacy: 'SELF_ONLY' as const,
      };
      const draft = await createPublishDraft(input, db);
      expect(draft.status).toBe('AWAITING_APPROVAL');
      const err = await createPublishDraft(input, db).catch((e) => e);
      expect(isAppError(err) && err.code).toBe('conflict');
      expect(await db.tikTokPublish.count({ where: { organizationId: org.id } })).toBe(1);
    } finally {
      await db.organization.delete({ where: { id: org.id } });
      await db.user.deleteMany({ where: { email: { contains: 'tt_pub_' } } });
    }
  });
});
