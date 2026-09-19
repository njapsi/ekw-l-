/**
 * The integration sync framework (Phase 1, Part 11).
 *
 * One entry point — `runIntegrationSync` — for every provider, used by the
 * "Sync now" button, the scheduled sweep and automations alike. It adds what
 * the per-provider syncs never had in common:
 *
 *   - a unified run ledger (`IntegrationSyncRun`) with duration + outcome,
 *   - a single-flight guard: one sync per connection at a time, decided by a
 *     total order over (startedAt, id) so two racing callers cannot both run,
 *   - stale-run recovery (a RUNNING row older than 30 min is closed FAILED —
 *     a crashed worker cannot wedge a connection forever),
 *   - a failure notification once consecutive failures reach 3,
 *   - scheduling with per-provider freshness and failure backoff.
 *
 * The provider sync logic itself (YouTube / TikTok / Search Console) is
 * called unchanged; this layer wraps it rather than re-implementing it.
 */
import {
  type Db,
  type IntegrationSyncRun,
  type IntegrationSyncTrigger,
  type SyncStatus,
  prisma,
} from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { type IntegrationKey, isUsable } from '../integrations/contract.js';
import { oauthRedirectUri } from '../integrations/redirect.js';
import { IntegrationApiError } from '../integrations/resilience.js';
import { createNotification } from '../notifications/index.js';
import { recordIntegrationSync } from '../observability/metrics.js';
import { scrubSecrets } from '../observability/scrub.js';
import { runSearchConsoleSyncJob } from '../searchconsole/jobs.js';
import { runTikTokFullSync } from '../tiktok/jobs.js';
import { requireWordPressSite } from '../wordpress/connect.js';
import { wordPressState } from '../wordpress/state.js';
import { syncWordPressContent } from '../wordpress/sync.js';
import { runYouTubeFullSync } from '../youtube/jobs.js';
import { getSyncFacts } from './status.js';

export { factsFor, getSyncFacts, type SyncFacts } from './status.js';

const log = createLogger('integration-sync');

export type SyncableKey = Exclude<IntegrationKey, 'WEBSITE'>;
export const SYNCABLE_KEYS: readonly SyncableKey[] = [
  'YOUTUBE',
  'GOOGLE_SEARCH_CONSOLE',
  'TIKTOK',
  'WORDPRESS',
];

export const STALE_RUN_MS = 30 * 60 * 1000;
export const FAILURE_NOTIFY_THRESHOLD = 3;

interface AdapterCtx {
  organizationId: string;
  connectionRef: string;
  db: Db;
}

interface SyncAdapter {
  /** How stale a successful sync may get before the scheduler refreshes it. */
  intervalMs: number;
  run(ctx: AdapterCtx): Promise<{ items: number; detail?: string }>;
  /** Connections eligible for scheduled sync (never revoked / broken ones). */
  listActive(db: Db, limit: number): Promise<{ organizationId: string; connectionRef: string }[]>;
  /** Tenant check, before any run row is written. */
  owns(db: Db, organizationId: string, connectionRef: string): Promise<boolean>;
}

function ownsOAuth(provider: 'YOUTUBE' | 'TIKTOK' | 'GOOGLE_SEARCH_CONSOLE') {
  return async (db: Db, organizationId: string, connectionRef: string) =>
    (await db.oAuthConnection.count({ where: { id: connectionRef, organizationId, provider } })) >
    0;
}

const HOUR = 60 * 60 * 1000;

async function activeOAuth(
  db: Db,
  provider: 'YOUTUBE' | 'TIKTOK' | 'GOOGLE_SEARCH_CONSOLE',
  limit: number,
) {
  const rows = await db.oAuthConnection.findMany({
    // A cross-tenant scheduler query by design: it only selects ids, and every
    // sync it starts re-scopes to the row's own organizationId.
    where: { provider, status: 'ACTIVE', organization: { deletionScheduledAt: null } },
    select: { id: true, organizationId: true },
    take: limit,
  });
  return rows.map((r) => ({ organizationId: r.organizationId, connectionRef: r.id }));
}

