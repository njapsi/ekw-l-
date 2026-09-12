import { defineConfig } from 'vitest/config';

// Without this, vitest walks up to the repo-root config whose include is
// scripts glob only, so the worker suite silently matched nothing
// (FORENSIC-AUDIT B-2). Scope it to the worker's own tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
