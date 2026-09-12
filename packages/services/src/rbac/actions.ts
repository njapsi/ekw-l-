/**
 * The closed set of authorizable actions. Keep this list explicit — a new
 * feature adds its actions here and to the policy table, never an ad-hoc role
 * check at the call site (docs/API.md §3, docs/SECURITY.md §3).
 */
export const ACTIONS = [
  // read
  'org:read',
  'data:read',
  'report:read',
  'recommendation:read',
  'audit:read',
  // work
  'crawl:run',
  'agent:run',
  'content:manage',
  'monetization:manage',
  'report:generate',
  'automation:manage',
  // approvals / external mutation
  'recommendation:approve',
  'publish:external',
  'report:share',
  // configuration
  'integration:manage',
  'member:manage',
  'org:update',
  // owner-only
  'billing:manage',
  'org:delete',
] as const;

export type Action = (typeof ACTIONS)[number];
