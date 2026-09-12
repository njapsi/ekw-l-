import type { IntegrationProvider } from '@growth-agent/db';

/**
 * Normalized OAuth token payload. Providers map their own response shapes onto
 * this before it reaches `storeConnection` / `withFreshAccessToken`.
 */
export interface OAuthTokenResponse {
  access_token: string;
  /** seconds until the access token expires */
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Per-provider OAuth operations that the generic connection layer needs.
 * Concrete providers register themselves on import (see `google.ts`,
 * `tiktok-oauth.ts`).
 */
export interface ProviderOAuth {
  refresh(refreshToken: string, redirectUri: string): Promise<OAuthTokenResponse>;
  revoke(token: string): Promise<void>;
}

const registry = new Map<IntegrationProvider, ProviderOAuth>();

export function registerProviderOAuth(provider: IntegrationProvider, impl: ProviderOAuth): void {
  registry.set(provider, impl);
}

export function providerOAuth(provider: IntegrationProvider): ProviderOAuth {
  const impl = registry.get(provider);
  if (!impl) {
    throw new Error(
      `No OAuth implementation registered for "${provider}". Import its integration module first.`,
    );
  }
  return impl;
}

export function hasProviderOAuth(provider: IntegrationProvider): boolean {
  return registry.has(provider);
}
