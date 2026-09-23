import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Readiness (Phase 12): unlike `/api/health` (deliberately liveness-only,
 * always 200 — see that route's own comment and Dockerfile.web/
 * docker-compose's HEALTHCHECK, which depend on that exact contract and are
 * NOT changed here), this endpoint returns a REAL non-200 status when a
 * dependency is down. It exists for a caller that gates on the HTTP status
 * code alone rather than parsing the JSON body — a Kubernetes
 * `readinessProbe`, an external uptime monitor, or a load balancer's health
 * check — none of which exist in this deployment's current single-host
 * Docker Compose setup, but the gap was real: nothing in this app has ever
 * returned a non-200 for "a dependency is down," only the always-200 body's
 * `status` field said so. Shares the same rate limit bucket prefix and
 * `runHealthChecks` logic as `/api/health` — no new health-check
 * implementation, just a stricter HTTP-status mapping of the existing one.
 */
export async function GET(req: Request): Promise<Response> {
  let deps: {
    observability: typeof import('@growth-agent/services').observability;
    security: typeof import('@growth-agent/services').security;
    prisma: typeof import('@growth-agent/db').prisma;
  };
  try {
    const [services, db] = await Promise.all([
      import('@growth-agent/services'),
      import('@growth-agent/db'),
    ]);
    deps = { observability: services.observability, security: services.security, prisma: db.prisma };
  } catch (e) {
    // Config failed to load — definitely not ready.
    return NextResponse.json(
      { status: 'down', detail: e instanceof Error ? e.message : 'failed to load application configuration' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const { observability, security, prisma } = deps;
  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({ key: `health:${ip}`, limit: 240, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { status: 'degraded', error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec), 'cache-control': 'no-store' } },
    );
  }

  const report = await observability.runHealthChecks(prisma, { deep: false });
  const body = { status: report.status, checks: report.checks, timestamp: report.generatedAt };
  // "degraded" still serves traffic (matches /api/health's own status
  // vocabulary) — only "down" fails a readiness gate.
  const httpStatus = report.status === 'down' ? 503 : 200;
  return NextResponse.json(body, { status: httpStatus, headers: { 'cache-control': 'no-store' } });
}
