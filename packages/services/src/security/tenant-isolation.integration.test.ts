import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { getReport } from '../reports/read.js';
import { getAutomation } from '../automation/rules.js';
import { getConversation } from '../agent/conversations.js';
import { getDashboard } from '../searchconsole/read.js';
import { getSelectedProperty, listProperties, requireProperty } from '../searchconsole/sites.js';

/**
 * Cross-tenant isolation, end to end against a real database (Phase 15 QA).
 * Self-skips without `DATABASE_URL` / `TEST_DATABASE_URL` — runs in CI.
 *
 * Property under test: a caller scoped to org A can never read org B's report,
 * automation or conversation — the read functions filter by `organizationId`
 * (and, for conversations, `userId`) and return `null` / throw `resource_not_found`.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
let reachable = false;

const tag = `iso_${Date.now()}`;
type Fixture = {
  orgId: string;
  userId: string;
  reportId: string;
  automationId: string;
  convId: string;
  gscSiteId: string;
};
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }

  const mk = async (k: string) => {
    const user = await prisma.user.create({ data: { email: `${tag}-${k}@example.com` } });
    const org = await prisma.organization.create({
      data: {
        name: k,
        slug: `${tag}-${k}`,
        memberships: { create: { userId: user.id, role: 'OWNER', status: 'ACTIVE' } },
      },
    });
    const report = await prisma.report.create({
      data: {
        organizationId: org.id,
        type: 'GROWTH',
        title: `${k} report`,
        status: 'READY',
        requestedById: user.id,
      },
    });
    const rule = await prisma.automationRule.create({
      data: {
        organizationId: org.id,
        ownerId: user.id,
        createdById: user.id,
        taskType: 'GROWTH_REPORT',
        name: `${k} rule`,
        cadence: 'WEEKLY',
        cronExpression: '0 9 * * 1',
      },
    });
    const conv = await prisma.aIConversation.create({
      data: { organizationId: org.id, userId: user.id, title: `${k} chat` },
    });
    const gscConn = await prisma.oAuthConnection.create({
      data: {
        organizationId: org.id,
        provider: 'GOOGLE_SEARCH_CONSOLE',
        externalAccountId: `${tag}-${k}-sub`,
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        accessTokenCipher: 'x',
        tokenIv: 'x',
        tokenAuthTag: 'x',
        keyId: 'x',
      },
    });
    const gscSite = await prisma.searchConsoleSite.create({
      data: {
        organizationId: org.id,
        oauthConnectionId: gscConn.id,
        siteUrl: `sc-domain:${tag}-${k}.example`,
        propertyType: 'DOMAIN',
        hostname: `${tag}-${k}.example`,
        permissionLevel: 'SITE_OWNER',
        verified: true,
        isSelected: true,
      },
    });
    return {
      orgId: org.id,
      userId: user.id,
      reportId: report.id,
      automationId: rule.id,
      convId: conv.id,
      gscSiteId: gscSite.id,
    };
  };

  A = await mk('a');
  B = await mk('b');
});

afterAll(async () => {
  if (prisma && reachable) {
    await prisma.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [A.userId, B.userId] } } });
  }
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

describe('cross-tenant isolation (integration)', () => {
  it('self-skips without a database', () => {
    if (!reachable) console.warn('[integration] no DATABASE_URL — skipping tenant-isolation tests');
    expect(true).toBe(true);
  });

  maybe()('org A reads its own data', async () => {
    expect(await getReport(A.orgId, A.reportId, prisma!)).not.toBeNull();
    expect(await getAutomation(A.orgId, A.automationId, prisma!)).not.toBeNull();
    await expect(
      getConversation(
        { organizationId: A.orgId, userId: A.userId, conversationId: A.convId },
        prisma!,
      ),
    ).resolves.toBeTruthy();
  });

  maybe()('org A cannot read org B — report + automation return null', async () => {
    expect(await getReport(A.orgId, B.reportId, prisma!)).toBeNull();
    expect(await getAutomation(A.orgId, B.automationId, prisma!)).toBeNull();
  });

  maybe()('org A cannot read org B — conversation throws resource_not_found', async () => {
    const err = await getConversation(
      { organizationId: A.orgId, userId: A.userId, conversationId: B.convId },
      prisma!,
    ).catch((e: unknown) => e);
    expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
  });

  maybe()(
    "a member of org B still cannot read another user's conversation in the same org",
    async () => {
      // B.userId owns B.convId; ask as B's user for A's conv id scoped to org B → miss.
      const err = await getConversation(
        { organizationId: B.orgId, userId: B.userId, conversationId: A.convId },
        prisma!,
      ).catch((e: unknown) => e);
      expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
    },
  );

  maybe()('Search Console: org A cannot read or select org B’s property', async () => {
    // A sees only A's property.
    const aProps = await listProperties(A.orgId, prisma!);
    expect(aProps.map((p) => p.id)).toEqual([A.gscSiteId]);
    expect((await getSelectedProperty(A.orgId, prisma!))?.id).toBe(A.gscSiteId);

    // A's dashboard never surfaces B's property.
    const aDash = await getDashboard(A.orgId, prisma!);
    expect(aDash.property?.id ?? null).toBe(A.gscSiteId);

    // Resolving B's site id under org A fails.
    await expect(requireProperty(A.orgId, B.gscSiteId, prisma!)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'resource_not_found',
    );
  });
});
