export * from './types.js';
export * from './errors.js';
export * from './pricing.js';
export * from './registry.js';
export * from './roles.js';
export * from './resilient.js';
export * from './fallback.js';
export * from './providers/index.js';

import { ProviderRegistry, defaultsFromEnv } from './registry.js';
import { anthropicProvider, googleProvider, openaiProvider } from './providers/index.js';
import { withResilience } from './resilient.js';
import { parseModelRef } from './roles.js';
import type { AIProvider, ModelRef, UsageSink } from './types.js';

/** `AI_FALLBACK_MODELS="openai:gpt-4o-mini,google:gemini-2.0-flash"` → [ModelRef, …]. */
export function fallbackModelsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef[] {
  return String(env.AI_FALLBACK_MODELS ?? '')
    .split(',')
    .map((s) => parseModelRef(s))
    .filter((r): r is ModelRef => r !== null);
}

/**
 * Build a registry with whichever providers have credentials configured. Every
 * provider is wrapped in `withResilience` (kill switch + timeout + timeout
 * retry); `AI_FALLBACK_MODELS` adds a cross-provider fallback chain. The default
 * provider/model come from env; call sites can still override per call or ask
 * for a role via `getForRole`.
 */
export function createRegistryFromEnv(sinks: UsageSink[] = []): ProviderRegistry {
  const registry = new ProviderRegistry(defaultsFromEnv(), sinks, fallbackModelsFromEnv());
  const add = (p: AIProvider) => registry.register(withResilience(p));
  if (process.env.ANTHROPIC_API_KEY) add(anthropicProvider());
  if (process.env.OPENAI_API_KEY) add(openaiProvider());
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) add(googleProvider());
  return registry;
}
