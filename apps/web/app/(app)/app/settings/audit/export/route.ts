import type { NextRequest } from 'next/server';
import { audit, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pickCategory(v: string | null | undefined): audit.AuditCategory | undefined {
  return (audit.AUDIT_CATEGORIES as readonly string[]).includes(v ?? '')
    ? (v as audit.AuditCategory)
    : undefined;
}

function pickResult(v: string | null | undefined): 'SUCCESS' | 'FAILURE' | 'DENIED' | undefined {
  return v === 'SUCCESS' || v === 'FAILURE' || v === 'DENIED' ? v : undefined;
}

/** A YYYY-MM-DD filter value as a UTC bound; anything else is ignored. */
function utcDay(v: string | null | undefined, end: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T${end ? '23:59:59' : '00:00:00'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** CSV export of the audit log with the page's filters (ADMIN+ `audit.export`). */
export async function GET(req: NextRequest) {
  const { user, org } = await requirePermission('audit.export');
  const rl = await security.checkRateLimit({
    key: `audit-export:${org.id}`,
    limit: 5,
    windowSec: 600,
  });
  if (!rl.ok) {
    return Response.json({ error: 'Too many exports. Try again shortly.' }, { status: 429 });
  }
  const sp = req.nextUrl.searchParams;
  const { csv, truncated } = await audit.exportAuditCsv(user.id, org.id, {
    q: sp.get('q') || undefined,
    category: pickCategory(sp.get('category')),
    actorId: sp.get('actor') || undefined,
    result: pickResult(sp.get('result')),
    from: utcDay(sp.get('from'), false),
    to: utcDay(sp.get('to'), true),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'cache-control': 'no-store',
      ...(truncated ? { 'x-export-truncated': 'true' } : {}),
    },
  });
}
