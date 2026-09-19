/**
 * Shared API resilience for every integration client (Phase 1, Part 10).
 *
 * Four pieces, composable and dependency-free:
 *   - `IntegrationApiError` + `classifyHttpStatus` — one error vocabulary for
 *     every provider, so retry/diagnostic decisions never string-match a
 *     provider's prose.
 *   - `withRetry` — exponential backoff with full jitter that honours a
 *     provider's `Retry-After`, and only retries what is actually transient.
 *   - `CircuitBreaker` — stops hammering a provider that is down, per key.
 *   - `withTimeout` — a hard deadline on any promise.
 *
 * The existing YouTube / TikTok clients keep their own, already-tested retry
 * paths (not rewritten — ADR-0051); new clients (WordPress, the connection
 * probe, the sync framework) use this module.
 */

export type ApiErrorKind =
  | 'auth' // 401 — credential invalid/expired
  | 'permission' // 403 — authenticated but not allowed (scope / role)
  | 'not_found' // 404
  | 'validation' // 400 / 409 / 422 — our request was wrong; never retried
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'timeout'
  | 'network'
  | 'circuit_open';

const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set([
  'rate_limited',
  'server',
  'timeout',
  'network',
]);

export class IntegrationApiError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly provider: string,
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    /** Provider-requested wait before retrying, if it sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'IntegrationApiError';
    this.retryable = RETRYABLE.has(kind);
  }
}

export function classifyHttpStatus(status: number): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Returns ms, or
 * undefined when absent/unparseable. Capped so a hostile or buggy provider
 * cannot park a worker for hours.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
  capMs = 60_000,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, capMs);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), capMs);
}

/** Classify an arbitrary thrown value into a retryable-or-not decision. */
export function toIntegrationError(provider: string, err: unknown): IntegrationApiError {
  if (err instanceof IntegrationApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|aborted/i.test(message)) {
    return new IntegrationApiError(provider, 'timeout', message);
  }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(message)) {
    return new IntegrationApiError(provider, 'network', message);
  }
  return new IntegrationApiError(provider, 'server', message);
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  provider = 'integration',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new IntegrationApiError(provider, 'timeout', `timeout: no response in ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  provider?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: IntegrationApiError }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Full-jitter exponential backoff: delay ∈ [0, min(max, base·2^attempt)].
 * A provider's `Retry-After` wins when present (it knows its own limits).
 * Non-retryable errors (auth, permission, validation, not-found) are thrown
 * immediately — retrying a 401 only burns quota and delays the real message.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const provider = opts.provider ?? 'integration';

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (raw) {
      const error = toIntegrationError(provider, raw);
      if (!error.retryable || attempt >= retries) throw error;
      const backoff = Math.floor(random() * Math.min(max, base * 2 ** attempt));
      const delayMs = error.retryAfterMs ?? backoff;
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive transient failures that trip the breaker. */
  failureThreshold?: number;
  /** How long it stays open before allowing one trial call. */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Per-process, per-key breaker. Only *transient* failures count: a 401 means
 * one credential is bad, not that the provider is down, so it must never
 * block every other organization's calls to the same provider.
 *
 * In-memory by design (ADR-0051): each web/worker process protects itself;
 * a shared Redis breaker would add a network hop to every call to guard
 * against a condition the provider already signals with 429/5xx.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly key: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.trialInFlight)) {
      const openedAt = this.openedAt ?? this.now();
      const waitMs = Math.max(0, this.cooldownMs - (this.now() - openedAt));
      throw new IntegrationApiError(
        this.key,
        'circuit_open',
        `${this.key} is temporarily unavailable after repeated failures; retrying in ${Math.ceil(waitMs / 1000)}s.`,
        undefined,
        waitMs,
      );
    }
    if (state === 'half_open') this.trialInFlight = true;
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (raw) {
      const error = toIntegrationError(this.key, raw);
      if (error.retryable) {
        this.failures += 1;
        if (state === 'half_open' || this.failures >= this.threshold) this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (state === 'half_open') this.trialInFlight = false;
    }
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** Process-wide breaker registry, one per provider (or provider+host). */
export function breakerFor(key: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let b = breakers.get(key);
  if (!b) {
    b = new CircuitBreaker(key, opts);
    breakers.set(key, b);
  }
  return b;
}

/** Test seam. */
export function resetBreakers(): void {
  breakers.clear();
}

export interface ResilientCallOptions extends RetryOptions {
  timeoutMs?: number;
  breakerKey?: string;
}

/**
 * The composition every new client uses: breaker( retry( timeout(call) ) ).
 * The breaker sits outside the retries so one logical call counts once.
 */
export function resilientCall<T>(
  fn: () => Promise<T>,
  opts: ResilientCallOptions = {},
): Promise<T> {
  const provider = opts.provider ?? 'integration';
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const attempt = () => withRetry(() => withTimeout(fn(), timeoutMs, provider), opts);
  return opts.breakerKey ? breakerFor(opts.breakerKey).run(attempt) : attempt();
}
