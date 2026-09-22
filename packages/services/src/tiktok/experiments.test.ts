import { describe, expect, it } from 'vitest';
import { evaluateExperiment } from './experiments.js';

describe('evaluateExperiment', () => {
  it('SUPPORTED when an INCREASE hypothesis sees a large enough increase', () => {
    const result = evaluateExperiment(100, 130, 'INCREASE', 10);
    expect(result.conclusion).toBe('SUPPORTED');
  });

  it('NOT_SUPPORTED when an INCREASE hypothesis sees a large enough decrease', () => {
    const result = evaluateExperiment(100, 70, 'INCREASE', 10);
    expect(result.conclusion).toBe('NOT_SUPPORTED');
  });

  it('SUPPORTED when a DECREASE hypothesis sees a large enough decrease', () => {
    const result = evaluateExperiment(100, 70, 'DECREASE', 10);
    expect(result.conclusion).toBe('SUPPORTED');
  });

  it('NOT_SUPPORTED when a DECREASE hypothesis sees a large enough increase', () => {
    const result = evaluateExperiment(100, 130, 'DECREASE', 10);
    expect(result.conclusion).toBe('NOT_SUPPORTED');
  });

  it('INCONCLUSIVE below the 15% meaningful-change threshold', () => {
    const result = evaluateExperiment(100, 108, 'INCREASE', 10);
    expect(result.conclusion).toBe('INCONCLUSIVE');
  });

  it('INCONCLUSIVE with a null ratio for a zero baseline', () => {
    const result = evaluateExperiment(0, 50, 'INCREASE', 10);
    expect(result.conclusion).toBe('INCONCLUSIVE');
    expect(result.observedRatio).toBeNull();
  });

  it('never upgrades a single dramatic sample past LOW confidence', () => {
    const result = evaluateExperiment(100, 1000, 'INCREASE', 1);
    expect(result.confidence).toBe('LOW');
  });

  it('confidence buckets: HIGH >=8, MEDIUM >=3, LOW below', () => {
    expect(evaluateExperiment(100, 200, 'INCREASE', 8).confidence).toBe('HIGH');
    expect(evaluateExperiment(100, 200, 'INCREASE', 3).confidence).toBe('MEDIUM');
    expect(evaluateExperiment(100, 200, 'INCREASE', 2).confidence).toBe('LOW');
  });
});
