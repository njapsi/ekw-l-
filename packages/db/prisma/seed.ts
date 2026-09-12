/**
 * Development seed. Dev-only data, clearly marked (master instruction H).
 * Refuses to run against a production database.
 *
 *   pnpm --filter @growth-agent/db seed
 */
import { PrismaClient, OrgType, Role, StaffLevel } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const owner = await prisma.user.upsert({
    where: { email: 'owner@example.com' },
    update: {},
    create: {
      email: 'owner@example.com',
      name: 'Demo Owner',
      emailVerified: new Date(),
      profile: { create: {} },
    },
  });

  const member = await prisma.user.upsert({
    where: { email: 'member@example.com' },
    update: {},
    create: {
      email: 'member@example.com',
      name: 'Demo Member',
      emailVerified: new Date(),
      profile: { create: {} },
    },
  });

  const org = await prisma.organization.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: { name: 'Demo Organization', slug: 'demo-org', type: OrgType.TEAM },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: owner.id, organizationId: org.id } },
    update: { role: Role.OWNER },
    create: { userId: owner.id, organizationId: org.id, role: Role.OWNER },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: member.id, organizationId: org.id } },
    update: { role: Role.MEMBER },
    create: { userId: member.id, organizationId: org.id, role: Role.MEMBER },
  });

  await prisma.platformStaff.upsert({
    where: { userId: owner.id },
    update: { level: StaffLevel.SUPERADMIN },
    create: { userId: owner.id, level: StaffLevel.SUPERADMIN },
  });

  console.warn(
    `Seeded dev data:\n  org=${org.slug} (${org.id})\n  owner=owner@example.com (also platform SUPERADMIN)\n  member=member@example.com`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
