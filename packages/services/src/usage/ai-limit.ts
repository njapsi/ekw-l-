/**
 * Per-user AI throttle (Phase 22). Sits in front of the per-org monthly
 * `AI_REQUESTS` entitlement (`enforceUsage`) so one member cannot burn the whole
 * organization's quota — or run up cost — in a burst.
 *
 * It is a **rate limit**, not a billing meter: coarse fixed windows on Redis,
 * **fail-open** (a Redis outage must never block a paying user). The hard
 * monthly cap stays with `enforceUsage`.
 *
 * Limits: `AI_USER_RATE_LIMIT` (default 30) requests per `AI_USER_RATE_WINDOW_SEC`
 * (default 60) seconds, per `(organizationId, userId)`.
 */
import { AppError } from '../errors.js';
import { checkRateLimit } from '../security/rate-limit.js';

export interface AiUserLimitInput {
  organizationId: string;
  userId: string;
  /** Override the env default. */
  limit?: number;
  /** Override the env default (seconds). */
  windowSec?: number;
  /** Distinguish call sites that should not share a bucket (e.g. 'chat', 'scan'). */
  scope?: string;
}

function resolve(input: AiUserLimitInput): { key: string; limit: number; windowSec: number } {
  const envLimit = Number(process.env.AI_USER_RATE_LIMIT);
  const envWindow = Number(process.env.AI_USER_RATE_WINDOW_SEC);
  const limit = input.limit ?? (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 30);
  const windowSec =
    input.windowSec ?? (Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 60);
  const scope = input.scope ? `:${input.scope}` : '';
  return { key: `ai-user${scope}:${input.organizationId}:${input.userId}`, limit, windowSec };
}

export interface AiUserLimitResult {
  ok: boolean;
  retryAfterSec: number;
  /** True when Redis was unreachable and the call was allowed through. */
  degraded: boolean;
}

/** Non-throwing check — consume one token. */
export async function checkAiUserLimit(input: AiUserLimitInput): Promise<AiUserLimitResult> {
  const { key, limit, windowSec } = resolve(input);
  const res = await checkRateLimit({ key, limit, windowSec });
  return { ok: res.ok, retryAfterSec: res.retryAfterSec, degraded: res.degraded };
}

/** Throwing guard — `AppError('rate_limited')` (HTTP 429) when the user is over. */
export async function enforceAiUserLimit(input: AiUserLimitInput): Promise<void> {
  const res = await checkAiUserLimit(input);
  if (!res.ok) {
    throw new AppError(
      'rate_limited',
      'You are sending AI requests too quickly. Please wait a moment and try again.',
      { expose: true },
    );
  }
}
