import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signState, verifyState } from './state.js';

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-0123456789abcdef';
  vi.useRealTimers();
});

describe('OAuth state', () => {
  const base = { organizationId: 'org_1', userId: 'usr_1', provider: 'youtube' };

  it('round-trips and carries the tenant', () => {
    const s = verifyState(signState(base));
    expect(s).toMatchObject(base);
    expect(s.nonce).toBeTruthy();
  });

  it('rejects a tampered payload (CSRF / cross-tenant swap)', () => {
    const token = signState(base);
    const [payload] = token.split('.');
    const evil = Buffer.from(
      JSON.stringify({ ...base, organizationId: 'org_ATTACKER', iat: Date.now(), nonce: 'x' }),
    ).toString('base64url');
    expect(() => verifyState(`${evil}.${payload}`)).toThrow(/signature is invalid|Malformed/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyState('not-a-token')).toThrow(/Malformed/);
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = signState(base);
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // +11 min > 10 min TTL
    expect(() => verifyState(token)).toThrow(/expired/);
  });

  it('rejects when signed with a different secret', () => {
    const token = signState(base);
    process.env.AUTH_SECRET = 'a-totally-different-secret-value-01';
    expect(() => verifyState(token)).toThrow(/signature is invalid/);
  });
});
