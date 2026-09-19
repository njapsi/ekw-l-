import 'server-only';
import { randomBytes } from 'node:crypto';
import { isAppError, observability } from '@growth-agent/services';

export interface ActionFailure {
  ok: false;
  error: string;
  /** Support reference, e.g. GA-8F31C2 — shown instead of internals. */
  ref?: string;
}

/**
 * Turn a thrown error into something safe to show a user (Phase 2, Part 28).
 *
 *   - An `AppError` marked `expose` is already a user-facing message.
 *   - Anything else (a database error, a stack, a provider message) is never
 *     shown: the user gets a friendly sentence plus a reference id, and the
 *     real error is captured server-side under the same id so support can
 *     find it in /admin/errors.
 */
export function toActionError(
  e: unknown,
  fallback = 'Something went wrong. Please try again.',
  ctx: { route?: string; organizationId?: string; userId?: string } = {},
): ActionFailure {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  const ref = `GA-${randomBytes(3).toString('hex').toUpperCase()}`;
  void observability
    .captureError(e, {
      source: 'WEB',
      route: ctx.route,
      correlationId: ref,
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
    })
    .catch(() => undefined);
  return { ok: false, error: `${fallback} (Reference: ${ref})`, ref };
}
