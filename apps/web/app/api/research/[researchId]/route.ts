import { isAppError, research, statusForCode } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One research project's live status, findings, and citations (Phase 11, §41-42). */
export async function GET(_req: Request, { params }: { params: Promise<{ researchId: string }> }) {
  const { researchId } = await params;
  const { org } = await requirePermission('research.view');
  try {
    const project = await research.getResearchProject(org.id, researchId);
    return Response.json(project);
  } catch (e) {
    if (isAppError(e)) return Response.json({ error: e.message }, { status: statusForCode(e.code) });
    throw e;
  }
}
