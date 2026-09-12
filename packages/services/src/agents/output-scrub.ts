/**
 * Output-side secret scrubbing for agent-generated text (Phase 25,
 * docs/AI-SECURITY-AUDIT.md finding 2). `observability/scrub.ts`'s
 * `scrubSecrets` already redacts API-key shapes, JWTs, connection-string
 * credentials, `KEY=value` assignments, and bearer tokens — but until now it
 * was only ever applied to logs and `ErrorEvent` context, never to the
 * free-text an agent persists and shows to a user.
 *
 * Secrets should never reach a model prompt or an evidence string in the
 * first place (that remains true and unchanged — tokens are sealed at rest
 * and never selected into an API response or a prompt). This is
 * defense-in-depth for the case that never should happen but must still be
 * caught if it does: a compromised model response, a future call site that
 * accidentally interpolates something sensitive, or an injection that gets a
 * model to echo something secret-shaped.
 *
 * `scrubModelOutput` deep-walks any JSON-shaped value (the schema-validated
 * object every agent returns) and scrubs every string leaf, preserving the
 * original shape. Every agent calls it on its final output, right before
 * persistence/return, on BOTH the model path and any deterministic fallback.
 */
import { scrubSecrets } from '../observability/scrub.js';

export function scrubModelOutput<T>(value: T): T {
  if (typeof value === 'string') {
    return scrubSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown) => scrubModelOutput(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    // Dates, and other non-plain objects, pass through unchanged — only plain
    // data (the shape every Zod-validated agent output actually has) is walked.
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubModelOutput(v);
    }
    return out as T;
  }
  return value;
}
