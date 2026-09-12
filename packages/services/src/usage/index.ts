/**
 * The `usage` module — centralized metering + limit enforcement (master
 * instruction hard rule 11, ADR-0010/0025). Split from `billing`: `billing`
 * owns plans, Stripe and entitlements; `usage` owns counting and the
 * `check` → do work → `record` cycle. Limits are always enforced here,
 * server-side; the browser is never trusted.
 */
export * from './meters.js';
export { checkUsage, type UsageVerdict, type CheckUsageInput } from './check.js';
export { recordUsage, type RecordUsageInput, type RecordUsageResult } from './record.js';
export { enforceUsage, guardUsage, UsageLimitError, type EnforceUsageInput } from './enforce.js';
export {
  getUsageSummary,
  refreshUsageCounters,
  type UsageSummary,
  type MeterUsage,
} from './summary.js';
export { createAiUsageSink, recordAgentRunUsage, type AiSinkOptions } from './ai-sink.js';
export {
  checkAiUserLimit,
  enforceAiUserLimit,
  type AiUserLimitInput,
  type AiUserLimitResult,
} from './ai-limit.js';
export {
  checkAiBudget,
  enforceAiBudget,
  type AiBudgetInput,
  type AiBudgetVerdict,
} from './ai-budget.js';
