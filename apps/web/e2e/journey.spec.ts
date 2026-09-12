import { expect, test } from '@playwright/test';
import {
  AUTHED,
  BASE,
  checkReachable,
  cleanupOrg,
  initialsOf,
  prisma,
  seedCrawlIssues,
  seedMonetizationOpportunity,
  seedYouTubeConnected,
  signIn,
  tag,
} from './support/seed';

/**
 * Phase 27 — the full realistic user journey, one continuous run. Real UI
 * interaction wherever a real user could reach it; direct Prisma seeding
 * only where the product genuinely has no automatable path (documented
 * per-step below — see docs/E2E-TESTING.md for the full rationale):
 *
 * - Real Google/TikTok/Stripe consent screens are never automated (no live
 *   credentials, and doing so would violate those providers' own policies).
 *   "Connect" is verified to reach the real provider's authorize host; the
 *   *connected* state is exercised by seeding the row a completed OAuth flow
 *   would have written.
 * - The crawl step hits one real, stable public URL (there is no SSRF
 *   allowlist escape hatch, confirmed) — the issues list itself is seeded
 *   deterministically so it never depends on that page's actual content.
 *
 * Self-skips without `E2E_AUTHED=1` + a reachable Postgres, same as
 * `authed.spec.ts`.
 */

let reachable = false;
test.beforeAll(async () => {
  reachable = await checkReachable();
});

const run = AUTHED ? test : test.skip;
const needDb = () => test.skip(!reachable, 'database not reachable');

test.describe.configure({ mode: 'serial' });

