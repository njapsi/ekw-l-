import { PrismaClient } from '@growth-agent/db';
import { type BrowserContext, expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/**
 * Authenticated browser workflows (Phase 15 QA). These need a real database, so
 * they **self-skip** unless `E2E_AUTHED=1` and the DB is reachable — CI provides
 * both (see `.github/workflows/ci.yml`); a plain `pnpm test:e2e` run skips them.
 *
 * Rather than driving a real magic-link (needs a mail transport) or the dev
 * credentials provider (prod-disabled — Phase 14), each test mints the same JWE
 * session cookie NextAuth would issue, for a user it seeds directly.
 */

const AUTHED = process.env.E2E_AUTHED === '1';
const DB_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const SECRET = process.env.AUTH_SECRET ?? 'e2e-insecure-secret-value-0123456789';
const COOKIE = 'authjs.session-token'; // http origin ⇒ no __Secure- prefix
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100';

const prisma = AUTHED && DB_URL ? new PrismaClient({ datasources: { db: { url: DB_URL } } }) : null;
let reachable = false;

interface Seeded {
  ownerId: string;
  viewerId: string;
  staffId: string;
  orgId: string;
  orgSlug: string;
}
let seeded: Seeded | null = null;
const tag = `e2e_${Date.now()}`;

test.beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }

  const owner = await prisma.user.create({
    data: { email: `${tag}-owner@example.com`, name: 'QA Owner', emailVerified: new Date() },
  });
  const viewer = await prisma.user.create({
    data: { email: `${tag}-viewer@example.com`, name: 'QA Viewer', emailVerified: new Date() },
  });
  const staff = await prisma.user.create({
    data: { email: `${tag}-staff@example.com`, name: 'QA Staff', emailVerified: new Date() },
  });
  await prisma.platformStaff.create({ data: { userId: staff.id, level: 'SUPPORT' } });

  const org = await prisma.organization.create({
    data: {
      name: 'QA Org',
      slug: `${tag}-org`,
      memberships: {
        create: [
          { userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
          { userId: viewer.id, role: 'VIEWER', status: 'ACTIVE' },
        ],
      },
    },
  });

  seeded = {
    ownerId: owner.id,
    viewerId: viewer.id,
    staffId: staff.id,
    orgId: org.id,
    orgSlug: org.slug,
  };
});

test.afterAll(async () => {
  if (prisma && seeded) {
    await prisma.organization.deleteMany({ where: { id: seeded.orgId } });
    await prisma.user.deleteMany({
      where: { id: { in: [seeded.ownerId, seeded.viewerId, seeded.staffId] } },
    });
  }
  await prisma?.$disconnect();
});

async function signIn(
  context: BrowserContext,
  who: {
    id: string;
    email: string;
    name: string;
    isPlatformStaff?: boolean;
    orgs: { id: string; slug: string; name: string; role: string }[];
  },
) {
  const value = await encode({
    salt: COOKIE,
    secret: SECRET,
    token: {
      uid: who.id,
      email: who.email,
      name: who.name,
      picture: null,
      orgs: who.orgs,
      isPlatformStaff: who.isPlatformStaff ?? false,
      sv: 0,
    },
  });
  await context.addCookies([{ name: COOKIE, value, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
}

// Collection-time gate on the (sync) env flag; the DB-reachability check runs in
// `beforeAll` and each test bails via `test.skip(!reachable, …)` if CI's Postgres
// is somehow down.
const run = AUTHED ? test : test.skip;
const needDb = () => test.skip(!reachable || !seeded, 'database not reachable / not seeded');

run('the dashboard renders for a signed-in owner', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  await expect(page.locator('body')).toBeVisible();
  await expect(page.getByRole('navigation')).toBeVisible();
});

run('an app page shows its empty state, not an error', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/automations');
  await expect(page).toHaveURL(/\/app\/automations/);
  await expect(page.getByRole('heading', { name: /automations/i })).toBeVisible();
});

run(
  'RBAC — a VIEWER does not see the create-automation form an OWNER sees',
  async ({ browser }) => {
    needDb();
    const s = seeded!;

    const ownerCtx = await browser.newContext();
    await signIn(ownerCtx, {
      id: s.ownerId,
      email: `${tag}-owner@example.com`,
      name: 'QA Owner',
      orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
    });
    const ownerPage = await ownerCtx.newPage();
    await ownerPage.goto('/app/automations');
    const ownerHasForm = await ownerPage
      .getByLabel(/name/i)
      .first()
      .isVisible()
      .catch(() => false);

    const viewerCtx = await browser.newContext();
    await signIn(viewerCtx, {
      id: s.viewerId,
      email: `${tag}-viewer@example.com`,
      name: 'QA Viewer',
      orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'VIEWER' }],
    });
    const viewerPage = await viewerCtx.newPage();
    await viewerPage.goto('/app/automations');
    const viewerHasForm = await viewerPage
      .getByLabel(/name/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(ownerHasForm).toBe(true);
    expect(viewerHasForm).toBe(false);

    await ownerCtx.close();
    await viewerCtx.close();
  },
);

