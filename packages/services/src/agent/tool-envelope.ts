/**
 * The standardized tool result/error envelope (Phase 5, Parts 26-27). Every
 * tool call this codebase makes — native, research, or MCP — returns one of
 * these instead of a raw provider payload or a bare thrown error, so the
 * orchestrator (and, transitively, the model) can always distinguish
 * "the tool succeeded", "it succeeded but only partially", "it was blocked
 * by policy", and "it needs a human decision" without string-matching an
 * error message.
 */
import type { ToolPolicyOutcome } from './policy-engine.js';

export type ToolResultStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'BLOCKED' | 'REQUIRES_APPROVAL';

export interface ToolErrorEnvelope {
  code:
    | 'POLICY_DENIED'
    | 'REAUTH_REQUIRED'
    | 'RATE_LIMITED'
    | 'QUOTA_EXCEEDED'
    | 'UNAVAILABLE'
    | 'VALIDATION_FAILED'
    | 'TIMEOUT'
    | 'PROVIDER_ERROR'
    | 'INTERNAL_ERROR';
  /** User-safe — never a raw stack trace or provider exception body. */
  message: string;
  retryable: boolean;
  requiresUserAction: boolean;
  requiresReauth: boolean;
  requiresApproval: boolean;
  provider: string;
  /** Correlates this failure to the AgentRunEvent / audit-log entries. */
  correlationId: string;
}

export interface ToolResultEnvelope<T = unknown> {
  status: ToolResultStatus;
  tool: string;
  provider: string;
  durationMs: number;
  data?: T;
  warnings: string[];
  error?: ToolErrorEnvelope;
  /** Ids of anything the tool call touched or produced (for citation/audit),
   *  e.g. a WordPress post id or an MCP tool call id. */
  resourceReferences: string[];
}

const OUTCOME_TO_ERROR_CODE: Record<
  Exclude<ToolPolicyOutcome, 'ALLOW'>,
  ToolErrorEnvelope['code']
> = {
  DENY: 'POLICY_DENIED',
  REQUIRE_APPROVAL: 'POLICY_DENIED', // never reached — REQUIRE_APPROVAL has its own branch
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UNAVAILABLE: 'UNAVAILABLE',
};

export function success<T>(input: {
  tool: string;
  provider: string;
  durationMs: number;
  data: T;
  warnings?: string[];
  resourceReferences?: string[];
}): ToolResultEnvelope<T> {
  return {
    status: 'SUCCESS',
    tool: input.tool,
    provider: input.provider,
    durationMs: input.durationMs,
    data: input.data,
    warnings: input.warnings ?? [],
    resourceReferences: input.resourceReferences ?? [],
  };
}

export function partial<T>(input: {
  tool: string;
  provider: string;
  durationMs: number;
  data: T;
  warnings: string[];
  resourceReferences?: string[];
}): ToolResultEnvelope<T> {
  return {
    status: 'PARTIAL',
    tool: input.tool,
    provider: input.provider,
    durationMs: input.durationMs,
    data: input.data,
    warnings: input.warnings,
    resourceReferences: input.resourceReferences ?? [],
  };
}

/** From a Policy Engine decision that was not ALLOW. */
export function blockedFromPolicy(input: {
  tool: string;
  provider: string;
  durationMs: number;
  outcome: Exclude<ToolPolicyOutcome, 'ALLOW'>;
  reason: string;
  correlationId: string;
}): ToolResultEnvelope<never> {
  if (input.outcome === 'REQUIRE_APPROVAL') {
    return {
      status: 'REQUIRES_APPROVAL',
      tool: input.tool,
      provider: input.provider,
      durationMs: input.durationMs,
      warnings: [],
      resourceReferences: [],
      error: {
        code: 'POLICY_DENIED',
        message: input.reason,
        retryable: false,
        requiresUserAction: true,
        requiresReauth: false,
        requiresApproval: true,
        provider: input.provider,
        correlationId: input.correlationId,
      },
    };
  }
  return {
    status: 'BLOCKED',
    tool: input.tool,
    provider: input.provider,
    durationMs: input.durationMs,
    warnings: [],
    resourceReferences: [],
    error: {
      code: OUTCOME_TO_ERROR_CODE[input.outcome],
      message: input.reason,
      retryable: input.outcome === 'RATE_LIMITED' || input.outcome === 'UNAVAILABLE',
      requiresUserAction: input.outcome === 'REAUTH_REQUIRED' || input.outcome === 'QUOTA_EXCEEDED',
      requiresReauth: input.outcome === 'REAUTH_REQUIRED',
      requiresApproval: false,
      provider: input.provider,
      correlationId: input.correlationId,
    },
  };
}

export function failed(input: {
  tool: string;
  provider: string;
  durationMs: number;
  code: ToolErrorEnvelope['code'];
  message: string;
  retryable?: boolean;
  correlationId: string;
}): ToolResultEnvelope<never> {
  return {
    status: 'FAILED',
    tool: input.tool,
    provider: input.provider,
    durationMs: input.durationMs,
    warnings: [],
    resourceReferences: [],
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable ?? false,
      requiresUserAction: false,
      requiresReauth: false,
      requiresApproval: false,
      provider: input.provider,
      correlationId: input.correlationId,
    },
  };
}
