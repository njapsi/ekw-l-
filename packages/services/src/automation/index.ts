/**
 * The `automation` module (operator's "Phase 12"). Scheduled, retrying,
 * idempotent background automations. Every execution re-checks the OWNER's RBAC
 * so an automation can never exceed its owner's permissions, and no task type
 * performs an external publish (ADR-0027).
 */
export {
  AUTOMATION_TASK_TYPES,
  AUTOMATION_CADENCES,
  TASK_TYPE_META,
  assertNoExternalPublish,
  parseTaskConfig,
  type AutomationTaskTypeKey,
  type AutomationCadenceKey,
  type AutomationInput,
  type TaskTypeMeta,
} from './schemas.js';
export {
  parseCron,
  isValidCron,
  nextRunAfter,
  matches,
  cronForCadence,
  describeCron,
  CronError,
  type ParsedCron,
} from './cron.js';
export {
  createAutomation,
  updateAutomation,
  setAutomationStatus,
  deleteAutomation,
  listAutomations,
  getAutomation,
  resolveOwnerAuthz,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from './rules.js';
export {
  dueAutomations,
  dueRetryRuns,
  claimRun,
  executeAutomationRun,
  cancelRun,
  retryDelayMs,
  type ExecuteResult,
  type ClaimResult,
} from './runner.js';
export { dispatchTask, type DispatchContext, type DispatchResult } from './dispatch.js';
export {
  runAutomationSweepJob,
  runAutomationRetrySweepJob,
  runAutomationNowJob,
  type SweepResult,
} from './jobs.js';
