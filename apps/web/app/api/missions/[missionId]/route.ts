import { isAppError, missions, statusForCode } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One mission's current status + plan (Phase 10, §45). */
export async function GET(_req: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const { org } = await requirePermission('mission.view');
  try {
    const detail = await missions.getMissionDetail(org.id, missionId);
    return Response.json(detail);
  } catch (e) {
    if (isAppError(e)) return Response.json({ error: e.message }, { status: statusForCode(e.code) });
    throw e;
  }
}
