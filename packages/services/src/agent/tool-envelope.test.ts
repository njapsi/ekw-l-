import { describe, expect, it } from 'vitest';
import { blockedFromPolicy, failed, partial, success } from './tool-envelope.js';

describe('tool envelope', () => {
  it('success carries data and defaults warnings/resourceReferences to empty', () => {
    const env = success({ tool: 't', provider: 'p', durationMs: 5, data: { x: 1 } });
    expect(env.status).toBe('SUCCESS');
    expect(env.data).toEqual({ x: 1 });
    expect(env.warnings).toEqual([]);
    expect(env.resourceReferences).toEqual([]);
    expect(env.error).toBeUndefined();
  });

  it('partial requires explicit warnings so a caller cannot silently drop them', () => {
    const env = partial({
      tool: 't',
      provider: 'p',
      durationMs: 5,
      data: [1],
      warnings: ['second page failed'],
    });
    expect(env.status).toBe('PARTIAL');
    expect(env.warnings).toEqual(['second page failed']);
  });

  it('blockedFromPolicy(REQUIRE_APPROVAL) produces a distinct REQUIRES_APPROVAL status', () => {
    const env = blockedFromPolicy({
      tool: 't',
      provider: 'p',
      durationMs: 1,
      outcome: 'REQUIRE_APPROVAL',
      reason: 'needs a human',
      correlationId: 'c1',
    });
    expect(env.status).toBe('REQUIRES_APPROVAL');
    expect(env.error?.requiresApproval).toBe(true);
    expect(env.error?.retryable).toBe(false);
  });

  it.each([
    ['DENY', 'POLICY_DENIED', false, false],
    ['REAUTH_REQUIRED', 'REAUTH_REQUIRED', false, true],
    ['RATE_LIMITED', 'RATE_LIMITED', true, false],
    ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', false, false],
    ['UNAVAILABLE', 'UNAVAILABLE', true, false],
  ] as const)('blockedFromPolicy(%s) maps to error code %s', (outcome, code, retryable, reauth) => {
    const env = blockedFromPolicy({
      tool: 't',
      provider: 'p',
      durationMs: 1,
      outcome,
      reason: 'x',
      correlationId: 'c1',
    });
    expect(env.status).toBe('BLOCKED');
    expect(env.error?.code).toBe(code);
    expect(env.error?.retryable).toBe(retryable);
    expect(env.error?.requiresReauth).toBe(reauth);
  });

  it('failed never marks requiresApproval or requiresReauth', () => {
    const env = failed({
      tool: 't',
      provider: 'p',
      durationMs: 1,
      code: 'TIMEOUT',
      message: 'timed out',
      correlationId: 'c1',
    });
    expect(env.status).toBe('FAILED');
    expect(env.error?.requiresApproval).toBe(false);
    expect(env.error?.requiresReauth).toBe(false);
  });
});
