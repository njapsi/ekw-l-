import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { isAppError, security, usage, youtube } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { googleRedirectUri, youtubeConfigured } from '@/lib/youtube';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the YouTube OAuth flow. Only members who can manage integrations. */
export async function GET(req: Request) {
  const { user, org } = await requirePermission('integration:manage');

  const rl = await security.checkRateLimit({
    key: `oauth-connect:${user.id}`,
    limit: 15,
    windowSec: 600,
  });
  if (!rl.ok) {
    return NextResponse.redirect(new URL('/app/integrations/youtube?error=rate_limited', req.url));
  }

  if (!youtubeConfigured()) {
    return NextResponse.redirect(
      new URL('/app/integrations/youtube?error=not_configured', req.url),
    );
  }

  // Server-side plan limit — connecting an account is metered (ADR-0025).
  try {
    await usage.enforceUsage({ organizationId: org.id, meter: 'CONNECTED_ACCOUNTS', amount: 1 });
  } catch (e) {
    if (isAppError(e) && e.code === 'usage_limit_exceeded') {
      return NextResponse.redirect(
        new URL('/app/integrations/youtube?error=account_limit', req.url),
      );
    }
    throw e;
  }

  const includeRevenue = new URL(req.url).searchParams.get('revenue') === '1';
  const authUrl = youtube.startYouTubeConnect({
    organizationId: org.id,
    userId: user.id,
    redirectUri: await googleRedirectUri(),
    includeRevenue,
  });
  redirect(authUrl);
}
