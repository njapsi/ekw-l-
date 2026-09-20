import { describe, expect, it } from 'vitest';
import { runSearch, searchProviderFromEnv } from './search.js';

describe('web search (no provider configured)', () => {
  it('searchProviderFromEnv returns null — no fabricated provider', () => {
    expect(searchProviderFromEnv()).toBeNull();
  });

  it('runSearch reports { available: false } with a plain, actionable reason — never invented results', async () => {
    const outcome = await runSearch('best seo tools');
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.reason).toMatch(/no web search provider is configured/i);
    }
  });
});