const ADAPTERS: Record<SyncableKey, SyncAdapter> = {
  YOUTUBE: {
    intervalMs: 24 * HOUR,
    async run(c) {
      const results = await runYouTubeFullSync(
        {
          organizationId: c.organizationId,
          connectionId: c.connectionRef,
          redirectUri: oauthRedirectUri('google'),
        },
        c.db,
      );
      return { items: results.reduce((n, r) => n + r.itemsProcessed, 0) };
    },
    listActive: (db, limit) => activeOAuth(db, 'YOUTUBE', limit),
    owns: ownsOAuth('YOUTUBE'),
  },
  TIKTOK: {
    intervalMs: 24 * HOUR,
    async run(c) {
      const results = await runTikTokFullSync(
        {
          organizationId: c.organizationId,
          connectionId: c.connectionRef,
          redirectUri: oauthRedirectUri('tiktok'),
        },
        c.db,
      );
      return { items: results.reduce((n, r) => n + r.itemsProcessed, 0) };
    },
    listActive: (db, limit) => activeOAuth(db, 'TIKTOK', limit),
    owns: ownsOAuth('TIKTOK'),
  },
  GOOGLE_SEARCH_CONSOLE: {
    intervalMs: 24 * HOUR,
    async run(c) {
      const r = await runSearchConsoleSyncJob({
        organizationId: c.organizationId,
        connectionId: c.connectionRef,
        redirectUri: oauthRedirectUri('google'),
        db: c.db,
      });
      return { items: r.properties };
    },
    listActive: (db, limit) => activeOAuth(db, 'GOOGLE_SEARCH_CONSOLE', limit),
    owns: ownsOAuth('GOOGLE_SEARCH_CONSOLE'),
  },
  WORDPRESS: {
    intervalMs: 12 * HOUR,
    async run(c) {
      const site = await requireWordPressSite(c.organizationId, c.connectionRef, c.db);
      const state = wordPressState(site);
      if (!isUsable(state)) {
        throw new AppError(
          'provider_unavailable',
          'This WordPress site needs to be reconnected before it can sync.',
        );
      }
      let r;
      try {
        r = await syncWordPressContent(site, c.db);
      } catch (err) {
        // A rejected credential is a connection-state fact, not just a failed
        // sync: record it so the Connection Center shows "reconnect".
        const authFailed = err instanceof IntegrationApiError && err.kind === 'auth';
        await c.db.wordPressSite.update({
          where: { id: site.id },
          data: {
            ...(authFailed ? { status: 'EXPIRED' as const } : {}),
            lastCheckOk: false,
            lastCheckAt: new Date(),
            lastError: scrubSecrets(err instanceof Error ? err.message : 'sync failed').slice(
              0,
              500,
            ),
          },
        });
        throw err;
      }
      await c.db.wordPressSite.update({
        where: { id: site.id },
        data: { lastCheckOk: true, lastCheckAt: new Date(), lastError: null },
      });
      return {
        items: r.posts + r.pages,
        detail: r.truncated
          ? 'Large site: only the most recently modified 1,000 items per type were read.'
          : undefined,
      };
    },
    async listActive(db, limit) {
      const rows = await db.wordPressSite.findMany({
        where: { status: 'ACTIVE', organization: { deletionScheduledAt: null } },
        select: { id: true, organizationId: true },
        take: limit,
      });
      return rows.map((r) => ({ organizationId: r.organizationId, connectionRef: r.id }));
    },
    owns: async (db, organizationId, connectionRef) =>
      (await db.wordPressSite.count({ where: { id: connectionRef, organizationId } })) > 0,
  },
};

export function isSyncable(key: string): key is SyncableKey {
  return (SYNCABLE_KEYS as readonly string[]).includes(key);
}

export interface SyncOutcome {
  runId: string | null;
  status: SyncStatus;
  items: number;
  error: string | null;
  detail?: string;
}

/** Close RUNNING rows nobody finished (worker crash, deploy mid-sync). */
export async function closeStaleRuns(now: Date = new Date(), db: Db = prisma): Promise<number> {
  const res = await db.integrationSyncRun.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
    data: {
      status: 'FAILED',
      error:
        'Abandoned: no result was recorded within 30 minutes (the process running it likely stopped).',
      finishedAt: now,
    },
  });
  return res.count;
}

function isEarlier(
  a: Pick<IntegrationSyncRun, 'startedAt' | 'id'>,
  b: Pick<IntegrationSyncRun, 'startedAt' | 'id'>,
) {
  return (
    a.startedAt < b.startedAt || (a.startedAt.getTime() === b.startedAt.getTime() && a.id < b.id)
  );
}

