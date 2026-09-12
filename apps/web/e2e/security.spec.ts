import { expect, test } from '@playwright/test';
import {
  AUTHED,
  checkReachable,
  cleanupOrg,
  prisma,
  seedCrawl,
  seedOrg,
  seedVerifiedWebsite,
  signIn,
  tag,
} from './support/seed';

/**
 * Phase 27 — security: unauthorized routes, cross-user (same-org, wrong
 * role), cross-organization, and admin restrictions. `smoke.spec.ts` already
 * covers every *unauthenticated* redirect and `authed.spec.ts` covers the
 * first RBAC/admin case each — this file extends both to more surfaces and
 * adds the authenticated-cross-tenant cases neither covers. Self-skips
 * without `E2E_AUTHED=1` + a reachable Postgres.
 */

let reachable = false;
test.beforeAll(async () => {
  reachable = await checkReachable();
});

const run = AUTHED ? test : test.skip;
const needDb = () => test.skip(!reachable, 'database not reachable');

test.describe('unauthorized routes (authenticated, wrong permission)', () => {
  run(
    'a VIEWER cannot add a website (crawl:run/integration:manage required)',
    async ({ page, context }) => {
      needDb();
      const db = prisma!;
      const t = tag('sec-viewer-site');
      const { orgId, orgSlug } = await seedOrg(db, t);
      const viewer = await db.user.create({
        data: { email: `${t}-viewer@example.com`, name: 'QA Viewer', emailVerified: new Date() },
      });
      await db.membership.create({
        data: { userId: viewer.id, organizationId: orgId, role: 'VIEWER', status: 'ACTIVE' },
      });
      await signIn(context, {
        id: viewer.id,
        email: `${t}-viewer@example.com`,
        name: 'QA Viewer',
        orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'VIEWER' }],
      });

      await page.goto('/app/seo');
      await page.getByLabel('Website URL').fill('https://example.com');
      await page.getByRole('button', { name: /^add website$/i }).click();
      await expect(page.locator('.text-destructive').first()).toBeVisible({ timeout: 10_000 });
      expect(await db.website.count({ where: { organizationId: orgId } })).toBe(0);

      await cleanupOrg(db, orgId, [viewer.id]);
    },
  );

  run('a VIEWER cannot use the AI agent (agent:run required)', async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('sec-viewer-agent');
    const { orgId, orgSlug } = await seedOrg(db, t);
    const viewer = await db.user.create({
      data: { email: `${t}-viewer@example.com`, name: 'QA Viewer', emailVerified: new Date() },
    });
    await db.membership.create({
      data: { userId: viewer.id, organizationId: orgId, role: 'VIEWER', status: 'ACTIVE' },
    });
    await signIn(context, {
      id: viewer.id,
      email: `${t}-viewer@example.com`,
      name: 'QA Viewer',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'VIEWER' }],
    });

    const res = await page.request.post('/api/agent/stream', { data: { message: 'hi' } });
    expect(res.status()).toBe(403);

    await cleanupOrg(db, orgId, [viewer.id]);
  });
});

test.describe('cross-user access (same organization, wrong role)', () => {
  run(
    'a MEMBER cannot connect an integration (integration:manage is ADMIN+)',
    async ({ page, context }) => {
      needDb();
      const db = prisma!;
      const t = tag('sec-member-connect');
      const { orgId, orgSlug } = await seedOrg(db, t);
      const member = await db.user.create({
        data: { email: `${t}-member@example.com`, name: 'QA Member', emailVerified: new Date() },
      });
      await db.membership.create({
        data: { userId: member.id, organizationId: orgId, role: 'MEMBER', status: 'ACTIVE' },
      });
      await signIn(context, {
        id: member.id,
        email: `${t}-member@example.com`,
        name: 'QA Member',
        orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'MEMBER' }],
      });

      const res = await page.request.get('/api/integrations/youtube/connect', {
        maxRedirects: 0,
      });
      // Never a redirect straight into Google's consent screen for a role that
      // isn't allowed to manage integrations.
      expect(res.headers()['location'] ?? '').not.toContain('accounts.google.com');

      await cleanupOrg(db, orgId, [member.id]);
    },
  );
});

