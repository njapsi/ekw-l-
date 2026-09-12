import { FallbackProvider, type FallbackEntry } from './fallback.js';
import { modelForRole, type AiRole } from './roles.js';
import type { AIProvider, ModelRef, ProviderName, UsageRecord, UsageSink } from './types.js';

/**
 * Central place to register concrete providers and resolve the model a call
 * should use. Defaults come from env (AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL)
 * but any call site may override per request ("model selection", section I).
 *
 * When one or more `fallbacks` are configured, `get()` returns a
 * `FallbackProvider` — the head is the requested model, the tail is every
 * configured fallback whose provider is registered and differs from the head.
 * Call sites keep calling `registry.get().provider.generateObject(...)` and
 * transparently gain cross-provider failover (each entry is already wrapped in
 * `withResilience` by `createRegistryFromEnv`).
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, AIProvider>();
  private readonly sinks: UsageSink[] = [];

  constructor(
    private readonly defaults: ModelRef,
    sinks: UsageSink[] = [],
    private readonly fallbacks: ModelRef[] = [],
  ) {
    this.sinks.push(...sinks);
  }

  register(provider: AIProvider): this {
    this.providers.set(provider.name, provider);
    return this;
  }

  addUsageSink(sink: UsageSink): this {
    this.sinks.push(sink);
    return this;
  }

  has(provider: ProviderName): boolean {
    return this.providers.has(provider);
  }

  private require(ref: ModelRef): AIProvider {
    const provider = this.providers.get(ref.provider);
    if (!provider) {
      throw new Error(
        `AI provider "${ref.provider}" is not registered. Registered: ${[...this.providers.keys()].join(', ') || 'none'}`,
      );
    }
    return provider;
  }

  /**
   * Resolve the provider + model for a call. Returns a `FallbackProvider` when a
   * usable fallback chain exists, otherwise the single registered provider.
   */
  get(ref?: ModelRef): { provider: AIProvider; model: string } {
    const head = ref ?? this.defaults;
    const headProvider = this.require(head);

    const tail: FallbackEntry[] = [];
    const seen = new Set<ProviderName>([head.provider]);
    for (const fb of this.fallbacks) {
      if (seen.has(fb.provider)) continue;
      const p = this.providers.get(fb.provider);
      if (!p) continue;
      seen.add(fb.provider);
      tail.push({ provider: p, model: fb.model });
    }

    if (tail.length === 0) return { provider: headProvider, model: head.model };
    return {
      provider: new FallbackProvider([{ provider: headProvider, model: head.model }, ...tail]),
      model: head.model,
    };
  }

  /** Resolve by logical role (`analyst`, `router`, `long_context`, `embedding`). */
  getForRole(role: AiRole): { provider: AIProvider; model: string } {
    return this.get(modelForRole(role));
  }

  async reportUsage(usage: UsageRecord): Promise<void> {
    for (const sink of this.sinks) {
      await sink.record(usage);
    }
  }

  get defaultModel(): ModelRef {
    return this.defaults;
  }
}

export function defaultsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef {
  const provider = (env.AI_DEFAULT_PROVIDER ?? 'anthropic') as ProviderName;
  const model = env.AI_DEFAULT_MODEL ?? 'claude-sonnet-4-5';
  return { provider, model };
}
