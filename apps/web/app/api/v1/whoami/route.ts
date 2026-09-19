import { prisma } from '@growth-agent/db';
import { json, withApiKey } from '@/lib/api-key-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which organization and scopes the presented key resolves to. */
export const GET = withApiKey(null, async (_req, principal) => {
  const org = await prisma.organization.findUnique({
    where: { id: principal.organizationId },
    select: { id: true, name: true, slug: true },
  });
  return json({ organization: org, keyId: principal.keyId, scopes: principal.scopes });
});
