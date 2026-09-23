#!/usr/bin/env node
/**
 * Production environment validation (Phase 16).
 *
 *   node scripts/check-env.mjs [--target web|worker|all] [--file .env.production] [--json]
 *   pnpm check:env -- --target all
 *
 * Verifies that every variable a production deployment needs is present and
 * well-formed. It NEVER prints a secret value — a secret-shaped variable is
 * reported only as `set` / `MISSING` / `invalid: <reason>`, and every "reason"
 * string is written to describe the *rule*, never to echo the value.
 *
 * Exit code 0 = ready to deploy; 1 = one or more blocking problems.
 * Zero dependencies — safe to run in a minimal release image.
 */

import { readFileSync } from 'node:fs';

// --- args -----------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const TARGET = opt('target', 'all'); // web | worker | all
const FILE = opt('file', null);
const JSON_OUT = has('json');
const STRICT_HTTPS = !has('allow-insecure'); // prod requires https/wss; escape hatch for staging

// --- load an env file if asked (does not override real process.env) -----

if (FILE) {
  try {
    const text = readFileSync(FILE, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.error(`Could not read --file ${FILE}: ${e.message}`);
    process.exit(2);
  }
}

const E = process.env;

// --- validators (reasons describe the rule, never the value) ------------

const url = (schemes) => (v) => {
  let u;
  try {
    u = new URL(v);
  } catch {
    return 'must be a valid URL';
  }
  if (!schemes.includes(u.protocol.replace(':', ''))) {
    return `must use one of: ${schemes.join(', ')}`;
  }
  if (STRICT_HTTPS && ['http', 'ws'].includes(u.protocol.replace(':', ''))) {
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      return 'must not be localhost in production';
    return 'must be https/wss in production (use --allow-insecure for staging)';
  }
  return null;
};

const bytesAtLeast = (n) => (v) => {
  // Accept base64 / hex that decodes to >= n bytes, OR a raw string of >= n chars.
  let decoded = 0;
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) decoded = v.length / 2;
  else if (/^[A-Za-z0-9+/_=-]+$/.test(v)) {
    try {
      decoded = Buffer.from(v, 'base64').length;
    } catch {
      decoded = 0;
    }
  }
  return Math.max(decoded, v.length >= n ? n : 0) >= n
    ? null
    : `must be >= ${n} bytes (generate with: openssl rand -base64 ${n})`;
};

const postgres = (v) =>
  /^postgres(ql)?:\/\//.test(v) ? null : 'must be a postgres:// / postgresql:// connection string';
