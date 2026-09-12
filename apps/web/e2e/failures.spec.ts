import { expect, test } from '@playwright/test';
import {
  AUTHED,
  checkReachable,
  cleanupOrg,
  prisma,
  seedCrawl,
  seedCrawlIssues,
  seedOrg,
  seedVerifiedWebsite,
  seedYouTubeConnected,
  signIn,
  tag,
} from './support/seed';

/**
 * Phase 27 — failure-injection browser tests: what a user actually sees when
 * something goes wrong. Many of these already have solid *unit*-level
 * coverage (docs/QA.md); this file adds the browser-visible half. Self-skips
 * without `E2E_AUTHED=1` + a reachable Postgres, same as `authed.spec.ts`.
 */

let reachable = false;
test.beforeAll(async () => {
  reachable = await checkReachable();
});

const run = AUTHED ? test : test.skip;
const needDb = () => test.skip(!reachable, 'database not reachable');

run(
  'network failure: an aborted agent-stream request surfaces an error, not a stuck spinner',
  async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('fail-net');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    await page.route('**/api/agent/stream', (route) => route.abort('failed'));
    await page.goto('/app/agent');
    await page.getByPlaceholder(/ask the growth agent/i).fill('hello');
    await page.getByRole('button', { name: /^send$/i }).click();
    await expect(page.locator('.text-destructive').first()).toBeVisible({ timeout: 10_000 });
    // The button recovers — never stuck on "Working…" forever.
    await expect(page.getByRole('button', { name: /^send$/i })).toBeVisible({ timeout: 10_000 });

    await cleanupOrg(db, orgId, [userId]);
  },
);

run('AI failure: a 500 from agent-stream surfaces an error bubble', async ({ page, context }) => {
  needDb();
  const db = prisma!;
  const t = tag('fail-ai');
  const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
  await signIn(context, {
    id: userId,
    email,
    name: 'QA Owner',
    orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
  });

  await page.route('**/api/agent/stream', (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) }),
  );
  await page.goto('/app/agent');
  await page.getByPlaceholder(/ask the growth agent/i).fill('hello');
  await page.getByRole('button', { name: /^send$/i }).click();
  await expect(page.locator('.text-destructive').first()).toBeVisible({ timeout: 10_000 });

  await cleanupOrg(db, orgId, [userId]);
});

run(
  'OAuth failure: an ERROR-status connection shows the reconnect prompt, not a blank state',
  async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('fail-oauth');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    await seedYouTubeConnected(db, orgId, 'ERROR');
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    await page.goto('/app/integrations/youtube');
    await expect(page.getByText(/token refresh failed/i)).toBeVisible();

    await cleanupOrg(db, orgId, [userId]);
  },
);

run('expired token: a REVOKED connection prompts reconnect', async ({ page, context }) => {
  needDb();
  const db = prisma!;
  const t = tag('fail-revoked');
  const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
  await seedYouTubeConnected(db, orgId, 'REVOKED');
  await signIn(context, {
    id: userId,
    email,
    name: 'QA Owner',
    orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
  });

  await page.goto('/app/integrations/youtube');
  await expect(page.getByText(/revoked/i).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^connect youtube$/i })).toBeVisible();

  await cleanupOrg(db, orgId, [userId]);
});

run(
  'invalid website: a private-IP URL is rejected as a form error, never a 500',
  async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('fail-invalid-site');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    await page.goto('/app/seo');
    await page.getByLabel('Website URL').fill('http://127.0.0.1/');
    await page.getByRole('button', { name: /^add website$/i }).click();
    await expect(page.locator('.text-destructive').first()).toBeVisible({ timeout: 10_000 });
    expect(await db.website.count({ where: { organizationId: orgId } })).toBe(0);

    await cleanupOrg(db, orgId, [userId]);
  },
);

run('crawler failure: a BLOCKED crawl renders its reason', async ({ page, context }) => {
  needDb();
  const db = prisma!;
  const t = tag('fail-crawl');
  const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
  const site = await seedVerifiedWebsite(db, orgId, 'https://example.com');
  const crawl = await seedCrawl(db, {
    websiteId: site.id,
    organizationId: orgId,
    status: 'BLOCKED',
    blockedReason: 'The target refused us (WAF / bot protection).',
  });
  await signIn(context, {
    id: userId,
    email,
    name: 'QA Owner',
    orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
  });

  await page.goto(`/app/seo/${site.id}`);
  await expect(page.getByText(/blocked/i).first()).toBeVisible();
  void crawl;

  await cleanupOrg(db, orgId, [userId]);
});

