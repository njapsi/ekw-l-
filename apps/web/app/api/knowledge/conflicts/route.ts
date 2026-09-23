import { knowledge } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Open knowledge conflicts (Phase 11, §37). */
export async function GET(req: Request) {
  const { org } = await requirePermission('knowledge.view');
  const url = new URL(req.url);
  const status = (url.searchParams.get('status') ?? 'OPEN') as 'OPEN' | 'RESOLVED' | 'DISMISSED';
  const conflicts = await knowledge.listConflicts(org.id, status);
  return Response.json({ conflicts });
}
