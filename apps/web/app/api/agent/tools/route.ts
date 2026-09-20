import { agent } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tool catalogue this organization's agent runtime can currently select
 * from (Phase 5, Part 102) — native + research tools plus this org's
 * enabled MCP tools. Read-only; never exposes a handler or a credential.
 */
export async function GET() {
  const { org } = await requirePermission('agent:run');
  const tools = await agent.listOrgToolMetadata(org.id);
  return Response.json({ tools });
}
