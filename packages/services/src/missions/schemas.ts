/**
 * Growth Missions — schemas (Phase 10). `GrowthMission.budget`/`constraints`/
 * `limits`/`approvalPolicy`/`successMetrics`/`currentStrategy` are Zod-
 * validated JSON rather than their own tables, mirroring
 * `AiGovernancePolicy.policy`'s existing precedent (one config blob per
 * organization/mission, no relational need for a join table).
 *
 * `MissionLimits` is the resource-limit ceiling (§36 — "prevent runaway
 * agents"). Every bound has a product-chosen maximum a mission's own config
 * cannot exceed, so a user (or a compromised planning prompt) cannot ask the
 * mission to remove its own leash.
 */
import { z } from 'zod';

export const MISSION_AUTONOMY_LEVELS = ['ADVISORY', 'ASSISTED', 'SUPERVISED', 'CONTROLLED'] as const;
export type MissionAutonomyLevelKey = (typeof MISSION_AUTONOMY_LEVELS)[number];

export const MISSION_PLATFORMS = [
  'YOUTUBE',
  'TIKTOK',
  'SEO',
  'WORDPRESS',
  'WEBSITE',
  'CROSS_PLATFORM',
] as const;
export type MissionPlatformKey = (typeof MISSION_PLATFORMS)[number];

export const MISSION_TASK_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type MissionTaskRiskKey = (typeof MISSION_TASK_RISKS)[number];

/** Absolute ceilings — a mission's own `limits` can only ever be at or below
 *  these, never above (Part 36/56 — "do not add unrestricted autonomy"). */
export const LIMIT_CEILINGS = {
  maxToolCalls: 2_000,
  maxTasks: 300,
  maxDurationDays: 365,
  maxRetries: 5,
  maxPublishPerWeek: 14,
  maxContentGenerationsPerWeek: 50,
} as const;

export const MissionLimitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(LIMIT_CEILINGS.maxToolCalls).default(500),
  maxTasks: z.number().int().min(1).max(LIMIT_CEILINGS.maxTasks).default(100),
  maxDurationDays: z.number().int().min(1).max(LIMIT_CEILINGS.maxDurationDays).default(180),
  maxRetries: z.number().int().min(0).max(LIMIT_CEILINGS.maxRetries).default(2),
  maxPublishPerWeek: z.number().int().min(0).max(LIMIT_CEILINGS.maxPublishPerWeek).default(3),
  maxContentGenerationsPerWeek: z
    .number()
    .int()
    .min(0)
    .max(LIMIT_CEILINGS.maxContentGenerationsPerWeek)
    .default(10),
});
export type MissionLimits = z.infer<typeof MissionLimitsSchema>;

export const DEFAULT_MISSION_LIMITS: MissionLimits = MissionLimitsSchema.parse({});

/** A mission's own tightening on top of org AI governance — can only add
 *  approval gates, never remove one the org policy or the capability floor
 *  already requires (`missions/policy.ts` enforces this at read time). */
export const MissionApprovalPolicySchema = z.object({
  /** Additional risk levels that always require approval for this mission,
   *  even if the org's governance policy would otherwise let them run. */
  alwaysApprove: z.array(z.enum(MISSION_TASK_RISKS)).default(['HIGH', 'CRITICAL']),
});
export type MissionApprovalPolicy = z.infer<typeof MissionApprovalPolicySchema>;

export const MissionBudgetSchema = z.object({
  maxUsd: z.number().min(0).max(100_000).nullable().default(null),
  spentUsd: z.number().min(0).default(0),
  currency: z.string().length(3).default('USD'),
});
export type MissionBudget = z.infer<typeof MissionBudgetSchema>;

export const MissionSuccessMetricDefSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  kind: z.enum(['LEADING', 'LAGGING']),
  unit: z.string().max(40).optional(),
  targetValue: z.number().optional(),
});
export type MissionSuccessMetricDef = z.infer<typeof MissionSuccessMetricDefSchema>;

export const MissionStrategySchema = z.object({
  narrative: z.string().max(4_000),
  currentState: z.string().max(2_000),
  targetState: z.string().max(2_000),
  assumptions: z.array(z.string().max(400)).max(20).default([]),
  risks: z.array(z.string().max(400)).max(20).default([]),
  /** Whether a model refined the narrative (grounded) or it is the
   *  deterministic fallback — never claimed as more certain than it is. */
  grounded: z.boolean().default(false),
});
export type MissionStrategy = z.infer<typeof MissionStrategySchema>;

/** Mission creation input from the UI wizard (§47). Only the goal is
 *  required; everything else gets a safe default the plan discloses. */
export const CreateMissionInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  description: z.string().trim().max(4_000).optional(),
  targetDate: z.coerce.date().optional(),
  platforms: z.array(z.enum(MISSION_PLATFORMS)).min(1).max(6).default(['CROSS_PLATFORM']),
  autonomyLevel: z.enum(MISSION_AUTONOMY_LEVELS).default('ASSISTED'),
  successMetrics: z.array(MissionSuccessMetricDefSchema).max(10).default([]),
  budget: MissionBudgetSchema.partial().optional(),
  constraints: z.string().max(2_000).optional(),
  limits: MissionLimitsSchema.partial().optional(),
});
export type CreateMissionInput = z.infer<typeof CreateMissionInputSchema>;

export function autonomyRank(level: MissionAutonomyLevelKey): number {
  return MISSION_AUTONOMY_LEVELS.indexOf(level);
}
