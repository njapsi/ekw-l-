import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TenantAccessError,
  getOrganizationForUser,
  listOrganizationsForUser,
  requireMembership,
  withOrgScope,
} from './repositories.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

let reachable = false;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

describe('tenant-scoped repositories (integration)', () => {
  it('is skipped without a reachable database', () => {
    if (!reachable) {
      console.warn(
        '[integration] no DATABASE_URL/TEST_DATABASE_URL — skipping DB integration tests',
      );
    }
    expect(true).toBe(true);
  });

  maybe()('enforces membership and isolates organizations', async () => {
    const db = prisma!;
    const tag = `it_${Date.now()}`;

    const userA = await db.user.create({ data: { email: `${tag}-a@example.com` } });
    const userB = await db.user.create({ data: { email: `${tag}-b@example.com` } });
    const orgA = await db.organization.create({
      data: {
        name: 'A',
        slug: `${tag}-a`,
        memberships: { create: { userId: userA.id, role: 'OWNER' } },
      },
    });
    const orgB = await db.organization.create({
      data: {
        name: 'B',
        slug: `${tag}-b`,
        memberships: { create: { userId: userB.id, role: 'OWNER' } },
      },
    });

    try {
      // A sees only org A.
      const aOrgs = await listOrganizationsForUser(userA.id, db);
      expect(aOrgs.map((o) => o.id)).toEqual([orgA.id]);

      // A cannot read org B.
      expect(await getOrganizationForUser(userA.id, orgB.id, db)).toBeNull();

      // requireMembership throws for a non-member.
      await expect(requireMembership(userA.id, orgB.id, db)).rejects.toBeInstanceOf(
        TenantAccessError,
      );

      // withOrgScope runs for a member, rejects for a non-member.
      const role = await withOrgScope({ userId: userA.id, organizationId: orgA.id, db }, (ctx) =>
        Promise.resolve(ctx.membership.role),
      );
      expect(role).toBe('OWNER');
      await expect(
        withOrgScope({ userId: userA.id, organizationId: orgB.id, db }, () =>
          Promise.resolve('nope'),
        ),
      ).rejects.toBeInstanceOf(TenantAccessError);
    } finally {
      await db.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
      await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    }
  });

  maybe()('a suspended membership is denied', async () => {
    const db = prisma!;
    const tag = `it_susp_${Date.now()}`;
    const user = await db.user.create({ data: { email: `${tag}@example.com` } });
    const org = await db.organization.create({
      data: {
        name: 'S',
        slug: tag,
        memberships: { create: { userId: user.id, role: 'ADMIN', status: 'SUSPENDED' } },
      },
    });
    try {
      await expect(requireMembership(user.id, org.id, db)).rejects.toBeInstanceOf(
        TenantAccessError,
      );
      expect(await getOrganizationForUser(user.id, org.id, db)).toBeNull();
    } finally {
      await db.organization.delete({ where: { id: org.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