test.describe('cross-organization access', () => {
  run(
    "org A cannot read org B's website by id (404, never the data)",
    async ({ page, context }) => {
      needDb();
      const db = prisma!;
      const t = tag('sec-cross-org-site');
      const a = await seedOrg(db, `${t}a`);
      const b = await seedOrg(db, `${t}b`);
      const siteB = await seedVerifiedWebsite(db, b.orgId, 'https://cross-org-b.example.com');
      await signIn(context, {
        id: a.userId,
        email: a.email,
        name: 'QA Owner',
        orgs: [{ id: a.orgId, slug: a.orgSlug, name: 'Org A', role: 'OWNER' }],
      });

      const res = await page.goto(`/app/seo/${siteB.id}`);
      expect(res?.status()).toBe(404);
      await expect(page.locator('body')).not.toContainText('cross-org-b.example.com');

      await cleanupOrg(db, a.orgId, [a.userId]);
      await cleanupOrg(db, b.orgId, [b.userId]);
    },
  );

  run(
    "org A cannot read org B's crawl via a mismatched website/crawl pair",
    async ({ page, context }) => {
      needDb();
      const db = prisma!;
      const t = tag('sec-cross-org-crawl');
      const a = await seedOrg(db, `${t}a`);
      const b = await seedOrg(db, `${t}b`);
      const siteA = await seedVerifiedWebsite(db, a.orgId, 'https://cross-org-a.example.com');
      const siteB = await seedVerifiedWebsite(db, b.orgId, 'https://cross-org-b2.example.com');
      const crawlB = await seedCrawl(db, { websiteId: siteB.id, organizationId: b.orgId });
      await signIn(context, {
        id: a.userId,
        email: a.email,
        name: 'QA Owner',
        orgs: [{ id: a.orgId, slug: a.orgSlug, name: 'Org A', role: 'OWNER' }],
      });

      const res = await page.goto(`/app/seo/${siteA.id}/crawls/${crawlB.id}`);
      expect(res?.status()).toBe(404);

      await cleanupOrg(db, a.orgId, [a.userId]);
      await cleanupOrg(db, b.orgId, [b.userId]);
    },
  );

  run("org A cannot read org B's content project by id", async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('sec-cross-org-content');
    const a = await seedOrg(db, `${t}a`);
    const b = await seedOrg(db, `${t}b`);
    const projectB = await db.repurposeProject.create({
      data: {
        organizationId: b.orgId,
        createdById: b.userId,
        name: 'Org B private project',
        sourceType: 'MANUAL',
        sourceBody: 'Org B private source content that org A must never see.',
        status: 'DRAFT',
      },
    });
    await signIn(context, {
      id: a.userId,
      email: a.email,
      name: 'QA Owner',
      orgs: [{ id: a.orgId, slug: a.orgSlug, name: 'Org A', role: 'OWNER' }],
    });

    const res = await page.goto(`/app/content/${projectB.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.locator('body')).not.toContainText('Org B private source content');

    await cleanupOrg(db, a.orgId, [a.userId]);
    await cleanupOrg(db, b.orgId, [b.userId]);
  });

  run("org A cannot read org B's automation rule by id", async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('sec-cross-org-auto');
    const a = await seedOrg(db, `${t}a`);
    const b = await seedOrg(db, `${t}b`);
    const ruleB = await db.automationRule.create({
      data: {
        organizationId: b.orgId,
        ownerId: b.userId,
        createdById: b.userId,
        name: 'Org B private automation',
        taskType: 'GROWTH_REPORT',
        cadence: 'WEEKLY',
        cronExpression: '0 9 * * 1',
        config: {},
      },
    });
    await signIn(context, {
      id: a.userId,
      email: a.email,
      name: 'QA Owner',
      orgs: [{ id: a.orgId, slug: a.orgSlug, name: 'Org A', role: 'OWNER' }],
    });

    const res = await page.goto(`/app/automations/${ruleB.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.locator('body')).not.toContainText('Org B private automation');

    await cleanupOrg(db, a.orgId, [a.userId]);
    await cleanupOrg(db, b.orgId, [b.userId]);
  });
});

test.describe('admin restrictions', () => {
  for (const path of ['/admin/organizations', '/admin/users', '/admin/system-health']) {
    run(`${path} 302s a normal (non-staff) user to /app`, async ({ page, context }) => {
      needDb();
      const db = prisma!;
      const t = tag('sec-admin');
      const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
      await signIn(context, {
        id: userId,
        email,
        name: 'QA Owner',
        orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
      });

      await page.goto(path);
      await expect(page).toHaveURL(/\/app(\/|$)/);

      await cleanupOrg(db, orgId, [userId]);
    });
  }
});
