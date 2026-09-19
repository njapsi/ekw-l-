import { describe, expect, it } from 'vitest';
import {
  APPROVAL_POLICY,
  INTEGRATIONS,
  actionFor,
  diagnoseConnection,
  isUsable,
  requiresApproval,
  resolveCapabilities,
  resolveConnectionState,
  type ConnectionStateInput,
  type IntegrationKey,
} from './contract.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const FUTURE = new Date('2026-09-19T13:00:00.000Z');
const PAST = new Date('2026-09-19T11:00:00.000Z');

function conn(overrides: Partial<ConnectionStateInput> = {}): ConnectionStateInput {
  return {
    status: 'ACTIVE',
    expiresAt: FUTURE,
    lastError: null,
    hasRefreshToken: true,
    ...overrides,
  };
}

describe('resolveConnectionState', () => {
  it('reports NOT_CONNECTED when there is no connection row', () => {
    expect(resolveConnectionState(null, null, NOW)).toBe('NOT_CONNECTED');
  });

  it('reports CONNECTED for a healthy, unexpired connection', () => {
    expect(resolveConnectionState(conn(), { ok: true, detail: null, lastCheckAt: PAST }, NOW)).toBe(
      'CONNECTED',
    );
  });

  it('treats an absent health row as connected rather than degraded', () => {
    // Never-probed is unknown, not broken — inventing DEGRADED here would show
    // users a warning for a connection that has simply not been checked yet.
    expect(resolveConnectionState(conn(), null, NOW)).toBe('CONNECTED');
  });

  it('reports DEGRADED when the last health probe failed', () => {
    expect(
      resolveConnectionState(conn(), { ok: false, detail: 'quota', lastCheckAt: PAST }, NOW),
    ).toBe('DEGRADED');
  });

  it('reports DISCONNECTED for a revoked connection', () => {
    expect(resolveConnectionState(conn({ status: 'REVOKED' }), null, NOW)).toBe('DISCONNECTED');
  });

  it('reports ERROR for an errored connection', () => {
    expect(resolveConnectionState(conn({ status: 'ERROR' }), null, NOW)).toBe('ERROR');
  });

  it('splits EXPIRED from REAUTH_REQUIRED on whether a refresh token exists', () => {
    expect(resolveConnectionState(conn({ status: 'EXPIRED' }), null, NOW)).toBe('EXPIRED');
    expect(
      resolveConnectionState(conn({ status: 'EXPIRED', hasRefreshToken: false }), null, NOW),
    ).toBe('REAUTH_REQUIRED');
  });

  it('derives expiry from expiresAt even while the row still says ACTIVE', () => {
    expect(resolveConnectionState(conn({ expiresAt: PAST }), null, NOW)).toBe('EXPIRED');
    expect(
      resolveConnectionState(conn({ expiresAt: PAST, hasRefreshToken: false }), null, NOW),
    ).toBe('REAUTH_REQUIRED');
  });

  it('treats an exactly-now expiry as lapsed', () => {
    expect(resolveConnectionState(conn({ expiresAt: NOW }), null, NOW)).toBe('EXPIRED');
  });

  it('treats a null expiresAt as non-expiring', () => {
    expect(resolveConnectionState(conn({ expiresAt: null }), null, NOW)).toBe('CONNECTED');
  });

  it('prioritises expiry over a failed health probe', () => {
    // A stale token explains the failed probe; telling the user "degraded" when
    // the real fix is a refresh would be misleading.
    expect(
      resolveConnectionState(
        conn({ expiresAt: PAST }),
        { ok: false, detail: null, lastCheckAt: PAST },
        NOW,
      ),
    ).toBe('EXPIRED');
  });
});

describe('isUsable / actionFor', () => {
  it('treats only CONNECTED and DEGRADED as usable', () => {
    expect(isUsable('CONNECTED')).toBe(true);
    expect(isUsable('DEGRADED')).toBe(true);
    for (const s of [
      'NOT_CONNECTED',
      'CONNECTING',
      'EXPIRED',
      'REAUTH_REQUIRED',
      'ERROR',
      'DISCONNECTED',
    ] as const) {
      expect(isUsable(s)).toBe(false);
    }
  });

  it('offers CONNECT when there is nothing to fix and RECONNECT when consent is needed', () => {
    expect(actionFor('NOT_CONNECTED')).toBe('CONNECT');
    expect(actionFor('DISCONNECTED')).toBe('CONNECT');
    expect(actionFor('REAUTH_REQUIRED')).toBe('RECONNECT');
    expect(actionFor('CONNECTED')).toBe('NONE');
  });
});

