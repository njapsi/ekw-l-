import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { isAppError, searchConsole, security, usage } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { googleRedirectUri, searchConsoleConfigured } from '@/lib/search-console';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the Search Console OAuth flow. Only members who can manage integrations. */
export async function GET(req: Request) {
  const { user, org } = await requirePermission('integration:manage');
  const dest = (q: string) =>
    NextResponse.redirect(new URL(`/app/integrations/search-console?${q}`, req.url));

  const rl = await security.checkRateLimit({
    key: `oauth-connect:${user.id}`,
    limit: 15,
    windowSec: 600,
  });
  if (!rl.ok) return dest('error=rate_limited');

  if (!searchConsoleConfigured()) return dest('error=not_configured');

  try {
    await usage.enforceUsage({ organizationId: org.id, meter: 'CONNECTED_ACCOUNTS', amount: 1 });
  } catch (e) {
    if (isAppError(e) && e.code === 'usage_limit_exceeded') return dest('error=account_limit');
    throw e;
  }

  const authUrl = searchConsole.startSearchConsoleConnect({
    organizationId: org.id,
    userId: user.id,
    redirectUri: await googleRedirectUri(),
  });
  redirect(authUrl);
}
