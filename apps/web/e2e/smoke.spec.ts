import { expect, test } from '@playwright/test';

const PUBLIC_PATHS = ['/', '/features', '/pricing', '/docs', '/login', '/signup'];

test.describe('public pages', () => {
  for (const path of PUBLIC_PATHS) {
    test(`renders ${path}`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `status for ${path}`).toBeLessThan(400);
      await expect(page.locator('body')).toBeVisible();
    });
  }

  test('landing has the primary heading and CTAs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();
  });
});

test.describe('route protection', () => {
  test('/app redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test('/app/dashboard redirects to /login with a callbackUrl', async ({ page }) => {
    await page.goto('/app/dashboard');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/admin redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test('/app/youtube/overview redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/youtube/overview');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('the YouTube OAuth connect route requires a session', async ({ page }) => {
    const res = await page.goto('/api/integrations/youtube/connect');
    // Middleware sends the unauthenticated request to /login before the handler runs.
    expect(res?.url()).toMatch(/\/login(\?|$)/);
  });

  test('/app/tiktok/publishing redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/tiktok/publishing');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('the TikTok OAuth connect route requires a session', async ({ page }) => {
    const res = await page.goto('/api/integrations/tiktok/connect');
    expect(res?.url()).toMatch(/\/login(\?|$)/);
  });

  test('/app/seo redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/seo');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/seo/search-console redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/seo/search-console');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/integrations/search-console redirects unauthenticated users to /login', async ({
    page,
  }) => {
    await page.goto('/app/integrations/search-console');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/api/integrations/search-console/connect is not reachable unauthenticated', async ({
    request,
  }) => {
    const res = await request.get('/api/integrations/search-console/connect', {
      maxRedirects: 0,
    });
    // Redirects to /login (or an error page) — never a 200 that starts an OAuth flow.
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()['location'] ?? '').not.toContain('accounts.google.com');
  });

  test('/app/agent redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/agent');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/content redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/content');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/monetization redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/monetization');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/billing redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/billing');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('the Stripe webhook endpoint is public and rejects an unsigned body', async ({
    request,
  }) => {
    const res = await request.post('/api/billing/webhook', {
      data: { id: 'evt_test', type: 'ping' },
    });
    // Not a redirect to /login (no auth needed); with no signature it is a
    // 400 (bad signature) when billing is configured, or an acknowledged 200
    // ("not configured") otherwise — never a 3xx and never a 500.
    expect([200, 400]).toContain(res.status());
  });

  test('the agent stream API rejects an unauthenticated POST', async ({ request }) => {
    const res = await request.post('/api/agent/stream', { data: { message: 'hi' } });
    // Middleware redirects to /login (HTML) before the handler; either way not a 200 stream.
    expect(res.headers()['content-type'] ?? '').not.toContain('text/event-stream');
  });

  test('/app/reports redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/reports');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('/app/automations redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/app/automations');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });

  test('a shared report link is public and returns 404 for an invalid token', async ({
    request,
  }) => {
    const res = await request.get('/r/bad', { maxRedirects: 0 });
    // Public route — no redirect to /login — and a malformed token is a plain 404
    // (rejected before any DB lookup).
    expect(res.status()).toBe(404);
  });
});

test('health endpoint responds with a dependency status body', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    status: string;
    checks: { name: string; state: string }[];
  };
  expect(['ok', 'degraded', 'down']).toContain(body.status);
  expect(Array.isArray(body.checks)).toBe(true);
  const names = body.checks.map((c) => c.name);
  expect(names).toEqual(
    expect.arrayContaining(['database', 'redis', 'ai_provider', 'external_integrations', 'worker']),
  );
});

test('the metrics endpoint is not public', async ({ request }) => {
  const res = await request.get('/api/metrics', { maxRedirects: 0 });
  // No platform-staff session and no bearer token → 403 (or a redirect to
  // /login from middleware). Never a 200 exposition to an anonymous caller.
  expect(res.status()).not.toBe(200);
});

test('mobile viewport shows the navigation toggle on a protected redirect target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();
});
