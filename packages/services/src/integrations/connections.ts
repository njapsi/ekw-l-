import {
  type ConnectionStatus,
  type Db,
  type IntegrationProvider,
  type OAuthConnection,
  prisma,
} from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { open, seal } from '../crypto/tokens.js';
import { type OAuthTokenResponse, hasProviderOAuth, providerOAuth } from './oauth-token.js';

const log = createLogger('integrations');

export class ConnectionUnavailableError extends AppError {
  constructor(message: string) {
    super('provider_unavailable', message);
    this.name = 'ConnectionUnavailableError';
  }
}

export interface DecryptedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

function decrypt(conn: OAuthConnection): DecryptedTokens {
  const accessToken = open({
    cipher: conn.accessTokenCipher,
    iv: conn.tokenIv,
    authTag: conn.tokenAuthTag,
    keyId: conn.keyId,
  });
  let refreshToken: string | null = null;
  if (conn.refreshTokenCipher && conn.refreshIv && conn.refreshAuthTag) {
    refreshToken = open({
      cipher: conn.refreshTokenCipher,
      iv: conn.refreshIv,
      authTag: conn.refreshAuthTag,
      keyId: conn.keyId,
    });
  }
  return { accessToken, refreshToken, expiresAt: conn.expiresAt };
}

