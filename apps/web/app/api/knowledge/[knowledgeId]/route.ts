import { isAppError, knowledge, statusForCode } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One knowledge item, with its evidence and source (Phase 11, §40). */
export async function GET(_req: Request, { params }: { params: Promise<{ knowledgeId: string }> }) {
  const { knowledgeId } = await params;
  const { org } = await requirePermission('knowledge.view');
  try {
    const item = await knowledge.getKnowledgeItem(org.id, knowledgeId);
    const relations = await knowledge.listRelationsFor(org.id, knowledgeId);
    return Response.json({ item, relations });
  } catch (e) {
    if (isAppError(e)) return Response.json({ error: e.message }, { status: statusForCode(e.code) });
    throw e;
  }
}
