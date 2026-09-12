import type { MembershipStatus, Role } from '@growth-agent/db';
import { AppError } from '../errors.js';
import type { Action } from './actions.js';
import { POLICY } from './policy.js';

export interface Actor {
  userId: string;
  /** The caller's membership in the organization the action targets. */
  role: Role;
  membershipStatus: MembershipStatus;
}

/** Pure predicate — does this role permit this action? */
export function can(role: Role, action: Action): boolean {
  return POLICY[role].has(action);
}

/** Resolve every action a role permits (for UI gating). */
export function allowedActions(role: Role): Action[] {
  return [...POLICY[role]];
}

/**
 * The single authorization choke point. Throws `AppError('permission_denied')`
 * when the actor may not perform `action` in the target organization.
 * A suspended membership is denied everything.
 */
export function authorize(actor: Actor, action: Action): void {
  if (actor.membershipStatus !== 'ACTIVE') {
    throw AppError.forbidden('Your membership in this organization is not active.');
  }
  if (!can(actor.role, action)) {
    throw AppError.forbidden(`Your role (${actor.role}) cannot perform "${action}".`);
  }
}
