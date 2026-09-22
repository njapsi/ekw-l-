import { missions } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List this organization's Growth Missions (Phase 10, §45). */
export async function GET() {
  const { org } = await requirePermission('mission.view');
  const rows = await missions.listMissions(org.id);
  return Response.json({ missions: rows });
}
