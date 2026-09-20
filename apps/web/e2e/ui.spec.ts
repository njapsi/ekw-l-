import { expect, test } from '@playwright/test';

/**
 * Browser-workflow tests for the unauthenticated surface (Phase 15 QA):
 * the auth forms (incl. failure states), marketing content, and mobile layout.
 * Signed-in workflows are in `authed.spec.ts` (DB-backed, CI).
 */

test.describe('auth form', () => {
  // The password tab is the default (ADR-0049): "Welcome back", an email +
  // password form, a "Magic Link" tab alongside it, and a link to sign up.
  test('login shows the password form, the magic-link tab and the signup link', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: /^log in$/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /magic link/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /create an account/i })).toBeVisible();
  });

  test('the magic-link tab shows its own form', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('tab', { name: /magic link/i }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();
  });

  test('rejects an email with no TLD client-side (no magic-link request fires)', async ({
    page,
  }) => {
    let sendAttempted = false;
    page.on('request', (r) => {
      if (/\/api\/auth\/(signin|callback)\/nodemailer/.test(r.url())) sendAttempted = true;
    });
    await page.goto('/login');
    await page.getByRole('tab', { name: /magic link/i }).click();
    // `a@b` passes the browser's native `type=email` check but fails the form's
    // own `EMAIL_RE` (which requires a dot), so the JS handler returns early and
    // shows its message without dispatching the magic-link send.
    await page.getByLabel('Email').fill('a@b');
    await page.getByRole('button', { name: /send magic link/i }).click();
    await expect(page.getByText(/could not send the sign-in link/i)).toBeVisible();
    // Still on the input form — not the "check your email" state.
    await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();
    expect(sendAttempted).toBe(false);
  });

  test('a magic-link send that fails (no mail backend) surfaces an error, not a crash', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('tab', { name: /magic link/i }).click();
    await page.getByLabel('Email').fill('qa-user@example.com');
    await page.getByRole('button', { name: /send magic link/i }).click();
    // Without a database/mail transport the send fails; the form must show a
    // friendly message OR the "check your email" state — never an unhandled
    // error page.
    await expect(
      page.getByText(/could not send the sign-in link|check .* for a sign-in link/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('the session-expired reason renders its notice', async ({ page }) => {
    await page.goto('/login?reason=session_expired');
    await expect(page.getByText(/your session expired/i)).toBeVisible();
  });

  test('signup renders its own heading', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  });
});

const PUBLIC = ['/', '/features', '/pricing', '/docs', '/login', '/signup'];

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const path of PUBLIC) {
    test(`${path} fits the viewport with no horizontal scroll`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('body')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // Allow 1px for sub-pixel rounding.
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    });
  }

  test('the landing page CTA is reachable on mobile', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible();
  });
});

test.describe('not-found', () => {
  test('an unknown path renders the 404 page, not a stack trace', async ({ page }) => {
    const res = await page.goto('/this-route-does-not-exist-qa');
    expect(res?.status()).toBe(404);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/at Object\.<anonymous>|node_modules/);
  });
});
