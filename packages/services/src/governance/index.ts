/**
 * AI governance (Phase 2, Parts 23–26). ADR-0052.
 *
 * An organization-level policy that says, per integration and per action
 * class, whether AI-initiated work runs automatically, needs a human
 * approval, or is disabled — plus which integrations the agent may touch
 * and limits for background automation.
 *
 * Hard floor: `modify`, `publish` and `delete` can be `approval_required` or
 * `disabled`, never `automatic`. Hard rule 4 permits skipping approval only in
 * an explicit "automation mode", which this product does not implement; the
 * schema therefore cannot express an unsafe policy. Absent a stored policy,
 * `DEFAULT_POLICY` applies.
 */
import { type Db, prisma, requireMembership } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { AUTOMATION_TASK_TYPES } from '../automation/schemas.js';

export { AUTOMATION_TASK_TYPES };
import type { CapabilityLevel, IntegrationKey } from '../integrations/contract.js';
import { authorize } from '../rbac/authorize.js';

/** `decide()` / `assertGovernanceAllows()` accept any governed bucket — the
 *  five real connected integrations from `contract.ts`, plus `'MCP'`, which
 *  has no `IntegrationDescriptor` of its own (Phase 5). */
export type GovernanceTarget = IntegrationKey | 'MCP';

export const ACTION_CLASSES = [
  'analyze',
  'generate',
  'draft',
  'modify',
  'publish',
  'delete',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const GOVERNED_INTEGRATIONS = [
  'YOUTUBE',
  'TIKTOK',
  'WORDPRESS',
  'GOOGLE_SEARCH_CONSOLE',
  'WEBSITE',
  /** Phase 5 — the bucket every connected MCP server's tools are governed
   *  under, regardless of which server. A per-server or per-tool override
   *  is not modelled yet (Part 77 — deferred; every MCP tool call is org-wide
   *  governed the same way for now, on top of the tool's own explicit
   *  enable/disable and the server's own trust level). */
  'MCP',
] as const;
export type GovernedIntegration = (typeof GOVERNED_INTEGRATIONS)[number];

const Mode = z.enum(['automatic', 'approval_required', 'disabled']);
const GatedMode = z.enum(['approval_required', 'disabled']);
export type GovernanceMode = z.infer<typeof Mode>;

const IntegrationPolicy = z.object({
  agentAllowed: z.boolean(),
  analyze: Mode,
  generate: Mode,
  draft: Mode,
  modify: GatedMode,
  publish: GatedMode,
  delete: GatedMode,
});
export type IntegrationPolicy = z.infer<typeof IntegrationPolicy>;

/**
 * Third-party MCP tools carry more inherent uncertainty than our own native
 * integrations (Phase 5, Part 30 — a newly connected server defaults to
 * UNVERIFIED_EXTERNAL trust, and every discovered tool is disabled until an
 * admin opts it in). The org-wide governance default is correspondingly more
 * conservative than the native-integration default below: reading through an
 * enabled MCP tool is still automatic (the per-tool enable flag is the real
 * gate), but Growth Agent never generates or drafts content by feeding an
 * MCP tool's output back into a write, and any MCP-tool-driven write is
 * disabled outright rather than merely gated behind approval — an org that
 * wants MCP write access must explicitly loosen this in Settings → AI
 * governance.
 */
const MCP_DEFAULT: IntegrationPolicy = {
  agentAllowed: true,
  analyze: 'automatic',
  generate: 'disabled',
  draft: 'disabled',
  modify: 'disabled',
  publish: 'disabled',
  delete: 'disabled',
};

export const GovernancePolicySchema = z.object({
  version: z.literal(1),
  integrations: z.object({
    ...(Object.fromEntries(
      GOVERNED_INTEGRATIONS.filter((k) => k !== 'MCP').map((k) => [k, IntegrationPolicy]),
    ) as Record<Exclude<GovernedIntegration, 'MCP'>, typeof IntegrationPolicy>),
    // `.default` — a policy stored before Phase 5 has no `MCP` key at all;
    // it must still parse, getting the conservative default above rather
    // than silently reverting the org's whole customized policy to
    // `DEFAULT_POLICY` (the same forward-compatibility reasoning as
    // `approvalTtlMinutes` below).
    MCP: IntegrationPolicy.default(MCP_DEFAULT),
  }),
  automation: z.object({
    /** Minimum minutes between two runs of the same automation. */
    minIntervalMinutes: z.number().int().min(15).max(10_080),
    allowedTaskTypes: z.array(z.enum(AUTOMATION_TASK_TYPES)),
  }),
  /**
   * How long a PENDING approval (`IntegrationActionRequest`) stays valid
   * before it expires and must be recreated (Phase 4, Part 10). `.default`
   * so a policy stored before this field existed still parses — it gets the
   * same 7-day value that was previously hardcoded, not silently rejected.
   * Bounds: 15 minutes minimum (long enough for a human to actually see and
   * act on a notification) to 30 days maximum.
   */
  approvalTtlMinutes: z.number().int().min(15).max(43_200).default(10_080),
});
export type GovernancePolicy = z.infer<typeof GovernancePolicySchema>;

const base: IntegrationPolicy = {
  agentAllowed: true,
  analyze: 'automatic',
  generate: 'automatic',
  draft: 'automatic',
  modify: 'approval_required',
  publish: 'approval_required',
  delete: 'approval_required',
};

/** The brief's recommended defaults (Part 26). */
export const DEFAULT_POLICY: GovernancePolicy = {
  version: 1,
  integrations: {
    YOUTUBE: { ...base },
    TIKTOK: { ...base },
    WORDPRESS: { ...base },
    GOOGLE_SEARCH_CONSOLE: { ...base, generate: 'disabled', draft: 'disabled' },
    WEBSITE: { ...base },
    MCP: { ...MCP_DEFAULT },
  },
  automation: { minIntervalMinutes: 60, allowedTaskTypes: [...AUTOMATION_TASK_TYPES] },
  approvalTtlMinutes: 10_080,
};

export function actionClassForLevel(level: CapabilityLevel): ActionClass {
  switch (level) {
    case 'READ':
      return 'analyze';
    case 'DRAFT':
      return 'draft';
    case 'WRITE':
      return 'modify';
    case 'PUBLISH':
      return 'publish';
    case 'DANGEROUS':
      return 'delete';
  }
}

export async function getGovernancePolicy(
  organizationId: string,
  db: Db = prisma,
): Promise<GovernancePolicy> {
  const row = await db.aiGovernancePolicy.findUnique({
    where: { organizationId },
    select: { policy: true },
  });
  if (!row) return DEFAULT_POLICY;
  const parsed = GovernancePolicySchema.safeParse(row.policy);
  // A stored policy that no longer parses (e.g. after a schema change) must
  // not silently loosen anything: fall back to the safe defaults.
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}

export async function updateGovernancePolicy(
  actorUserId: string,
  organizationId: string,
  raw: unknown,
  db: Db = prisma,
): Promise<GovernancePolicy> {
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, 'agent.configure');
  const parsed = GovernancePolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues[0]?.message ??
        'Invalid policy. Modify, publish and delete can only require approval or be disabled.',
    );
  }
  const before = await getGovernancePolicy(organizationId, db);
  await db.aiGovernancePolicy.upsert({
    where: { organizationId },
    create: {
      organizationId,
      policy: parsed.data,
      updatedById: actorUserId,
    },
    update: { policy: parsed.data, updatedById: actorUserId },
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'governance.updated',
      targetType: 'ai_governance_policy',
      targetId: organizationId,
      metadata: { changes: diffPolicy(before, parsed.data) },
    },
    db,
  );
  return parsed.data;
}

