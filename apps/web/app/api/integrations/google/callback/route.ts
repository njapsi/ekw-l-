import { NextResponse } from 'next/server';
import { integrations, searchConsole, security, youtube } from '@growth-agent/services';
import { createLogger } from '@growth-agent/observability';
import { getSessionUser } from '@/lib/auth';
import { googleRedirectUri } from '@/lib/youtube';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('oauth.callback');

/**
 * Shared Google OAuth 2.0 redirect target for YouTube AND Search Console. The
 * acting organization comes from the signed `state` (never a query param) and
 * the callback is bound to the session that started the flow — the
 * `complete*Connect` functions refuse a state whose `userId` is not the
 * signed-in user (SECURITY-AUDIT.md H-1). Per-IP rate-limited (H-2). The
 * provider is read from the (verified) state so one registered redirect URI
 * serves both flows.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const ytDest = new URL('/app/integrations/youtube', origin);
  const gscDest = new URL('/app/integrations/search-console', origin);
  let dest = ytDest;

  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({
    key: `oauth-callback:${ip}`,
    limit: 20,
    windowSec: 600,
  });
  if (!rl.ok) {
    dest.searchParams.set('error', 'rate_limited');
    return NextResponse.redirect(dest);
  }

  const oauthError = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // Route the redirect (and errors) to the right integration page as early as
  // possible by peeking the verified state's provider.
  let provider: string | null = null;
  if (state) {
    try {
      provider = integrations.verifyState(state).provider;
    } catch {
      provider = null;
    }
  }
  if (provider === searchConsole.GSC_PROVIDER_STATE) dest = gscDest;

  if (oauthError) {
    dest.searchParams.set(
      'error',
      oauthError === 'access_denied' ? 'access_denied' : 'oauth_error',
    );
    return NextResponse.redirect(dest);
  }

  const user = await getSessionUser().catch(() => null);
  if (!user?.id) return NextResponse.redirect(new URL('/login', origin));

  if (!code || !state) {
    dest.searchParams.set('error', 'missing_params');
    return NextResponse.redirect(dest);
  }

  const redirectUri = await googleRedirectUri();
  try {
    if (provider === searchConsole.GSC_PROVIDER_STATE) {
      const result = await searchConsole.completeSearchConsoleConnect({
        code,
        state,
        actingUserId: user.id,
        redirectUri,
      });
      gscDest.searchParams.set('connected', '1');
      gscDest.searchParams.set('properties', String(result.propertyCount));
      return NextResponse.redirect(gscDest);
    }
    const result = await youtube.completeYouTubeConnect({
      code,
      state,
      actingUserId: user.id,
      redirectUri,
    });
    ytDest.searchParams.set('connected', '1');
    ytDest.searchParams.set('channels', String(result.channelCount));
    return NextResponse.redirect(ytDest);
  } catch (err) {
    // Message only — a provider error object can carry a token-bearing body on a
    // malformed response (SECURITY-AUDIT.md M-3).
    log.warn(
      { err: err instanceof Error ? err.message : String(err), provider },
      'Google OAuth callback failed',
    );
    dest.searchParams.set(
      'error',
      err instanceof Error && /state|match the account/i.test(err.message)
        ? 'bad_state'
        : 'connect_failed',
    );
    return NextResponse.redirect(dest);
  }
}
