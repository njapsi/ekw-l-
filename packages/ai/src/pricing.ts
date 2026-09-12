import type { ProviderName, UsageRecord } from './types.js';

/**
 * Per-model price table (USD per 1M tokens). Keep this in sync with provider
 * pricing pages; it is only used for internal cost estimation / budgeting and
 * is deliberately conservative. Unknown models fall back to zero and MUST be
 * flagged by the caller rather than silently ignored.
 */
interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<ProviderName, Record<string, Price>> = {
  anthropic: {
    'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
    'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  },
  openai: {
    'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
    'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0 },
  },
  google: {
    'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
    'gemini-1.5-pro': { inputPerMTok: 1.25, outputPerMTok: 5 },
  },
};

export function estimateCostUsd(
  provider: ProviderName,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = PRICES[provider]?.[model];
  if (!price) return 0;
  return (
    (promptTokens / 1_000_000) * price.inputPerMTok +
    (completionTokens / 1_000_000) * price.outputPerMTok
  );
}

export function makeUsageRecord(
  provider: ProviderName,
  model: string,
  promptTokens: number,
  completionTokens: number,
  context?: string,
): UsageRecord {
  return {
    provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateCostUsd(provider, model, promptTokens, completionTokens),
    context,
  };
}

export function isKnownModel(provider: ProviderName, model: string): boolean {
  return Boolean(PRICES[provider]?.[model]);
}
