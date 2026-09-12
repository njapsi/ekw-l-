import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TT_SCOPE_VIDEO_PUBLISH,
  TikTokOAuthError,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  refreshAccessToken,
  tiktokConfig,
  tiktokScopes,
} from './tiktok-oauth.js';

beforeEach(() => {
  process.env.TIKTOK_CLIENT_KEY = 'ck_test';
  process.env.TIKTOK_CLIENT_SECRET = 'cs_test';
});
afterEach(() => vi.unstubAllGlobals());

describe('tiktok oauth', () => {
  it('requests only the minimal scopes unless publishing is opted in', () => {
    expect(tiktokScopes(false)).not.toContain(TT_SCOPE_VIDEO_PUBLISH);
    expect(tiktokScopes(true)).toContain(TT_SCOPE_VIDEO_PUBLISH);
  });

  it('builds an auth URL with PKCE S256 and comma-joined scopes', () => {
    const pkce = createPkce();
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    const url = new URL(
      buildAuthUrl(tiktokConfig('https://app/cb'), {
        state: 'st',
        scopes: tiktokScopes(false),
        codeChallenge: pkce.challenge,
      }),
    );
    expect(url.searchParams.get('client_key')).toBe('ck_test');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(
      'user.info.basic,user.info.profile,user.info.stats,video.list',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a code and normalizes the token payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'act_1',
              expires_in: 86400,
              refresh_token: 'ref_1',
              refresh_expires_in: 31536000,
              open_id: 'open_123',
              scope: 'user.info.basic,video.list',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const t = await exchangeCode(tiktokConfig('https://app/cb'), 'code', 'verifier');
    expect(t.access_token).toBe('act_1');
    expect(t.open_id).toBe('open_123');
  });

  it('treats a 200 with an error field as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(refreshAccessToken(tiktokConfig('https://app/cb'), 'ref')).rejects.toBeInstanceOf(
      TikTokOAuthError,
    );
  });
});
