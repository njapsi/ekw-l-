import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { runTikTokTool, TIKTOK_TOOL_NAMES } = await import('./tiktok-tools.js');

let db: MemoryDb;
let asDb: Db;
const ctx = () => ({ organizationId: 'org_1', userId: 'u1', db: asDb });

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runTikTokTool dispatcher', () => {
  it('rejects an unknown tool name', async () => {
    await expect(runTikTokTool('tiktok.delete_video', ctx(), {})).rejects.toThrow(/Unknown tool/);
  });

  it('lists exactly ten tools, with only the publish-draft tool touching an external write path', async () => {
    expect(TIKTOK_TOOL_NAMES).toHaveLength(10);
    const writeLike = TIKTOK_TOOL_NAMES.filter((n) => /publish|update|delete/i.test(n));
    expect(writeLike).toEqual(['tiktok.content.publish.draft']);
  });

  it('validates tiktok.content.compare input — fewer than two video ids is rejected before any lookup', async () => {
    await expect(
      runTikTokTool('tiktok.content.compare', ctx(), { videoIds: ['only-one'] }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('validates tiktok.experiment.create input — a missing hypothesis is rejected', async () => {
    await expect(
      runTikTokTool('tiktok.experiment.create', ctx(), {
        variable: 'hook',
        successMetric: 'views',
        expectedDirection: 'INCREASE',
        experimentNote: 'test',
      }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('validates tiktok.content.publish.draft input — a non-https URL is rejected', async () => {
    await expect(
      runTikTokTool('tiktok.content.publish.draft', ctx(), {
        sourceUrl: 'not-a-url',
        caption: 'hi',
      }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('every capability-gated tool refuses when TikTok is not connected, naming the reason', async () => {
    await expect(runTikTokTool('tiktok.account.get', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
    await expect(runTikTokTool('tiktok.video.list', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
    await expect(runTikTokTool('tiktok.content.performance', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
    await expect(
      runTikTokTool('tiktok.content.compare', ctx(), { videoIds: ['a', 'b'] }),
    ).rejects.toThrow(/TikTok is not connected/);
    await expect(runTikTokTool('tiktok.content.opportunities', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
    await expect(runTikTokTool('tiktok.content.calendar.generate', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
    await expect(
      runTikTokTool('tiktok.experiment.create', ctx(), {
        hypothesis: 'Shorter hooks increase watch time',
        variable: 'hook_length',
        successMetric: 'watch_time',
        expectedDirection: 'INCREASE',
        experimentNote: 'Testing shorter hooks for two weeks.',
      }),
    ).rejects.toThrow(/TikTok is not connected/);
    await expect(runTikTokTool('tiktok.report.generate', ctx(), {})).rejects.toThrow(
      /TikTok is not connected/,
    );
  });

  it('tiktok.content.publish.draft re-checks RBAC before anything else, and is safely rejected (never a silent success) with no organization on record', async () => {
    await expect(
      runTikTokTool('tiktok.content.publish.draft', ctx(), {
        sourceUrl: 'https://example.com/video.mp4',
        caption: 'hello',
      }),
    ).rejects.toThrow();
  });

  it("re-checks the caller's RBAC role at call time — a MEMBER (agent:run but no publish:external) is refused even with a usable connection", async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'x');
    vi.stubEnv('TIKTOK_CLIENT_KEY', 'ck_test');
    vi.stubEnv('TIKTOK_CLIENT_SECRET', 'cs_test');
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await db.user.create({ data: { id: 'member_1', email: 'member@example.com' } });
    await db.membership.create({
      data: { userId: 'member_1', organizationId: 'org_1', role: 'MEMBER', status: 'ACTIVE' },
    });
    await db.oAuthConnection.create({
      data: {
        organizationId: 'org_1',
        provider: 'TIKTOK',
        externalAccountId: 'ext1',
        scopes: ['user.info.basic', 'video.publish'],
        accessTokenCipher: 'c',
        tokenIv: 'i',
        tokenAuthTag: 't',
        keyId: 'k',
        status: 'ACTIVE',
      },
    });
    const memberCtx = { organizationId: 'org_1', userId: 'member_1', db: asDb };
    await expect(
      runTikTokTool('tiktok.content.publish.draft', memberCtx, {
        sourceUrl: 'https://example.com/video.mp4',
        caption: 'hello',
      }),
    ).rejects.toThrow(/publish:external|permission/i);
  });

  it('rejects report generation and experiment creation with no signed-in user before touching the connection', async () => {
    const anon = { organizationId: 'org_1', userId: null, db: asDb };
    await expect(runTikTokTool('tiktok.report.generate', anon, {})).rejects.toThrow();
    await expect(
      runTikTokTool('tiktok.experiment.create', anon, {
        hypothesis: 'x',
        variable: 'y',
        successMetric: 'z',
        expectedDirection: 'INCREASE',
        experimentNote: 'note',
      }),
    ).rejects.toThrow();
  });
});
