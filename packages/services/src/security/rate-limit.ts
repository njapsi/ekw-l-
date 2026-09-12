/**
 * A minimal fixed-window rate limiter on Redis, for abuse protection on
 * authentication and other sensitive endpoints (docs/SECURITY.md §8). It is a
 * security control, not a product feature: buckets are coarse and the limiter
 * **fails open** — if Redis is unreachable the request is allowed (with a
 * logged warning) rather than locking every user out.
 *
 * For per-plan quota enforcement use `usage.enforceUsage` instead; this module
 * is about "too many requests, too fast" from one identity / IP.
 */
import { createLogger } from '@growth-agent/observability';
import { getObservabilityRedis } from '../observability/redis.js';

const log = createLogger('security.rate-limit');

export interface RateLimitOptions {
  /** Stable identifier for the bucket, e.g. `magic-link:alice@example.com`. */
  key: string;
  /** Max hits allowed within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Requests still allowed in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (only meaningful when `ok` is false). */
  retryAfterSec: number;
  /** True when the check could not run (Redis down) and was allowed through. */
  degraded: boolean;
}

let warnedDegraded = false;

/**
 * Consume one token from `key`. Increments a per-window counter in Redis and
 * sets the TTL on first use.
 */
export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const windowSec = Math.max(1, Math.trunc(opts.windowSec));
  const limit = Math.max(1, Math.trunc(opts.limit));
  const now = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(now / windowSec);
  const redisKey = `rl:${opts.key}:${windowIndex}`;

  try {
    const redis = getObservabilityRedis();
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect().catch(() => undefined);
    }
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSec);
    }
    if (count > limit) {
      const resetAt = (windowIndex + 1) * windowSec;
      return {
        ok: false,
        remaining: 0,
        retryAfterSec: Math.max(1, resetAt - now),
        degraded: false,
      };
    }
    return { ok: true, remaining: limit - count, retryAfterSec: 0, degraded: false };
  } catch (err) {
    if (!warnedDegraded) {
      warnedDegraded = true;
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rate limiter unavailable (Redis) — failing open',
      );
    }
    return { ok: true, remaining: limit, retryAfterSec: 0, degraded: true };
  }
}

/** Extract a best-effort client IP from proxy headers. */
export function clientIpFrom(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Test-only: reset the one-time degraded warning latch. */
export function resetRateLimitWarnForTest(): void {
  warnedDegraded = false;
}
