import { describe, expect, it } from 'vitest';
import { applyIdentityToToken, roleForOrg, tokenToSessionUser } from './callbacks.js';

const snap = {
  userId: 'u_1',
  email: 'a@example.com',
  name: 'Ada',
  image: null,
  orgs: [
    { id: 'o_1', slug: 'acme', name: 'Acme', role: 'OWNER' as const },
    { id: 'o_2', slug: 'beta', name: 'Beta', role: 'VIEWER' as const },
  ],
  isPlatformStaff: true,
  sessionVersion: 3,
};

describe('auth callbacks', () => {
  it('folds an identity snapshot into the token', () => {
    const t = applyIdentityToToken({}, snap);
    expect(t.uid).toBe('u_1');
    expect(t.sv).toBe(3);
    expect(t.isPlatformStaff).toBe(true);
    expect(t.orgs).toHaveLength(2);
  });

  it('projects the token onto a session user', () => {
    const user = tokenToSessionUser(applyIdentityToToken({}, snap));
    expect(user).toMatchObject({
      id: 'u_1',
      email: 'a@example.com',
      isPlatformStaff: true,
      sessionVersion: 3,
    });
  });

  it('defaults are safe when the token is empty', () => {
    const user = tokenToSessionUser({});
    expect(user.orgs).toEqual([]);
    expect(user.isPlatformStaff).toBe(false);
    expect(user.sessionVersion).toBe(0);
  });

  it('resolves the role for a given org', () => {
    expect(roleForOrg(snap.orgs, 'o_2')).toBe('VIEWER');
    expect(roleForOrg(snap.orgs, 'missing')).toBeNull();
  });
});
