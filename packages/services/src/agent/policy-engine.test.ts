import { describe, expect, it } from 'vitest';
import { evaluateToolPolicy, floorDecision, type ToolPolicyInput } from './policy-engine.js';

const BASE: ToolPolicyInput = {
  actionClass: 'analyze',
  level: 'READ',
  connection: 'CONNECTED',
  governance: { allowed: true, requiresApproval: false },
  quotaExceeded: false,
  rateLimited: false,
};

describe('evaluateToolPolicy', () => {
  it('allows a plain read with no obstruction', () => {
    expect(evaluateToolPolicy(BASE).outcome).toBe('ALLOW');
  });

  it('governance DENY outranks everything else, even when nothing else is wrong', () => {
    const d = evaluateToolPolicy({
      ...BASE,
      governance: { allowed: false, reason: 'disabled by policy' },
      connection: 'REAUTH_REQUIRED',
      rateLimited: true,
      quotaExceeded: true,
    });
    expect(d.outcome).toBe('DENY');
    expect(d.reason).toBe('disabled by policy');
  });

  it('REAUTH_REQUIRED connection state outranks rate limit and quota', () => {
    const d = evaluateToolPolicy({
      ...BASE,
      connection: 'REAUTH_REQUIRED',
      rateLimited: true,
      quotaExceeded: true,
    });
    expect(d.outcome).toBe('REAUTH_REQUIRED');
  });

  it.each(['NOT_CONNECTED', 'CONNECTING', 'EXPIRED', 'ERROR', 'DISCONNECTED'] as const)(
    'connection state %s that is not usable yields UNAVAILABLE, not REAUTH_REQUIRED',
    (state) => {
      const d = evaluateToolPolicy({ ...BASE, connection: state });
      expect(d.outcome).toBe('UNAVAILABLE');
    },
  );

  it('DEGRADED is still usable — falls through to the next check', () => {
    const d = evaluateToolPolicy({ ...BASE, connection: 'DEGRADED' });
    expect(d.outcome).toBe('ALLOW');
  });

  it('NONE connection (no account concept, e.g. research) is always usable', () => {
    const d = evaluateToolPolicy({ ...BASE, connection: 'NONE' });
    expect(d.outcome).toBe('ALLOW');
  });

  it('rate limit outranks quota', () => {
    const d = evaluateToolPolicy({ ...BASE, rateLimited: true, quotaExceeded: true });
    expect(d.outcome).toBe('RATE_LIMITED');
  });

  it('quota exceeded outranks a plain approval requirement', () => {
    const d = evaluateToolPolicy({
      ...BASE,
      quotaExceeded: true,
      governance: { allowed: true, requiresApproval: true },
    });
    expect(d.outcome).toBe('QUOTA_EXCEEDED');
  });

  it('a null quota check is skipped entirely', () => {
    const d = evaluateToolPolicy({ ...BASE, quotaExceeded: null });
    expect(d.outcome).toBe('ALLOW');
  });

  it('governance requiresApproval with no other obstruction yields REQUIRE_APPROVAL', () => {
    const d = evaluateToolPolicy({
      ...BASE,
      governance: { allowed: true, requiresApproval: true },
    });
    expect(d.outcome).toBe('REQUIRE_APPROVAL');
    expect(d.requiresApproval).toBe(true);
  });

  it('a model request can never bypass a DENY: the input has no field a model output could set', () => {
    // The type itself has no "override" flag; this test documents the
    // invariant rather than exercising a runtime branch.
    const keys = Object.keys(BASE);
    expect(keys).not.toContain('override');
    expect(keys).not.toContain('modelApproved');
  });
});

function requiresApprovalOf(level: Parameters<typeof floorDecision>[0]): boolean {
  const d = floorDecision(level);
  if (!d.allowed) throw new Error('floorDecision must always allow');
  return d.requiresApproval;
}

describe('floorDecision', () => {
  it('READ and DRAFT never require approval', () => {
    expect(requiresApprovalOf('READ')).toBe(false);
    expect(requiresApprovalOf('DRAFT')).toBe(false);
  });

  it('WRITE, PUBLISH and DANGEROUS always require approval', () => {
    expect(requiresApprovalOf('WRITE')).toBe(true);
    expect(requiresApprovalOf('PUBLISH')).toBe(true);
    expect(requiresApprovalOf('DANGEROUS')).toBe(true);
  });

  it('always allows — the floor only ever raises the approval bar, never denies', () => {
    for (const level of ['READ', 'DRAFT', 'WRITE', 'PUBLISH', 'DANGEROUS'] as const) {
      expect(floorDecision(level).allowed).toBe(true);
    }
  });
});
