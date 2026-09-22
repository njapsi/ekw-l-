import { missions } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The durable per-mission timeline (Phase 10, §25/§45) — an unknown/foreign
 *  mission id returns an empty list rather than an error, since the
 *  underlying query is itself tenant-scoped. */
export async function GET(_req: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const { org } = await requirePermission('mission.view');
  const events = await missions.listMissionEvents(org.id, missionId);
  return Response.json({ events });
}
