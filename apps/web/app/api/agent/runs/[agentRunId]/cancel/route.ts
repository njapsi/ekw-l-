import { agent, isAppError, statusForCode } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stop an in-progress agent run (Phase 4, Part 20/47). Independently
 * re-verifies ownership and the run's current status server-side — never
 * trusts the client's belief that a run is still running (Part 49).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ agentRunId: string }> }) {
  const { agentRunId } = await params;
  const { user, org } = await requirePermission('agent:run');
  try {
    const result = await agent.cancelAgentRun({
      organizationId: org.id,
      userId: user.id,
      agentRunId,
    });
    return Response.json(result);
  } catch (e) {
    if (isAppError(e))
      return Response.json({ error: e.message }, { status: statusForCode(e.code) });
    throw e;
  }
}
