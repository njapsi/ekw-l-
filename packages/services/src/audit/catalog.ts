/**
 * Audit event catalog (Phase 2, Part 16).
 *
 * Rows store the historical dotted action names (`integration.connected`);
 * this catalog maps them onto the canonical enterprise event types
 * (`INTEGRATION_CONNECTED`) and categories used by the audit UI, filters and
 * CSV export — so no existing row has to be rewritten.
 */

export const AUDIT_CATEGORIES = [
  'auth',
  'organization',
  'member',
  'integration',
  'ai',
  'content',
  'seo',
  'automation',
  'report',
  'billing',
  'api_key',
  'security',
  'data',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Explicit canonical names, including every event the Phase 2 brief lists. */
const CANONICAL: Record<string, string> = {
  'auth.sign_in': 'AUTH_LOGIN',
  'auth.sign_out': 'AUTH_LOGOUT',
  'auth.sign_up': 'AUTH_SIGN_UP',
  'auth.password_set': 'PASSWORD_CHANGED',
  'auth.password_changed': 'PASSWORD_CHANGED',
  'auth.sessions_revoked': 'SESSION_REVOKED',
  'organization.created': 'ORGANIZATION_CREATED',
  'organization.updated': 'ORGANIZATION_UPDATED',
  'organization.renamed': 'ORGANIZATION_UPDATED',
  'organization.deletion_requested': 'ORGANIZATION_DELETION_REQUESTED',
  'organization.ownership_transferred': 'OWNERSHIP_TRANSFERRED',
  'invitation.created': 'MEMBER_INVITED',
  'member.invited': 'MEMBER_INVITED',
  'invitation.accepted': 'MEMBER_JOINED',
  'member.joined': 'MEMBER_JOINED',
  'member.removed': 'MEMBER_REMOVED',
  'member.left': 'MEMBER_REMOVED',
  'member.role_changed': 'ROLE_CHANGED',
  'integration.connected': 'INTEGRATION_CONNECTED',
  'integration.disconnected': 'INTEGRATION_DISCONNECTED',
  'integration.reconnected': 'INTEGRATION_REAUTHORIZED',
  'integration.action_requested': 'AI_ACTION_REQUESTED',
  'integration.action_approved': 'AI_ACTION_APPROVED',
  'integration.action_rejected': 'AI_ACTION_REJECTED',
  'integration.action_executed': 'AI_ACTION_EXECUTED',
  'integration.action_failed': 'AI_ACTION_FAILED',
  'agent.turn.started': 'AI_AGENT_STARTED',
  'agent.turn.completed': 'AI_AGENT_COMPLETED',
  'agent.turn.failed': 'AI_AGENT_FAILED',
  'content.project.created': 'CONTENT_CREATED',
  'content.assets.generated': 'CONTENT_CREATED',
  'wordpress.draft_created': 'CONTENT_CREATED',
  'content.asset.edited': 'CONTENT_UPDATED',
  'content.asset.published_marked': 'CONTENT_PUBLISHED',
  'tiktok.publish.approved': 'CONTENT_PUBLISHED',
  'content.project.archived': 'CONTENT_DELETED',
  'seo.crawl.started': 'SEO_CRAWL_STARTED',
  'seo.crawl.finished': 'SEO_CRAWL_COMPLETED',
  'automation.created': 'AUTOMATION_CREATED',
  'automation.updated': 'AUTOMATION_UPDATED',
  'automation.deleted': 'AUTOMATION_DELETED',
  'api_key.created': 'API_KEY_CREATED',
  'api_key.revoked': 'API_KEY_REVOKED',
  'governance.updated': 'SECURITY_SETTING_CHANGED',
};

const CATEGORY_BY_PREFIX: Array<[string, AuditCategory]> = [
  ['auth.', 'auth'],
  ['account.', 'auth'],
  ['user.', 'auth'],
  ['organization.', 'organization'],
  ['invitation.', 'member'],
  ['member.', 'member'],
  ['integration.action_', 'ai'],
  ['integration.', 'integration'],
  ['search_console.', 'integration'],
  ['agent.', 'ai'],
  ['youtube.analyst', 'ai'],
  ['tiktok.analyst', 'ai'],
  ['seo.agent', 'ai'],
  ['seo.auditor', 'ai'],
  ['content.', 'content'],
  ['wordpress.', 'content'],
  ['tiktok.publish', 'content'],
  ['seo.', 'seo'],
  ['automation.', 'automation'],
  ['report.', 'report'],
  ['billing.', 'billing'],
  ['api_key.', 'api_key'],
  ['governance.', 'security'],
];

export function auditCategory(action: string): AuditCategory {
  for (const [prefix, category] of CATEGORY_BY_PREFIX) {
    if (action.startsWith(prefix)) return category;
  }
  return 'data';
}

/** Canonical upper-snake event type; unmapped actions are derived mechanically. */
export function auditEventType(action: string): string {
  return CANONICAL[action] ?? action.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** All stored action strings belonging to a category (for filtering). */
export function actionPrefixesFor(category: AuditCategory): string[] {
  return CATEGORY_BY_PREFIX.filter(([, c]) => c === category).map(([p]) => p);
}

/** Sentence-case label for the UI, e.g. "Integration reauthorized". */
export function auditLabel(action: string): string {
  const type = auditEventType(action);
  const words = type.toLowerCase().split('_');
  const sentence = words
    .join(' ')
    .replace(/\bai\b/g, 'AI')
    .replace(/\bseo\b/g, 'SEO')
    .replace(/\bapi\b/g, 'API');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
