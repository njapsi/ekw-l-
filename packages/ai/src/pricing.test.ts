import { describe, expect, it } from 'vitest';
import { estimateCostUsd, isKnownModel, makeUsageRecord } from './pricing.js';

describe('pricing', () => {
  it('computes a cost for a known model', () => {
    const cost = estimateCostUsd('anthropic', 'claude-sonnet-4-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18);
  });

  it('returns zero for an unknown model', () => {
    expect(estimateCostUsd('openai', 'made-up-model', 1000, 1000)).toBe(0);
    expect(isKnownModel('openai', 'made-up-model')).toBe(false);
  });

  it('builds a usage record with totals', () => {
    const u = makeUsageRecord('anthropic', 'claude-haiku-4-5', 100, 50, 'task-1');
    expect(u.totalTokens).toBe(150);
    expect(u.context).toBe('task-1');
  });
});