describe('approval policy', () => {
  it('requires approval for everything that changes an external system', () => {
    expect(requiresApproval('READ')).toBe(false);
    expect(requiresApproval('DRAFT')).toBe(false);
    expect(requiresApproval('WRITE')).toBe(true);
    expect(requiresApproval('PUBLISH')).toBe(true);
    expect(requiresApproval('DANGEROUS')).toBe(true);
  });

  it('re-asks for approval on every destructive action', () => {
    expect(APPROVAL_POLICY.DANGEROUS.reApprovePerAction).toBe(true);
    expect(APPROVAL_POLICY.PUBLISH.reApprovePerAction).toBe(false);
  });
});

describe('integration descriptors', () => {
  it('keys every descriptor to itself', () => {
    for (const [key, descriptor] of Object.entries(INTEGRATIONS)) {
      expect(descriptor.key).toBe(key);
    }
  });

  it('gives every non-available capability a concrete reason', () => {
    // "Not available" with no explanation is exactly the vague failure the
    // product rules forbid.
    for (const descriptor of Object.values(INTEGRATIONS)) {
      for (const cap of descriptor.capabilities) {
        if (
          cap.availability === 'NOT_AVAILABLE' ||
          cap.availability === 'REQUIRES_PROVIDER_APPROVAL'
        ) {
          expect(cap.unavailableReason, `${cap.id} needs a reason`).toBeTruthy();
        }
      }
    }
  });

  it('marks every integration with real code behind it as implemented', () => {
    for (const d of Object.values(INTEGRATIONS)) expect(d.implemented).toBe(true);
  });

  it('gates WordPress writes behind approval-level capabilities', () => {
    const levels = Object.fromEntries(
      INTEGRATIONS.WORDPRESS.capabilities.map((c) => [c.id, c.level]),
    );
    expect(levels['wordpress.create_draft']).toBe('DRAFT');
    expect(levels['wordpress.update_post']).toBe('WRITE');
    expect(levels['wordpress.publish']).toBe('PUBLISH');
  });

  it('never marks a write-level capability as freely available on a read-only integration', () => {
    for (const cap of INTEGRATIONS.GOOGLE_SEARCH_CONSOLE.capabilities) {
      expect(cap.level).toBe('READ');
    }
  });
});

describe('resolveCapabilities', () => {
  const yt = INTEGRATIONS.YOUTUBE;

  it('downgrades a capability whose scope was not granted', () => {
    const resolved = resolveCapabilities(
      yt,
      ['https://www.googleapis.com/auth/youtube.readonly'],
      'CONNECTED',
    );
    const analytics = resolved.find((c) => c.id === 'youtube.get_analytics');
    expect(analytics?.resolved).toBe('REQUIRES_SCOPE');
    expect(analytics?.usable).toBe(false);
  });

  it('promotes a baseline REQUIRES_SCOPE capability once the scope is actually granted', () => {
    const resolved = resolveCapabilities(
      yt,
      ['https://www.googleapis.com/auth/yt-analytics-monetary.readonly'],
      'CONNECTED',
    );
    const revenue = resolved.find((c) => c.id === 'youtube.get_revenue');
    expect(revenue?.resolved).toBe('AVAILABLE');
    expect(revenue?.usable).toBe(true);
  });

  it('marks everything unusable while the connection itself is unusable', () => {
    const resolved = resolveCapabilities(
      yt,
      yt.capabilities.flatMap((c) => c.requiredScopes ?? []),
      'EXPIRED',
    );
    expect(resolved.every((c) => c.usable === false)).toBe(true);
  });

  it('leaves a provider-approval capability gated even when its scope is granted', () => {
    const resolved = resolveCapabilities(INTEGRATIONS.TIKTOK, ['video.publish'], 'CONNECTED');
    const publish = resolved.find((c) => c.id === 'tiktok.publish');
    expect(publish?.resolved).toBe('REQUIRES_PROVIDER_APPROVAL');
    expect(publish?.usable).toBe(false);
  });

  it('keeps credential-less capabilities available with no scopes at all', () => {
    const resolved = resolveCapabilities(INTEGRATIONS.WEBSITE, [], 'CONNECTED');
    expect(resolved.every((c) => c.usable)).toBe(true);
  });
});

