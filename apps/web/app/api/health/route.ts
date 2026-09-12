import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness + readiness. Always returns 200 with a body describing each
 * dependency (database, Redis, AI provider, external integrations, worker) so a
 * load balancer can tell "process up" from "dependencies degraded". A hard gate
 * should treat `status !== "ok"` as unhealthy.
 *
 * `?deep=1` additionally makes one cheap authenticated request per configured
 * AI provider — restricted to platform staff so it cannot be used to probe or
 * to burn quota.
 *
 * Hardening (SECURITY-AUDIT.md H-2 / M-6): a generous per-IP rate limit backs
 * off a flood, and the non-deep report is memoised for a few seconds so a burst
 * cannot amplify into a burst of dependency probes.
 *
 * Every import this route needs is loaded dynamically, inside the try below
 * (Phase 27, docs/E2E-TESTING.md finding 1): `@growth-agent/services`'s boot
 * env validation (`config/env.ts`) throws at module-evaluation time on a
 * misconfigured deployment, and every one of these imports transitively
 * pulls that module in. A static top-level import here meant a bad config
 * poisoned this route with an uncaught 500 — the one response this endpoint
 * must never give, since its entire job is to stay diagnosable when
 * something else is broken. A load failure is now just another `checks[]`
 * entry in the normal 200 body.
 */
let cached: { at: number; body: unknown } | null = null;
const CACHE_MS = 4_000;

export async function GET(req: Request): Promise<Response> {
  let deps: {
    observability: typeof import('@growth-agent/services').observability;
    security: typeof import('@growth-agent/services').security;
    prisma: typeof import('@growth-agent/db').prisma;
    getSessionUser: typeof import('@/lib/auth').getSessionUser;
    withRouteObservability: typeof import('@/lib/observability').withRouteObservability;
  };
  try {
    const [services, db, auth, obs] = await Promise.all([
      import('@growth-agent/services'),
      import('@growth-agent/db'),
      import('@/lib/auth'),
      import('@/lib/observability'),
    ]);
    deps = {
      observability: services.observability,
      security: services.security,
      prisma: db.prisma,
      getSessionUser: auth.getSessionUser,
      withRouteObservability: obs.withRouteObservability,
    };
  } catch (e) {
    return NextResponse.json(
      {
        status: 'down',
        service: 'growth-agent-web',
        version: process.env.npm_package_version ?? '0.0.0',
        checks: [
          {
            name: 'config',
            state: 'down',
            detail: e instanceof Error ? e.message : 'failed to load application configuration',
          },
        ],
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  const { observability, security, prisma, getSessionUser, withRouteObservability } = deps;

  return withRouteObservability('api.health', async (req: Request) => {
    const ip = security.clientIpFrom(req.headers);
    const rl = await security.checkRateLimit({ key: `health:${ip}`, limit: 240, windowSec: 60 });
    if (!rl.ok) {
      return NextResponse.json(
        { status: 'degraded', error: 'rate_limited' },
        {
          status: 429,
          headers: { 'retry-after': String(rl.retryAfterSec), 'cache-control': 'no-store' },
        },
      );
    }

    const wantsDeep = new URL(req.url).searchParams.get('deep') === '1';
    let deep = false;
    if (wantsDeep) {
      const user = await getSessionUser().catch(() => null);
      deep = Boolean(user?.isPlatformStaff);
    }

    if (!deep && cached && Date.now() - cached.at < CACHE_MS) {
      return NextResponse.json(cached.body, { headers: { 'cache-control': 'no-store' } });
    }

    const report = await observability.runHealthChecks(prisma, { deep });
    const body = {
      status: report.status,
      service: 'growth-agent-web',
      version: process.env.npm_package_version ?? '0.0.0',
      checks: report.checks,
      timestamp: report.generatedAt,
    };
    if (!deep) cached = { at: Date.now(), body };

    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  })(req);
}
