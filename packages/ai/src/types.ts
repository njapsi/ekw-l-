import type { z } from 'zod';

/**
 * AI abstraction layer (master instruction, section I).
 *
 * The application is NOT hard-coded around one model provider. Every call site
 * depends on this interface; concrete providers (Anthropic, OpenAI, Google, …)
 * are registered behind it and selected at runtime.
 */

export type ProviderName = 'anthropic' | 'openai' | 'google';

export interface ModelRef {
  provider: ProviderName;
  /** Provider-native model id, e.g. "claude-sonnet-4-5". */
  model: string;
}

export interface UsageRecord {
  provider: ProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD, computed from a per-model price table. */
  estimatedCostUsd: number;
  /** Free-form correlation id (agent task id, request id, …). */
  context?: string;
}

export interface GenerateTextOptions {
  model?: ModelRef;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Transient-error retries handled by the underlying provider (429/5xx/network).
   * Defaults to `AI_MAX_RETRIES` (2). Timeout, provider fallback and the kill
   * switch are handled one level up by `withResilience` / `FallbackProvider`.
   */
  maxRetries?: number;
  /** Per-call deadline in ms. Defaults to `AI_REQUEST_TIMEOUT_MS` (60000). */
  timeoutMs?: number;
}

export interface GenerateTextResult {
  text: string;
  usage: UsageRecord;
  finishReason: string;
}

export interface GenerateObjectOptions<TSchema extends z.ZodTypeAny> extends GenerateTextOptions {
  schema: TSchema;
  schemaName?: string;
  schemaDescription?: string;
}

export interface GenerateObjectResult<T> {
  object: T;
  usage: UsageRecord;
}

export interface StreamTextResult {
  textStream: AsyncIterable<string>;
  /** Resolves once the stream finishes. */
  usage: Promise<UsageRecord>;
}

export interface EmbedOptions {
  model?: ModelRef;
  values: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  embeddings: number[][];
  usage: UsageRecord;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TInput;
  execute: (input: z.infer<TInput>) => Promise<unknown>;
}

export interface AIProvider {
  readonly name: ProviderName;
  generateText(opts: GenerateTextOptions): Promise<GenerateTextResult>;
  generateObject<TSchema extends z.ZodTypeAny>(
    opts: GenerateObjectOptions<TSchema>,
  ): Promise<GenerateObjectResult<z.infer<TSchema>>>;
  streamText(opts: GenerateTextOptions): Promise<StreamTextResult>;
  embed?(opts: EmbedOptions): Promise<EmbedResult>;
}

export interface UsageSink {
  record(usage: UsageRecord): Promise<void> | void;
}