describe('diagnoseConnection', () => {
  it('classifies a quota failure as QUOTA and does not tell the user to reconnect', () => {
    const d = diagnoseConnection({
      key: 'YOUTUBE',
      state: 'DEGRADED',
      connectionId: 'ckabc123456',
      lastError: 'quotaExceeded: The request cannot be completed',
    });
    expect(d.category).toBe('QUOTA');
    expect(d.action).toBe('RETRY');
    expect(d.recommendedAction.toLowerCase()).not.toContain('reconnect');
  });

  it('classifies a 403/scope failure as PERMISSION and asks for reconsent', () => {
    const d = diagnoseConnection({
      key: 'TIKTOK',
      state: 'ERROR',
      lastError: 'HTTP 403 Forbidden: scope not authorized',
    });
    expect(d.category).toBe('PERMISSION');
    expect(d.recommendedAction).toContain('Reconnect');
  });

  it('falls back to PROVIDER rather than guessing on an unrecognised error', () => {
    const d = diagnoseConnection({
      key: 'YOUTUBE',
      state: 'ERROR',
      lastError: 'backendError: something unexpected',
    });
    expect(d.category).toBe('PROVIDER');
  });

  it('never returns an empty or vague explanation for any state', () => {
    const states = [
      'NOT_CONNECTED',
      'CONNECTING',
      'CONNECTED',
      'DEGRADED',
      'EXPIRED',
      'REAUTH_REQUIRED',
      'ERROR',
      'DISCONNECTED',
    ] as const;
    for (const key of Object.keys(INTEGRATIONS) as IntegrationKey[]) {
      for (const state of states) {
        const d = diagnoseConnection({ key, state });
        expect(d.title.length, `${key}/${state}`).toBeGreaterThan(0);
        expect(d.explanation.length).toBeGreaterThan(20);
        expect(d.recommendedAction.length).toBeGreaterThan(0);
        expect(d.explanation.toLowerCase()).not.toContain('something went wrong');
      }
    }
  });

  it('scrubs secrets out of the technical detail it surfaces', () => {
    const d = diagnoseConnection({
      key: 'YOUTUBE',
      state: 'ERROR',
      lastError: 'refresh failed: access_token=ya29.SUPERSECRETVALUE1234567890',
    });
    expect(d.technicalDetail).not.toContain('SUPERSECRETVALUE');
  });

  it('caps technical detail so a huge provider body cannot flood the UI', () => {
    const d = diagnoseConnection({ key: 'YOUTUBE', state: 'ERROR', lastError: 'x'.repeat(5000) });
    expect(d.technicalDetail?.length).toBeLessThanOrEqual(500);
  });

  it('produces a stable reference id for the same fault', () => {
    const input = {
      key: 'YOUTUBE' as const,
      state: 'ERROR' as const,
      connectionId: 'ckabc123456',
      lastError: 'quota',
    };
    expect(diagnoseConnection(input).referenceId).toBe(diagnoseConnection(input).referenceId);
  });

  it('never puts the whole connection id in the reference', () => {
    const d = diagnoseConnection({ key: 'YOUTUBE', state: 'ERROR', connectionId: 'ckabc123456' });
    expect(d.referenceId).not.toContain('ckabc123456');
  });

  it('falls back to the health detail when there is no lastError', () => {
    const d = diagnoseConnection({
      key: 'TIKTOK',
      state: 'DEGRADED',
      healthDetail: 'probe timed out',
    });
    expect(d.technicalDetail).toContain('probe timed out');
  });

  it('reports no technical detail rather than an empty string when there is nothing to say', () => {
    expect(diagnoseConnection({ key: 'WEBSITE', state: 'CONNECTED' }).technicalDetail).toBeNull();
  });
});
