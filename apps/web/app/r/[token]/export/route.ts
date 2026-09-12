import { reports, security } from '@growth-agent/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = new Set(['pdf', 'csv', 'json']);

/**
 * Public export of a shared report. Serves the SAME redacted snapshot the
 * public page shows — never the private one.
 *
 * Hardened (PRODUCTION-READINESS.md H-1): unauthenticated + renders a PDF per
 * request, so it is per-IP rate-limited and — because a report snapshot is
 * immutable once READY — the response is cacheable, which collapses a repeat
 * download to a CDN hit.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const format = new URL(req.url).searchParams.get('format') ?? 'pdf';
  if (!FORMATS.has(format)) {
    return Response.json({ error: 'Unsupported format.' }, { status: 400 });
  }

  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({
    key: `report-export:${ip}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const shared = await reports.getReportForShare(token);
  if (!shared) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }

  const rendered = reports.renderExport(shared.snapshot, format as 'pdf' | 'csv' | 'json');
  const filename = reports.exportFilename(shared.snapshot, format as 'pdf' | 'csv' | 'json');

  return new Response(new Uint8Array(rendered.bytes), {
    headers: {
      'content-type': rendered.contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      // Browser-only, short — collapses a rapid repeat-download loop without
      // letting a CDN serve a revoked link. The per-IP limit is the real guard.
      'cache-control': 'private, max-age=60',
      'x-robots-tag': 'noindex',
    },
  });
}
