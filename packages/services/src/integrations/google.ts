import { z } from 'zod';
import { registerProviderOAuth } from './oauth-token.js';

/**
 * Google OAuth 2.0 (Authorization Code). Only the scopes the product needs are
 * requested (master instruction: "Do not request unnecessary permissions").
 *   - youtube.readonly       : channel + video metadata / public stats
 *   - yt-analytics.readonly   : non-monetary analytics (views, watch time, subs…)
 * The monetary analytics scope is requested ONLY when the user explicitly opts
 * in to revenue data.
 */
export const YT_SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
export const YT_SCOPE_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const YT_SCOPE_ANALYTICS_MONETARY =
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';

/**
 * Search Console: read-only Search Console API (`webmasters.readonly`) plus
 * `openid` + `userinfo.email` so we can key the connection on the Google account
 * (its stable `sub` id) rather than on a property list that can change.
 */
export const GSC_SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GSC_SCOPE_OPENID = 'openid';
export const GSC_SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

export function searchConsoleScopes(): string[] {
  return [GSC_SCOPE_READONLY, GSC_SCOPE_OPENID, GSC_SCOPE_EMAIL];
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(redirectUri: string): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not configured.');
  }
  return { clientId, clientSecret, redirectUri };
}

export function youtubeScopes(includeRevenue: boolean): string[] {
  const scopes = [YT_SCOPE_READONLY, YT_SCOPE_ANALYTICS];
  if (includeRevenue) scopes.push(YT_SCOPE_ANALYTICS_MONETARY);
  return scopes;
}

export function buildAuthUrl(
  cfg: GoogleOAuthConfig,
  opts: { state: string; scopes: string[] },
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('access_type', 'offline'); // ask for a refresh token
  url.searchParams.set('prompt', 'consent'); // ensure a refresh token is returned
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type GoogleTokenResponse = z.infer<typeof TokenResponse>;

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

async function postForm(endpoint: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new GoogleOAuthError(
      `Non-JSON response from ${endpoint} (${res.status})`,
      res.status,
      text,
    );
  }
  if (!res.ok) {
    const errObj = json as { error?: string; error_description?: string };
    throw new GoogleOAuthError(
      errObj.error_description ?? errObj.error ?? `Token endpoint returned ${res.status}`,
      res.status,
      json,
    );
  }
  return json;
}

export async function exchangeCode(
  cfg: GoogleOAuthConfig,
  code: string,
): Promise<GoogleTokenResponse> {
  const json = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });
  const parsed = TokenResponse.safeParse(json);
  // Do NOT attach `json` — a near-miss response can still contain a real
  // access/refresh token, and error objects get logged (SECURITY-AUDIT.md M-3).
  if (!parsed.success)
    throw new GoogleOAuthError('Malformed token response', 200, {
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
  return parsed.data;
}

export async function refreshAccessToken(
  cfg: GoogleOAuthConfig,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  const json = await postForm(TOKEN_ENDPOINT, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success)
    throw new GoogleOAuthError('Malformed refresh response', 200, {
      issues: parsed.error.issues.map((i) => i.path.join('.')),
    });
  return parsed.data;
}

/** Best-effort upstream revocation. A failure here is logged, not fatal. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
}

registerProviderOAuth('YOUTUBE', {
  refresh: (refreshToken, redirectUri) =>
    refreshAccessToken(googleConfig(redirectUri), refreshToken),
  revoke: revokeToken,
});

// Search Console uses the same Google OAuth client + token endpoints.
registerProviderOAuth('GOOGLE_SEARCH_CONSOLE', {
  refresh: (refreshToken, redirectUri) =>
    refreshAccessToken(googleConfig(redirectUri), refreshToken),
  revoke: revokeToken,
});

/** Fetch the connected Google account's stable id + email (OpenID userinfo). */
export async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<{ sub: string; email: string | null }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new GoogleOAuthError(`userinfo endpoint returned ${res.status}`, res.status);
  }
  const json = (await res.json()) as { sub?: unknown; email?: unknown };
  if (typeof json.sub !== 'string' || !json.sub) {
    throw new GoogleOAuthError('userinfo response is missing "sub"', 200);
  }
  return { sub: json.sub, email: typeof json.email === 'string' ? json.email : null };
}
