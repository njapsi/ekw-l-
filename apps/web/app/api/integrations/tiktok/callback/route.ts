import { NextResponse } from 'next/server';
import { security, tiktok } from '@growth-agent/services';
import { createLogger } from '@growth-agent/observability';
import { getSessionUser } from '@/lib/auth';
import { TIKTOK_PKCE_COOKIE, tiktokRedirectUri } from '@/lib/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('oauth.callback');

/**
 * TikTok OAuth callback. Bound to the session that started the flow
 * (`completeTikTokConnect` refuses a state whose `userId` is not the signed-in
 * user — SECURITY-AUDIT.md H-1) and rate-limited per IP (H-2).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const dest = new URL('/app/integrations/tiktok', url.origin);

  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({
    key: `oauth-callback:${ip}`,
    limit: 20,
    windowSec: 600,
  });
  if (!rl.ok) {
    dest.searchParams.set('error', 'rate_limited');
    return clearCookie(NextResponse.redirect(dest));
  }

  const err = url.searchParams.get('error');
  if (err) {
    dest.searchParams.set('error', err === 'access_denied' ? 'access_denied' : 'oauth_error');
    return clearCookie(NextResponse.redirect(dest));
  }

  const user = await getSessionUser().catch(() => null);
  if (!user?.id) {
    return clearCookie(NextResponse.redirect(new URL('/login', url.origin)));
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pkceCookie = req.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${TIKTOK_PKCE_COOKIE}=`))
    ?.slice(TIKTOK_PKCE_COOKIE.length + 1);

  if (!code || !state || !pkceCookie) {
    dest.searchParams.set('error', 'missing_params');
    return clearCookie(NextResponse.redirect(dest));
  }

  try {
    const result = await tiktok.completeTikTokConnect({
      code,
      state,
      actingUserId: user.id,
      pkceCookie: decodeURIComponent(pkceCookie),
      redirectUri: await tiktokRedirectUri(),
    });
    dest.searchParams.set('connected', '1');
    dest.searchParams.set('account', result.accountName);
    return clearCookie(NextResponse.redirect(dest));
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'TikTok OAuth callback failed');
    dest.searchParams.set(
      'error',
      e instanceof Error && /state|pkce|match the account/i.test(e.message)
        ? 'bad_state'
        : 'connect_failed',
    );
    return clearCookie(NextResponse.redirect(dest));
  }
}

function clearCookie(res: NextResponse): NextResponse {
  res.cookies.set(TIKTOK_PKCE_COOKIE, '', { path: '/api/integrations/tiktok', maxAge: 0 });
  return res;
}
