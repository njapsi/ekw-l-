import { type Db, type IntegrationProvider, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import {
  type ConnectionDiagnostic,
  type ConnectionState,
  type IntegrationKey,
  diagnoseConnection,
  resolveConnectionState,
} from './contract.js';
import {
  ConnectionUnavailableError,
  requireConnection,
  withFreshAccessToken,
} from './connections.js';
import { recordHealth } from './health.js';
import {
  IntegrationApiError,
  breakerFor,
  classifyHttpStatus,
  parseRetryAfter,
  withTimeout,
} from './resilience.js';

const log = createLogger('integrations.probe');

/**
 * On-demand connection testing (Phase 1, Part 9).
 *
 * Until now `IntegrationHealth` was only ever written as a side effect of a
 * sync, so a connection that had never synced showed "never checked" with no
 * way to check it. This makes a single real, read-only, cheapest-available
 * call against each provider and records the true outcome.
 *
 * It deliberately does NOT fabricate success: a provider that cannot be
 * reached produces a failed probe and a diagnostic explaining why.
 */

/** The cheapest read-only call that proves a token works, per provider. */
const PROBES: Record<IntegrationProvider, (accessToken: string) => Promise<void>> = {
  YOUTUBE: async (token) => {
    // 1 quota unit — the cheapest authenticated Data API call there is.
    await expectOk(
      fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  },
  GOOGLE_SEARCH_CONSOLE: async (token) => {
    await expectOk(
      fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  },
  TIKTOK: async (token) => {
    await expectOk(
      fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  },
};

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Turn a provider response into a thrown error carrying a useful, non-secret
 * message. The body is read because every one of these APIs puts the actual
 * reason (quota vs scope vs revoked) there rather than in the status text —
 * but only the first 300 characters are kept, and the caller scrubs it.
 */
async function expectOk(promise: Promise<Response>): Promise<void> {
  const res = await promise;
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // An unreadable error body is not itself an error — the status is enough.
    detail = '';
  }
  throw new IntegrationApiError(
    'probe',
    classifyHttpStatus(res.status),
    `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    res.status,
    parseRetryAfter(res.headers.get('retry-after')),
  );
}

export interface ProbeResult {
  ok: boolean;
  state: ConnectionState;
  diagnostic: ConnectionDiagnostic;
  checkedAt: Date;
}

/**
 * Test one connection and persist the result.
 *
 * Tenant scoping: `requireConnection` asserts the connection belongs to
 * `organizationId` before anything else happens.
 */
export async function testConnection(
  organizationId: string,
  connectionId: string,
  redirectUri: string,
  db: Db = prisma,
): Promise<ProbeResult> {
  const conn = await requireConnection(organizationId, connectionId, db);
  const key = conn.provider as IntegrationKey;
  const checkedAt = new Date();

  const probe = PROBES[conn.provider];
  if (!probe) {
    // No probe defined is a programming gap, not a user-facing failure —
    // report it honestly rather than claiming the connection is fine.
    return {
      ok: false,
      state: 'ERROR',
      diagnostic: diagnoseConnection({
        key,
        state: 'ERROR',
        connectionId,
        lastError: `No connection test is implemented for ${conn.provider}.`,
      }),
      checkedAt,
    };
  }

  try {
    await withFreshAccessToken(
      conn,
      redirectUri,
      // No retries: a connection test must report what happened, not paper
      // over it. The per-provider breaker still stops a user hammering a
      // provider that is already down.
      (accessToken) =>
        breakerFor(`probe:${conn.provider}`).run(() =>
          withTimeout(probe(accessToken), PROBE_TIMEOUT_MS, conn.provider),
        ),
      db,
    );

    await recordHealth(conn.id, { ok: true, detail: 'connection test passed' }, db);
    // Re-read so the reported state reflects any refresh that just happened.
    const fresh = await db.oAuthConnection.findUnique({
      where: { id: conn.id },
      select: { status: true, expiresAt: true, lastError: true, refreshTokenCipher: true },
    });
    const state = resolveConnectionState(
      fresh
        ? {
            status: fresh.status,
            expiresAt: fresh.expiresAt,
            lastError: fresh.lastError,
            hasRefreshToken: Boolean(fresh.refreshTokenCipher),
          }
        : null,
      { ok: true, detail: 'connection test passed', lastCheckAt: checkedAt },
      checkedAt,
    );
    return {
      ok: true,
      state,
      diagnostic: diagnoseConnection({ key, state, connectionId }),
      checkedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connection test failed';
    log.warn({ connectionId, provider: conn.provider }, 'connection test failed');
    await recordHealth(conn.id, { ok: false, detail: message }, db);

    // `withFreshAccessToken` already marks the row ERROR when a refresh fails;
    // an unrecoverable one means re-consent, everything else is degraded.
    const state: ConnectionState =
      err instanceof ConnectionUnavailableError ? 'REAUTH_REQUIRED' : 'DEGRADED';

    return {
      ok: false,
      state,
      diagnostic: diagnoseConnection({ key, state, connectionId, lastError: message }),
      checkedAt,
    };
  }
}
