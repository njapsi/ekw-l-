import { defineConfig } from 'vitest/config';

/**
 * Root-level tests that are not part of any workspace package — currently just
 * the production env-validation script. Package suites run via `turbo run test`
 * (each package has its own vitest config). This one is wired as
 * `pnpm test:scripts`.
 */
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
