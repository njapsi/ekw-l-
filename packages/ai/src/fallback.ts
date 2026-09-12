/**
 * A provider chain (docs/AI-ARCHITECTURE.md §1). Tries each `{ provider, model }`
 * in order; on a thrown error it advances to the next entry. When every entry
 * fails it throws `AiAllProvidersFailedError` carrying the last error.
 *
 * The kill switch (`AiDisabledError`) is NOT swallowed for fallback: if the
 * whole layer is disabled every entry throws it and the chain surfaces it. A
 * single disabled provider still lets the chain move on.
 *
 * `streamText` only falls back on the *initial* call failure — once tokens are
 * flowing the stream cannot be swapped.
 */
import { AiAllProvidersFailedError, AiDisabledError } from './errors.js';
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

export interface FallbackEntry {
  provider: AIProvider;
  model: string;
}

export type FallbackLogger = (info: {
  from: ProviderName;
  model: string;
  index: number;
  error: unknown;
}) => void;

export class FallbackProvider implements AIProvider {
  readonly name: ProviderName;

  constructor(
    private readonly chain: FallbackEntry[],
    private readonly onFallback?: FallbackLogger,
  ) {
    if (chain.length === 0) throw new Error('FallbackProvider needs at least one entry');
    this.name = chain[0]!.provider.name;
  }

  private async run<T>(op: (entry: FallbackEntry) => Promise<T>): Promise<T> {
    let lastError: unknown;
    let disabledCount = 0;
    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i]!;
      try {
        return await op(entry);
      } catch (err) {
        lastError = err;
        if (err instanceof AiDisabledError) disabledCount++;
        if (i < this.chain.length - 1) {
          this.onFallback?.({
            from: entry.provider.name,
            model: entry.model,
            index: i,
            error: err,
          });
        }
      }
    }
    // Whole layer disabled → surface that; it is not a transient failure.
    if (disabledCount === this.chain.length && lastError instanceof AiDisabledError)
      throw lastError;
    throw new AiAllProvidersFailedError(this.chain.length, lastError);
  }

  generateText(o: GenerateTextOptions): Promise<GenerateTextResult> {
    return this.run((e) =>
      e.provider.generateText({ ...o, model: { provider: e.provider.name, model: e.model } }),
    );
  }

  generateObject<TSchema extends z.ZodTypeAny>(
    o: GenerateObjectOptions<TSchema>,
  ): Promise<GenerateObjectResult<z.infer<TSchema>>> {
    return this.run((e) =>
      e.provider.generateObject({ ...o, model: { provider: e.provider.name, model: e.model } }),
    );
  }

  streamText(o: GenerateTextOptions): Promise<StreamTextResult> {
    return this.run((e) =>
      e.provider.streamText({ ...o, model: { provider: e.provider.name, model: e.model } }),
    );
  }

  embed(o: EmbedOptions): Promise<EmbedResult> {
    const entry = this.chain.find((e) => typeof e.provider.embed === 'function');
    if (!entry) return Promise.reject(new Error('no provider in the chain implements embed()'));
    return entry.provider.embed!({
      ...o,
      model: { provider: entry.provider.name, model: entry.model },
    });
  }
}
