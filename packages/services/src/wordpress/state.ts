import type { WordPressSite } from '@growth-agent/db';
import { type ConnectionState, resolveConnectionState } from '../integrations/contract.js';

type SiteStateInput = Pick<WordPressSite, 'status' | 'lastError' | 'lastCheckAt' | 'lastCheckOk'>;

/**
 * Unified state for a WordPress site. Application passwords never expire and
 * cannot be refreshed, so `hasRefreshToken` is always false: a rejected
 * credential (stored as EXPIRED) is REAUTH_REQUIRED, the honest answer —
 * only the user can issue a new one.
 */
export function wordPressState(site: SiteStateInput, now: Date = new Date()): ConnectionState {
  return resolveConnectionState(
    { status: site.status, expiresAt: null, lastError: site.lastError, hasRefreshToken: false },
    site.lastCheckOk === null || site.lastCheckAt === null
      ? null
      : { ok: site.lastCheckOk, detail: site.lastError, lastCheckAt: site.lastCheckAt },
    now,
  );
}