export async function runIntegrationSync(
  input: {
    organizationId: string;
    key: SyncableKey;
    connectionRef: string;
    trigger: IntegrationSyncTrigger;
  },
  db: Db = prisma,
): Promise<SyncOutcome> {
  const adapter = ADAPTERS[input.key];
  const started = Date.now();
  if (!(await adapter.owns(db, input.organizationId, input.connectionRef))) {
    throw AppError.notFound('Connection');
  }
  await closeStaleRuns(new Date(), db);

  // Insert-then-check single flight: only the earliest RUNNING row proceeds.
  const run = await db.integrationSyncRun.create({
    data: {
      organizationId: input.organizationId,
      integration: input.key,
      connectionRef: input.connectionRef,
      trigger: input.trigger,
    },
  });
  const others = await db.integrationSyncRun.findMany({
    where: {
      organizationId: input.organizationId,
      connectionRef: input.connectionRef,
      status: 'RUNNING',
      id: { not: run.id },
    },
    select: { id: true, startedAt: true },
  });
  if (others.some((o) => isEarlier(o, run))) {
    await db.integrationSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'SKIPPED',
        error: 'Another sync for this connection was already running.',
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      },
    });
    recordIntegrationSync({ integration: input.key, status: 'SKIPPED', durationMs: 0 });
    return { runId: run.id, status: 'SKIPPED', items: 0, error: 'A sync is already running.' };
  }

  try {
    const r = await adapter.run({
      organizationId: input.organizationId,
      connectionRef: input.connectionRef,
      db,
    });
    const durationMs = Date.now() - started;
    await db.integrationSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        itemsProcessed: r.items,
        error: r.detail ?? null,
        finishedAt: new Date(),
        durationMs,
      },
    });
    recordIntegrationSync({ integration: input.key, status: 'COMPLETED', durationMs });
    return { runId: run.id, status: 'COMPLETED', items: r.items, error: null, detail: r.detail };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = scrubSecrets(
      err instanceof AppError && err.expose
        ? err.message
        : err instanceof Error
          ? err.message
          : 'sync failed',
    ).slice(0, 500);
    await db.integrationSyncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', error: message, finishedAt: new Date(), durationMs },
    });
    recordIntegrationSync({ integration: input.key, status: 'FAILED', durationMs });
    log.warn({ key: input.key, connectionRef: input.connectionRef }, 'integration sync failed');
    await maybeNotifyFailing(input.organizationId, input.key, input.connectionRef, message, db);
    return { runId: run.id, status: 'FAILED', items: 0, error: message };
  }
}

async function maybeNotifyFailing(
  organizationId: string,
  key: SyncableKey,
  connectionRef: string,
  message: string,
  db: Db,
) {
  const facts = (await getSyncFacts(organizationId, db)).get(connectionRef);
  if (!facts || facts.consecutiveFailures < FAILURE_NOTIFY_THRESHOLD) return;
  const day = new Date().toISOString().slice(0, 10);
  await createNotification(
    {
      organizationId,
      kind: 'integration.sync_failing',
      level: 'WARNING',
      title: `${key === 'GOOGLE_SEARCH_CONSOLE' ? 'Search Console' : key.charAt(0) + key.slice(1).toLowerCase()} sync is failing`,
      body: `The last ${facts.consecutiveFailures} syncs failed. Latest error: ${message}. Data shown for this connection is not being refreshed.`,
      linkPath: '/app/integrations',
      // One notice per connection per day — failures are not re-announced every tick.
      dedupeKey: `sync-failing:${connectionRef}:${day}`,
      sourceType: 'integration_sync',
      sourceId: connectionRef,
    },
    db,
  );
}

/**
 * Backoff after failures: 1h, 2h, 4h … capped at the adapter's interval, so a
 * broken connection is retried less and less rather than every tick.
 */
export function isDue(
  facts: {
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    consecutiveFailures: number;
    running: boolean;
  },
  intervalMs: number,
  now: Date,
): boolean {
  if (facts.running) return false;
  if (facts.lastFailureAt && facts.consecutiveFailures > 0) {
    const backoff = Math.min(intervalMs, HOUR * 2 ** (facts.consecutiveFailures - 1));
    if (now.getTime() - facts.lastFailureAt.getTime() < backoff) return false;
  }
  if (!facts.lastSuccessAt) return true;
  return now.getTime() - facts.lastSuccessAt.getTime() >= intervalMs;
}

export function scheduledSyncEnabled(): boolean {
  return process.env.INTEGRATION_SCHEDULED_SYNC !== '0';
}

/**
 * The worker's scheduled tick. Runs at most `maxRuns` syncs per tick,
 * sequentially, so a large backlog spreads over several ticks instead of
 * bursting provider quotas.
 */
export async function sweepDueSyncs(
  opts: { now?: Date; maxRuns?: number; db?: Db } = {},
): Promise<{ considered: number; ran: number; failed: number }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const maxRuns = opts.maxRuns ?? 10;
  if (!scheduledSyncEnabled()) return { considered: 0, ran: 0, failed: 0 };

  await closeStaleRuns(now, db);
  let considered = 0;
  let ran = 0;
  let failed = 0;
  const factsByOrg = new Map<string, Awaited<ReturnType<typeof getSyncFacts>>>();

  for (const key of SYNCABLE_KEYS) {
    const adapter = ADAPTERS[key];
    const conns = await adapter.listActive(db, 500);
    for (const c of conns) {
      if (ran >= maxRuns) return { considered, ran, failed };
      considered += 1;
      let facts = factsByOrg.get(c.organizationId);
      if (!facts) {
        facts = await getSyncFacts(c.organizationId, db);
        factsByOrg.set(c.organizationId, facts);
      }
      const f = facts.get(c.connectionRef) ?? {
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        running: false,
      };
      if (!isDue(f, adapter.intervalMs, now)) continue;
      const out = await runIntegrationSync(
        {
          organizationId: c.organizationId,
          key,
          connectionRef: c.connectionRef,
          trigger: 'SCHEDULED',
        },
        db,
      );
      ran += 1;
      if (out.status === 'FAILED') failed += 1;
    }
  }
  return { considered, ran, failed };
}
