/**
 * Organization API keys (Phase 2, Part 18). ADR-0052.
 *
 * Format: `ga_<prefix>_<secret>` — a public 12-hex-char lookup prefix and a
 * 256-bit random secret. Only SHA-256(secret) is stored; the full key is
 * returned exactly once, at creation. SHA-256 (not a slow KDF) is correct for
 * 256-bit random secrets: there is nothing to brute-force.
 *
 * Least privilege: a key's scopes can never exceed its creator's current
 * permissions, and every request re-checks that the creator is still an
 * active member whose role still grants each scope — so demoting or removing
 * a person also neuters the keys they made.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, prisma, requireMembership } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac/authorize.js';
import { type Permission, roleHasPermission } from '../rbac/permissions.js';
import { recordSecurityEvent } from '../security/events.js';

export const API_SCOPES = [
  'agent:read',
  'agent:run',
  'analytics:read',
  'content:read',
  'content:write',
  'seo:read',
  'seo:write',
  'integrations:read',
  'integrations:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** The permission a creator must hold to mint each scope. */
export const SCOPE_PERMISSION: Record<ApiScope, Permission> = {
  'agent:read': 'agent.view',
  'agent:run': 'agent.run',
  'analytics:read': 'analytics.view',
  'content:read': 'content.view',
  'content:write': 'content.create',
  'seo:read': 'seo.view',
  'seo:write': 'seo.analyze',
  'integrations:read': 'integration.view',
  'integrations:manage': 'integration.manage',
};

export const MAX_ACTIVE_KEYS_PER_ORG = 25;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const KEY_RE = /^ga_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1, 'Give the key a name.').max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose at least one scope.'),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

export async function createApiKey(
  actorUserId: string,
  organizationId: string,
  raw: z.input<typeof createApiKeyInput>,
  db: Db = prisma,
) {
  const input = createApiKeyInput.parse(raw);
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, 'api_key.create');
  const scopes = [...new Set(input.scopes)];
  const excess = scopes.filter((s) => !roleHasPermission(m.role, SCOPE_PERMISSION[s]));
  if (excess.length) {
    throw AppError.forbidden(`Your role cannot grant: ${excess.join(', ')}.`);
  }
  const active = await db.apiKey.count({ where: { organizationId, revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS_PER_ORG) {
    throw AppError.conflict(
      `An organization can have at most ${MAX_ACTIVE_KEYS_PER_ORG} active keys.`,
    );
  }

  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const row = await db.apiKey.create({
    data: {
      organizationId,
      name: input.name,
      prefix,
      secretHash: sha256(secret),
      scopes,
      createdById: actorUserId,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    },
    select: { id: true, name: true, prefix: true, scopes: true, createdAt: true, expiresAt: true },
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row.id,
      metadata: { name: row.name, prefix, scopes, expiresAt: row.expiresAt?.toISOString() ?? null },
    },
    db,
  );
  await recordSecurityEvent(
    { userId: actorUserId, organizationId, type: 'API_KEY_CREATED', metadata: { prefix, scopes } },
    db,
  );
  // The only time the full key exists outside the caller's clipboard.
  return { ...row, key: `ga_${prefix}_${secret}` };
}

export async function listApiKeys(actorUserId: string, organizationId: string, db: Db = prisma) {
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, 'api_key.view');
  return db.apiKey.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdById: true,
    },
  });
}

export async function revokeApiKey(
  actorUserId: string,
  organizationId: string,
  keyId: string,
  db: Db = prisma,
) {
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, 'api_key.revoke');
  const res = await db.apiKey.updateMany({
    where: { id: keyId, organizationId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: actorUserId },
  });
  if (res.count === 0) throw AppError.notFound('API key');
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: keyId,
    },
    db,
  );
  await recordSecurityEvent(
    { userId: actorUserId, organizationId, type: 'API_KEY_REVOKED', metadata: { keyId } },
    db,
  );
}

export interface ApiPrincipal {
  keyId: string;
  organizationId: string;
  scopes: ApiScope[];
  createdById: string;
}

const INVALID = () => AppError.unauthenticated('Invalid or expired API key.');

/**
 * Resolve a presented key to its organization + scopes, or throw a single
 * generic 401 (no oracle distinguishing unknown / revoked / expired keys).
 */
export async function authenticateApiKey(
  presented: string | null | undefined,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ApiPrincipal> {
  const match = presented ? KEY_RE.exec(presented.trim()) : null;
  if (!match) throw INVALID();
  const [, prefix, secret] = match as unknown as [string, string, string];
  const row = await db.apiKey.findUnique({ where: { prefix } });
  const expected = Buffer.from(row?.secretHash ?? sha256('x'), 'hex');
  const actual = Buffer.from(sha256(secret), 'hex');
  const hashOk = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!row || !hashOk || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) throw INVALID();

  const creator = await db.membership.findUnique({
    where: {
      userId_organizationId: { userId: row.createdById, organizationId: row.organizationId },
    },
    select: { role: true, status: true },
  });
  const scopes = row.scopes.filter((s): s is ApiScope =>
    (API_SCOPES as readonly string[]).includes(s),
  );
  if (
    !creator ||
    creator.status !== 'ACTIVE' ||
    scopes.some((s) => !roleHasPermission(creator.role, SCOPE_PERMISSION[s]))
  ) {
    throw INVALID();
  }

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  }
  return {
    keyId: row.id,
    organizationId: row.organizationId,
    scopes,
    createdById: row.createdById,
  };
}

export function requireScope(principal: ApiPrincipal, scope: ApiScope): void {
  if (!principal.scopes.includes(scope)) {
    throw AppError.forbidden(`This API key lacks the "${scope}" scope.`);
  }
}
