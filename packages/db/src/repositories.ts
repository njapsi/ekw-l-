import type { Membership, Organization, Prisma, PrismaClient, Role } from '@prisma/client';
import { prisma as defaultPrisma } from './index.js';

/**
 * Tenant-scoped data access. Application code (services) must go through these
 * helpers rather than calling `prisma.<model>` directly, so every tenant query
 * carries an `organizationId` and membership is checked. A lint rule + review
 * enforce this; Postgres RLS is the runtime backstop (docs/SECURITY.md §3).
 */
export type Db = PrismaClient | Prisma.TransactionClient;

export class TenantAccessError extends Error {
  constructor(
    readonly userId: string,
    readonly organizationId: string,
  ) {
    super(`User ${userId} has no active membership in organization ${organizationId}`);
    this.name = 'TenantAccessError';
  }
}

/** Resolve the caller's active membership, or throw `TenantAccessError`. */
export async function requireMembership(
  userId: string,
  organizationId: string,
  db: Db = defaultPrisma,
): Promise<Membership> {
  const membership = await db.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    throw new TenantAccessError(userId, organizationId);
  }
  return membership;
}

/** All organizations the user is an active member of, with their role. */
export async function listOrganizationsForUser(
  userId: string,
  db: Db = defaultPrisma,
): Promise<Array<Organization & { role: Role }>> {
  const memberships = await db.membership.findMany({
    where: { userId, status: 'ACTIVE', organization: { deletedAt: null } },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map((m) => ({ ...m.organization, role: m.role }));
}

/** A single organization the user may access. Returns null when not permitted. */
export async function getOrganizationForUser(
  userId: string,
  organizationId: string,
  db: Db = defaultPrisma,
): Promise<(Organization & { role: Role }) | null> {
  const membership = await db.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    include: { organization: true },
  });
  if (!membership || membership.status !== 'ACTIVE' || membership.organization.deletedAt) {
    return null;
  }
  return { ...membership.organization, role: membership.role };
}

/**
 * Run a callback with an assured membership. Use this to wrap any tenant-scoped
 * operation so the `organizationId` filter is never forgotten.
 */
export async function withOrgScope<T>(
  args: { userId: string; organizationId: string; db?: Db },
  fn: (ctx: { membership: Membership; db: Db }) => Promise<T>,
): Promise<T> {
  const db = args.db ?? defaultPrisma;
  const membership = await requireMembership(args.userId, args.organizationId, db);
  return fn({ membership, db });
}
