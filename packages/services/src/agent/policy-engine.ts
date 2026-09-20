/**
 * The Tool Policy Engine (Phase 5, Parts 11-12).
 *
 * Every tool invocation — native, research, or MCP — passes through one
 * deterministic decision function before it runs. The engine composes
 * outcomes from systems that already exist rather than re-deriving them:
 * org AI governance (`governance.decide`), connection/capability usability
 * (`integrations/contract.ts`), plan usage (`usage.checkUsage`), and abuse
 * rate limiting (`security.checkRateLimit`). It never talks to a database or
 * Redis itself — `evaluateToolPolicy` is a pure function over pre-resolved
 * facts, exactly like `integrations/contract.ts`'s own "deliberately pure"
 * convention, so every precedence rule is exhaustively unit-testable without
 * mocking I/O. `resolveNativeToolPolicy` / `resolveGenericToolPolicy` do the
 * actual fact-gathering for the two shapes of tool this codebase has.
 *
 * Precedence (brief Part 12): a security/governance DENY always wins; a
 * connection that cannot serve the request right now (REAUTH_REQUIRED /
 * UNAVAILABLE) is reported before a quota or rate problem, because fixing
 * quota would not make the tool usable; RATE_LIMITED (abuse protection) is
 * checked before QUOTA_EXCEEDED (plan limit) because the former is cheaper
 * to evaluate and is not a billing signal. A model's own request is never a
 * source of authority here — nothing in this module reads anything the
 * model produced except the tool name and arguments the caller already
 * decided to evaluate.
 *
 * Native tools (`integrations.*`, `wordpress.*`) already enforce governance
 * and capability usability *inside* `integration-tools.ts`'s own
 * `execute()` functions (Phase 1, already audited — Phase 22/25's
 * adversarial suites cover it). This module does not re-implement or
 * shadow that enforcement for native tools; `tool-executor.ts` still calls
 * `runIntegrationTool` unchanged and relies on its existing throw behaviour.
 * The Policy Engine's outcome vocabulary is instead the primary
 * authorization path for the two tool kinds that had none: MCP tools
 * (Part 33 — Growth Agent's own layer, separate from the MCP server's own
 * authorization) and the new research tools, and it is reused for a
 * dry-run/what-if check (e.g. capability discovery) against any tool kind.
 */
import type { ActionClass, GovernanceDecision } from '../governance/index.js';
import type { CapabilityLevel, ConnectionState } from '../integrations/contract.js';

export type ToolPolicyOutcome =
  | 'ALLOW'
  | 'DENY'
  | 'REQUIRE_APPROVAL'
  | 'REAUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'UNAVAILABLE';

export interface ToolPolicyDecision {
  outcome: ToolPolicyOutcome;
  reason: string;
  requiresApproval: boolean;
}

/** `'NONE'` — the tool has no connected-account concept at all (research). */
export type PolicyConnectionState = ConnectionState | 'NONE';

export interface ToolPolicyInput {
  actionClass: ActionClass;
  level: CapabilityLevel;
  connection: PolicyConnectionState;
  /** Pre-computed via `governance.decide()`. */
  governance: GovernanceDecision;
  /** `null` skips the quota check entirely (e.g. a free read with no meter). */
  quotaExceeded: boolean | null;
  rateLimited: boolean;
}

function connectionOutcome(state: PolicyConnectionState): ToolPolicyOutcome | null {
  if (state === 'NONE' || state === 'CONNECTED' || state === 'DEGRADED') return null;
  if (state === 'REAUTH_REQUIRED') return 'REAUTH_REQUIRED';
  // NOT_CONNECTED, CONNECTING, EXPIRED, ERROR, DISCONNECTED: the tool cannot
  // serve the request right now, but a fix other than "reconnect" may
  // resolve it (a retry, a sync running to completion) — UNAVAILABLE, not
  // the stronger REAUTH_REQUIRED.
  return 'UNAVAILABLE';
}

/**
 * The one deterministic decision. Governance's own DENY (an org disabled the
 * action, or disallowed the agent for this integration entirely) outranks
 * everything, because it is an explicit organizational security choice, not
 * a transient condition — undoing it requires a policy change, not a retry.
 */
export function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  if (!input.governance.allowed) {
    return { outcome: 'DENY', reason: input.governance.reason, requiresApproval: false };
  }

  const connOutcome = connectionOutcome(input.connection);
  if (connOutcome === 'REAUTH_REQUIRED') {
    return {
      outcome: 'REAUTH_REQUIRED',
      reason: 'This connection needs to be reauthorized before the tool can run.',
      requiresApproval: false,
    };
  }
  if (connOutcome === 'UNAVAILABLE') {
    return {
      outcome: 'UNAVAILABLE',
      reason: 'This tool is not usable right now (the connection is not ready).',
      requiresApproval: false,
    };
  }

  if (input.rateLimited) {
    return {
      outcome: 'RATE_LIMITED',
      reason: 'Too many tool calls in a short period. Try again shortly.',
      requiresApproval: false,
    };
  }

  if (input.quotaExceeded === true) {
    return {
      outcome: 'QUOTA_EXCEEDED',
      reason: "This organization's plan usage limit for tool calls has been reached.",
      requiresApproval: false,
    };
  }

  if (input.governance.requiresApproval) {
    return {
      outcome: 'REQUIRE_APPROVAL',
      reason: 'This action requires human approval before it can run.',
      requiresApproval: true,
    };
  }

  return { outcome: 'ALLOW', reason: 'Allowed.', requiresApproval: false };
}

/**
 * The capability-level floor a caller can use for a tool kind that has no
 * dynamic org governance bucket of its own (research). READ/DRAFT run
 * freely; anything at WRITE or above always requires approval, mirroring
 * `integrations/contract.ts`'s `APPROVAL_POLICY` — the same floor every
 * native capability already obeys, applied to a tool kind that never had a
 * governance record before Phase 5.
 */
export function floorDecision(level: CapabilityLevel): GovernanceDecision {
  const requiresApproval = level !== 'READ' && level !== 'DRAFT';
  return { allowed: true, requiresApproval };
}