const redis = (v) => {
  if (!/^rediss?:\/\//.test(v)) return 'must be a redis:// / rediss:// URL';
  if (STRICT_HTTPS && v.startsWith('redis://'))
    return 'must use TLS (rediss://) in production (use --allow-insecure for staging)';
  // Phase 12: an unauthenticated Redis is a real, common misconfiguration —
  // Redis has no auth by default, and this instance holds rate-limit
  // counters, the crawl frontier, job queues, and cache. Require userinfo
  // (a password, with or without a username) in the URL when strict, same
  // escape hatch as the TLS check above.
  if (STRICT_HTTPS) {
    let hasAuth = false;
    try {
      hasAuth = new URL(v).password.length > 0;
    } catch {
      hasAuth = false;
    }
    if (!hasAuth) {
      return 'must include a password (redis[s]://:password@host) in production (use --allow-insecure for staging)';
    }
  }
  return null;
};
const oneOf = (list) => (v) => (list.includes(v) ? null : `must be one of: ${list.join(', ')}`);
const notValue = (bad, msg) => (v) => (v === bad ? msg : null);

// --- variable catalogue -------------------------------------------------
// group: which target(s) need it · required: blocks deploy if missing ·
// secret: never echo · check: returns null | reason

const SECRET = true;

/** @type {Array<{name:string, targets:string[], required:boolean, secret?:boolean, check?:(v:string)=>string|null, note?:string}>} */
const VARS = [
  // ---- core (web + worker) ----
  {
    name: 'NODE_ENV',
    targets: ['web', 'worker'],
    required: true,
    check: oneOf(['production']),
    note: 'production only',
  },
  {
    name: 'DATABASE_URL',
    targets: ['web', 'worker'],
    required: true,
    secret: SECRET,
    check: postgres,
    note: 'pooled connection',
  },
  {
    name: 'DIRECT_URL',
    targets: ['web', 'worker'],
    required: true,
    secret: SECRET,
    check: postgres,
    note: 'unpooled — migrations',
  },
  {
    name: 'AUTH_SECRET',
    targets: ['web', 'worker'],
    required: true,
    secret: SECRET,
    check: bytesAtLeast(32),
    note: 'openssl rand -base64 32',
  },
  {
    name: 'ENCRYPTION_KEY',
    targets: ['web', 'worker'],
    required: true,
    secret: SECRET,
    check: bytesAtLeast(32),
    note: 'AES-256-GCM key for OAuth tokens',
  },
  {
    name: 'REDIS_URL',
    targets: ['web', 'worker'],
    required: true,
    secret: SECRET,
    check: redis,
    note: 'managed Redis — queues, rate limits',
  },
  {
    name: 'AUTH_URL',
    targets: ['web'],
    required: true,
    check: url(['https', 'http']),
    note: 'canonical origin — pins the Host',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    targets: ['web'],
    required: true,
    check: url(['https', 'http']),
    note: 'same as AUTH_URL',
  },
  {
    name: 'AUTH_DEV_LOGIN',
    targets: ['web', 'worker'],
    required: false,
    check: notValue('true', 'MUST NOT be "true" in production (seeded-user login bypass)'),
  },
  {
    name: 'LOG_LEVEL',
    targets: ['web', 'worker'],
    required: false,
    check: oneOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  },

  // ---- object storage (all-or-nothing) ----
  {
    name: 'S3_ENDPOINT',
    targets: ['web', 'worker'],
    required: false,
    check: url(['https', 'http']),
    group: 'object-storage',
  },
  { name: 'S3_REGION', targets: ['web', 'worker'], required: false, group: 'object-storage' },
  { name: 'S3_BUCKET', targets: ['web', 'worker'], required: false, group: 'object-storage' },
  {
    name: 'S3_ACCESS_KEY_ID',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'object-storage',
  },
  {
    name: 'S3_SECRET_ACCESS_KEY',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'object-storage',
  },

  // ---- AI providers (>=1 recommended) ----
  {
    name: 'ANTHROPIC_API_KEY',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'ai-any',
  },
  {
    name: 'OPENAI_API_KEY',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'ai-any',
  },
  {
    name: 'GOOGLE_GENERATIVE_AI_API_KEY',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'ai-any',
  },

  // ---- Google / YouTube OAuth (pair) ----
  {
    name: 'GOOGLE_OAUTH_CLIENT_ID',
    targets: ['web', 'worker'],
    required: false,
    group: 'google-oauth',
  },
  {
    name: 'GOOGLE_OAUTH_CLIENT_SECRET',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'google-oauth',
  },

  // ---- TikTok (pair) ----
  { name: 'TIKTOK_CLIENT_KEY', targets: ['web', 'worker'], required: false, group: 'tiktok' },
  {
    name: 'TIKTOK_CLIENT_SECRET',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    group: 'tiktok',
  },

  // ---- Billing / Stripe (set) ----
  {
    name: 'STRIPE_SECRET_KEY',
    targets: ['web'],
    required: false,
    secret: SECRET,
    group: 'billing',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    targets: ['web'],
    required: false,
    secret: SECRET,
    group: 'billing',
  },
  {
    name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    targets: ['web'],
    required: false,
    group: 'billing',
  },
  { name: 'STRIPE_PRICE_CREATOR_MONTH', targets: ['web'], required: false, group: 'billing' },
  { name: 'STRIPE_PRICE_CREATOR_YEAR', targets: ['web'], required: false, group: 'billing' },
  { name: 'STRIPE_PRICE_PRO_MONTH', targets: ['web'], required: false, group: 'billing' },
  { name: 'STRIPE_PRICE_PRO_YEAR', targets: ['web'], required: false, group: 'billing' },
  { name: 'STRIPE_PRICE_AGENCY_MONTH', targets: ['web'], required: false, group: 'billing' },
  { name: 'STRIPE_PRICE_AGENCY_YEAR', targets: ['web'], required: false, group: 'billing' },

  // ---- Email (required when transport = smtp) ----
  {
    name: 'EMAIL_TRANSPORT',
    targets: ['web'],
    required: false,
    check: oneOf(['console', 'smtp', 'resend']),
  },
  { name: 'EMAIL_FROM', targets: ['web'], required: false },
  { name: 'EMAIL_SERVER', targets: ['web'], required: false, secret: SECRET },
  { name: 'RESEND_API_KEY', targets: ['web'], required: false, secret: SECRET },

  // ---- Observability ----
  {
    name: 'METRICS_TOKEN',
    targets: ['web', 'worker'],
    required: false,
    secret: SECRET,
    note: 'unset ⇒ /api/metrics needs a staff session',
  },
  { name: 'SENTRY_DSN', targets: ['web', 'worker'], required: false, secret: SECRET },
  {
    name: 'WORKER_HEALTH_PORT',
    targets: ['worker'],
    required: false,
    check: (v) => (/^\d{2,5}$/.test(v) ? null : 'must be a TCP port number'),
  },
];

// --- run ---------------------------------------------------------------

const targets = TARGET === 'all' ? ['web', 'worker'] : [TARGET];
const rows = [];
let blocking = 0;
let warnings = 0;

for (const spec of VARS) {
  if (!spec.targets.some((t) => targets.includes(t))) continue;
  const value = E[spec.name];
  const present = value !== undefined && value !== '';

  let status;
  let note = spec.note ?? '';

  if (!present) {
    if (spec.required) {
      status = 'MISSING';
      blocking += 1;
    } else {
      status = '—';
    }
  } else if (spec.check) {
    const reason = spec.check(value);
    if (reason) {
      status = `invalid`;
      note = reason;
      blocking += 1;
    } else {
      status = 'set';
    }
  } else {
    status = 'set';
  }

  rows.push({ name: spec.name, status, note, group: spec.group });
}

// --- group consistency (all-or-nothing / at-least-one) ----------------

const groups = {};
for (const spec of VARS) {
  if (!spec.group) continue;
  if (!spec.targets.some((t) => targets.includes(t))) continue;
  (groups[spec.group] ??= []).push(spec.name);
}

const groupNotes = [];
for (const [group, names] of Object.entries(groups)) {
  const setNames = names.filter((n) => E[n] !== undefined && E[n] !== '');
  if (group === 'ai-any') {
    if (setNames.length === 0) {
      groupNotes.push({
        level: 'warn',
        msg: 'ai: no provider key set — the app runs deterministically (no model planning / synthesis)',
      });
      warnings += 1;
    }
    continue;
  }
  if (setNames.length > 0 && setNames.length < names.length) {
    const missing = names.filter((n) => !setNames.includes(n));
    groupNotes.push({
      level: 'error',
      msg: `${group}: partially configured — also set ${missing.join(', ')}`,
    });
    blocking += 1;
  }
}

// EMAIL_TRANSPORT=smtp needs a server; resend needs a key
if (targets.includes('web') && E.EMAIL_TRANSPORT === 'smtp' && !E.EMAIL_SERVER) {
  groupNotes.push({ level: 'error', msg: 'email: EMAIL_TRANSPORT=smtp requires EMAIL_SERVER' });
  blocking += 1;
}
if (targets.includes('web') && E.EMAIL_TRANSPORT === 'resend' && !E.RESEND_API_KEY) {
  groupNotes.push({ level: 'error', msg: 'email: EMAIL_TRANSPORT=resend requires RESEND_API_KEY' });
  blocking += 1;
}

// There must be at least ONE way for a user to sign in (FORENSIC-AUDIT D-2).
if (targets.includes('web')) {
  const emailReal =
    Boolean(E.RESEND_API_KEY) || (E.EMAIL_TRANSPORT === 'smtp' && Boolean(E.EMAIL_SERVER));
  const googleReal = Boolean(E.GOOGLE_OAUTH_CLIENT_ID) && Boolean(E.GOOGLE_OAUTH_CLIENT_SECRET);
  if (!emailReal && !googleReal) {
    const isProd = E.NODE_ENV === 'production';
    groupNotes.push({
      level: isProd ? 'error' : 'warn',
      msg: 'auth: no working sign-in path — set RESEND_API_KEY, or EMAIL_TRANSPORT=smtp + EMAIL_SERVER, or GOOGLE_OAUTH_CLIENT_ID + _SECRET',
    });
    if (isProd) blocking += 1;
    else warnings += 1;
  } else if (!emailReal && (!E.EMAIL_TRANSPORT || E.EMAIL_TRANSPORT === 'console')) {
    groupNotes.push({
      level: 'warn',
      msg: 'email: EMAIL_TRANSPORT is "console" — magic-link links only print to the log (Google OAuth still works)',
    });
    warnings += 1;
  }
}

// --- output ----------------------------------------------------------

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { target: TARGET, ok: blocking === 0, blocking, warnings, vars: rows, notes: groupNotes },
      null,
      2,
    ),
  );
} else {
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`\n  Environment check — target: ${TARGET}\n`);
  console.log(`  ${'NAME'.padEnd(w)}  ${'STATUS'.padEnd(8)}  NOTE`);
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(40)}`);
  for (const r of rows) {
    const mark =
      r.status === 'MISSING' || r.status === 'invalid' ? '✗' : r.status === '—' ? ' ' : '✓';
    console.log(`  ${r.name.padEnd(w)}  ${mark} ${r.status.padEnd(6)}  ${r.note}`);
  }
  if (groupNotes.length) {
    console.log('');
    for (const n of groupNotes) console.log(`  ${n.level === 'error' ? '✗' : '!'} ${n.msg}`);
  }
  console.log(
    `\n  ${blocking === 0 ? '✓ ready' : `✗ ${blocking} blocking problem(s)`}` +
      `${warnings ? ` · ${warnings} warning(s)` : ''}\n`,
  );
}

process.exit(blocking === 0 ? 0 : 1);
