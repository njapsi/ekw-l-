import { organizations, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DSR data export (FORENSIC-AUDIT M-2). Streams a single JSON document with
 * every row this organization owns. ADMIN+ only; per-org rate-limited because
 * it is an expensive full-tenant read.
 */
export async function GET() {
  const { org } = await requirePermission('org:update');

  const rl = await security.checkRateLimit({
    key: `org-export:${org.id}`,
    limit: 3,
    windowSec: 600,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'An export was requested recently. Please wait a few minutes.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  const data = await organizations.exportOrganizationData(org.id);
  const body = organizations.serializeExport(data);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `growth-agent-export-${org.slug}-${stamp}.json`;

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}
