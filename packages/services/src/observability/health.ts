/**
 * Dependency health checks for `GET /api/health` (web) and `/admin/system-health`.
 * Every check returns a state and a short, secret-free detail string. The
 * endpoint always responds 200 — the body's `status` is the signal.
 */
import { type Db, prisma } from '@growth-agent/db';
import { pingRedis } from './redis.js';
import { workerFleetHealth } from './worker-heartbeat.js';

export type HealthState = 'ok' | 'degraded' | 'down' | 'unconfigured';

export interface HealthCheck {
  name: string;
  state: HealthState;
  latencyMs?: number;
  detail?: string;
}

/**
 * A hung dependency (e.g. an unreachable Postgres whose driver retries its
 * own connection attempts) must not stall `/api/health` — every DB-touching
 * check below is bounded by this, mirroring `pingRedis`'s existing
 * `Promise.race` pattern in `./redis.ts`.
 */
const CHECK_TIMEOUT_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), CHECK_TIMEOUT_MS),
    ),
  ]);
}

export async function checkDatabase(db: Db = prisma): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, 'database check timed out');
    return { name: 'database', state: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      name: 'database',
      state: 'down',
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : 'query failed',
    };
  }
}

export async function checkRedis(): Promise<HealthCheck> {
  const ping = await pingRedis();
  return {
    name: 'redis',
    state: ping.ok ? 'ok' : 'down',
    latencyMs: ping.latencyMs,
    detail: ping.ok ? undefined : (ping.error ?? 'ping failed'),
  };
}

interface ProviderProbe {
  name: string;
  configured: boolean;
  url: string;
  headers: Record<string, string>;
}

function aiProviderProbes(): ProviderProbe[] {
  return [
    {
      name: 'anthropic',
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
    },
    {
      name: 'openai',
      configured: Boolean(process.env.OPENAI_API_KEY),
      url: 'https://api.openai.com/v1/models',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
    },
    {
      name: 'google',
      configured: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
      url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''}`,
      headers: {},
    },
  ];
}

/**
 * `deep: false` (default) only reports which providers have credentials — no
 * network call, no spend. `deep: true` makes one cheap authenticated GET to a
 * models endpoint per configured provider (2.5s timeout).
 */
export async function checkAiProviders(opts: { deep?: boolean } = {}): Promise<HealthCheck> {
  const probes = aiProviderProbes();
  const configured = probes.filter((p) => p.configured);
  if (configured.length === 0) {
    return {
      name: 'ai_provider',
      state: 'unconfigured',
      detail: 'no AI provider credentials set — the app runs deterministically',
    };
  }
  if (!opts.deep) {
    return {
      name: 'ai_provider',
      state: 'ok',
      detail: `configured: ${configured.map((p) => p.name).join(', ')}`,
    };
  }
  const started = Date.now();
  const results = await Promise.all(
    configured.map(async (p) => {
      try {
        const res = await fetch(p.url, {
          method: 'GET',
          headers: p.headers,
          signal: AbortSignal.timeout(2_500),
        });
        return { name: p.name, ok: res.ok || res.status === 429, status: res.status };
      } catch {
        return { name: p.name, ok: false, status: 0 };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  return {
    name: 'ai_provider',
    state: failed.length === 0 ? 'ok' : failed.length === results.length ? 'down' : 'degraded',
    latencyMs: Date.now() - started,
    detail:
      failed.length === 0
        ? `reachable: ${results.map((r) => r.name).join(', ')}`
        : `unreachable: ${failed.map((r) => r.name).join(', ')}`,
  };
}

export async function checkExternalIntegrations(db: Db = prisma): Promise<HealthCheck> {
  try {
    const grouped = await withTimeout(
      db.oAuthConnection.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      'external integrations check timed out',
    );
    const total = grouped.reduce((n, g) => n + g._count._all, 0);
    if (total === 0) {
      return {
        name: 'external_integrations',
        state: 'unconfigured',
        detail: 'no connected accounts',
      };
    }
    const bad = grouped
      .filter((g) => g.status === 'ERROR' || g.status === 'EXPIRED' || g.status === 'REVOKED')
      .reduce((n, g) => n + g._count._all, 0);
    return {
      name: 'external_integrations',
      state: bad === 0 ? 'ok' : 'degraded',
      detail: `${total} connected, ${bad} in error/expired`,
    };
  } catch (err) {
    return {
      name: 'external_integrations',
      state: 'down',
      detail: err instanceof Error ? err.message : 'query failed',
    };
  }
}

export async function checkWorker(db: Db = prisma): Promise<HealthCheck> {
  try {
    const fleet = await withTimeout(workerFleetHealth(db), 'worker check timed out');
    return {
      name: 'worker',
      state: fleet.health,
      detail:
        fleet.workers === 0
          ? 'no worker heartbeat on record'
          : `${fleet.workers} worker(s), newest beat ${Math.round((fleet.newestAgeMs ?? 0) / 1000)}s ago`,
    };
  } catch (err) {
    return {
      name: 'worker',
      state: 'down',
      detail: err instanceof Error ? err.message : 'query failed',
    };
  }
}

const RANK: Record<HealthState, number> = { ok: 0, unconfigured: 0, degraded: 1, down: 2 };

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: HealthCheck[];
  generatedAt: string;
}

export async function runHealthChecks(
  db: Db = prisma,
  opts: { deep?: boolean } = {},
): Promise<HealthReport> {
  const checks = await Promise.all([
    checkDatabase(db),
    checkRedis(),
    checkAiProviders(opts),
    checkExternalIntegrations(db),
    checkWorker(db),
  ]);
  const worst = checks.reduce((acc, c) => Math.max(acc, RANK[c.state]), 0);
  const status: HealthReport['status'] = worst === 2 ? 'down' : worst === 1 ? 'degraded' : 'ok';
  return { status, checks, generatedAt: new Date().toISOString() };
}
