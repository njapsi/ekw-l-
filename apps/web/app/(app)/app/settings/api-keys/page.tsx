import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiKeys, can, rbac } from '@growth-agent/services';
import { ApiKeysPanel } from '@/components/app/settings/api-keys-panel';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'API keys · Settings' };

export default async function ApiKeysSettingsPage() {
  const { user, org } = await requireActiveOrg();
  if (!can(org.role, 'api_key.view')) redirect('/app/settings');
  const keys = await apiKeys.listApiKeys(user.id, org.id);
  const grantable = apiKeys.API_SCOPES.filter((s) =>
    rbac.roleHasPermission(org.role, apiKeys.SCOPE_PERMISSION[s]),
  );
  return (
    <ApiKeysPanel
      keys={keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
      }))}
      grantableScopes={[...grantable]}
      canCreate={can(org.role, 'api_key.create')}
      canRevoke={can(org.role, 'api_key.revoke')}
    />
  );
}
