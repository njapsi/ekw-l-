import { NextResponse } from 'next/server';
import { isAppError, security, tiktok, usage } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { TIKTOK_PKCE_COOKIE, tiktokRedirectUri, tiktokConfigured } from '@/lib/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { user, org } = await requirePermission('integration:manage');

  const rl = await security.checkRateLimit({
    key: `oauth-connect:${user.id}`,
    limit: 15,
    windowSec: 600,
  });
  if (!rl.ok) {
    return NextResponse.redirect(new URL('/app/integrations/tiktok?error=rate_limited', req.url));
  }

  if (!tiktokConfigured()) {
    return NextResponse.redirect(new URL('/app/integrations/tiktok?error=not_configured', req.url));
  }

  // Server-side plan limit — connecting an account is metered (ADR-0025).
  try {
    await usage.enforceUsage({ organizationId: org.id, meter: 'CONNECTED_ACCOUNTS', amount: 1 });
  } catch (e) {
    if (isAppError(e) && e.code === 'usage_limit_exceeded') {
      return NextResponse.redirect(
        new URL('/app/integrations/tiktok?error=account_limit', req.url),
      );
    }
    throw e;
  }

  const includePublish = new URL(req.url).searchParams.get('publish') === '1';
  const { authUrl, pkceCookie } = tiktok.startTikTokConnect({
    organizationId: org.id,
    userId: user.id,
    redirectUri: await tiktokRedirectUri(),
    includePublish,
  });

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(TIKTOK_PKCE_COOKIE, pkceCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/integrations/tiktok',
    maxAge: 600,
  });
  return res;
}
