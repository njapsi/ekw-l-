import { knowledge } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Memory candidates awaiting review (Phase 11, §20-22). */
export async function GET(req: Request) {
  const { org } = await requirePermission('memory.view');
  const url = new URL(req.url);
  const status = (url.searchParams.get('status') ?? 'PENDING') as
    | 'PENDING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'AUTO_ACCEPTED'
    | 'SUPERSEDED';
  const candidates = await knowledge.listMemoryCandidates(org.id, status);
  return Response.json({ candidates });
}