function sealTokens(tokens: OAuthTokenResponse) {
  const access = seal(tokens.access_token);
  const refresh = tokens.refresh_token ? seal(tokens.refresh_token) : null;
  return {
    accessTokenCipher: access.cipher,
    tokenIv: access.iv,
    tokenAuthTag: access.authTag,
    keyId: access.keyId,
    refreshTokenCipher: refresh?.cipher ?? null,
    refreshIv: refresh?.iv ?? null,
    refreshAuthTag: refresh?.authTag ?? null,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

export interface StoreConnectionInput {
  organizationId: string;
  userId: string;
  provider: IntegrationProvider;
  externalAccountId: string;
  displayName?: string;
  scopes: string[];
  tokens: OAuthTokenResponse;
}

/**
 * Upsert a connection after a successful OAuth exchange. If a connection for the
 * same external account already exists it is re-activated with the new tokens
 * (a re-consent flow). A refresh token is only overwritten when Google returns
 * a new one.
 */
export async function storeConnection(
  input: StoreConnectionInput,
  db: Db = prisma,
): Promise<OAuthConnection> {
  const sealed = sealTokens(input.tokens);
  const existing = await db.oAuthConnection.findUnique({
    where: {
      organizationId_provider_externalAccountId: {
        organizationId: input.organizationId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
      },
    },
  });

  const data = {
    displayName: input.displayName,
    scopes: input.scopes,
    accessTokenCipher: sealed.accessTokenCipher,
    tokenIv: sealed.tokenIv,
    tokenAuthTag: sealed.tokenAuthTag,
    keyId: sealed.keyId,
    expiresAt: sealed.expiresAt,
    status: 'ACTIVE' as ConnectionStatus,
    lastError: null,
    lastRefreshedAt: new Date(),
    ...(sealed.refreshTokenCipher
      ? {
          refreshTokenCipher: sealed.refreshTokenCipher,
          refreshIv: sealed.refreshIv,
          refreshAuthTag: sealed.refreshAuthTag,
        }
      : {}),
  };

  const conn = existing
    ? await db.oAuthConnection.update({ where: { id: existing.id }, data })
    : await db.oAuthConnection.create({
        data: {
          organizationId: input.organizationId,
          provider: input.provider,
          externalAccountId: input.externalAccountId,
          createdById: input.userId,
          ...data,
          refreshTokenCipher: sealed.refreshTokenCipher,
          refreshIv: sealed.refreshIv,
          refreshAuthTag: sealed.refreshAuthTag,
        },
      });

  await db.integrationHealth.upsert({
    where: { oauthConnectionId: conn.id },
    update: { ok: true, detail: 'connected', lastCheckAt: new Date() },
    create: { oauthConnectionId: conn.id, ok: true, detail: 'connected' },
  });

  await recordAudit({
    organizationId: input.organizationId,
    actorId: input.userId,
    action: existing ? 'integration.reconnected' : 'integration.connected',
    targetType: 'oauth_connection',
    targetId: conn.id,
    metadata: { provider: input.provider, scopes: input.scopes },
  });

  return conn;
}

export async function listConnections(organizationId: string, db: Db = prisma) {
  return db.oAuthConnection.findMany({
    where: { organizationId },
    include: { health: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getConnectionForOrg(
  organizationId: string,
  provider: IntegrationProvider,
  db: Db = prisma,
) {
  return db.oAuthConnection.findFirst({
    where: { organizationId, provider },
    include: { health: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** Fetch a connection and assert it belongs to the caller's organization. */
export async function requireConnection(
  organizationId: string,
  connectionId: string,
  db: Db = prisma,
): Promise<OAuthConnection> {
  const conn = await db.oAuthConnection.findUnique({ where: { id: connectionId } });
  if (!conn || conn.organizationId !== organizationId) throw AppError.notFound('Connection');
  return conn;
}

const REFRESH_SKEW_MS = 60_000;

/**
 * Provide a valid access token to `fn`, refreshing and persisting first if the
 * current one is expired or about to be. On an unrecoverable refresh failure
 * the connection is marked `ERROR` and `ConnectionUnavailableError` is thrown.
 */
export async function withFreshAccessToken<T>(
  connection: OAuthConnection,
  redirectUri: string,
  fn: (accessToken: string) => Promise<T>,
  db: Db = prisma,
): Promise<T> {
  if (connection.status === 'REVOKED') {
    throw new ConnectionUnavailableError(
      'This account has been disconnected. Reconnect it to continue.',
    );
  }

  let tokens = decrypt(connection);
  const needsRefresh =
    !tokens.accessToken ||
    !tokens.expiresAt ||
    tokens.expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS ||
    connection.status === 'EXPIRED' ||
    connection.status === 'ERROR';

  if (needsRefresh) {
    if (!tokens.refreshToken) {
      await db.oAuthConnection.update({
        where: { id: connection.id },
        data: { status: 'ERROR', lastError: 'No refresh token; reconnection required.' },
      });
      throw new ConnectionUnavailableError('Reconnect this account — its access has expired.');
    }
    try {
      const refreshed = await providerOAuth(connection.provider).refresh(
        tokens.refreshToken,
        redirectUri,
      );
      const sealed = sealTokens(refreshed);
      await db.oAuthConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenCipher: sealed.accessTokenCipher,
          tokenIv: sealed.tokenIv,
          tokenAuthTag: sealed.tokenAuthTag,
          keyId: sealed.keyId,
          expiresAt: sealed.expiresAt,
          status: 'ACTIVE',
          lastError: null,
          lastRefreshedAt: new Date(),
          ...(sealed.refreshTokenCipher
            ? {
                refreshTokenCipher: sealed.refreshTokenCipher,
                refreshIv: sealed.refreshIv,
                refreshAuthTag: sealed.refreshAuthTag,
              }
            : {}),
        },
      });
      tokens = {
        accessToken: refreshed.access_token,
        refreshToken: tokens.refreshToken,
        expiresAt: sealed.expiresAt,
      };
      log.info({ connectionId: connection.id }, 'refreshed access token');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'refresh failed';
      await db.oAuthConnection.update({
        where: { id: connection.id },
        data: { status: 'ERROR', lastError: message },
      });
      await db.integrationHealth.updateMany({
        where: { oauthConnectionId: connection.id },
        data: { ok: false, detail: `token refresh failed: ${message}`, lastCheckAt: new Date() },
      });
      throw new ConnectionUnavailableError(
        'Could not refresh access to this account. Please reconnect it.',
      );
    }
  }

  return fn(tokens.accessToken);
}

export async function disconnectConnection(
  organizationId: string,
  connectionId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const conn = await requireConnection(organizationId, connectionId, db);

  try {
    const { refreshToken, accessToken } = decrypt(conn);
    if (hasProviderOAuth(conn.provider)) {
      await providerOAuth(conn.provider).revoke(refreshToken ?? accessToken);
    }
  } catch (err) {
    log.warn({ err, connectionId }, 'upstream token revocation failed (continuing)');
  }

  await db.oAuthConnection.update({
    where: { id: conn.id },
    data: {
      status: 'REVOKED',
      accessTokenCipher: '',
      tokenIv: '',
      tokenAuthTag: '',
      refreshTokenCipher: null,
      refreshIv: null,
      refreshAuthTag: null,
      lastError: null,
    },
  });
  await db.integrationHealth.updateMany({
    where: { oauthConnectionId: conn.id },
    data: { ok: false, detail: 'disconnected', lastCheckAt: new Date() },
  });

  await recordAudit({
    organizationId,
    actorId: userId,
    action: 'integration.disconnected',
    targetType: 'oauth_connection',
    targetId: conn.id,
    metadata: { provider: conn.provider },
  });
}
