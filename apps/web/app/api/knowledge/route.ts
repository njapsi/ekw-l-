import { knowledge } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List this organization's knowledge items (Phase 11, §63). */
export async function GET(req: Request) {
  const { org } = await requirePermission('knowledge.view');
  const url = new URL(req.url);
  const result = await knowledge.listKnowledgeItems(org.id, {
    type: url.searchParams.get('type') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    scope: url.searchParams.get('scope') ?? undefined,
    classification: url.searchParams.get('classification') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 50),
  });
  return Response.json(result);
}
