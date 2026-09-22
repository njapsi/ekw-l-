import { missions } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current/previous/target/trend for every metric this mission tracks
 *  (Phase 10, §9/§45). */
export async function GET(_req: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const { org } = await requirePermission('mission.view');
  const progress = await missions.getMissionMetricProgress(org.id, missionId);
  return Response.json({ metrics: progress });
}
