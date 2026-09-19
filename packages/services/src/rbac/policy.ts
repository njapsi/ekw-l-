import type { Role } from '@growth-agent/db';
import type { Action } from './actions.js';
import { type Permission, ROLE_PERMISSIONS } from './permissions.js';

/**
 * Legacy action → permission. The role matrix lives in `permissions.ts`; the
 * older coarse `Action` names are aliases resolved through this table, so a
 * role's legacy grants can never drift from its permission grants. The
 * mapping preserves every pre-Phase-2 role's behaviour exactly (a test pins
 * this).
 */
export const LEGACY_ACTION_PERMISSION: Record<Action, Permission> = {
  'org:read': 'organization.view',
  'data:read': 'analytics.view',
  'report:read': 'report.view',
  'recommendation:read': 'recommendation.view',
  'audit:read': 'audit.view',
  'crawl:run': 'seo.analyze',
  'agent:run': 'agent.run',
  'content:manage': 'content.create',
  'monetization:manage': 'monetization.manage',
  'report:generate': 'report.create',
  'automation:manage': 'automation.create',
  'recommendation:approve': 'recommendation.approve',
  'publish:external': 'content.publish',
  'report:share': 'report.share',
  'integration:manage': 'integration.manage',
  'member:manage': 'member.update_role',
  'org:update': 'organization.update',
  'billing:manage': 'billing.manage',
  'org:delete': 'organization.delete',
};

function legacyActionsFor(role: Role): ReadonlySet<Action> {
  return new Set(
    (Object.keys(LEGACY_ACTION_PERMISSION) as Action[]).filter((a) =>
      ROLE_PERMISSIONS[role].has(LEGACY_ACTION_PERMISSION[a]),
    ),
  );
}

/** Role → legacy actions, derived from the permission matrix. */
export const POLICY: Record<Role, ReadonlySet<Action>> = {
  VIEWER: legacyActionsFor('VIEWER'),
  MEMBER: legacyActionsFor('MEMBER'),
  MANAGER: legacyActionsFor('MANAGER'),
  ADMIN: legacyActionsFor('ADMIN'),
  OWNER: legacyActionsFor('OWNER'),
};
