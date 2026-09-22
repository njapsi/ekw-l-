import { describe, expect, it } from 'vitest';
import { evaluateStopConditions, isTerminalStop, type StopEvaluationInput } from './stop-conditions.js';
import { DEFAULT_MISSION_LIMITS } from './schemas.js';

function base(overrides: Partial<StopEvaluationInput> = {}): StopEvaluationInput {
  return {
    status: 'ACTIVE',
    targetDate: null,
    now: new Date('2026-01-15T00:00:00Z'),
    limits: DEFAULT_MISSION_LIMITS,
    toolCallCount: 0,
    taskCount: 0,
    budgetMaxUsd: null,
    budgetSpentUsd: 0,
    loopFailureCount: 0,
    allSuccessMetricsMet: false,
    requiredIntegrationDisconnected: false,
    ...overrides,
  };
}

describe('evaluateStopConditions', () => {
  it('returns null (keep going) when nothing is triggered', () => {
    expect(evaluateStopConditions(base())).toBeNull();
  });

  it('USER_PAUSED when the mission status is PAUSED', () => {
    expect(evaluateStopConditions(base({ status: 'PAUSED' }))).toBe('USER_PAUSED');
  });

  it('GOAL_ACHIEVED takes priority once every success metric is met', () => {
    expect(evaluateStopConditions(base({ allSuccessMetricsMet: true }))).toBe('GOAL_ACHIEVED');
  });

  it('DEADLINE_REACHED once the target date has passed', () => {
    const result = evaluateStopConditions(
      base({ targetDate: new Date('2026-01-14T00:00:00Z'), now: new Date('2026-01-15T00:00:00Z') }),
    );
    expect(result).toBe('DEADLINE_REACHED');
  });

  it('not yet DEADLINE_REACHED before the target date', () => {
    const result = evaluateStopConditions(
      base({ targetDate: new Date('2026-02-01T00:00:00Z'), now: new Date('2026-01-15T00:00:00Z') }),
    );
    expect(result).toBeNull();
  });

  it('BUDGET_EXHAUSTED once spend meets the configured max', () => {
    expect(evaluateStopConditions(base({ budgetMaxUsd: 100, budgetSpentUsd: 100 }))).toBe('BUDGET_EXHAUSTED');
  });

  it('no budget stop when maxUsd is null (unlimited/unconfigured)', () => {
    expect(evaluateStopConditions(base({ budgetMaxUsd: null, budgetSpentUsd: 1_000_000 }))).toBeNull();
  });

  it('ACTION_LIMIT_REACHED at the configured tool-call ceiling', () => {
    const limits = { ...DEFAULT_MISSION_LIMITS, maxToolCalls: 10 };
    expect(evaluateStopConditions(base({ limits, toolCallCount: 10 }))).toBe('ACTION_LIMIT_REACHED');
  });

  it('TASK_LIMIT_REACHED at the configured task ceiling', () => {
    const limits = { ...DEFAULT_MISSION_LIMITS, maxTasks: 5 };
    expect(evaluateStopConditions(base({ limits, taskCount: 5 }))).toBe('TASK_LIMIT_REACHED');
  });

  it('INTEGRATION_DISCONNECTED when a required platform is gone', () => {
    expect(evaluateStopConditions(base({ requiredIntegrationDisconnected: true }))).toBe(
      'INTEGRATION_DISCONNECTED',
    );
  });

  it('REPEATED_FAILURE after 5 consecutive loop failures', () => {
    expect(evaluateStopConditions(base({ loopFailureCount: 5 }))).toBe('REPEATED_FAILURE');
    expect(evaluateStopConditions(base({ loopFailureCount: 4 }))).toBeNull();
  });

  it('a lagging metric that has not moved yet does not, by itself, stop the mission (§10)', () => {
    // allSuccessMetricsMet is computed by the caller from real metric rows;
    // when it is honestly false, evaluateStopConditions must not invent a
    // stop reason just because progress looks slow.
    expect(evaluateStopConditions(base({ allSuccessMetricsMet: false, toolCallCount: 3, taskCount: 2 }))).toBeNull();
  });
});

describe('isTerminalStop', () => {
  it('GOAL_ACHIEVED and DEADLINE_REACHED are terminal', () => {
    expect(isTerminalStop('GOAL_ACHIEVED')).toBe(true);
    expect(isTerminalStop('DEADLINE_REACHED')).toBe(true);
  });

  it('resource/failure reasons are not terminal — the mission can resume', () => {
    expect(isTerminalStop('BUDGET_EXHAUSTED')).toBe(false);
    expect(isTerminalStop('REPEATED_FAILURE')).toBe(false);
    expect(isTerminalStop('INTEGRATION_DISCONNECTED')).toBe(false);
  });
});
