import { agent } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dynamic capability discovery for this organization (Phase 5, Parts 9,
 * 102): every capability, grouped by integration, with a deterministic
 * ALLOW/DENY/REQUIRE_APPROVAL/REAUTH_REQUIRED/RATE_LIMITED/QUOTA_EXCEEDED/
 * UNAVAILABLE outcome and a concrete reason — never a bare "unavailable".
 */
export async function GET() {
  const { org } = await requirePermission('agent:run');
  const capabilities = await agent.discoverCapabilities(org.id);
  return Response.json({ capabilities });
}
