import { describe, expect, it } from 'vitest';
import { evaluateExperiment } from './experiments.js';

describe('evaluateExperiment', () => {
  it('reports SUPPORTED when the metric moves meaningfully in the expected direction', () => {
    const result = evaluateExperiment(1000, 1300, 'INCREASE', 10);
    expect(result.conclusion).toBe('SUPPORTED');
    expect(result.changeRatio).toBeCloseTo(0.3, 5);
  });

  it('reports NOT_SUPPORTED when the metric moves meaningfully opposite the expected direction', () => {
    const result = evaluateExperiment(1000, 700, 'INCREASE', 10);
    expect(result.conclusion).toBe('NOT_SUPPORTED');
  });

  it('reports SUPPORTED for a DECREASE hypothesis when the metric drops meaningfully', () => {
    const result = evaluateExperiment(1000, 700, 'DECREASE', 10);
    expect(result.conclusion).toBe('SUPPORTED');
  });

  it('reports INCONCLUSIVE when the change is below the meaningful threshold', () => {
    const result = evaluateExperiment(1000, 1050, 'INCREASE', 10);
    expect(result.conclusion).toBe('INCONCLUSIVE');
  });

  it('reports INCONCLUSIVE with a null ratio when the baseline is zero', () => {
    const result = evaluateExperiment(0, 500, 'INCREASE', 10);
    expect(result.conclusion).toBe('INCONCLUSIVE');
    expect(result.changeRatio).toBeNull();
  });

  it('never forces a winner from a single data point — confidence is LOW below 3 samples even with a large change', () => {
    const result = evaluateExperiment(1000, 5000, 'INCREASE', 1);
    expect(result.confidence).toBe('LOW');
    // Still SUPPORTED (the direction is real), but flagged low-confidence —
    // never silently upgraded because the ratio looks dramatic.
    expect(result.conclusion).toBe('SUPPORTED');
  });

  it('assigns HIGH confidence at 8+ samples, MEDIUM at 3-7, LOW below 3', () => {
    expect(evaluateExperiment(1000, 1300, 'INCREASE', 8).confidence).toBe('HIGH');
    expect(evaluateExperiment(1000, 1300, 'INCREASE', 5).confidence).toBe('MEDIUM');
    expect(evaluateExperiment(1000, 1300, 'INCREASE', 2).confidence).toBe('LOW');
  });
});
