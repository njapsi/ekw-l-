/**
 * Politeness + resilience primitives for the crawl runner (CRAWL CONTROLS:
 * per-host rate limits, concurrency, retries, exponential backoff).
 *
 * In-process only. A distributed crawl would move the per-host clock into Redis
 * (docs/DECISIONS.md ADR-0018); the interface here is intentionally small so
 * that swap is local.
 */

/** Enforces a minimum delay between successive requests to the same host. */
export class HostRateLimiter {
  private readonly nextAllowed = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Resolve when it is polite to hit `host` again; reserves the next slot. */
  async take(host: string): Promise<void> {
    const t = this.now();
    const earliest = this.nextAllowed.get(host) ?? 0;
    const wait = Math.max(0, earliest - t);
    this.nextAllowed.set(host, Math.max(t, earliest) + this.minDelayMs);
    if (wait > 0) await this.sleep(wait);
  }
}

/** Bounded-concurrency task pool (no external dependency). */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Return true to retry; default retries every thrown error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Run `fn`, retrying with full-jitter exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const canRetry = opts.shouldRetry ? opts.shouldRetry(error, attempt) : true;
      if (attempt > opts.retries || !canRetry) throw error;
      const ceil = Math.min(maxDelay, opts.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceil);
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
