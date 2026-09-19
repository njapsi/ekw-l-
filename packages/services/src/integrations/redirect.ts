/**
 * OAuth redirect URIs for code running outside a request (the worker's sync
 * and token-lifecycle sweeps). Token *refresh* does not validate the redirect
 * URI, but the refresh helpers take one, and it must be the registered
 * callback — derived from the one canonical app URL, never from input.
 */
export function oauthRedirectUri(kind: 'google' | 'tiktok'): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/integrations/${kind}/callback`;
}

export function redirectKindFor(provider: string): 'google' | 'tiktok' {
  return provider === 'TIKTOK' ? 'tiktok' : 'google';
}
