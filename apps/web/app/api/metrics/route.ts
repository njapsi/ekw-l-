import { timingSafeEqual } from 'node:crypto';
import { observability } from '@growth-agent/services';
import { getSessionUser } from '@/lib/auth';
import { withRouteObservability } from '@/lib/observability';

/** Constant-time bearer-token comparison (SECURITY-AUDIT.md L-1). */
function bearerMatches(header: string | null, token: string | undefined): boolean {
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Prometheus text exposition of the web process's in-memory metrics registry
 * (request latency + error rate, AI calls, external API calls, …). Per-instance
 * and reset on deploy — a scraper turns it into history.
 *
 * Access: a `Bearer $METRICS_TOKEN` (for the scraper) or a platform-staff
 * session. Never public — series names + label cardinality are internal detail.
 */
export const GET = withRouteObservability('api.metrics', async (req: Request) => {
  const bearerOk = bearerMatches(req.headers.get('authorization'), process.env.METRICS_TOKEN);

  if (!bearerOk) {
    const user = await getSessionUser().catch(() => null);
    if (!user?.isPlatformStaff) {
      return new Response('forbidden\n', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      });
    }
  }

  return new Response(observability.renderProm(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
});
