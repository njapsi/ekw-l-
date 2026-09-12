import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres. They self-skip when
 * `DATABASE_URL` (or `TEST_DATABASE_URL`) is not reachable, so `pnpm test` stays
 * green on a machine without a database. CI provides a Postgres service.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
