/**
 * Resilience decorator over any `AIProvider` (docs/AI-ARCHITECTURE.md §1, §7).
 *
 * Adds three things the raw provider does not have:
 *   1. **Kill switch** — `AI_DISABLED` disables the whole layer; a provider name
 *      in `AI_DISABLED_PROVIDERS` disables just that one. Checked per call so an
 *      operator can flip it without a redeploy.
 *   2. **Timeout** — every call gets a deadline (`opts.timeoutMs` else
 *      `AI_REQUEST_TIMEOUT_MS` else 60s); on expiry the in-flight request is
 *      aborted and an `AiTimeoutError` is thrown. For `streamText` the deadline
 *      only covers *establishing* the stream.
 *   3. **Timeout retry** — a timed-out call is retried once (configurable) with a
 *      short jittered backoff. Transient 429/5xx/network retries are left to the
 *      underlying provider (`VercelAIProvider` passes `maxRetries` to the SDK) so
 *      the two layers do not compound.
 */
import { AiDisabledError, AiTimeoutError } from './errors.js';
import type {
  AIProvider,
  EmbedOptions,
  EmbedResult,
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  ProviderName,
  StreamTextResult,
} from './types.js';
import type { z } from 'zod';

export interface ResilienceOptions {
  /** Per-call deadline in ms. Default: `AI_REQUEST_TIMEOUT_MS` or 60000. */
  timeoutMs?: number;
  /** How many times to retry a call that timed out. Default: 1. */
  timeoutRetries?: number;
  /** Override the env for tests. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function resolveTimeout(opts: ResilienceOptions, callTimeoutMs?: number): number {
  if (typeof callTimeoutMs === 'number' && callTimeoutMs > 0) return callTimeoutMs;
  if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) return opts.timeoutMs;
  const env = opts.env ?? process.env;
  const fromEnv = Number(env.AI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

function killSwitch(opts: ResilienceOptions, provider: ProviderName): void {
  const env = opts.env ?? process.env;
  const disabled = String(env.AI_DISABLED ?? '').toLowerCase();
  if (disabled === '1' || disabled === 'true' || disabled === 'yes') {
    throw new AiDisabledError('AI_DISABLED is set');
  }
  const blocked = String(env.AI_DISABLED_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (blocked.includes(provider)) {
    throw new AiDisabledError(`provider "${provider}" is in AI_DISABLED_PROVIDERS`);
  }
}

function backoff(attempt: number): Promise<void> {
  const base = Math.min(4000, 250 * 2 ** attempt);
  const jitter = base * (0.8 + Math.random() * 0.4);
  return new Promise((r) => setTimeout(r, jitter));
}

/** Abort when either input aborts. Avoids relying on `AbortSignal.any` typings. */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const merged = new AbortController();
  const onAbort = (reason: unknown) => merged.abort(reason);
  if (a.aborted) merged.abort(a.reason);
  else if (b.aborted) merged.abort(b.reason);
  else {
    a.addEventListener('abort', () => onAbort(a.reason), { once: true });
    b.addEventListener('abort', () => onAbort(b.reason), { once: true });
  }
  return merged.signal;
}

/**
 * Run `fn` with a fresh timeout signal (merged with any caller signal). If the
 * deadline fires first, abort and throw `AiTimeoutError`; retry per
 * `timeoutRetries`. A caller-initiated abort is surfaced as-is, never retried.
 */
async function withTimeout<T>(
  opts: ResilienceOptions,
  callerSignal: AbortSignal | undefined,
  callTimeoutMs: number | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = resolveTimeout(opts, callTimeoutMs);
  const retries = Math.max(0, opts.timeoutRetries ?? 1);

  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? new Error('aborted');
    const timer = new AbortController();
    const timeoutId = setTimeout(() => timer.abort(new AiTimeoutError(timeoutMs)), timeoutMs);
    const signal = mergeSignals(callerSignal, timer.signal);
    try {
      return await fn(signal);
    } catch (err) {
      const timedOut = timer.signal.aborted && !callerSignal?.aborted;
      if (timedOut && attempt < retries) {
        await backoff(attempt);
        continue;
      }
      if (timedOut) throw new AiTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Wrap a provider with the kill switch + timeout + timeout-retry. The returned
 * object is a drop-in `AIProvider`; call sites are unchanged.
 */
export function withResilience(inner: AIProvider, opts: ResilienceOptions = {}): AIProvider {
  const guard = () => killSwitch(opts, inner.name);

  const wrapped: AIProvider = {
    name: inner.name,

    async generateText(o: GenerateTextOptions): Promise<GenerateTextResult> {
      guard();
      return withTimeout(opts, o.signal, o.timeoutMs, (signal) =>
        inner.generateText({ ...o, signal }),
      );
    },

    async generateObject<TSchema extends z.ZodTypeAny>(
      o: GenerateObjectOptions<TSchema>,
    ): Promise<GenerateObjectResult<z.infer<TSchema>>> {
      guard();
      return withTimeout(opts, o.signal, o.timeoutMs, (signal) =>
        inner.generateObject({ ...o, signal }),
      );
    },

    async streamText(o: GenerateTextOptions): Promise<StreamTextResult> {
      guard();
      // The deadline covers establishing the stream only — once tokens flow the
      // consumer owns the lifetime.
      return withTimeout(opts, o.signal, o.timeoutMs, (signal) =>
        inner.streamText({ ...o, signal }),
      );
    },
  };

  if (inner.embed) {
    wrapped.embed = async (o: EmbedOptions): Promise<EmbedResult> => {
      guard();
      return withTimeout(opts, o.signal, undefined, (signal) => inner.embed!({ ...o, signal }));
    };
  }

  return wrapped;
}
