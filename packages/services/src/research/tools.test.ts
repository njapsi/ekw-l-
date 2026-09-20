import { describe, expect, it } from 'vitest';
import { runResearchTool } from './tools.js';

describe('research tool dispatcher', () => {
  it('rejects an unknown tool name', async () => {
    await expect(runResearchTool('research.execute', {})).rejects.toThrow(/Unknown tool/);
  });

  it('validates research.fetch input — a non-URL is rejected before any network call', async () => {
    await expect(runResearchTool('research.fetch', { url: 'not-a-url' })).rejects.toThrow();
  });

  it('validates research.search input — an empty query is rejected', async () => {
    await expect(runResearchTool('research.search', { query: '' })).rejects.toThrow();
  });

  it('research.search runs deterministically to an "unavailable" result with valid input', async () => {
    const result = await runResearchTool('research.search', { query: 'seo tips' });
    expect(result).toMatchObject({ available: false });
  });
});
