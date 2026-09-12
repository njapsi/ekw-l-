/**
 * Typed errors for the resilience layer (`resilient.ts`, `fallback.ts`). Call
 * sites already fall back to a deterministic path on any thrown error; these
 * types let logging and tests tell the failure modes apart.
 */

/** A model call was blocked by the kill switch (`AI_DISABLED` / `AI_DISABLED_PROVIDERS`). */
export class AiDisabledError extends Error {
  constructor(readonly reason: string) {
    super(`AI is disabled: ${reason}`);
    this.name = 'AiDisabledError';
  }
}

/** A model call exceeded its deadline (`AI_REQUEST_TIMEOUT_MS` / `opts.timeoutMs`). */
export class AiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`AI request timed out after ${timeoutMs}ms`);
    this.name = 'AiTimeoutError';
  }
}

/** Every provider in a `FallbackProvider` chain failed. Carries the last error. */
export class AiAllProvidersFailedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `all ${attempts} AI provider(s) failed; last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = 'AiAllProvidersFailedError';
  }
}
