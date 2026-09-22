/**
 * Mission-level policy (Phase 10, §5/§15/§17/§33). This module is an
 * ADDITIONAL, mission-scoped pre-filter on top of the existing security
 * stack — it never replaces or loosens `assertGovernanceAllows`,
 * `assertCapabilityUsable`, or the approval queue's hard floor (hard rule 4:
 * WRITE/PUBLISH/DANGEROUS capabilities only ever file a pending
 * `IntegrationActionRequest`, by construction of every existing `*-tools.ts`
 * ACTION-kind tool — Phase 6-9 already built this invariant, this module
 * cannot violate it even if a policy decision here were wrong). What this
 * module decides is narrower: whether the mission's OWN configuration
 * (`allowedPlatforms`, `allowedActions`, `autonomyLevel`, `approvalPolicy`)
 * permits the loop to attempt a task at all, and whether it should dispatch
 * directly or go straight to an approval request.
 */
import { listToolMetadata, type ToolRiskLevel } from '../agent/tool-registry.js';
import type { MissionPlatformKey } from './schemas.js';

export type { ToolRiskLevel as MissionRiskLevel };

const RISK_RANK: Record<ToolRiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** The real risk level for a tool, from the same registry the Tool Executor
 *  uses — never a second, parallel classification. A task with no tool name
 *  (a pure human-decision task) is LOW risk by definition: it makes no call. */
export function lookupToolRisk(toolName: string | null): ToolRiskLevel {
  if (!toolName) return 'LOW';
  const meta = listToolMetadata().find((m) => m.name === toolName);
  return meta?.riskLevel ?? 'HIGH'; // an unrecognized name is never assumed safe
}

export interface MissionPolicyInput {
  allowedPlatforms: MissionPlatformKey[];
  allowedActions: string[];
  autonomyLevel: 'ADVISORY' | 'ASSISTED' | 'SUPERVISED' | 'CONTROLLED';
  alwaysApproveRisks: ToolRiskLevel[];
}

export interface MissionPolicyDecision {
  /** May this task run at all — automated or human-triggered? False when
   *  the platform or tool is outside the mission's own declared boundary —
   *  the mission cannot widen this itself (§17: "The AI must not expand
   *  these boundaries itself"). A human cannot override `permitted: false`
   *  either; only re-planning/re-configuring the mission can. */
  permitted: boolean;
  /** May the unattended background sweep (`loop.ts`) dispatch this task on
   *  its own, or must a human explicitly trigger it from the UI? This is
   *  the autonomy-level gate (§5-6) — it is completely independent of
   *  whether the underlying tool call ends up needing an approval:
   *  LOW-risk (READ/ANALYZE) tasks never take an external action, so they
   *  auto-run at *every* level, including ADVISORY ("analyze, research,
   *  recommend" — §5 Level 0); WRITE/PUBLISH/DANGEROUS tools always file a
   *  pending `IntegrationActionRequest` regardless of this flag (Phase 6-9's
   *  ACTION-tool convention, see module doc) — `autoExecutable` only
   *  changes whether the sweep *attempts* the call unattended, never
   *  whether attempting it is safe. */
  autoExecutable: boolean;
  reason: string;
}

/**
 * §5's four levels, applied to one task's real risk. HIGH/CRITICAL are
 * never auto-executable at any level — that floor is absolute (§33:
 * "High/critical actions must require explicit controls"), not something a
 * higher autonomy level can lift; in practice this is moot for background
 * safety (delegation.ts's propose-only routing already forces approval for
 * every such tool regardless), but it keeps the *unattended-sweep* decision
 * honest about what it is choosing to attempt on its own.
 */
export function evaluateMissionPolicy(
  input: MissionPolicyInput,
  task: { platform: MissionPlatformKey; toolName: string | null },
): MissionPolicyDecision {
  if (
    !input.allowedPlatforms.includes(task.platform) &&
    !input.allowedPlatforms.includes('CROSS_PLATFORM')
  ) {
    return {
      permitted: false,
      autoExecutable: false,
      reason: `"${task.platform}" is not one of this mission's allowed platforms.`,
    };
  }
  if (task.toolName && !isActionAllowlisted(input.allowedActions, task.toolName)) {
    return {
      permitted: false,
      autoExecutable: false,
      reason: `"${task.toolName}" is not one of this mission's allowed actions.`,
    };
  }

  const risk = lookupToolRisk(task.toolName);

  // LOW risk (READ/ANALYZE, including a pure human-decision task with no
  // tool at all) never takes an external action, so every autonomy level —
  // including ADVISORY — may run it unattended (§5 Level 0: "analyze,
  // research, recommend" is explicitly not gated behind approval).
  if (risk === 'LOW') {
    return { permitted: true, autoExecutable: true, reason: 'Low-risk analysis runs automatically at every autonomy level.' };
  }
  if (input.autonomyLevel === 'ADVISORY') {
    return {
      permitted: false,
      autoExecutable: false,
      reason: 'Advisory missions cannot take actions, only analyze and recommend.',
    };
  }
  if (input.alwaysApproveRisks.includes(risk)) {
    return {
      permitted: true,
      autoExecutable: false,
      reason: `This mission always requires approval for ${risk.toLowerCase()}-risk actions.`,
    };
  }
  if (risk === 'HIGH' || risk === 'CRITICAL') {
    return {
      permitted: true,
      autoExecutable: false,
      reason: `${risk} actions always require approval, regardless of autonomy level.`,
    };
  }

  // MEDIUM risk (e.g. a DRAFT-level tool that runs directly without an
  // approval queue detour, per Phase 6-9 precedent).
  switch (input.autonomyLevel) {
    case 'ASSISTED':
      return {
        permitted: true,
        autoExecutable: false,
        reason: 'Assisted missions prepare actions for a human to explicitly run.',
      };
    case 'SUPERVISED':
      return {
        permitted: true,
        autoExecutable: false,
        reason: 'Medium-risk actions need an explicit human trigger under supervised autonomy.',
      };
    case 'CONTROLLED':
      return {
        permitted: true,
        autoExecutable: true,
        reason: 'Pre-approved action class within a controlled-autonomy mission.',
      };
    default:
      return { permitted: true, autoExecutable: false, reason: 'Requires an explicit human trigger.' };
  }
}

function isActionAllowlisted(allowed: string[], toolName: string): boolean {
  if (allowed.length === 0) return true; // no restriction configured
  return allowed.some((prefix) => toolName === prefix || toolName.startsWith(`${prefix}.`));
}

export function riskAtLeast(risk: ToolRiskLevel, floor: ToolRiskLevel): boolean {
  return RISK_RANK[risk] >= RISK_RANK[floor];
}
