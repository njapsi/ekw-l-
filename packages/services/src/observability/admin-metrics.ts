/**
 * Database-derived aggregates for the `/admin` dashboards and `/admin/system-health`.
 * These are the durable, historical numbers (the in-process `metrics.ts`
 * registry resets on deploy). All queries are platform-wide — `/admin` is only
 * reachable by platform staff.
 */
import { type Db, prisma } from '@growth-agent/db';
import { getQueueDepths } from './queues.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function durationsMs(rows: { startedAt: Date | null; finishedAt: Date | null }[]): number[] {
  return rows
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => (r.finishedAt as Date).getTime() - (r.startedAt as Date).getTime())
    .filter((ms) => ms >= 0 && Number.isFinite(ms));
}

// --- AI usage ------------------------------------------------------------

export async function aiUsageSummary(db: Db = prisma, opts: { sinceMs?: number } = {}) {
  const since = new Date(Date.now() - (opts.sinceMs ?? DAY_MS));
  const where = { createdAt: { gte: since } };

  const [totals, byProvider, byModel, byAgent, byStatus, sample] = await Promise.all([
    db.agentRun.aggregate({
      where,
      _count: { _all: true },
      _sum: { tokensPrompt: true, tokensCompletion: true, costUsd: true },
    }),
    db.agentRun.groupBy({
      by: ['provider'],
      where,
      _count: { _all: true },
      _sum: { costUsd: true },
    }),
    db.agentRun.groupBy({
      by: ['model'],
      where,
      _count: { _all: true },
      _sum: { tokensPrompt: true, tokensCompletion: true, costUsd: true },
    }),
    db.agentRun.groupBy({ by: ['agent'], where, _count: { _all: true }, _sum: { costUsd: true } }),
    db.agentRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
    db.agentRun.findMany({
      where: { ...where, startedAt: { not: null }, finishedAt: { not: null } },
      select: { startedAt: true, finishedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    }),
  ]);

  const runs = totals._count._all;
  const failed = byStatus.find((s) => s.status === 'FAILED')?._count._all ?? 0;
  const lat = durationsMs(sample);

  return {
    sinceMs: opts.sinceMs ?? DAY_MS,
    runs,
    failed,
    failureRate: runs ? failed / runs : 0,
    promptTokens: Number(totals._sum.tokensPrompt ?? 0),
    completionTokens: Number(totals._sum.tokensCompletion ?? 0),
    costUsd: Number(totals._sum.costUsd ?? 0),
    latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), samples: lat.length },
    byProvider: byProvider
      .map((r) => ({
        provider: r.provider ?? 'unknown',
        runs: r._count._all,
        costUsd: Number(r._sum.costUsd ?? 0),
      }))
      .sort((a, b) => b.runs - a.runs),
    byModel: byModel
      .map((r) => ({
        model: r.model ?? 'unknown',
        runs: r._count._all,
        promptTokens: Number(r._sum.tokensPrompt ?? 0),
        completionTokens: Number(r._sum.tokensCompletion ?? 0),
        costUsd: Number(r._sum.costUsd ?? 0),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byAgent: byAgent
      .map((r) => ({ agent: r.agent, runs: r._count._all, costUsd: Number(r._sum.costUsd ?? 0) }))
      .sort((a, b) => b.runs - a.runs),
  };
}

export async function recentExpensiveAgentRuns(db: Db = prisma, limit = 20) {
  const rows = await db.agentRun.findMany({
    orderBy: { costUsd: 'desc' },
    take: limit,
    select: {
      id: true,
      organizationId: true,
      agent: true,
      model: true,
      provider: true,
      status: true,
      tokensPrompt: true,
      tokensCompletion: true,
      costUsd: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    agent: r.agent,
    model: r.model,
    provider: r.provider,
    status: r.status,
    promptTokens: r.tokensPrompt,
    completionTokens: r.tokensCompletion,
    costUsd: Number(r.costUsd),
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

// --- Crawler -----------------------------------------------------------

export async function crawlerSummary(db: Db = prisma, opts: { sinceMs?: number } = {}) {
  const since = new Date(Date.now() - (opts.sinceMs ?? 7 * DAY_MS));
  const where = { createdAt: { gte: since } };

  const [byStatus, totals, sample] = await Promise.all([
    db.crawl.groupBy({ by: ['status'], where, _count: { _all: true } }),
    db.crawl.aggregate({
      where,
      _count: { _all: true },
      _sum: { pagesCrawled: true, issuesFound: true },
    }),
    db.crawl.findMany({
      where: { ...where, startedAt: { not: null }, finishedAt: { not: null } },
      select: { startedAt: true, finishedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
    }),
  ]);

  const total = totals._count._all;
  const failed = byStatus.find((s) => s.status === 'FAILED')?._count._all ?? 0;
  const durations = durationsMs(sample);

  return {
    sinceMs: opts.sinceMs ?? 7 * DAY_MS,
    total,
    failed,
    failureRate: total ? failed / total : 0,
    pagesCrawled: Number(totals._sum.pagesCrawled ?? 0),
    issuesFound: Number(totals._sum.issuesFound ?? 0),
    byStatus: byStatus
      .map((s) => ({ status: s.status, count: s._count._all }))
      .sort((a, b) => b.count - a.count),
    durationMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      samples: durations.length,
    },
  };
}

// --- Background jobs --------------------------------------------------

export async function jobDurationSummary(db: Db = prisma, opts: { sinceMs?: number } = {}) {
  const since = new Date(Date.now() - (opts.sinceMs ?? 7 * DAY_MS));
  const [byStatus, sample, depths] = await Promise.all([
    db.automationRun.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.automationRun.findMany({
      where: { createdAt: { gte: since }, durationMs: { not: null } },
      select: { durationMs: true },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    }),
    getQueueDepths(),
  ]);
  const durs = sample.map((r) => r.durationMs ?? 0).filter((n) => n > 0);
  return {
    automationRuns: {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      durationMs: { p50: percentile(durs, 0.5), p95: percentile(durs, 0.95), samples: durs.length },
    },
    queues: depths,
    totalDepth: depths.reduce((n, d) => n + d.waiting + d.active + d.delayed, 0),
    totalFailed: depths.reduce((n, d) => n + d.failed, 0),
  };
}

// --- Subscriptions --------------------------------------------------

export async function subscriptionsOverview(db: Db = prisma) {
  const [byTier, byStatus, trialsEnding] = await Promise.all([
    db.subscription.groupBy({ by: ['tier'], _count: { _all: true } }),
    db.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
    db.subscription.count({
      where: { trialEndsAt: { gte: new Date(), lte: new Date(Date.now() + 7 * DAY_MS) } },
    }),
  ]);
  return {
    byTier: byTier
      .map((t) => ({ tier: t.tier, count: t._count._all }))
      .sort((a, b) => b.count - a.count),
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    trialsEndingIn7d: trialsEnding,
  };
}

// --- Usage -------------------------------------------------------------

export async function usageOverview(db: Db = prisma) {
  const now = new Date();
  const counters = await db.usageCounter.findMany({
    where: { periodEnd: { gte: now } },
    select: { meter: true, used: true, limitValue: true, organizationId: true },
  });
  const byMeter = new Map<
    string,
    { meter: string; used: number; orgs: number; atOrOverLimit: number }
  >();
  for (const c of counters) {
    const key = c.meter;
    const entry = byMeter.get(key) ?? { meter: key, used: 0, orgs: 0, atOrOverLimit: 0 };
    entry.used += Number(c.used);
    entry.orgs += 1;
    if (c.limitValue != null && c.used >= c.limitValue) entry.atOrOverLimit += 1;
    byMeter.set(key, entry);
  }
  return {
    periodedOrgs: new Set(counters.map((c) => c.organizationId)).size,
    byMeter: [...byMeter.values()].sort((a, b) => b.used - a.used),
  };
}

// --- Platform counts (overview) --------------------------------------

export async function platformCounts(db: Db = prisma) {
  const [
    users,
    orgs,
    deletedOrgs,
    memberships,
    connections,
    websites,
    crawls,
    agentRuns,
    automations,
    reports,
    errors24h,
  ] = await Promise.all([
    db.user.count(),
    db.organization.count({ where: { deletedAt: null } }),
    db.organization.count({ where: { deletedAt: { not: null } } }),
    db.membership.count({ where: { status: 'ACTIVE' } }),
    db.oAuthConnection.count(),
    db.website.count(),
    db.crawl.count(),
    db.agentRun.count(),
    db.automationRule.count(),
    db.report.count(),
    db.errorEvent.aggregate({
      _sum: { count: true },
      where: { lastSeenAt: { gte: new Date(Date.now() - DAY_MS) } },
    }),
  ]);
  return {
    users,
    orgs,
    deletedOrgs,
    memberships,
    connections,
    websites,
    crawls,
    agentRuns,
    automations,
    reports,
    errors24h: Number(errors24h._sum.count ?? 0),
  };
}

// --- Database performance ------------------------------------------

interface PgStatRow {
  numbackends: bigint;
  xact_commit: bigint;
  xact_rollback: bigint;
  blks_read: bigint;
  blks_hit: bigint;
  deadlocks: bigint;
  db_size: bigint;
}

interface PgActivityRow {
  total: bigint;
  active: bigint;
  idle_in_transaction: bigint;
  waiting: bigint;
}

interface SlowQueryRow {
  query: string;
  calls: bigint;
  mean_exec_ms: number;
  total_exec_ms: number;
}

export async function dbPerformance(db: Db = prisma) {
  const stat = await db.$queryRaw<PgStatRow[]>`
    SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, deadlocks,
           pg_database_size(current_database()) AS db_size
    FROM pg_stat_database WHERE datname = current_database()`;
  const activity = await db.$queryRaw<PgActivityRow[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE state = 'active') AS active,
           count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction,
           count(*) FILTER (WHERE wait_event_type IS NOT NULL) AS waiting
    FROM pg_stat_activity WHERE datname = current_database()`;

  let slowQueries: SlowQueryRow[] = [];
  let pgStatStatements = false;
  try {
    slowQueries = await db.$queryRaw<SlowQueryRow[]>`
      SELECT left(query, 200) AS query, calls,
             round(mean_exec_time::numeric, 2)::float8 AS mean_exec_ms,
             round(total_exec_time::numeric, 2)::float8 AS total_exec_ms
      FROM pg_stat_statements
      ORDER BY mean_exec_time DESC
      LIMIT 5`;
    pgStatStatements = true;
  } catch {
    pgStatStatements = false;
  }

  const s = stat[0];
  const a = activity[0];
  const hit = s ? Number(s.blks_hit) : 0;
  const read = s ? Number(s.blks_read) : 0;
  const commits = s ? Number(s.xact_commit) : 0;
  const rollbacks = s ? Number(s.xact_rollback) : 0;

  return {
    connections: {
      total: a ? Number(a.total) : 0,
      active: a ? Number(a.active) : 0,
      idleInTransaction: a ? Number(a.idle_in_transaction) : 0,
      waiting: a ? Number(a.waiting) : 0,
    },
    cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
    rollbackRatio: commits + rollbacks > 0 ? rollbacks / (commits + rollbacks) : 0,
    deadlocks: s ? Number(s.deadlocks) : 0,
    databaseSizeBytes: s ? Number(s.db_size) : 0,
    pgStatStatements,
    slowQueries: slowQueries.map((q) => ({
      query: q.query,
      calls: Number(q.calls),
      meanExecMs: q.mean_exec_ms,
      totalExecMs: q.total_exec_ms,
    })),
  };
}