run('the full journey: signup through logout', async ({ page, context }) => {
  needDb();
  const db = prisma!;
  const t = tag('journey');

  // --- Landing -----------------------------------------------------
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // --- Signup --------------------------------------------------------
  // Real signup is magic-link only and needs a mail transport we don't have
  // here; the form itself is exercised in ui.spec.ts. The account a magic
  // link would eventually produce is seeded directly.
  await page
    .getByRole('link', { name: /get started/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();

  // A brand-new user with zero memberships, to exercise onboarding for real.
  const newUser = await db.user.create({
    data: { email: `${t}-new@example.com`, name: 'QA Newcomer', emailVerified: new Date() },
  });
  await signIn(context, {
    id: newUser.id,
    email: `${t}-new@example.com`,
    name: 'QA Newcomer',
    orgs: [],
  });

  // --- Onboarding ------------------------------------------------------
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Organization name').fill('QA Journey Org');
  await page.getByRole('button', { name: /create organization/i }).click();
  await expect(page).toHaveURL(/\/app\/dashboard/, { timeout: 15_000 });

  const org = await db.organization.findFirst({
    where: { memberships: { some: { userId: newUser.id } } },
  });
  expect(org).toBeTruthy();
  const orgId = org!.id;
  const orgSlug = org!.slug;

  // Re-sign-in with the org claim populated (the cookie minted before
  // onboarding had none) so the rest of the journey has an active org.
  await signIn(context, {
    id: newUser.id,
    email: `${t}-new@example.com`,
    name: 'QA Newcomer',
    orgs: [{ id: orgId, slug: orgSlug, name: 'QA Journey Org', role: 'OWNER' }],
  });

  // --- Dashboard ---------------------------------------------------
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  await expect(page.getByRole('navigation')).toBeVisible();

  // --- Connect YouTube / TikTok / Search Console ------------------------
  // The buttons reach the real provider's authorize host; the *connected*
  // dashboard state is exercised by seeding (see file header).
  await page.goto('/app/integrations/youtube');
  const [ytPopup] = await Promise.all([
    page.waitForEvent('framenavigated', { timeout: 10_000 }).catch(() => null),
    page.getByRole('link', { name: /^connect youtube$/i }).click(),
  ]);
  void ytPopup;
  await expect(page).toHaveURL(/accounts\.google\.com/, { timeout: 15_000 });

  await seedYouTubeConnected(db, orgId, 'ACTIVE');
  await page.goto('/app/integrations/youtube');
  await expect(page.getByText(/^connected$/i).first()).toBeVisible();

  await page.goto('/app/integrations/tiktok');
  await page.getByRole('link', { name: /connect tiktok/i }).click();
  await expect(page).toHaveURL(/tiktok\.com/, { timeout: 15_000 });

  await page.goto('/app/integrations/search-console');
  await page
    .getByRole('link', { name: /connect/i })
    .first()
    .click();
  await expect(page).toHaveURL(/accounts\.google\.com/, { timeout: 15_000 });

  // --- Add website + crawl ---------------------------------------------
  await page.goto('/app/seo');
  await page.getByLabel('Website URL').fill('https://example.com');
  await page.getByRole('button', { name: /^add website$/i }).click();
  await expect(page.getByText(/added|https:\/\/example\.com/i).first()).toBeVisible({
    timeout: 10_000,
  });

  const website = await db.website.findFirst({ where: { organizationId: orgId } });
  expect(website).toBeTruthy();
  // No verification bypass exists in the product — write exactly what a
  // successful DNS/file check would have written.
  await db.website.update({
    where: { id: website!.id },
    data: { verified: true, verificationMethod: 'DNS_TXT', verifiedAt: new Date() },
  });

  await page.goto(`/app/seo/${website!.id}`);
  await page.getByRole('button', { name: /^start crawl$/i }).click();
  await expect(page.getByText(/crawling|queued|running/i).first()).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(
      async () => {
        const c = await db.crawl.findFirst({
          where: { websiteId: website!.id },
          orderBy: { createdAt: 'desc' },
        });
        return c?.status;
      },
      { timeout: 60_000, message: 'crawl of https://example.com to finish' },
    )
    .toMatch(/COMPLETED|FAILED|BLOCKED/);

  // --- View issues -------------------------------------------------
  // Seeded deterministically so this assertion never depends on what
  // example.com happens to contain.
  const crawl = await db.crawl.findFirst({
    where: { websiteId: website!.id },
    orderBy: { createdAt: 'desc' },
  });
  await seedCrawlIssues(db, {
    crawlId: crawl!.id,
    websiteId: website!.id,
    organizationId: orgId,
    count: 5,
  });
  await page.goto(`/app/seo/${website!.id}/crawls/${crawl!.id}`);
  await expect(page.getByText(/^issues \(\d+\)$/i)).toBeVisible();
  await expect(page.getByText('QA seeded issue 0')).toBeVisible();

  // --- Ask AI Agent (deterministic — no AI key needed) ------------------
  await page.goto('/app/agent');
  await page.getByPlaceholder(/ask the growth agent/i).fill('What are the biggest SEO problems?');
  await page.getByRole('button', { name: /^send$/i }).click();
  await expect(page.getByRole('button', { name: /^send$/i })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('.whitespace-pre-wrap').last()).not.toHaveText('…');

  // --- Generate content --------------------------------------------
  await page.goto('/app/content');
  await page.getByRole('button', { name: /paste content/i }).click();
  await page
    .getByLabel('Source content')
    .fill(
      'This is a long-form piece of source content about landscape photography, written so the '.repeat(
        3,
      ),
    );
  await page.getByRole('button', { name: /^create project$/i }).click();
  await expect(page).toHaveURL(/\/app\/content\/.+/, { timeout: 15_000 });
  await page.getByRole('button', { name: /analyze source/i }).click();
  await expect(page.getByRole('button', { name: /generate all 13 content types/i })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /generate all 13 content types/i }).click();

  const projectId = page.url().split('/content/')[1]!.split(/[/?#]/)[0]!;
  await expect
    .poll(async () => db.contentAsset.count({ where: { repurposeProjectId: projectId } }), {
      timeout: 30_000,
      message: 'content assets to be generated',
    })
    .toBeGreaterThan(0);

  // --- Create recommendation → Create task ------------------------------
  // The only UI-wired "promote to Task" control today is the monetization
  // opportunity card (docs/E2E-TESTING.md documents why
  // createTaskFromRecommendationAction has no calling button yet).
  await seedMonetizationOpportunity(db, orgId);
  await page.goto('/app/monetization');
  await page
    .getByRole('button', { name: /^create task$/i })
    .first()
    .click();
  await expect
    .poll(async () => db.task.count({ where: { organizationId: orgId } }), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await page.goto('/app/tasks');
  await expect(page.getByRole('heading', { name: /^tasks$/i })).toBeVisible();

  // --- Generate report ---------------------------------------------
  await page.goto('/app/reports');
  await page.getByRole('button', { name: /^generate report$/i }).click();
  await expect(page).toHaveURL(/\/app\/reports\/.+/, { timeout: 20_000 });
  await expect(page.getByText(/executive summary/i).first()).toBeVisible();

  // --- View billing / change plan ----------------------------------
  await page.goto('/app/billing');
  await expect(page.getByText(/billing is not set up on this deployment/i)).toBeVisible();
  // No STRIPE_* configured here — every non-Free plan CTA is correctly
  // disabled rather than leading into a doomed checkout call.
  const planButtons = page.getByRole('button', { name: /^choose /i });
  if (await planButtons.count()) {
    await expect(planButtons.first()).toBeDisabled();
  }

  // --- Logout --------------------------------------------------------
  await page.goto('/app/dashboard');
  const initials = initialsOf('QA Newcomer');
  await page.getByRole('button', { name: initials }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page).toHaveURL(BASE + '/', { timeout: 10_000 });
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/login/);

  await cleanupOrg(db, orgId, [newUser.id]);
});
