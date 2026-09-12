/**
 * Best-effort secret scrubbing for anything that gets persisted or shown in
 * `/admin` — error messages, stack traces, structured-log context. The pino
 * logger already redacts by key path (`packages/observability`); this covers
 * free text where a token can appear inline. "Do not expose secrets" (Phase 13).
 */

const REPLACEMENT = '[redacted]';

/** Vendor key shapes with an unambiguous prefix — always redacted. */
const PREFIXED_KEY =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{8,}|sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;

/** `Authorization: Bearer <x>` / `Basic <x>`. */
const AUTH_HEADER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** JWTs. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/** Credentials embedded in a connection string. */
const CONN_STRING_CREDS =
  /\b((?:postgres(?:ql)?|rediss?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:)[^\s:@/]+@/gi;

/** `SOMETHING_SECRET=value`, `apiKey: "value"`, `password = value`. */
const NAMED_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE_KEY|SESSION)[A-Za-z0-9_]*)\b(\s*[=:]\s*)(['"]?)([^\s'"&]{4,})\3/gi;

export function scrubSecrets(input: string | null | undefined): string {
  if (!input) return input ?? '';
  return input
    .replace(CONN_STRING_CREDS, `$1${REPLACEMENT}@`)
    .replace(NAMED_ASSIGNMENT, `$1$2$3${REPLACEMENT}$3`)
    .replace(AUTH_HEADER, `$1 ${REPLACEMENT}`)
    .replace(JWT, REPLACEMENT)
    .replace(PREFIXED_KEY, REPLACEMENT);
}

const SENSITIVE_KEY =
  /(key|secret|token|password|passwd|pwd|credential|authorization|cookie|cipher|iv|authtag|sessionversion)/i;

/**
 * Shallow-scrub a plain object destined for an `ErrorEvent.context` / log line:
 * drop values under sensitive-looking keys, scrub string values, keep the shape.
 */
export function scrubContext(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = REPLACEMENT;
    } else if (typeof v === 'string') {
      out[k] = scrubSecrets(v).slice(0, 500);
    } else if (v && typeof v === 'object') {
      out[k] = '[object]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
