import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const runYouTubeFullSync = vi.fn(async (..._a: unknown[]) => [
  { kind: 'CHANNEL', itemsProcessed: 1, quotaUnitsSpent: 1 },
  { kind: 'VIDEOS', itemsProcessed: 12, quotaUnitsSpent: 3 },
]);
const syncWordPressContent = vi.fn(async (..._a: unknown[]) => ({
  posts: 3,
  pages: 1,
  truncated: false,
}));

vi.mock('../youtube/jobs.js', () => ({ runYouTubeFullSync }));
vi.mock('../tiktok/jobs.js', () => ({ runTikTokFullSync: vi.fn(async () => []) }));
vi.mock('../searchconsole/jobs.js', () => ({
  runSearchConsoleSyncJob: vi.fn(async () => ({ properties: 2 })),
}));
vi.mock('../wordpress/sync.js', () => ({ syncWordPressContent }));

const { closeStaleRuns, getSyncFacts, isDue, runIntegrationSync, sweepDueSyncs } =
  await import('./index.js');

let db: MemoryDb;
let asDb: Db;

async function ytConnection(org = 'org_1') {
  return db.oAuthConnection.create({
    data: { organizationId: org, provider: 'YOUTUBE', status: 'ACTIVE' },
  });
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  runYouTubeFullSync.mockClear();
  syncWordPressContent.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runIntegrationSync', () => {
  it('records a completed run with the item count and duration', async () => {
    const c = await ytConnection();
    const out = await runIntegrationSync(
      { organizationId: 'org_1', key: 'YOUTUBE', connectionRef: c.id as string, trigger: 'MANUAL' },
      asDb,
    );
    expect(out).toMatchObject({ status: 'COMPLETED', items: 13 });
    const run = db.integrationSyncRun.rows[0];
    expect(run?.status).toBe('COMPLETED');
    expect(typeof run?.durationMs).toBe('number');
  });

  it('refuses a connection from another organization without writing a run', async () => {
    const c = await ytConnection('org_2');
    await expect(
      runIntegrationSync(
        {
          organizationId: 'org_1',
          key: 'YOUTUBE',
          connectionRef: c.id as string,
          trigger: 'MANUAL',
        },
        asDb,
      ),
    ).rejects.toThrow(/not found/);
    expect(db.integrationSyncRun.rows).toHaveLength(0);
    expect(runYouTubeFullSync).not.toHaveBeenCalled();
  });

  it('records a failure honestly instead of throwing', async () => {
    const c = await ytConnection();
    runYouTubeFullSync.mockRejectedValueOnce(new Error('quotaExceeded'));
    const out = await runIntegrationSync(
      { organizationId: 'org_1', key: 'YOUTUBE', connectionRef: c.id as string, trigger: 'MANUAL' },
      asDb,
    );
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('quotaExceeded');
  });

  it('notifies once consecutive failures reach the threshold', async () => {
    const c = await ytConnection();
    for (let i = 0; i < 3; i++) {
      runYouTubeFullSync.mockRejectedValueOnce(new Error('boom'));
      await runIntegrationSync(
        {
          organizationId: 'org_1',
          key: 'YOUTUBE',
          connectionRef: c.id as string,
          trigger: 'SCHEDULED',
        },
        asDb,
      );
    }
    expect(db.notification.rows.map((n) => n.kind)).toEqual(['integration.sync_failing']);
  });

  it('skips when another sync for the same connection is already running', async () => {
    const c = await ytConnection();
    await db.integrationSyncRun.create({
      data: {
        organizationId: 'org_1',
        integration: 'YOUTUBE',
        connectionRef: c.id,
        trigger: 'SCHEDULED',
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    const out = await runIntegrationSync(
      { organizationId: 'org_1', key: 'YOUTUBE', connectionRef: c.id as string, trigger: 'MANUAL' },
      asDb,
    );
    expect(out.status).toBe('SKIPPED');
    expect(runYouTubeFullSync).not.toHaveBeenCalled();
  });

  it('closes an abandoned RUNNING row instead of being blocked by it forever', async () => {
    const c = await ytConnection();
    await db.integrationSyncRun.create({
      data: {
        organizationId: 'org_1',
        integration: 'YOUTUBE',
        connectionRef: c.id,
        trigger: 'SCHEDULED',
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const out = await runIntegrationSync(
      { organizationId: 'org_1', key: 'YOUTUBE', connectionRef: c.id as string, trigger: 'MANUAL' },
      asDb,
    );
    expect(out.status).toBe('COMPLETED');
    expect(db.integrationSyncRun.rows[0]?.status).toBe('FAILED');
    expect(String(db.integrationSyncRun.rows[0]?.error)).toMatch(/Abandoned/);
  });

  it('refuses to sync a WordPress site that needs reconnecting, and says why', async () => {
    const site = await db.wordPressSite.create({
      data: {
        organizationId: 'org_1',
        siteUrl: 'https://b.example.com',
        username: 'u',
        credentialCipher: 'c',
        credentialIv: 'i',
        credentialAuthTag: 't',
        keyId: 'k',
        status: 'EXPIRED',
      },
    });
    const out = await runIntegrationSync(
      {
        organizationId: 'org_1',
        key: 'WORDPRESS',
        connectionRef: site.id as string,
        trigger: 'MANUAL',
      },
      asDb,
    );
    expect(out.status).toBe('FAILED');
    expect(out.error).toMatch(/reconnected/);
    expect(syncWordPressContent).not.toHaveBeenCalled();
  });
});

describe('isDue', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const h = (n: number) => new Date(now.getTime() - n * 3600_000);
  const base = { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, running: false };

  it('is due when never synced, or older than the interval', () => {
    expect(isDue(base, 24 * 3600_000, now)).toBe(true);
    expect(isDue({ ...base, lastSuccessAt: h(25) }, 24 * 3600_000, now)).toBe(true);
    expect(isDue({ ...base, lastSuccessAt: h(2) }, 24 * 3600_000, now)).toBe(false);
  });

  it('backs off exponentially after failures', () => {
    const failing = { ...base, lastFailureAt: h(1.5), consecutiveFailures: 2 }; // backoff 2h
    expect(isDue(failing, 24 * 3600_000, now)).toBe(false);
    expect(isDue({ ...failing, lastFailureAt: h(2.5) }, 24 * 3600_000, now)).toBe(true);
  });

  it('never starts a second concurrent run', () => {
    expect(isDue({ ...base, running: true }, 1, now)).toBe(false);
  });
});

describe('sweepDueSyncs', () => {
  it('runs due connections only, bounded per tick', async () => {
    for (let i = 0; i < 3; i++) await ytConnection(`org_${i}`);
    const res = await sweepDueSyncs({ db: asDb, maxRuns: 2 });
    expect(res.ran).toBe(2);
    const again = await sweepDueSyncs({ db: asDb, maxRuns: 10 });
    // Two are fresh now; only the third is still due.
    expect(again.ran).toBe(1);
  });

  it('honours the INTEGRATION_SCHEDULED_SYNC=0 kill switch', async () => {
    await ytConnection();
    vi.stubEnv('INTEGRATION_SCHEDULED_SYNC', '0');
    expect(await sweepDueSyncs({ db: asDb })).toEqual({ considered: 0, ran: 0, failed: 0 });
  });
});

describe('getSyncFacts', () => {
  it('counts syncs from the older per-provider run tables as successes', async () => {
    const c = await ytConnection();
    const at = new Date('2026-09-18T10:00:00Z');
    await db.youTubeSyncRun.create({
      data: {
        organizationId: 'org_1',
        status: 'COMPLETED',
        error: null,
        startedAt: at,
        finishedAt: at,
        channel: { oauthConnectionId: c.id },
      },
    });
    const facts = await getSyncFacts('org_1', asDb);
    expect(facts.get(c.id as string)?.lastSuccessAt).toEqual(at);
  });

  it('closeStaleRuns only touches old RUNNING rows', async () => {
    await db.integrationSyncRun.create({
      data: { organizationId: 'o', integration: 'YOUTUBE', connectionRef: 'x', trigger: 'MANUAL' },
    });
    expect(await closeStaleRuns(new Date(), asDb)).toBe(0);
  });
});
