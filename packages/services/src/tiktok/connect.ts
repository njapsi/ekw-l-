import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { storeConnection } from '../integrations/connections.js';
import { signState, verifyState } from '../integrations/state.js';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  tiktokConfig,
  tiktokScopes,
  toOAuthTokenResponse,
} from '../integrations/tiktok-oauth.js';
import { DisplayTikTokClient } from './display-client.js';
import { ResilientTikTokClient } from './resilient-client.js';
import { discoverAccount } from './sync.js';

const log = createLogger('tiktok.connect');
const PROVIDER = 'tiktok';

/**
 * PKCE `code_verifier` is carried in a signed, short-lived value that the
 * connect route stores in an HttpOnly cookie and the callback reads back.
 * Signed with `AUTH_SECRET` so it cannot be forged.
 */
export function signPkce(verifier: string): string {
  const secret = process.env.AUTH_SECRET ?? '';
  const sig = createHmac('sha256', secret).update(verifier).digest('base64url');
  const payload = Buffer.from(JSON.stringify({ v: verifier, iat: Date.now() })).toString(
    'base64url',
  );
  return `${payload}.${sig}`;
}

export function readPkce(cookieValue: string): string {
  const [payload, sig] = cookieValue.split('.');
  if (!payload || !sig) throw new AppError('validation_failed', 'Malformed PKCE cookie.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    v: string;
    iat: number;
  };
  const secret = process.env.AUTH_SECRET ?? '';
  const expected = createHmac('sha256', secret).update(parsed.v).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('validation_failed', 'PKCE cookie signature is invalid.');
  }
  if (Date.now() - parsed.iat > 10 * 60 * 1000) {
    throw new AppError(
      'validation_failed',
      'The sign-in attempt expired. Please try connecting again.',
    );
  }
  return parsed.v;
}

export interface StartConnectResult {
  authUrl: string;
  /** Set this as an HttpOnly, 10-minute cookie; the callback needs it. */
  pkceCookie: string;
}

export function startTikTokConnect(input: {
  organizationId: string;
  userId: string;
  redirectUri: string;
  includePublish?: boolean;
}): StartConnectResult {
  const cfg = tiktokConfig(input.redirectUri);
  const pkce = createPkce();
  const state = signState({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: PROVIDER,
  });
  const authUrl = buildAuthUrl(cfg, {
    state,
    scopes: tiktokScopes(Boolean(input.includePublish)),
    codeChallenge: pkce.challenge,
  });
  return { authUrl, pkceCookie: signPkce(pkce.verifier) };
}

export async function completeTikTokConnect(
  input: {
    state: string;
    code: string;
    redirectUri: string;
    pkceCookie: string;
    /**
     * The id of the user whose browser is completing the callback — the flow is
     * bound to the session that started it (SECURITY-AUDIT.md H-1).
     */
    actingUserId: string;
  },
  db: Db = prisma,
): Promise<{ connectionId: string; organizationId: string; accountName: string }> {
  const state = verifyState(input.state);
  if (state.provider !== PROVIDER) {
    throw AppError.validation('OAuth state is for a different provider.');
  }
  if (state.userId !== input.actingUserId) {
    throw AppError.forbidden(
      'This sign-in does not match the account that started the connection.',
    );
  }
  const codeVerifier = readPkce(input.pkceCookie);

  const cfg = tiktokConfig(input.redirectUri);
  const tokens = await exchangeCode(cfg, input.code, codeVerifier);
  const grantedScopes = tokens.scope
    ? tokens.scope.split(/[\s,]+/).filter(Boolean)
    : tiktokScopes(false);
  const openId = tokens.open_id;

  // Identify the account with the fresh token.
  const bootstrap = new DisplayTikTokClient(tokens.access_token);
  const info = await bootstrap.getUserInfo();
  const externalAccountId = info.data.user.open_id ?? openId;
  if (!externalAccountId) {
    throw AppError.validation('TikTok did not return an account id for this login.');
  }

  const connection = await storeConnection(
    {
      organizationId: state.organizationId,
      userId: state.userId,
      provider: 'TIKTOK',
      externalAccountId,
      displayName: info.data.user.display_name ?? info.data.user.username ?? undefined,
      scopes: grantedScopes,
      tokens: toOAuthTokenResponse(tokens),
    },
    db,
  );

  const client = new ResilientTikTokClient(connection, input.redirectUri, db);
  const account = await discoverAccount(client, {
    db,
    organizationId: state.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  });

  log.info(
    { organizationId: state.organizationId, connectionId: connection.id },
    'TikTok connected',
  );
  return {
    connectionId: connection.id,
    organizationId: state.organizationId,
    accountName: account.displayName ?? account.username ?? account.openId,
  };
}
