import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * E2E. Boots a production build and checks the public surface, route
 * protection, and the health endpoint — no database required for those.
 * Authenticated/deep-flow specs (journey.spec.ts, failures.spec.ts,
 * security.spec.ts, authed.spec.ts) additionally need Postgres + `E2E_AUTHED=1`
 * and self-skip without it (see docs/E2E-TESTING.md).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Unbounded local parallelism launches one Chromium instance per CPU core,
  // all hitting `next start` in the same instant it reports healthy; on this
  // Windows dev machine the very first wave of navigations occasionally
  // exceeds the 30s test timeout under that burst (reproduced: 100% reliable
  // serially, 0-4 transient timeouts at full parallelism, never the same test
  // twice, never anything past the first request of any given worker). A
  // small local retry count is the standard fix for exactly this — CI's
  // Linux runner has never shown it and keeps its own retry count.
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/growth_agent_e2e',
      DIRECT_URL:
        process.env.DIRECT_URL ??
        process.env.DATABASE_URL ??
        'postgresql://localhost:5432/growth_agent_e2e',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-insecure-secret-value-0123456789',
      // Without this, Auth.js's `trustHost` origin detection falls back to
      // its hardcoded `http://localhost:3000` default for every sign-in
      // redirect it builds server-side (confirmed live: the `Location`
      // header pointed at :3000 regardless of the actual request's Host
      // header). Nothing listens on :3000 here, so every `page.goto()` that
      // followed one of those redirects failed with ERR_CONNECTION_REFUSED
      // — deterministically, not flakily (reproduced with `--workers=1`).
      // Production requires and validates AUTH_URL === NEXT_PUBLIC_APP_URL
      // (config/env.ts), so this gap only ever existed in this harness.
      AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      NO_PRETTY_LOGS: '1',
      // Fake-but-well-formed OAuth client config so youtubeConfigured() /
      // tiktokConfigured() / searchConsoleConfigured() report "configured"
      // and journey.spec.ts can exercise the real "Connect" → provider
      // authorize-URL redirect (never a real provider request — the flow
      // stops at our own /api/integrations/*/connect route, which only
      // needs a client id to build the URL, not a working one).
      ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ??
        '02da02ee47f4716ba09bbe0e9821643dc3a51b19162ca2c4cd6298ce07f41e85',
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'e2e-fake-google-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET:
        process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'e2e-fake-google-client-secret',
      TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY ?? 'e2e-fake-tiktok-client-key',
      TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET ?? 'e2e-fake-tiktok-client-secret',
      // This is a production *build* under test, not a production
      // *deployment* — relax config/env.ts's prod-strict footgun checks
      // (AUTH_URL must be https+non-localhost, ENCRYPTION_KEY required, a
      // real sign-in path required) while type-checking still runs on
      // whatever is provided. Without this, `next start` under
      // NODE_ENV=production + a localhost NEXT_PUBLIC_APP_URL throws at
      // boot and every route touching `@growth-agent/services` 500s,
      // including /api/health (docs/E2E-TESTING.md finding 1).
      GROWTH_AGENT_ENV_STRICT: '0',
    },
  },
});
