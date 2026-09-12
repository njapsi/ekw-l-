import type { Role } from '@growth-agent/db';
import type { Action } from './actions.js';

/**
 * Role → allowed actions. Roles are cumulative in spirit but expressed
 * explicitly per role so the matrix is auditable at a glance
 * (matches docs/API.md §3).
 */
const VIEWER: Action[] = ['org:read', 'data:read', 'report:read', 'recommendation:read'];

const MEMBER: Action[] = [
  ...VIEWER,
  'crawl:run',
  'agent:run',
  'content:manage',
  'monetization:manage',
  'report:generate',
  'automation:manage',
];

const ADMIN: Action[] = [
  ...MEMBER,
  'recommendation:approve',
  'publish:external',
  'report:share',
  'integration:manage',
  'member:manage',
  'org:update',
  'audit:read',
];

const OWNER: Action[] = [...ADMIN, 'billing:manage', 'org:delete'];

export const POLICY: Record<Role, ReadonlySet<Action>> = {
  VIEWER: new Set(VIEWER),
  MEMBER: new Set(MEMBER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};
