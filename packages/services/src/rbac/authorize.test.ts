import { describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { ACTIONS } from './actions.js';
import { authorize, can } from './authorize.js';

describe('RBAC policy', () => {
  it('VIEWER can read but not run work', () => {
    expect(can('VIEWER', 'data:read')).toBe(true);
    expect(can('VIEWER', 'crawl:run')).toBe(false);
    expect(can('VIEWER', 'member:manage')).toBe(false);
  });

  it('MEMBER can run work but not approve or manage', () => {
    expect(can('MEMBER', 'agent:run')).toBe(true);
    expect(can('MEMBER', 'recommendation:approve')).toBe(false);
    expect(can('MEMBER', 'integration:manage')).toBe(false);
  });

  it('ADMIN can approve, publish and manage members but not billing/delete', () => {
    expect(can('ADMIN', 'recommendation:approve')).toBe(true);
    expect(can('ADMIN', 'publish:external')).toBe(true);
    expect(can('ADMIN', 'member:manage')).toBe(true);
    expect(can('ADMIN', 'billing:manage')).toBe(false);
    expect(can('ADMIN', 'org:delete')).toBe(false);
  });

  it('OWNER can do everything in the matrix', () => {
    for (const action of ACTIONS) expect(can('OWNER', action)).toBe(true);
  });

  it('authorize() throws permission_denied for a disallowed action', () => {
    try {
      authorize({ userId: 'u1', role: 'MEMBER', membershipStatus: 'ACTIVE' }, 'billing:manage');
      throw new Error('expected authorize to throw');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('permission_denied');
    }
  });

  it('authorize() denies a suspended membership everything', () => {
    try {
      authorize({ userId: 'u1', role: 'OWNER', membershipStatus: 'SUSPENDED' }, 'data:read');
      throw new Error('expected authorize to throw');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('permission_denied');
    }
  });

  it('authorize() passes for an allowed action', () => {
    expect(() =>
      authorize({ userId: 'u1', role: 'ADMIN', membershipStatus: 'ACTIVE' }, 'member:manage'),
    ).not.toThrow();
  });
});
