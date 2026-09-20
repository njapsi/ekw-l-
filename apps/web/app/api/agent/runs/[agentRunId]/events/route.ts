import { agent } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The durable per-step timeline for one agent run (Phase 4, Part 3/47) —
 * independent of the live SSE stream, so a run's history survives a page
 * reload or a reconnect. Tenant-scoped; an unknown/foreign run id returns
 * an empty list rather than an error (the list query itself is scoped). */
export async function GET(_req: Request, { params }: { params: Promise<{ agentRunId: string }> }) {
  const { agentRunId } = await params;
  const { org } = await requirePermission('agent:run');
  const events = await agent.listAgentRunEvents(org.id, agentRunId);
  return Response.json({ events });
}
