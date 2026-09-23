import { research } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List this organization's research projects (Phase 11, §41). */
export async function GET(req: Request) {
  const { org } = await requirePermission('research.view');
  const url = new URL(req.url);
  const rows = await research.listResearchProjects(org.id, {
    status: url.searchParams.get('status') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 30),
  });
  return Response.json({ projects: rows });
}
