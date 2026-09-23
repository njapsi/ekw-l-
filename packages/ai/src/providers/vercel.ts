import {
  embedMany as aiEmbedMany,
  generateObject as aiGenerateObject,
  generateText as aiGenerateText,
  streamText as aiStreamText,
  tool as aiTool,
  type EmbeddingModel,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { makeUsageRecord } from '../pricing.js';
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
  ToolCallRecord,
  ToolDefinition,
} from '../types.js';

/** Only a provider whose factory passes this (currently OpenAI) exposes `embed()` —
 * `AIProvider.embed` stays `undefined` for the others, exactly as before this was
 * added, so every existing `typeof provider.embed === 'function'` check
 * (`resilient.ts`, `fallback.ts`) keeps degrading the same way it always has. */
export interface EmbeddingSupport {
  resolve: (modelId: string) => EmbeddingModel<string>;
  defaultModelId: string;
}

/**
 * Maps our provider-agnostic `ToolDefinition[]` to the Vercel AI SDK's
 * `ToolSet`. `execute` is exactly the function the caller registered —
 * `packages/ai` performs no authorization of its own; that lives entirely
 * in whoever builds the `ToolDefinition` (the agent's tool registry).
 */
function buildToolSet(tools: ToolDefinition[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      description: t.description,
      parameters: t.parameters,
      execute: t.execute,
    });
  }
  return set;
}

/** Flattens every step's tool calls/results across a multi-step run, in order. */
function collectToolCalls(
  steps: readonly { toolCalls?: unknown[]; toolResults?: unknown[] }[],
): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const step of steps) {
    const toolCalls = (step.toolCalls ?? []) as {
      toolCallId: string;
      toolName: string;
      args: unknown;
    }[];
    const toolResults = (step.toolResults ?? []) as { toolCallId: string; result: unknown }[];
    for (const call of toolCalls) {
      const found = toolResults.find((r) => r.toolCallId === call.toolCallId);
      calls.push({ name: call.toolName, args: call.args, result: found?.result });
    }
  }
  return calls;
}

/**
 * Adapts any Vercel AI SDK `LanguageModel` to our provider-agnostic interface.
 * Concrete providers (Anthropic/OpenAI/Google) are thin factories over this.
 */
export class VercelAIProvider implements AIProvider {
  readonly embed?: (opts: EmbedOptions) => Promise<EmbedResult>;

  constructor(
    public readonly name: ProviderName,
    private readonly resolveModel: (modelId: string) => LanguageModel,
    private readonly defaultModelId: string,
    embedding?: EmbeddingSupport,
  ) {
    if (embedding) {
      this.embed = async (opts: EmbedOptions): Promise<EmbedResult> => {
        const modelId = opts.model?.model ?? embedding.defaultModelId;
        const model = embedding.resolve(modelId);
        const { embeddings, usage } = await aiEmbedMany({
          model,
          values: opts.values,
          abortSignal: opts.signal,
        });
        return {
          embeddings,
          usage: makeUsageRecord(this.name, modelId, usage.tokens, 0),
        };
      };
    }
  }

  private model(id?: string): { model: LanguageModel; id: string } {
    const modelId = id ?? this.defaultModelId;
    return { model: this.resolveModel(modelId), id: modelId };
  }

  /**
   * Transient-error retries (429/5xx/network) owned by the SDK. Configured from
   * one place — `opts.maxRetries` else `AI_MAX_RETRIES` else 2. Timeout,
   * provider fallback and the kill switch live in `withResilience`.
   */
  private retries(opts: GenerateTextOptions): number {
    if (typeof opts.maxRetries === 'number' && opts.maxRetries >= 0) return opts.maxRetries;
    const fromEnv = Number(process.env.AI_MAX_RETRIES);
    return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2;
  }

  async generateText(opts: GenerateTextOptions): Promise<GenerateTextResult> {
    const { model, id } = this.model(opts.model?.model);
    const tools = buildToolSet(opts.tools);
    const res = await aiGenerateText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      messages: opts.messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      maxRetries: this.retries(opts),
      abortSignal: opts.signal,
      ...(tools ? { tools, maxSteps: opts.maxSteps ?? 1 } : {}),
    });
    return {
      text: res.text,
      finishReason: res.finishReason,
      usage: makeUsageRecord(this.name, id, res.usage.promptTokens, res.usage.completionTokens),
      ...(tools ? { toolCalls: collectToolCalls(res.steps), steps: res.steps.length } : {}),
    };
  }

  async generateObject<TSchema extends z.ZodTypeAny>(
    opts: GenerateObjectOptions<TSchema>,
  ): Promise<GenerateObjectResult<z.infer<TSchema>>> {
    const { model, id } = this.model(opts.model?.model);
    const res = await aiGenerateObject({
      model,
      schema: opts.schema,
      schemaName: opts.schemaName,
      schemaDescription: opts.schemaDescription,
      system: opts.system,
      prompt: opts.prompt,
      messages: opts.messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      maxRetries: this.retries(opts),
      abortSignal: opts.signal,
    });
    // `res.object` is typed `z.infer<TSchema>` which collapses to `any` for the
    // generic `z.ZodTypeAny` bound. The type-safe boundary is this method's
    // signature; callers pass a concrete schema and receive a concrete type.
    const object = res.object as z.infer<TSchema>;
    return {
      object,
      usage: makeUsageRecord(this.name, id, res.usage.promptTokens, res.usage.completionTokens),
    };
  }

  streamText(opts: GenerateTextOptions): Promise<StreamTextResult> {
    const { model, id } = this.model(opts.model?.model);
    // AI SDK v4 `streamText` is synchronous and returns a live result object.
    const res = aiStreamText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      messages: opts.messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      maxRetries: this.retries(opts),
      abortSignal: opts.signal,
    });
    return Promise.resolve({
      textStream: res.textStream,
      usage: res.usage.then((u) =>
        makeUsageRecord(this.name, id, u.promptTokens, u.completionTokens),
      ),
    });
  }
}