run('/admin renders for platform staff and 302s a normal user to /app', async ({ browser }) => {
  needDb();
  const s = seeded!;

  const staffCtx = await browser.newContext();
  await signIn(staffCtx, {
    id: s.staffId,
    email: `${tag}-staff@example.com`,
    name: 'QA Staff',
    isPlatformStaff: true,
    orgs: [],
  });
  const staffPage = await staffCtx.newPage();
  await staffPage.goto('/admin');
  await expect(staffPage).toHaveURL(/\/admin/);
  await expect(staffPage.getByText(/platform (overview|staff)/i).first()).toBeVisible();
  await staffCtx.close();

  const userCtx = await browser.newContext();
  await signIn(userCtx, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  const userPage = await userCtx.newPage();
  await userPage.goto('/admin');
  await expect(userPage).toHaveURL(/\/app(\/|$)/);
  await userCtx.close();
});

run('session revocation — bumping sessionVersion forces re-login', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/app\/dashboard/);

  await prisma!.user.update({
    where: { id: s.ownerId },
    data: { sessionVersion: { increment: 1 } },
  });

  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/login/);

  // restore for other tests
  await prisma!.user.update({ where: { id: s.ownerId }, data: { sessionVersion: 0 } });
});

// --- Phase 3: UI/UX shell, command palette, missions, theme (Part 43) ---

run('the missions page renders real connection state, not fake data', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/missions');
  await expect(page).toHaveURL(/\/app\/missions/);
  await expect(page.getByRole('heading', { name: /growth missions/i })).toBeVisible();
  // No platform is connected for this seeded org, so every mission must say
  // so plainly rather than showing a fabricated "Active" status.
  await expect(page.getByText(/not connected/i).first()).toBeVisible();
});

run('the command palette opens with Cmd+K and navigates', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/dashboard');
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByPlaceholder(/search or jump to/i).fill('missions');
  await page.getByRole('option', { name: /missions/i }).click();
  await expect(page).toHaveURL(/\/app\/missions/);
});

run('the sidebar can collapse to an icon rail and back', async ({ context, page }) => {
  needDb();
  const s = seeded!;
  await signIn(context, {
    id: s.ownerId,
    email: `${tag}-owner@example.com`,
    name: 'QA Owner',
    orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
  });
  await page.goto('/app/dashboard');
  const collapseButton = page.getByRole('button', { name: /collapse sidebar/i });
  await expect(collapseButton).toBeVisible();
  await collapseButton.click();
  await expect(page.getByRole('button', { name: /expand sidebar/i })).toBeVisible();
  // Nav labels are visually hidden (icon rail) but stay in the accessibility
  // tree, so the "Home" destination is still reachable by name. Scoped to the
  // desktop sidebar's own <nav> — the mobile bottom nav renders a second
  // "Home" link that is merely CSS-hidden at this viewport, not absent.
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }),
  ).toBeVisible();
});

run(
  'the theme toggle switches data-theme and persists across a reload',
  async ({ context, page }) => {
    needDb();
    const s = seeded!;
    await signIn(context, {
      id: s.ownerId,
      email: `${tag}-owner@example.com`,
      name: 'QA Owner',
      orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
    });
    await page.goto('/app/dashboard');
    await page.getByRole('button', { name: /^theme:/i }).click();
    await page.getByRole('menuitem', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    // The anti-FOUC script re-applies the stored preference before hydration.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  },
);

test.describe('mobile app shell', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  run('shows a bottom nav bar with primary destinations', async ({ context, page }) => {
    needDb();
    const s = seeded!;
    await signIn(context, {
      id: s.ownerId,
      email: `${tag}-owner@example.com`,
      name: 'QA Owner',
      orgs: [{ id: s.orgId, slug: s.orgSlug, name: 'QA Org', role: 'OWNER' }],
    });
    await page.goto('/app/dashboard');
    const bottomNav = page.getByRole('navigation', { name: 'Primary' });
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'AI Agent' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
