import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { buildAuthUrl, exchangeCode, googleConfig, youtubeScopes } from '../integrations/google.js';
import { signState, verifyState } from '../integrations/state.js';
import { storeConnection } from '../integrations/connections.js';
import { GoogleYouTubeClient } from './google-client.js';
import { ResilientYouTubeClient } from './resilient-client.js';
import { discoverChannels } from './sync.js';

const log = createLogger('youtube.connect');
const PROVIDER = 'youtube';

/** Step 1 — build the Google consent URL for this org + user. */
export function startYouTubeConnect(input: {
  organizationId: string;
  userId: string;
  redirectUri: string;
  includeRevenue?: boolean;
}): string {
  const cfg = googleConfig(input.redirectUri);
  const state = signState({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: PROVIDER,
  });
  return buildAuthUrl(cfg, { state, scopes: youtubeScopes(Boolean(input.includeRevenue)) });
}

/**
 * Step 2 — the OAuth callback. Verifies state, exchanges the code, discovers
 * the connected channel(s), and stores an encrypted connection scoped to the
 * organization named in the (signed) state — never a query parameter.
 */
export async function completeYouTubeConnect(
  input: {
    state: string;
    code: string;
    redirectUri: string;
    /**
     * The id of the user whose browser is completing the callback. The OAuth
     * flow is bound to the session that started it: a signed `state` alone is
     * not enough to attach a connected account (defends against OAuth-CSRF /
     * connection fixation — SECURITY-AUDIT.md H-1).
     */
    actingUserId: string;
  },
  db: Db = prisma,
): Promise<{ connectionId: string; organizationId: string; channelCount: number }> {
  const state = verifyState(input.state);
  if (state.provider !== PROVIDER)
    throw AppError.validation('OAuth state is for a different provider.');
  if (state.userId !== input.actingUserId)
    throw AppError.forbidden(
      'This sign-in does not match the account that started the connection.',
    );

  const cfg = googleConfig(input.redirectUri);
  const tokens = await exchangeCode(cfg, input.code);
  const grantedScopes = tokens.scope
    ? tokens.scope.split(/\s+/).filter(Boolean)
    : youtubeScopes(false);

  // Identify the channel with the freshly minted token (temporary client).
  const bootstrap = new GoogleYouTubeClient(tokens.access_token);
  const mine = await bootstrap.listMyChannels();
  const primary = mine.data.items[0];
  if (!primary) {
    throw AppError.validation(
      'That Google account does not have a YouTube channel we can access. Connect an account that owns a channel.',
    );
  }

  const connection = await storeConnection(
    {
      organizationId: state.organizationId,
      userId: state.userId,
      provider: 'YOUTUBE',
      externalAccountId: primary.id,
      displayName: primary.snippet.title || undefined,
      scopes: grantedScopes,
      tokens,
    },
    db,
  );

  const client = new ResilientYouTubeClient(connection, input.redirectUri, db);
  const channels = await discoverChannels(client, {
    db,
    organizationId: state.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  });

  log.info(
    {
      organizationId: state.organizationId,
      connectionId: connection.id,
      channels: channels.length,
    },
    'YouTube connected',
  );
  return {
    connectionId: connection.id,
    organizationId: state.organizationId,
    channelCount: channels.length,
  };
}
