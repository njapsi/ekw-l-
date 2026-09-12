import { reports, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = new Set(['pdf', 'csv', 'json']);

/** Authenticated export of a report the caller's org owns (`report:read`). */
export async function GET(req: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const { org, user } = await requirePermission('report:read');
  const format = new URL(req.url).searchParams.get('format') ?? 'pdf';
  if (!FORMATS.has(format)) {
    return Response.json({ error: 'Unsupported format.' }, { status: 400 });
  }

  const rl = await security.checkRateLimit({
    key: `report-export:${org.id}:${user.id}`,
    limit: 60,
    windowSec: 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const report = await reports.getReport(org.id, reportId);
  if (!report || report.status !== 'READY' || !report.snapshot) {
    return Response.json({ error: 'Report not found or not ready.' }, { status: 404 });
  }

  const rendered = reports.renderExport(report.snapshot, format as 'pdf' | 'csv' | 'json');
  const filename = reports.exportFilename(report.snapshot, format as 'pdf' | 'csv' | 'json');

  return new Response(new Uint8Array(rendered.bytes), {
    headers: {
      'content-type': rendered.contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=60',
    },
  });
}
