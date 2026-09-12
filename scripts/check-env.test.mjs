import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./check-env.mjs', import.meta.url));

/** Run the script with a fully-controlled env; return { code, out }. */
function run(env, args = ['--target', 'web']) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const SECRET = 'S3cr3t-do-not-print-me-abcdef0123456789';
const GOOD = {
  NODE_ENV: 'production',
  DATABASE_URL: `postgresql://u:${SECRET}@db.example:5432/app`,
  DIRECT_URL: `postgresql://u:${SECRET}@db.example:5432/app`,
  AUTH_SECRET: Buffer.alloc(32, 7).toString('base64'),
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  REDIS_URL: `rediss://:${SECRET}@redis.example:6379`,
  AUTH_URL: 'https://app.example.com',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  // A realistic prod config must have at least one working sign-in path.
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 'rk_live_xxxxxxxxxxxxxxxxxxxx',
};

describe('check-env.mjs', () => {
  it('exits 1 and lists MISSING for an empty production env', () => {
    const { code, out } = run({ NODE_ENV: 'production' });
    expect(code).toBe(1);
    expect(out).toMatch(/DATABASE_URL\s+.*MISSING/);
    expect(out).toMatch(/AUTH_SECRET\s+.*MISSING/);
    expect(out).toMatch(/blocking problem/);
  });

  it('exits 0 when the core production set is present and valid', () => {
    const { code, out } = run(GOOD);
    expect(code).toBe(0);
    expect(out).toMatch(/✓ ready/);
  });

  it('NEVER prints a secret value', () => {
    const { out } = run({
      ...GOOD,
      STRIPE_SECRET_KEY: `sk_live_${SECRET}`,
      GOOGLE_OAUTH_CLIENT_SECRET: SECRET,
    });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('sk_live_');
    // it still reports them
    expect(out).toMatch(/GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it('rejects http:// AUTH_URL in production but accepts it with --allow-insecure', () => {
    const bad = run({ ...GOOD, AUTH_URL: 'http://staging.example.com' });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/AUTH_URL\s+.*invalid/);
    expect(bad.out).toMatch(/https\/wss in production/);

    const ok = run({ ...GOOD, AUTH_URL: 'http://staging.example.com' }, [
      '--target',
      'web',
      '--allow-insecure',
    ]);
    expect(ok.code).toBe(0);
  });

  it('blocks AUTH_DEV_LOGIN=true in production', () => {
    const { code, out } = run({ ...GOOD, AUTH_DEV_LOGIN: 'true' });
    expect(code).toBe(1);
    expect(out).toMatch(/AUTH_DEV_LOGIN.*invalid/);
    expect(out).toMatch(/MUST NOT be "true"/);
  });

  it('blocks a partially-configured feature group (billing)', () => {
    const { code, out } = run({ ...GOOD, STRIPE_SECRET_KEY: 'sk_live_x' });
    expect(code).toBe(1);
    expect(out).toMatch(/billing: partially configured/);
  });

  it('rejects a non-postgres DATABASE_URL with a rule-only reason', () => {
    const { code, out } = run({ ...GOOD, DATABASE_URL: 'mysql://u:p@h/db' });
    expect(code).toBe(1);
    expect(out).toMatch(/DATABASE_URL\s+.*invalid/);
    expect(out).toMatch(/postgres/);
    expect(out).not.toContain('mysql://u:p@h/db');
  });

  it('--json emits a machine-readable summary without values', () => {
    const { out } = run({ ...GOOD }, ['--target', 'all', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.vars.find((v) => v.name === 'DATABASE_URL').status).toBe('set');
    expect(out).not.toContain(SECRET);
  });

  it('worker target requires REDIS_URL', () => {
    const { code, out } = run({ ...GOOD, REDIS_URL: '' }, ['--target', 'worker']);
    expect(code).toBe(1);
    expect(out).toMatch(/REDIS_URL\s+.*MISSING/);
  });

  it('blocks a production config with no working sign-in path (FORENSIC-AUDIT D-2)', () => {
    const { code, out } = run({
      ...GOOD,
      EMAIL_TRANSPORT: 'console',
      RESEND_API_KEY: '',
      GOOGLE_OAUTH_CLIENT_ID: '',
      GOOGLE_OAUTH_CLIENT_SECRET: '',
    });
    expect(code).toBe(1);
    expect(out).toMatch(/no working sign-in path/);
  });

  it('accepts EMAIL_TRANSPORT=resend as a sign-in path', () => {
    const { code } = run({ ...GOOD, EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'rk_x' });
    expect(code).toBe(0);
  });
});