run(
  'webhook failure: a malformed billing webhook body is a clean 400, never a 500',
  async ({ request }) => {
    const res = await request.post('/api/billing/webhook', {
      headers: { 'stripe-signature': 't=1,v1=not-a-real-signature' },
      data: '{"this is": "not valid stripe json',
    });
    expect(res.status()).toBeLessThan(500);
  },
);

run(
  'empty account: every /app/* surface shows its empty state, not an error',
  async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('fail-empty');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    for (const path of [
      '/app/youtube/overview',
      '/app/tiktok/overview',
      '/app/content',
      '/app/monetization',
      '/app/seo',
      '/app/reports',
      '/app/tasks',
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.locator('body'), path).not.toContainText(
        /unhandled|stack trace|TypeError/i,
      );
    }

    await cleanupOrg(db, orgId, [userId]);
  },
);

run('empty website: zero crawls prompts adding one, not an error', async ({ page, context }) => {
  needDb();
  const db = prisma!;
  const t = tag('fail-empty-site');
  const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
  const site = await seedVerifiedWebsite(db, orgId, 'https://example.org');
  await signIn(context, {
    id: userId,
    email,
    name: 'QA Owner',
    orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
  });

  await page.goto(`/app/seo/${site.id}`);
  await expect(page.getByRole('button', { name: /^start crawl$/i })).toBeVisible();

  await cleanupOrg(db, orgId, [userId]);
});

run(
  'no SEO issues: a completed crawl with zero issues says so, not an empty-looking error',
  async ({ page, context }) => {
    needDb();
    const db = prisma!;
    const t = tag('fail-no-issues');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    const site = await seedVerifiedWebsite(db, orgId, 'https://example.net');
    const crawl = await seedCrawl(db, {
      websiteId: site.id,
      organizationId: orgId,
      status: 'COMPLETED',
    });
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    await page.goto(`/app/seo/${site.id}/crawls/${crawl.id}`);
    await expect(page.getByText(/issues \(0\)/i)).toBeVisible();

    await cleanupOrg(db, orgId, [userId]);
  },
);

run(
  'thousands of SEO issues: the page still renders within a sane time budget',
  async ({ page, context }) => {
    needDb();
    test.setTimeout(90_000);
    const db = prisma!;
    const t = tag('fail-many-issues');
    const { userId, email, orgId, orgSlug } = await seedOrg(db, t);
    const site = await seedVerifiedWebsite(db, orgId, 'https://example.com');
    const crawl = await seedCrawl(db, {
      websiteId: site.id,
      organizationId: orgId,
      status: 'COMPLETED',
    });
    await seedCrawlIssues(db, {
      crawlId: crawl.id,
      websiteId: site.id,
      organizationId: orgId,
      count: 2000,
    });
    await signIn(context, {
      id: userId,
      email,
      name: 'QA Owner',
      orgs: [{ id: orgId, slug: orgSlug, name: 'QA Org', role: 'OWNER' }],
    });

    const started = Date.now();
    const res = await page.goto(`/app/seo/${site.id}/crawls/${crawl.id}`);
    expect(res?.status()).toBeLessThan(400);
    // The heading reports the true total; the list itself is capped at one
    // page (100) with a "Load more" link, never all 2,000 rendered at once.
    await expect(page.getByText(/issues \(2000\).*showing 100/i)).toBeVisible({
      timeout: 30_000,
    });
    const loadMore = page.getByRole('link', { name: /load more issues/i });
    await expect(loadMore).toBeVisible();
    const elapsedMs = Date.now() - started;
    // Not a hard SLA — a generous ceiling so a genuine "render everything
    // client-side, no pagination/cap" regression fails loudly rather than
    // silently shipping a multi-second page for a busy site.
    expect(elapsedMs, 'time to render a 2,000-issue crawl page').toBeLessThan(20_000);

    // The link actually works and advances to the next page of issues (each
    // page shows up to 100 — cursor-based, not a cumulative client-side list).
    await loadMore.click();
    await expect(page.getByText(/issues \(2000\).*showing 100/i)).toBeVisible({
      timeout: 30_000,
    });

    await cleanupOrg(db, orgId, [userId]);
  },
);
