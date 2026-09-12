import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchGoogleUserInfo,
  googleConfig,
  searchConsoleScopes,
} from '../integrations/google.js';
import { signState, verifyState } from '../integrations/state.js';
import { storeConnection } from '../integrations/connections.js';
import { syncProperties } from './sites.js';

const log = createLogger('searchconsole.connect');
export const GSC_PROVIDER_STATE = 'google_search_console';

/** Step 1 — build the Google consent URL for a Search Console connection. */
export function startSearchConsoleConnect(input: {
  organizationId: string;
  userId: string;
  redirectUri: string;
}): string {
  const cfg = googleConfig(input.redirectUri);
  const state = signState({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: GSC_PROVIDER_STATE,
  });
  return buildAuthUrl(cfg, { state, scopes: searchConsoleScopes() });
}

/**
 * Step 2 — the OAuth callback branch for Search Console. Verifies the signed
 * state (provider + session bind, same as YouTube — SECURITY-AUDIT H-1),
 * exchanges the code, identifies the Google account via OpenID userinfo, stores
 * an encrypted connection scoped to the org named in the state, and discovers
 * the account's properties.
 */
export async function completeSearchConsoleConnect(
  input: { state: string; code: string; redirectUri: string; actingUserId: string },
  db: Db = prisma,
): Promise<{ connectionId: string; organizationId: string; propertyCount: number }> {
  const state = verifyState(input.state);
  if (state.provider !== GSC_PROVIDER_STATE) {
    throw AppError.validation('OAuth state is for a different provider.');
  }
  if (state.userId !== input.actingUserId) {
    throw AppError.forbidden(
      'This sign-in does not match the account that started the connection.',
    );
  }

  const cfg = googleConfig(input.redirectUri);
  const tokens = await exchangeCode(cfg, input.code);
  const grantedScopes = tokens.scope
    ? tokens.scope.split(/\s+/).filter(Boolean)
    : searchConsoleScopes();

  const userInfo = await fetchGoogleUserInfo(tokens.access_token);

  const connection = await storeConnection(
    {
      organizationId: state.organizationId,
      userId: state.userId,
      provider: 'GOOGLE_SEARCH_CONSOLE',
      externalAccountId: userInfo.sub,
      displayName: userInfo.email ?? 'Google account',
      scopes: grantedScopes,
      tokens,
    },
    db,
  );

  let propertyCount = 0;
  try {
    propertyCount = await syncProperties(connection, input.redirectUri, db);
  } catch (err) {
    // The connection is stored; property discovery can be retried from the UI.
    log.warn(
      { connectionId: connection.id, err: err instanceof Error ? err.message : String(err) },
      'property discovery failed on connect (connection kept)',
    );
  }

  log.info(
    { organizationId: state.organizationId, connectionId: connection.id, propertyCount },
    'Search Console connected',
  );
  return { connectionId: connection.id, organizationId: state.organizationId, propertyCount };
}
