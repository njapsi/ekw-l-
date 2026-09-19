/**
 * Security events (Phase 2, Part 32): account-level signals, separate from
 * the org-scoped product audit log. They belong to a *person* across every
 * organization, and power "login history" and "security events" in
 * Settings → Security.
 *
 * Like `recordAudit`, recording never throws into the caller — a failed
 * write is logged, so it can never break the sign-in or change that
 * triggered it.
 */
import { isIP } from 'node:net';
import { type Db, type Prisma, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { scrubContext } from '../observability/scrub.js';

const log = createLogger('security-events');

export const SECURITY_EVENT_TYPES = [
  'AUTH_LOGIN',
  'AUTH_LOGIN_FAILED',
  'REPEATED_LOGIN_FAILURE',
  'AUTH_LOGOUT',
  'NEW_SESSION',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'MAGIC_LINK_REQUESTED',
  'EMAIL_VERIFIED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_REACTIVATED',
  'ACCOUNT_DELETION_REQUESTED',
  'ROLE_ESCALATION',
  'OWNER_TRANSFER',
  'MEMBER_REMOVED',
  'API_KEY_CREATED',
  'API_KEY_REVOKED',
  'ORG_DELETION_REQUESTED',
  'INTEGRATION_REAUTHORIZED',
  'MFA_CHANGED',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export type SecuritySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Reduce an IP to a coarse network prefix (IPv4 /24, IPv6 /48). Enough to
 * notice "a sign-in from a new network", without storing the full address.
 */
export function toIpPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const clean = ip.trim().replace(/^::ffff:/i, '');
  const kind = isIP(clean);
  if (kind === 4) {
    const parts = clean.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (kind === 6) {
    const groups = expandIPv6(clean);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

/** Expand a (possibly `::`-compressed) IPv6 address to 8 lowercase groups. */
function expandIPv6(ip: string): string[] | null {
  const [head = '', tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return null;
  const missing = 8 - h.length - t.length;
  if (missing < 0) return null;
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => g.replace(/^0+(?=.)/, '')) : null;
}

/** A short, non-identifying label for a user-agent string. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

export interface SecurityEventInput {
  userId?: string | null;
  organizationId?: string | null;
  type: SecurityEventType;
  severity?: SecuritySeverity;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordSecurityEvent(
  input: SecurityEventInput,
  db: Db = prisma,
): Promise<void> {
  try {
    await db.securityEvent.create({
      data: {
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        type: input.type,
        severity: input.severity ?? 'INFO',
        ipPrefix: toIpPrefix(input.ip),
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        metadata: input.metadata
          ? (scrubContext(input.metadata) as Prisma.InputJsonValue)
          : undefined,
      },
    });
  } catch (err) {
    log.error(
      { type: input.type, err: err instanceof Error ? err.message : String(err) },
      'failed to record security event',
    );
  }
}

export async function listSecurityEvents(
  userId: string,
  opts: { types?: SecurityEventType[]; limit?: number } = {},
  db: Db = prisma,
) {
  return db.securityEvent.findMany({
    where: { userId, ...(opts.types ? { type: { in: opts.types } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 200),
    select: {
      id: true,
      type: true,
      severity: true,
      ipPrefix: true,
      userAgent: true,
      metadata: true,
      createdAt: true,
    },
  });
}
