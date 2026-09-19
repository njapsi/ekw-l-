import { type Db, prisma } from '@growth-agent/db';

/**
 * Last-sync facts per connection, for the Connection Center and the scheduler.
 *
 * The unified `IntegrationSyncRun` ledger is the primary source. Syncs that
 * ran through the older per-provider paths (YouTube / TikTok run tables,
 * Search Console snapshots) still count as successes, so a connection synced
 * before this ledger existed is not shown as "never synced" — which would be
 * false.
 */
export interface SyncFacts {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  /** Consecutive failures since the last success (unified ledger only). */
  consecutiveFailures: number;
  running: boolean;
}

const EMPTY: SyncFacts = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  running: false,
};

function later(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b > a ? b : a;
}

/** Facts for every connection of one org, keyed by connectionRef. */
export async function getSyncFacts(
  organizationId: string,
  db: Db = prisma,
): Promise<Map<string, SyncFacts>> {
  const [runs, ytRuns, ttRuns, gscSnaps] = await Promise.all([
    db.integrationSyncRun.findMany({
      where: { organizationId },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: { connectionRef: true, status: true, error: true, startedAt: true, finishedAt: true },
    }),
    db.youTubeSyncRun.findMany({
      where: { organizationId, status: { in: ['COMPLETED', 'FAILED'] } },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: {
        status: true,
        error: true,
        finishedAt: true,
        channel: { select: { oauthConnectionId: true } },
      },
    }),
    db.tikTokSyncRun.findMany({
      where: { organizationId, status: { in: ['COMPLETED', 'FAILED'] } },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: {
        status: true,
        error: true,
        finishedAt: true,
        account: { select: { oauthConnectionId: true } },
      },
    }),
    db.searchConsoleSnapshot.findMany({
      where: { organizationId },
      orderBy: { capturedAt: 'desc' },
      take: 20,
      select: { capturedAt: true, site: { select: { oauthConnectionId: true } } },
    }),
  ]);

  const facts = new Map<string, SyncFacts>();
  const get = (ref: string) => {
    let f = facts.get(ref);
    if (!f) {
      f = { ...EMPTY };
      facts.set(ref, f);
    }
    return f;
  };

  // Unified ledger, newest first: count failures until the first success.
  const stopped = new Set<string>();
  for (const r of runs) {
    const f = get(r.connectionRef);
    if (r.status === 'RUNNING') {
      // A RUNNING row older than 30 min is abandoned (closed by closeStaleRuns).
      if (Date.now() - r.startedAt.getTime() < 30 * 60 * 1000) f.running = true;
      continue;
    }
    const at = r.finishedAt ?? r.startedAt;
    if (r.status === 'COMPLETED') {
      f.lastSuccessAt = later(f.lastSuccessAt, at);
      stopped.add(r.connectionRef);
    } else if (r.status === 'FAILED') {
      if (!f.lastFailureAt || at > f.lastFailureAt) {
        f.lastFailureAt = at;
        f.lastError = r.error;
      }
      if (!stopped.has(r.connectionRef)) f.consecutiveFailures += 1;
    }
  }

  const legacy = (ref: string, ok: boolean, at: Date | null, error: string | null) => {
    if (!at) return;
    const f = get(ref);
    if (ok) f.lastSuccessAt = later(f.lastSuccessAt, at);
    else if (!f.lastFailureAt || at > f.lastFailureAt) {
      f.lastFailureAt = at;
      f.lastError = error;
    }
  };
  for (const r of ytRuns)
    legacy(r.channel.oauthConnectionId, r.status === 'COMPLETED', r.finishedAt, r.error);
  for (const r of ttRuns)
    legacy(r.account.oauthConnectionId, r.status === 'COMPLETED', r.finishedAt, r.error);
  for (const s of gscSnaps) legacy(s.site.oauthConnectionId, true, s.capturedAt, null);

  return facts;
}

export function factsFor(map: Map<string, SyncFacts>, ref: string | null): SyncFacts {
  return (ref ? map.get(ref) : undefined) ?? { ...EMPTY };
}