function diffPolicy(a: GovernancePolicy, b: GovernancePolicy): string[] {
  const out: string[] = [];
  for (const k of GOVERNED_INTEGRATIONS) {
    for (const f of ['agentAllowed', ...ACTION_CLASSES] as const) {
      if (a.integrations[k][f] !== b.integrations[k][f]) {
        out.push(`${k}.${f}: ${String(a.integrations[k][f])} → ${String(b.integrations[k][f])}`);
      }
    }
  }
  if (a.automation.minIntervalMinutes !== b.automation.minIntervalMinutes) {
    out.push(
      `automation.minIntervalMinutes: ${a.automation.minIntervalMinutes} → ${b.automation.minIntervalMinutes}`,
    );
  }
  if (a.automation.allowedTaskTypes.join() !== b.automation.allowedTaskTypes.join()) {
    out.push('automation.allowedTaskTypes changed');
  }
  return out;
}

export type GovernanceDecision =
  { allowed: true; requiresApproval: boolean } | { allowed: false; reason: string };

/**
 * The policy decision for one AI-initiated action. `requiresApproval` is the
 * OR of the capability's own floor (WRITE+ always) and the org policy.
 */
export function decide(
  policy: GovernancePolicy,
  integration: GovernanceTarget,
  cls: ActionClass,
  opts: { viaAgent: boolean },
): GovernanceDecision {
  const p = policy.integrations[integration];
  if (!p) return { allowed: true, requiresApproval: cls !== 'analyze' && cls !== 'generate' };
  if (opts.viaAgent && !p.agentAllowed) {
    return {
      allowed: false,
      reason: `The AI agent is not allowed to use ${integration} in this organization.`,
    };
  }
  const mode = p[cls];
  if (mode === 'disabled') {
    return {
      allowed: false,
      reason: `"${cls}" actions for ${integration} are disabled by this organization's AI governance policy.`,
    };
  }
  const floor = cls === 'modify' || cls === 'publish' || cls === 'delete';
  return { allowed: true, requiresApproval: floor || mode === 'approval_required' };
}

export async function assertGovernanceAllows(
  organizationId: string,
  integration: GovernanceTarget,
  cls: ActionClass,
  opts: { viaAgent: boolean },
  db: Db = prisma,
): Promise<{ requiresApproval: boolean }> {
  const d = decide(await getGovernancePolicy(organizationId, db), integration, cls, opts);
  if (!d.allowed) throw AppError.forbidden(d.reason);
  return { requiresApproval: d.requiresApproval };
}

/** Automation guardrails: allowed task type + minimum interval. */
export async function assertAutomationAllowed(
  organizationId: string,
  taskType: string,
  minutesBetweenRuns: number | null,
  db: Db = prisma,
): Promise<void> {
  const policy = await getGovernancePolicy(organizationId, db);
  if (!(policy.automation.allowedTaskTypes as readonly string[]).includes(taskType)) {
    throw AppError.forbidden(
      `Automations of type ${taskType} are not allowed by this organization's AI governance policy.`,
    );
  }
  if (minutesBetweenRuns !== null && minutesBetweenRuns < policy.automation.minIntervalMinutes) {
    throw AppError.validation(
      `This schedule runs every ${minutesBetweenRuns} minutes; the organization allows at most one run every ${policy.automation.minIntervalMinutes} minutes.`,
    );
  }
}
