/**
 * A web-search provider seam (Phase 5, Part 41), following this codebase's
 * `NullBillingGateway` convention (`billing/gateway.ts`): the interface
 * exists so a real provider can be plugged in later, but no search API key
 * infrastructure exists in this deployment today, and inventing search
 * results would violate hard rule 1 (never fabricate data). Every call
 * returns a deterministic, explicit "not configured" result — never an
 * empty or fabricated result list — exactly like `search_console.*`'s
 * `{ available: false }` tools when Search Console is not connected.
 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

export type SearchOutcome =
  | { available: true; provider: string; results: SearchHit[] }
  | { available: false; reason: string };

/**
 * No environment variable is checked here on purpose: adding one now, with
 * no real provider integration behind it, would be exactly the kind of
 * "planned but not implemented" configuration this codebase's own audits
 * (docs/FORENSIC-AUDIT.md) have repeatedly flagged and had to walk back.
 * A future phase that adds a real provider (Bing, Google Programmable
 * Search, etc.) replaces this factory, not the tool that calls it.
 */
export function searchProviderFromEnv(): SearchProvider | null {
  return null;
}

export async function runSearch(query: string, limit = 5): Promise<SearchOutcome> {
  const provider = searchProviderFromEnv();
  if (!provider) {
    return {
      available: false,
      reason:
        'No web search provider is configured for this deployment. Ask an administrator to configure one, or provide a specific URL for research.fetch instead.',
    };
  }
  const results = await provider.search(query, limit);
  return { available: true, provider: provider.name, results };
}
