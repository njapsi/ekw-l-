import type { MembershipStatus, Role } from '@growth-agent/db';
import { AppError } from '../errors.js';
import type { Action } from './actions.js';
import { type Permission, ROLE_PERMISSIONS, isPermission } from './permissions.js';
import { LEGACY_ACTION_PERMISSION, POLICY } from './policy.js';

export interface Actor {
  userId: string;
  /** The caller's membership in the organization the action targets. */
  role: Role;
  membershipStatus: MembershipStatus;
}

/** Either a capability permission (`content.publish`) or a legacy action alias. */
export type Authorizable = Action | Permission;

export function toPermission(action: Authorizable): Permission {
  return isPermission(action) ? action : LEGACY_ACTION_PERMISSION[action];
}

/** Pure predicate — does this role grant this permission (or legacy action)? */
export function can(role: Role, action: Authorizable): boolean {
  return ROLE_PERMISSIONS[role].has(toPermission(action));
}

/** Every legacy action a role permits (for existing UI gating). */
export function allowedActions(role: Role): Action[] {
  return [...POLICY[role]];
}

/** Every permission a role holds. */
export function allowedPermissions(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * The single authorization choke point. Throws `AppError('permission_denied')`
 * when the actor may not perform `action` in the target organization.
 * A suspended membership is denied everything. The message names the missing
 * permission, never data about the resource.
 */
export function authorize(actor: Actor, action: Authorizable): void {
  if (actor.membershipStatus !== 'ACTIVE') {
    throw AppError.forbidden('Your membership in this organization is not active.');
  }
  if (!can(actor.role, action)) {
    throw AppError.forbidden(
      `Your role (${actor.role.toLowerCase()}) does not have the "${toPermission(action)}" permission.`,
    );
  }
}
