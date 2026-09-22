/**
 * Mission stop conditions (Phase 10, §21) — pure evaluation over a snapshot
 * of mission state. The loop calls this before scheduling any new work; a
 * non-null result means "stop, do not start another task this tick" (and,
 * for several reasons, transition the mission out of ACTIVE).
 */
import type { MissionLimits } from './schemas.js';

export type MissionStopReason =
  | 'GOAL_ACHIEVED'
  | 'DEADLINE_REACHED'
  | 'BUDGET_EXHAUSTED'
  | 'ACTION_LIMIT_REACHED'
  | 'TASK_LIMIT_REACHED'
  | 'INTEGRATION_DISCONNECTED'
  | 'REPEATED_FAILURE'
  | 'SAFETY_POLICY_TRIGGERED'
  | 'USER_PAUSED'
  | 'APPROVAL_UNAVAILABLE';

export interface StopEvaluationInput {
  status: 'DRAFT' | 'PLANNING' | 'AWAITING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  targetDate: Date | null;
  now: Date;
  limits: MissionLimits;
  toolCallCount: number;
  taskCount: number;
  budgetMaxUsd: number | null;
  budgetSpentUsd: number;
  /** Consecutive loop-tick failures (mirrors `AutomationRule.failureCount`). */
  loopFailureCount: number;
  /** True once every task in the mission's graph has reached a terminal
   *  state and every success metric has hit its target (computed by the
   *  caller from real metric rows — never guessed here). */
  allSuccessMetricsMet: boolean;
  /** True when a platform this mission depends on lost its connection since
   *  the mission was activated. */
  requiredIntegrationDisconnected: boolean;
}

const LOOP_FAILURE_LIMIT = 5;

/** Returns the first applicable stop reason, or null to keep going. Order
 *  matters only for which reason is reported when several are true at once —
 *  every branch is independently sufficient to stop. */
export function evaluateStopConditions(input: StopEvaluationInput): MissionStopReason | null {
  if (input.status === 'PAUSED') return 'USER_PAUSED';
  if (input.allSuccessMetricsMet) return 'GOAL_ACHIEVED';
  if (input.targetDate && input.now >= input.targetDate) return 'DEADLINE_REACHED';
  if (input.budgetMaxUsd != null && input.budgetSpentUsd >= input.budgetMaxUsd) {
    return 'BUDGET_EXHAUSTED';
  }
  if (input.toolCallCount >= input.limits.maxToolCalls) return 'ACTION_LIMIT_REACHED';
  if (input.taskCount >= input.limits.maxTasks) return 'TASK_LIMIT_REACHED';
  if (input.requiredIntegrationDisconnected) return 'INTEGRATION_DISCONNECTED';
  if (input.loopFailureCount >= LOOP_FAILURE_LIMIT) return 'REPEATED_FAILURE';
  return null;
}

/** Whether a stop reason means the mission is genuinely done (vs. merely
 *  paused for a fixable condition the user can resolve and resume from). */
export function isTerminalStop(reason: MissionStopReason): boolean {
  return reason === 'GOAL_ACHIEVED' || reason === 'DEADLINE_REACHED';
}
