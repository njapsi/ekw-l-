import { agent, isAppError, statusForCode } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One agent run's current status (Phase 4, Part 47) — for reconnect/poll
 * after an SSE connection drops, or for a background-executed run. */
export async function GET(_req: Request, { params }: { params: Promise<{ agentRunId: string }> }) {
  const { agentRunId } = await params;
  const { org } = await requirePermission('agent:run');
  try {
    const run = await agent.getAgentRun(org.id, agentRunId);
    return Response.json(run);
  } catch (e) {
    if (isAppError(e))
      return Response.json({ error: e.message }, { status: statusForCode(e.code) });
    throw e;
  }
}
