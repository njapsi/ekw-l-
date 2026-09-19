import { integrations } from '@growth-agent/services';
import { json, withApiKey } from '@/lib/api-key-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection state + usable capabilities for the key's organization. Never credentials. */
export const GET = withApiKey('integrations:read', async (_req, principal) => {
  const entries = await integrations.getConnectionCenter(principal.organizationId);
  return json({
    connections: entries
      .filter((e) => e.descriptor.implemented)
      .map((e) => ({
        integration: e.descriptor.key,
        state: e.state,
        configured: e.configured,
        account: e.accountLabel,
        lastSuccessfulSyncAt: e.sync.lastSuccessAt?.toISOString() ?? null,
        capabilities: e.capabilities.map((c) => ({ id: c.id, level: c.level, usable: c.usable })),
      })),
  });
});
