/**
 * Logical model roles (docs/AI-ARCHITECTURE.md §1). Call sites ask for a *role*
 * — `analyst` for synthesis, `router` for cheap classification/extraction,
 * `long_context` for whole-crawl reasoning, `embedding` for vector search — and
 * a config map resolves it to a concrete `ModelRef`. Swapping a model is then an
 * env change, not a code change.
 *
 * Resolution order for role R:
 *   1. `AI_MODEL_<R>` env, `"<provider>:<model>"` (e.g. `anthropic:claude-haiku-4-5`)
 *   2. a per-role default keyed off the default provider
 *   3. `defaultsFromEnv()` (`AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL`)
 */
import { defaultsFromEnv } from './registry.js';
import type { ModelRef, ProviderName } from './types.js';

export type AiRole = 'router' | 'analyst' | 'long_context' | 'embedding';

export const AI_ROLES = ['router', 'analyst', 'long_context', 'embedding'] as const;

const PROVIDERS: readonly ProviderName[] = ['anthropic', 'openai', 'google'];

/** Parse a `"provider:model"` pair; returns null if malformed or unknown provider. */
export function parseModelRef(raw: string | undefined | null): ModelRef | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const provider = raw.slice(0, idx).trim().toLowerCase();
  const model = raw.slice(idx + 1).trim();
  if (!PROVIDERS.includes(provider as ProviderName) || !model) return null;
  return { provider: provider as ProviderName, model };
}

/** A conservative default per role, given the default provider. */
function roleDefault(role: AiRole, base: ModelRef): ModelRef {
  if (role === 'embedding') return { provider: 'openai', model: 'text-embedding-3-small' };
  if (role === 'router') {
    if (base.provider === 'anthropic') return { provider: 'anthropic', model: 'claude-haiku-4-5' };
    if (base.provider === 'openai') return { provider: 'openai', model: 'gpt-4o-mini' };
    if (base.provider === 'google') return { provider: 'google', model: 'gemini-2.0-flash' };
  }
  // analyst + long_context ride the default model.
  return base;
}

export function modelForRole(role: AiRole, env: NodeJS.ProcessEnv = process.env): ModelRef {
  const explicit = parseModelRef(env[`AI_MODEL_${role.toUpperCase()}`]);
  if (explicit) return explicit;
  return roleDefault(role, defaultsFromEnv(env));
}
