import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type OAuthTokenResponse, registerProviderOAuth } from './oauth-token.js';

/**
 * TikTok Login Kit (OAuth 2.0 v2). We request only the scopes the product uses
 * (master instruction: "Do not request unnecessary permissions"). Publishing
 * scope is added only when the user opts into authorized publishing.
 *
 *   user.info.basic / user.info.profile / user.info.stats — profile + follower/
 *     like counts the Display API exposes
 *   video.list      — the user's own public video list + per-video fields
 *   video.publish   — Content Posting API "Direct Post" (opt-in only)
 */
export const TT_SCOPE_BASIC = 'user.info.basic';
export const TT_SCOPE_PROFILE = 'user.info.profile';
export const TT_SCOPE_STATS = 'user.info.stats';
export const TT_SCOPE_VIDEO_LIST = 'video.list';
export const TT_SCOPE_VIDEO_PUBLISH = 'video.publish';

const AUTH_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/revoke/';

export interface TikTokOAuthConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export function tiktokConfig(redirectUri: string): TikTokOAuthConfig {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not configured.');
  }
  return { clientKey, clientSecret, redirectUri };
}

export function tiktokScopes(includePublish: boolean): string[] {
  const scopes = [TT_SCOPE_BASIC, TT_SCOPE_PROFILE, TT_SCOPE_STATS, TT_SCOPE_VIDEO_LIST];
  if (includePublish) scopes.push(TT_SCOPE_VIDEO_PUBLISH);
  return scopes;
}

// --- PKCE --------------------------------------------------------------------

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(
  cfg: TikTokOAuthConfig,
  opts: { state: string; scopes: string[]; codeChallenge: string },
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_key', cfg.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(','));
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// --- token exchange / refresh ---------------------------------------------

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_expires_in: z.number().optional(),
  open_id: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TikTokTokenResponse = z.infer<typeof TokenResponse>;

export class TikTokOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'TikTokOAuthError';
  }
}

async function postForm(params: Record<string, string>): Promise<TikTokTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new TikTokOAuthError(
      `Non-JSON response from TikTok token endpoint (${res.status})`,
      res.status,
      text,
    );
  }
  // TikTok returns 200 with an `error` field on failure.
  const errObj = json as { error?: string; error_description?: string };
  if (!res.ok || errObj.error) {
    throw new TikTokOAuthError(
      errObj.error_description ?? errObj.error ?? `Token endpoint returned ${res.status}`,
      res.status,
      json,
    );
  }
  const parsed = TokenResponse.safeParse(json);
  // Do NOT attach `json` — it can still carry a real token (SECURITY-AUDIT.md M-3).
  if (!parsed.success)
    throw new TikTokOAuthError('Malformed token response', 200, {
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
  return parsed.data;
}

export function exchangeCode(
  cfg: TikTokOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TikTokTokenResponse> {
  return postForm({
    client_key: cfg.clientKey,
    client_secret: cfg.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshAccessToken(
  cfg: TikTokOAuthConfig,
  refreshToken: string,
): Promise<TikTokTokenResponse> {
  return postForm({
    client_key: cfg.clientKey,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export async function revokeToken(cfg: TikTokOAuthConfig, token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: cfg.clientKey,
      client_secret: cfg.clientSecret,
      token,
    }).toString(),
  });
}

/** Map TikTok's token response onto the generic shape. */
export function toOAuthTokenResponse(t: TikTokTokenResponse): OAuthTokenResponse {
  return {
    access_token: t.access_token,
    expires_in: t.expires_in,
    refresh_token: t.refresh_token,
    scope: t.scope,
  };
}

registerProviderOAuth('TIKTOK', {
  // Refresh does not need the redirect URI, but the interface passes it.
  refresh: async (refreshToken, redirectUri) =>
    toOAuthTokenResponse(await refreshAccessToken(tiktokConfig(redirectUri), refreshToken)),
  revoke: async (token) => {
    // Best effort — needs the app config; skip silently if unset.
    try {
      await revokeToken(tiktokConfig('http://unused'), token);
    } catch {
      /* logged by the caller */
    }
  },
});
