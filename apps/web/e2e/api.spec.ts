import { expect, test } from '@playwright/test';

/**
 * API-contract tests (Phase 15 QA). These exercise the HTTP surface directly
 * with Playwright's `request` fixture against the production build. They do NOT
 * need a database — every assertion is about auth gating, status codes, error
 * shape, headers and rate-limit behaviour, which all resolve before any DB
 * work. Authenticated + data-dependent flows are covered by the integration
 * suite and `authed.spec.ts`.
 */

test.describe('security headers', () => {
  test('every response carries the hardening headers (Phase 14)', async ({ request }) => {
    const res = await request.get('/login');
    const h = res.headers();
    expect(h['content-security-policy']).toBeTruthy();
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("object-src 'none'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('geolocation=()');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    // No framework fingerprint, no permissive CORS.
    expect(h['x-powered-by']).toBeUndefined();
    expect(h['access-control-allow-origin']).toBeUndefined();
  });
});

test.describe('GET /api/health', () => {
  test('returns 200 with a per-dependency body', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; state: string }[];
    };
    expect(['ok', 'degraded', 'down']).toContain(body.status);
    const names = body.checks.map((c) => c.name).sort();
    expect(names).toEqual(['ai_provider', 'database', 'external_integrations', 'redis', 'worker']);
    for (const c of body.checks) {
      expect(['ok', 'degraded', 'down', 'unconfigured']).toContain(c.state);
    }
  });

  test('?deep=1 is ignored for an anonymous caller (no AI probe)', async ({ request }) => {
    const res = await request.get('/api/health?deep=1');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { checks: { name: string; detail?: string }[] };
    const ai = body.checks.find((c) => c.name === 'ai_provider');
    // Anonymous ⇒ never the deep "reachable/unreachable" wording.
    expect(ai?.detail ?? '').not.toMatch(/reachable/);
  });

  test('survives a burst without a 5xx (rate-limited or cached, never crash)', async ({
    request,
  }) => {
    const codes = await Promise.all(
      Array.from({ length: 30 }, () => request.get('/api/health').then((r) => r.status())),
    );
    for (const c of codes) expect([200, 429]).toContain(c);
  });
});

