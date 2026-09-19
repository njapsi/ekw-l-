import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { assertCapabilityUsable, connectionFacts, runIntegrationTool } =
  await import('./integration-tools.js');

let db: MemoryDb;
let asDb: Db;
const ctx = () => ({ organizationId: 'org_1', userId: 'u1', db: asDb });

async function wpSite(caps: string[], org = 'org_1') {
  return db.wordPressSite.create({
    data: {
      organizationId: org,
      siteUrl: 'https://blog.example.com',
      siteName: 'Blog',
      username: 'editor',
      credentialCipher: 'SECRET-CIPHER',
      credentialIv: 'iv',
      credentialAuthTag: 'tag',
      keyId: 'k',
      status: 'ACTIVE',
      detectedCapabilities: caps,
      lastCheckAt: new Date(),
      lastCheckOk: true,
    },
  });
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  vi.stubEnv('ENCRYPTION_KEY', 'x');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'x');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'x');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertCapabilityUsable', () => {
  it('refuses a capability whose integration is not connected, with the reason', async () => {
    await expect(assertCapabilityUsable(ctx(), 'youtube.get_analytics')).rejects.toThrow(
      /YouTube is not connected/,
    );
  });

  it('refuses a capability the connected account lacks, naming what is missing', async () => {
    await wpSite(['read', 'edit_posts']);
    await expect(assertCapabilityUsable(ctx(), 'wordpress.publish')).rejects.toThrow(
      /publish_posts/,
    );
  });

  it('allows a capability the account really has', async () => {
    await wpSite(['read']);
    const entry = await assertCapabilityUsable(ctx(), 'wordpress.get_posts');
    expect(entry.descriptor.key).toBe('WORDPRESS');
  });

  it('refuses an unknown capability', async () => {
    await expect(assertCapabilityUsable(ctx(), 'wordpress.drop_database')).rejects.toThrow(
      /Unknown capability/,
    );
  });

  it('never sees another organization’s connection', async () => {
    await wpSite(['read', 'edit_posts', 'publish_posts'], 'org_2');
    await expect(assertCapabilityUsable(ctx(), 'wordpress.get_posts')).rejects.toThrow();
  });
});

describe('runIntegrationTool', () => {
  it('list_connections reports state and capabilities without any credential material', async () => {
    await wpSite(['read', 'edit_posts', 'publish_posts']);
    const out = await runIntegrationTool('integrations.list_connections', ctx(), {});
    const text = JSON.stringify(out);
    expect(text).toContain('WORDPRESS');
    expect(text).toContain('wordpress.publish');
    expect(text).not.toContain('SECRET-CIPHER');
  });

  it('wordpress.list_content returns synced rows only through the guard', async () => {
    const s = await wpSite(['read']);
    await db.wordPressContent.create({
      data: {
        organizationId: 'org_1',
        wordPressSiteId: s.id,
        wpId: 1,
        type: 'POST',
        status: 'publish',
        title: 'Hello',
        modifiedAt: new Date(),
      },
    });
    const out = (await runIntegrationTool('wordpress.list_content', ctx(), {})) as {
      items: unknown[];
    };
    expect(out.items).toHaveLength(1);
  });

  it('propose_action creates a PENDING request attributed to the agent — and nothing else', async () => {
    await wpSite(['read', 'edit_posts', 'publish_posts']);
    const out = (await runIntegrationTool('integrations.propose_action', ctx(), {
      capabilityId: 'wordpress.publish',
      payload: { wpId: 5 },
      summary: 'Publish the launch post',
    })) as { status: string };
    expect(out.status).toBe('PENDING');
    const row = db.integrationActionRequest.rows[0];
    expect(row?.source).toBe('AGENT');
    expect(row?.status).toBe('PENDING');
    expect(row?.executedAt).toBeNull();
  });

  it('propose_action cannot be used to run a non-approval capability', async () => {
    await wpSite(['read', 'edit_posts']);
    await expect(
      runIntegrationTool('integrations.propose_action', ctx(), {
        capabilityId: 'wordpress.create_draft',
        payload: { title: 'x' },
        summary: 'Draft',
      }),
    ).rejects.toThrow();
    expect(db.integrationActionRequest.rows).toHaveLength(0);
  });

  it('refuses unknown tools and invalid input', async () => {
    await expect(runIntegrationTool('wordpress.publish_now', ctx(), {})).rejects.toThrow(
      /Unknown tool/,
    );
    await expect(
      runIntegrationTool('integrations.get_capabilities', ctx(), { integration: 'MYSPACE' }),
    ).rejects.toThrow(/Invalid input/);
  });
});

describe('connectionFacts', () => {
  it('describes only connected integrations, with usable capabilities', async () => {
    await wpSite(['read']);
    const facts = await connectionFacts('org_1', asDb);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatch(/^WordPress: connected/);
    expect(facts[0]).toContain('Posts');
    expect(facts[0]).not.toContain('Publish');
  });
});
