import type { Role } from '@growth-agent/db';

/**
 * The capability-based permission catalog (Phase 2, Parts 5–11).
 *
 * This file is the single source of truth for "who may do what". Every
 * server-side check resolves to one of these permissions; the legacy
 * `Action` names (`integration:manage`, …) are kept as aliases so the ~70
 * existing call sites keep working unchanged (see `LEGACY_ACTION_PERMISSION`).
 */
export const PERMISSIONS = [
  'organization.view',
  'organization.update',
  'organization.delete',
  'member.view',
  'member.invite',
  'member.remove',
  'member.update_role',
  'ownership.transfer',
  'billing.view',
  'billing.manage',
  'integration.view',
  'integration.connect',
  'integration.disconnect',
  'integration.manage',
  'content.view',
  'content.create',
  'content.edit',
  'content.publish',
  'seo.view',
  'seo.analyze',
  'seo.modify',
  'youtube.view',
  'youtube.manage',
  'tiktok.view',
  'tiktok.manage',
  'analytics.view',
  'monetization.view',
  'monetization.manage',
  'recommendation.view',
  'recommendation.approve',
  'agent.view',
  'agent.run',
  'agent.configure',
  'agent.approve',
  'automation.view',
  'automation.create',
  'automation.update',
  'automation.delete',
  'report.view',
  'report.create',
  'report.export',
  'report.share',
  'settings.view',
  'settings.manage',
  'security.manage',
  'audit.view',
  'audit.export',
  'api_key.view',
  'api_key.create',
  'api_key.revoke',
  'mission.view',
  'mission.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'organization.view',
  'member.view',
  'integration.view',
  'content.view',
  'seo.view',
  'youtube.view',
  'tiktok.view',
  'analytics.view',
  'monetization.view',
  'recommendation.view',
  'agent.view',
  'automation.view',
  'report.view',
  'settings.view',
  'mission.view',
];

/**
 * MEMBER keeps everything the pre-Phase-2 MEMBER could do (backward
 * compatibility, Part 36) — including creating/updating automations — but
 * not deleting them, which is MANAGER+.
 */
const MEMBER: Permission[] = [
  ...VIEWER,
  'agent.run',
  'content.create',
  'content.edit',
  'seo.analyze',
  'monetization.manage',
  'report.create',
  'automation.create',
  'automation.update',
  'mission.manage',
];

const MANAGER: Permission[] = [
  ...MEMBER,
  'seo.modify',
  'youtube.manage',
  'tiktok.manage',
  'automation.delete',
  'report.export',
  'recommendation.approve',
];

/** ADMIN: everything operational. Billing is view-only (Part 8). */
const ADMIN: Permission[] = [
  ...MANAGER,
  'organization.update',
  'member.invite',
  'member.remove',
  'member.update_role',
  'billing.view',
  'integration.connect',
  'integration.disconnect',
  'integration.manage',
  'content.publish',
  'agent.configure',
  'agent.approve',
  'report.share',
  'settings.manage',
  'audit.view',
  'audit.export',
  'api_key.view',
  'api_key.create',
  'api_key.revoke',
];

const OWNER: Permission[] = [
  ...ADMIN,
  'organization.delete',
  'ownership.transfer',
  'billing.manage',
  'security.manage',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  MEMBER: new Set(MEMBER),
  MANAGER: new Set(MANAGER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

/** Strict hierarchy used for escalation rules (never for permission checks). */
export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 1,
  MEMBER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

export const ROLES_BY_RANK: readonly Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Role-assignment rules (Part 7 / Part 12 — no privilege escalation)
// ---------------------------------------------------------------------------

export type RoleChangeDenial =
  'not_permitted' | 'target_outranks_actor' | 'role_above_actor' | 'owner_only' | 'self_change';

/**
 * May `actor` move `target` from `from` to `to`?
 *
 *   - needs `member.update_role`;
 *   - granting or removing OWNER is OWNER-only (ownership transfer);
 *   - nobody can assign a role above their own, or change someone who
 *     outranks them;
 *   - nobody changes their own role, except an OWNER stepping down (the
 *     last-owner guard lives in the service, which can count owners).
 */
export function checkRoleChange(input: {
  actorRole: Role;
  isSelf: boolean;
  from: Role;
  to: Role;
}): RoleChangeDenial | null {
  const { actorRole, isSelf, from, to } = input;
  if (!roleHasPermission(actorRole, 'member.update_role')) return 'not_permitted';
  if (isSelf) return actorRole === 'OWNER' && from === 'OWNER' ? null : 'self_change';
  if (from === 'OWNER' || to === 'OWNER') return actorRole === 'OWNER' ? null : 'owner_only';
  if (ROLE_RANK[from] > ROLE_RANK[actorRole]) return 'target_outranks_actor';
  if (ROLE_RANK[to] > ROLE_RANK[actorRole]) return 'role_above_actor';
  return null;
}

/** Roles an actor may invite someone as. OWNER is never invitable. */
export function invitableRoles(actorRole: Role): Role[] {
  if (!roleHasPermission(actorRole, 'member.invite')) return [];
  return ROLES_BY_RANK.filter((r) => r !== 'OWNER' && ROLE_RANK[r] <= ROLE_RANK[actorRole]);
}

/** May `actor` remove a member holding `targetRole`? (self-leave handled separately) */
export function canRemoveMember(actorRole: Role, targetRole: Role): boolean {
  if (!roleHasPermission(actorRole, 'member.remove')) return false;
  if (targetRole === 'OWNER') return actorRole === 'OWNER';
  return ROLE_RANK[targetRole] <= ROLE_RANK[actorRole];
}
