import { describe, expect, it } from 'vitest';
import type { Role } from '@growth-agent/db';
import { can } from './authorize.js';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  canRemoveMember,
  checkRoleChange,
  invitableRoles,
  roleHasPermission,
} from './permissions.js';
import { POLICY } from './policy.js';

/**
 * The exact pre-Phase-2 policy table (git history: rbac/policy.ts before
 * ADR-0052). Existing users must not gain or lose anything (Part 36).
 */
const LEGACY: Record<'VIEWER' | 'MEMBER' | 'ADMIN' | 'OWNER', string[]> = {
  VIEWER: ['org:read', 'data:read', 'report:read', 'recommendation:read'],
  MEMBER: [
    'org:read',
    'data:read',
    'report:read',
    'recommendation:read',
    'crawl:run',
    'agent:run',
    'content:manage',
    'monetization:manage',
    'report:generate',
    'automation:manage',
  ],
  ADMIN: [
    'org:read',
    'data:read',
    'report:read',
    'recommendation:read',
    'crawl:run',
    'agent:run',
    'content:manage',
    'monetization:manage',
    'report:generate',
    'automation:manage',
    'recommendation:approve',
    'publish:external',
    'report:share',
    'integration:manage',
    'member:manage',
    'org:update',
    'audit:read',
  ],
  OWNER: [
    'org:read',
    'data:read',
    'report:read',
    'recommendation:read',
    'crawl:run',
    'agent:run',
    'content:manage',
    'monetization:manage',
    'report:generate',
    'automation:manage',
    'recommendation:approve',
    'publish:external',
    'report:share',
    'integration:manage',
    'member:manage',
    'org:update',
    'audit:read',
    'billing:manage',
    'org:delete',
  ],
};

describe('backward compatibility', () => {
  it('every pre-existing role keeps exactly its legacy action set', () => {
    for (const role of Object.keys(LEGACY) as Array<keyof typeof LEGACY>) {
      expect([...POLICY[role]].sort()).toEqual([...LEGACY[role]].sort());
    }
  });
});

describe('role matrix', () => {
  it('is strictly cumulative: each role holds everything the role below it holds', () => {
    const order: Role[] = ['VIEWER', 'MEMBER', 'MANAGER', 'ADMIN', 'OWNER'];
    for (let i = 1; i < order.length; i++) {
      const lower = ROLE_PERMISSIONS[order[i - 1] as Role];
      const higher = ROLE_PERMISSIONS[order[i] as Role];
      for (const p of lower) expect(higher.has(p), `${order[i]} lacks ${p}`).toBe(true);
    }
  });

  it('OWNER holds every permission', () => {
    for (const p of PERMISSIONS) expect(roleHasPermission('OWNER', p)).toBe(true);
  });

  it('VIEWER is read-only', () => {
    const writes = [...ROLE_PERMISSIONS.VIEWER].filter((p) => !/\.view$/.test(p));
    expect(writes).toEqual([]);
  });

  it('MANAGER runs operations but gets no billing, security, member or deletion rights', () => {
    expect(can('MANAGER', 'agent.run')).toBe(true);
    expect(can('MANAGER', 'seo.modify')).toBe(true);
    expect(can('MANAGER', 'automation.delete')).toBe(true);
    for (const p of [
      'billing.view',
      'billing.manage',
      'organization.delete',
      'security.manage',
      'ownership.transfer',
      'member.invite',
      'member.update_role',
      'content.publish',
      'api_key.create',
    ] as const) {
      expect(can('MANAGER', p), p).toBe(false);
    }
  });

  it('ADMIN sees but cannot manage billing', () => {
    expect(can('ADMIN', 'billing.view')).toBe(true);
    expect(can('ADMIN', 'billing.manage')).toBe(false);
    expect(can('ADMIN', 'organization.delete')).toBe(false);
  });

  it('only OWNER and ADMIN may approve publishing', () => {
    expect(can('ADMIN', 'content.publish')).toBe(true);
    expect(can('MANAGER', 'content.publish')).toBe(false);
    expect(can('MEMBER', 'content.publish')).toBe(false);
  });

  it('only OWNER and ADMIN may cancel someone else\'s pending approval (Phase 12: centralizes what was an inline ADMIN/OWNER role check)', () => {
    expect(can('OWNER', 'approval.cancel_others')).toBe(true);
    expect(can('ADMIN', 'approval.cancel_others')).toBe(true);
    expect(can('MANAGER', 'approval.cancel_others')).toBe(false);
    expect(can('MEMBER', 'approval.cancel_others')).toBe(false);
    expect(can('VIEWER', 'approval.cancel_others')).toBe(false);
  });
});

describe('checkRoleChange (no privilege escalation)', () => {
  it('an ADMIN cannot make anyone an OWNER', () => {
    expect(
      checkRoleChange({ actorRole: 'ADMIN', isSelf: false, from: 'MEMBER', to: 'OWNER' }),
    ).toBe('owner_only');
  });

  it('an ADMIN cannot demote an OWNER', () => {
    expect(
      checkRoleChange({ actorRole: 'ADMIN', isSelf: false, from: 'OWNER', to: 'MEMBER' }),
    ).toBe('owner_only');
  });

  it('nobody changes their own role, except an OWNER stepping down', () => {
    expect(checkRoleChange({ actorRole: 'ADMIN', isSelf: true, from: 'ADMIN', to: 'OWNER' })).toBe(
      'self_change',
    );
    expect(
      checkRoleChange({ actorRole: 'OWNER', isSelf: true, from: 'OWNER', to: 'ADMIN' }),
    ).toBeNull();
  });

  it('roles without member.update_role are refused outright', () => {
    expect(
      checkRoleChange({ actorRole: 'MANAGER', isSelf: false, from: 'VIEWER', to: 'MEMBER' }),
    ).toBe('not_permitted');
  });

  it('an OWNER may transfer or grant ownership', () => {
    expect(
      checkRoleChange({ actorRole: 'OWNER', isSelf: false, from: 'ADMIN', to: 'OWNER' }),
    ).toBeNull();
  });

  it('an ADMIN may move people between non-owner roles', () => {
    expect(
      checkRoleChange({ actorRole: 'ADMIN', isSelf: false, from: 'VIEWER', to: 'ADMIN' }),
    ).toBeNull();
  });
});

describe('invitations and removals', () => {
  it('OWNER is never invitable; ADMIN invites up to ADMIN', () => {
    expect(invitableRoles('OWNER')).toEqual(['ADMIN', 'MANAGER', 'MEMBER', 'VIEWER']);
    expect(invitableRoles('ADMIN')).toEqual(['ADMIN', 'MANAGER', 'MEMBER', 'VIEWER']);
    expect(invitableRoles('MANAGER')).toEqual([]);
  });

  it('only an OWNER removes an OWNER; nobody removes someone above them', () => {
    expect(canRemoveMember('ADMIN', 'OWNER')).toBe(false);
    expect(canRemoveMember('OWNER', 'OWNER')).toBe(true);
    expect(canRemoveMember('ADMIN', 'MANAGER')).toBe(true);
    expect(canRemoveMember('MEMBER', 'VIEWER')).toBe(false);
  });
});
