/**
 * Boot-time environment validation (Phase 19 — FORENSIC-AUDIT D-3 / M-10).
 *
 * Importing this module runs `loadEnv()` for its side effect: a misconfigured
 * deployment now fails **at process start with a readable field list**, not at
 * the first request that happens to need a missing variable. It is imported by
 * `apps/web/app/layout.tsx` (the server root) and `apps/worker/src/main.ts`.
 *
 * `scripts/check-env.mjs` remains the *pre-deploy* gate (it never prints a
 * secret value and can run against a file); this is the *runtime* backstop.
 *
 * Rules:
 *  - Always type-checked when present.
 *  - When `NODE_ENV === 'production'` the core set is **required** and a few
 *    footguns are refused outright (`AUTH_DEV_LOGIN=true`, `http://` origins,
 *    a config with no possible sign-in path).
 */
import { z } from 'zod';

/**
 * "Enforce the production ruleset" — true only when this is a real running
 * process in production, NOT during `next build` (which sets NODE_ENV=production
 * but has no runtime secrets) and NOT under vitest. Type validation still runs
 * in every mode; only the *required-in-prod* / footgun rules are gated on this.
 */
const isProd =
  process.env.NODE_ENV === 'production' &&
  process.env.NEXT_PHASE !== 'phase-production-build' &&
  !process.env.VITEST &&
  process.env.GROWTH_AGENT_ENV_STRICT !== '0';
const req = <T extends z.ZodTypeAny>(schema: T) => (isProd ? schema : schema.optional());

/** ≥32 bytes as hex, base64, or raw. */
const secret32 = z.string().refine((v) => {
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return v.length / 2 >= 32;
  try {
    if (/^[A-Za-z0-9+/_=-]+$/.test(v) && Buffer.from(v, 'base64').length >= 32) return true;
  } catch {
    /* fall through */
  }
  return v.length >= 32;
}, 'must be at least 32 bytes (openssl rand -base64 32)');

const httpsUrlInProd = z
  .string()
  .url()
  .refine(
    (v) => {
      if (!isProd) return true;
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';
      } catch {
        return false;
      }
    },
    { message: 'must be an https:// origin (not localhost) in production' },
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: req(
      z
        .string()
        .url()
        .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
    ),
    DIRECT_URL: req(z.string().url()),

    AUTH_SECRET: isProd ? secret32 : secret32.optional(),
    ENCRYPTION_KEY: isProd ? secret32 : secret32.optional(),
    REDIS_URL: req(
      z
        .string()
        .url()
        .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// URL')
        .refine((v) => !isProd || /^rediss:\/\//.test(v), 'must use TLS (rediss://) in production'),
    ),

    AUTH_URL: req(httpsUrlInProd),
    NEXT_PUBLIC_APP_URL: req(httpsUrlInProd),

    AUTH_DEV_LOGIN: z
      .enum(['true', 'false'])
      .optional()
      .refine((v) => !(isProd && v === 'true'), 'must not be "true" in production'),

    EMAIL_TRANSPORT: z.enum(['console', 'smtp', 'resend']).optional(),
    EMAIL_SERVER: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

    // --- AI layer (Phase 22) — all optional; sane defaults in code ---
    AI_DEFAULT_PROVIDER: z.enum(['anthropic', 'openai', 'google']).optional(),
    AI_DEFAULT_MODEL: z.string().optional(),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).optional(),
    /** Comma list of `provider:model` tried in order when the primary fails. */
    AI_FALLBACK_MODELS: z.string().optional(),
    /** Kill switch: truthy disables every model call. */
    AI_DISABLED: z.string().optional(),
    /** Comma list of provider names to disable individually. */
    AI_DISABLED_PROVIDERS: z.string().optional(),
    AI_MODEL_ROUTER: z.string().optional(),
    AI_MODEL_ANALYST: z.string().optional(),
    AI_MODEL_LONG_CONTEXT: z.string().optional(),
    AI_MODEL_EMBEDDING: z.string().optional(),
    /** Per-user AI request throttle (in front of the per-org monthly quota). */
    AI_USER_RATE_LIMIT: z.coerce.number().int().positive().optional(),
    AI_USER_RATE_WINDOW_SEC: z.coerce.number().int().positive().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .passthrough();

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Returns at least one working way for a user to sign in, or a reason string.
 * A production deploy with no email delivery AND no Google OAuth has no sign-in
 * path at all — that is a hard error, not a warning.
 */
export function authDeliveryStatus(e: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  paths: string[];
  reason?: string;
} {
  const paths: string[] = [];
  if (e.RESEND_API_KEY) paths.push('email:resend');
  if (e.EMAIL_TRANSPORT === 'smtp' && e.EMAIL_SERVER) paths.push('email:smtp');
  if (e.EMAIL_TRANSPORT === 'console' || !e.EMAIL_TRANSPORT) paths.push('email:console(dev-only)');
  if (e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET) paths.push('oauth:google');

  const realPaths = paths.filter((p) => p !== 'email:console(dev-only)');
  if (realPaths.length > 0) return { ok: true, paths: realPaths };
  return {
    ok: false,
    paths,
    reason:
      'no working sign-in path: set RESEND_API_KEY, or EMAIL_TRANSPORT=smtp + EMAIL_SERVER, or GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET',
  };
}

/**
 * Validate `process.env`. Throws an `Error` whose message lists every failing
 * field. Cached after the first successful call.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }

  if (isProd) {
    if (env.AUTH_URL && env.NEXT_PUBLIC_APP_URL && env.AUTH_URL !== env.NEXT_PUBLIC_APP_URL) {
      problems.push('  AUTH_URL / NEXT_PUBLIC_APP_URL: must be identical in production');
    }
    const auth = authDeliveryStatus(env);
    if (!auth.ok) problems.push(`  auth: ${auth.reason}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration (${problems.length} problem(s)):\n${problems.join('\n')}\n` +
        `Run \`node scripts/check-env.mjs --target all\` before deploying.`,
    );
  }

  // No problems recorded ⇒ the schema parse succeeded.
  if (parsed.success) {
    cached = parsed.data;
    return cached;
  }
  throw new Error('unreachable: env parse failed without recorded problems');
}

// Side effect: validate on import.
export const env: Env = loadEnv();