test.describe('GET /api/metrics', () => {
  test('anonymous is forbidden', async ({ request }) => {
    const res = await request.get('/api/metrics', { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
  });

  test('a wrong bearer token is forbidden', async ({ request }) => {
    const res = await request.get('/api/metrics', {
      headers: { authorization: 'Bearer definitely-not-the-token' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('POST /api/billing/webhook', () => {
  test('an unsigned body is rejected (400) or acknowledged when unconfigured (200) — never 3xx/5xx', async ({
    request,
  }) => {
    const res = await request.post('/api/billing/webhook', {
      data: { id: 'evt_qa', type: 'ping' },
    });
    expect([200, 400]).toContain(res.status());
  });

  test('a GET is not allowed', async ({ request }) => {
    const res = await request.get('/api/billing/webhook', { maxRedirects: 0 });
    expect([404, 405]).toContain(res.status());
  });

  test('a malformed (non-JSON) body does not 500', async ({ request }) => {
    const res = await request.post('/api/billing/webhook', {
      headers: { 'content-type': 'application/json' },
      data: '}{ not json',
    });
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe('POST /api/agent/stream', () => {
  test('an unauthenticated POST never returns an SSE stream', async ({ request }) => {
    const res = await request.post('/api/agent/stream', { data: { message: 'hi' } });
    expect(res.headers()['content-type'] ?? '').not.toContain('text/event-stream');
  });

  test('a GET is not allowed', async ({ request }) => {
    const res = await request.get('/api/agent/stream', { maxRedirects: 0 });
    expect([404, 405]).toContain(res.status());
  });
});

test.describe('OAuth callback routes', () => {
  test('google callback with ?error=access_denied redirects with a clean error param', async ({
    page,
  }) => {
    await page.goto('/api/integrations/google/callback?error=access_denied');
    await expect(page).toHaveURL(/\/(login|app\/integrations\/youtube\?error=access_denied)/);
  });

  test('google callback with no code/state and no session redirects (login or error)', async ({
    page,
  }) => {
    const resp = await page.goto('/api/integrations/google/callback');
    // Either bounced to /login (no session) or to the integrations page with an
    // error param — never a 200 render, never a 500.
    expect(resp?.status() ?? 0).toBeLessThan(500);
    await expect(page).toHaveURL(/\/(login|app\/integrations)/);
  });

  test('the connect route requires a session', async ({ page }) => {
    const resp = await page.goto('/api/integrations/youtube/connect');
    expect(resp?.url() ?? '').toMatch(/\/login(\?|$)/);
  });
});

test.describe('NextAuth endpoints', () => {
  test('the CSRF token endpoint is reachable and returns a token', async ({ request }) => {
    const res = await request.get('/api/auth/csrf');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { csrfToken?: string };
    expect(body.csrfToken).toBeTruthy();
  });

  test('the providers endpoint lists the configured providers', async ({ request }) => {
    const res = await request.get('/api/auth/providers');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, { id: string }>;
    // Magic-link (nodemailer) is always present; dev-credentials is prod-off.
    expect(body.nodemailer?.id).toBe('nodemailer');
    expect(body['dev-credentials']).toBeUndefined();
  });
});

test.describe('public share links', () => {
  test('a well-formed but unknown token never redirects and never serves content', async ({
    request,
  }) => {
    // Production (DB reachable) returns 404; this no-DB e2e server 500s on the
    // lookup. Either way the security-relevant properties hold: no redirect,
    // no 2xx, no redacted-snapshot body. The strict "unknown ⇒ 404" is proven
    // in `reports/share.test.ts` + the integration layer.
    const token = 'A'.repeat(43); // base64url of 32 bytes
    const res = await request.get(`/r/${token}`, { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.headers()['location']).toBeUndefined();
    expect(await res.text()).not.toContain('Executive Summary');
  });

  test('a malformed token is a plain 404, rejected before any lookup', async ({ request }) => {
    const res = await request.get('/r/bad', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()['location']).toBeUndefined();
  });
});

test.describe('public API keys (/api/v1, Phase 2)', () => {
  test('rejects a request with no key, without reading any session', async ({ request }) => {
    const res = await request.get('/api/v1/whoami');
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toBe('Bearer');
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.json()).toEqual({ error: 'Invalid or expired API key.' });
  });

  test('a malformed or forged key gets the same generic 401 (no oracle)', async ({ request }) => {
    for (const key of ['nope', `ga_${'0'.repeat(12)}_${'A'.repeat(43)}`, 'Bearer ga_x_y']) {
      const res = await request.get('/api/v1/connections', {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid or expired API key.' });
    }
  });

  test('a browser session cookie is not an API credential', async ({ request }) => {
    const res = await request.get('/api/v1/whoami', {
      headers: { cookie: 'authjs.session-token=anything; __Secure-authjs.session-token=anything' },
    });
    expect(res.status()).toBe(401);
  });

  test('no permissive CORS on the public API', async ({ request }) => {
    const res = await request.get('/api/v1/whoami', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });
});

test.describe('identity pages require a session (Phase 2)', () => {
  for (const path of [
    '/app/settings/security',
    '/app/settings/members',
    '/app/settings/audit',
    '/app/settings/api-keys',
    '/app/settings/ai-governance',
    '/app/settings/account/export',
    '/app/settings/audit/export',
  ]) {
    test(`${path} redirects an anonymous visitor to sign in`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([302, 303, 307, 308]).toContain(res.status());
      expect(res.headers()['location']).toContain('/login');
    });
  }

  test('an invitation link never accepts anything for an anonymous visitor', async ({
    request,
  }) => {
    const res = await request.get(`/invite/${'A'.repeat(43)}`, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toContain('/login');
  });
});
