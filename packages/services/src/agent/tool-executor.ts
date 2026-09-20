/**
 * The single controlled entry point for every tool call the agent runtime
 * makes — native, research, or MCP (Phase 5, Parts 4, 20-23, 45, 88, 96).
 * `runIntegrationTool` / `runResearchTool` / `executeMcpTool` each already
 * decide their own authorization; this module is the layer *around* all
 * three that the brief asks for and none of them had on their own:
 *
 *   - a real per-org, per-tool rate limit and `TOOL_CALLS` usage meter,
 *     applied identically no matter which kind of tool was called;
 *   - a standardized `ToolResultEnvelope`/`ToolErrorEnvelope`, so a native
 *     tool's thrown `AppError` and an MCP tool's provider failure look the
 *     same to whatever calls this;
 *   - the durable `AgentRunEvent` timeline (`TOOL_SELECTED` →
 *     `TOOL_AUTHORIZATION_CHECK` → `TOOL_STARTED` → `TOOL_COMPLETED` /
 *     `TOOL_FAILED`), recorded only when the caller supplies an
 *     `agentRunId` — a standalone call (e.g. an admin's "test this MCP
 *     tool" button) has no run to attach events to, and that's fine.
 *
 * The identity fields on `ToolExecutionContext` are the caller's job to
 * derive from its own authenticated session — this module never reads an
 * organization or user id out of the tool name or arguments (Part 80-81).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { checkUsage, recordUsage } from '../usage/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import type { AppError } from '../errors.js';
import { isAppError } from '../errors.js';
import { recordAgentRunEvent } from './events.js';
import {
  INTEGRATION_TOOL_NAMES,
  runIntegrationTool,
  type IntegrationToolContext,
} from './integration-tools.js';
import type { ToolPolicyOutcome } from './policy-engine.js';
import { RESEARCH_TOOL_NAMES, runResearchTool } from '../research/tools.js';
import { executeMcpTool } from '../mcp/execute.js';
import { blockedFromPolicy, failed, success, type ToolResultEnvelope } from './tool-envelope.js';

export interface ToolExecutionContext {
  organizationId: string;
  userId: string | null;
  db?: Db;
  /** Attaches every event this call records to an existing turn's timeline. */
  agentRunId?: string;
}

const NATIVE_NAMES = new Set<string>(INTEGRATION_TOOL_NAMES);
const RESEARCH_NAMES = new Set<string>(RESEARCH_TOOL_NAMES);

function kindOf(name: string): 'native' | 'research' | 'mcp' | 'unknown' {
  if (NATIVE_NAMES.has(name)) return 'native';
  if (RESEARCH_NAMES.has(name)) return 'research';
  if (name.startsWith('mcp.')) return 'mcp';
  return 'unknown';
}

const APP_ERROR_OUTCOME: Partial<Record<AppError['code'], Exclude<ToolPolicyOutcome, 'ALLOW'>>> = {
  permission_denied: 'DENY',
  rate_limited: 'RATE_LIMITED',
  usage_limit_exceeded: 'QUOTA_EXCEEDED',
  provider_unavailable: 'UNAVAILABLE',
};

function envelopeFromError(
  tool: string,
  provider: string,
  durationMs: number,
  err: unknown,
  correlationId: string,
): ToolResultEnvelope<never> {
  if (isAppError(err)) {
    const outcome = APP_ERROR_OUTCOME[err.code];
    if (outcome) {
      return blockedFromPolicy({
        tool,
        provider,
        durationMs,
        outcome,
        reason: err.message,
        correlationId,
      });
    }
    if (err.code === 'validation_failed') {
      return failed({
        tool,
        provider,
        durationMs,
        code: 'VALIDATION_FAILED',
        message: err.message,
        correlationId,
      });
    }
    return failed({
      tool,
      provider,
      durationMs,
      code: 'INTERNAL_ERROR',
      message: err.expose ? err.message : 'This tool could not complete the request.',
      correlationId,
    });
  }
  return failed({
    tool,
    provider,
    durationMs,
    code: 'INTERNAL_ERROR',
    message: 'This tool could not complete the request.',
    correlationId,
  });
}

async function recordEvent(
  ctx: ToolExecutionContext,
  db: Db,
  type: Parameters<typeof recordAgentRunEvent>[0]['type'],
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!ctx.agentRunId) return;
  await recordAgentRunEvent(
    { agentRunId: ctx.agentRunId, organizationId: ctx.organizationId, type, metadata },
    db,
  );
}

/**
 * Dispatch one tool call through usage/rate limiting, the tool's own
 * authorization, and the durable timeline. Never throws — every outcome,
 * including an unknown tool name, a rate limit, or a thrown exception,
 * comes back as a `ToolResultEnvelope`.
 */
export async function executeAgentTool(
  ctx: ToolExecutionContext,
  toolName: string,
  rawInput: unknown,
): Promise<ToolResultEnvelope> {
  const db = ctx.db ?? prisma;
  const start = Date.now();
  const correlationId = randomUUID();
  const kind = kindOf(toolName);
  const provider = kind === 'mcp' ? toolName : (toolName.split('.')[0] ?? toolName);

  await recordEvent(ctx, db, 'TOOL_SELECTED', { tool: toolName });

  if (kind === 'unknown') {
    return failed({
      tool: toolName,
      provider,
      durationMs: Date.now() - start,
      code: 'VALIDATION_FAILED',
      message: `"${toolName}" is not a registered tool.`,
      correlationId,
    });
  }

  const rl = await checkRateLimit({
    key: `tool-call:${ctx.organizationId}:${toolName}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    await recordEvent(ctx, db, 'TOOL_FAILED', { tool: toolName, reason: 'rate_limited' });
    return blockedFromPolicy({
      tool: toolName,
      provider,
      durationMs: Date.now() - start,
      outcome: 'RATE_LIMITED',
      reason: 'Too many calls to this tool in a short period. Try again shortly.',
      correlationId,
    });
  }

  const usageVerdict = await checkUsage(
    { organizationId: ctx.organizationId, meter: 'TOOL_CALLS' },
    db,
  );
  if (usageVerdict.wouldExceed) {
    await recordEvent(ctx, db, 'TOOL_FAILED', { tool: toolName, reason: 'quota_exceeded' });
    return blockedFromPolicy({
      tool: toolName,
      provider,
      durationMs: Date.now() - start,
      outcome: 'QUOTA_EXCEEDED',
      reason: "This organization's plan usage limit for tool calls has been reached.",
      correlationId,
    });
  }

  await recordEvent(ctx, db, 'TOOL_AUTHORIZATION_CHECK', { tool: toolName });
  await recordEvent(ctx, db, 'TOOL_STARTED', { tool: toolName });

  let envelope: ToolResultEnvelope;
  try {
    let data: unknown;
    if (kind === 'native') {
      const nativeCtx: IntegrationToolContext = {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        db,
      };
      data = await runIntegrationTool(toolName, nativeCtx, rawInput);
    } else if (kind === 'research') {
      data = await runResearchTool(toolName, rawInput);
    } else {
      envelope = await executeMcpTool(
        ctx.organizationId,
        toolName,
        (rawInput ?? {}) as Record<string, unknown>,
        db,
      );
      await finalizeEvent(ctx, db, toolName, envelope);
      await meterCall(ctx, db, toolName, envelope, correlationId);
      return envelope;
    }
    envelope = success({ tool: toolName, provider, durationMs: Date.now() - start, data });
  } catch (e) {
    envelope = envelopeFromError(toolName, provider, Date.now() - start, e, correlationId);
  }

  await finalizeEvent(ctx, db, toolName, envelope);
  await meterCall(ctx, db, toolName, envelope, correlationId);
  return envelope;
}

async function finalizeEvent(
  ctx: ToolExecutionContext,
  db: Db,
  toolName: string,
  envelope: ToolResultEnvelope,
): Promise<void> {
  if (envelope.status === 'SUCCESS' || envelope.status === 'PARTIAL') {
    await recordEvent(ctx, db, 'TOOL_COMPLETED', { tool: toolName, status: envelope.status });
  } else {
    await recordEvent(ctx, db, 'TOOL_FAILED', {
      tool: toolName,
      status: envelope.status,
      code: envelope.error?.code,
    });
  }
}

/**
 * Meter every dispatched call — including one that failed after we already
 * attempted it, since the attempt itself (a network call, an AI-adjacent
 * cost) already happened. Calls blocked *before* dispatch (rate limit,
 * quota, unknown tool) are never metered — nothing ran.
 */
async function meterCall(
  ctx: ToolExecutionContext,
  db: Db,
  toolName: string,
  envelope: ToolResultEnvelope,
  correlationId: string,
): Promise<void> {
  if (envelope.status === 'BLOCKED' || envelope.status === 'REQUIRES_APPROVAL') return;
  await recordUsage(
    {
      organizationId: ctx.organizationId,
      meter: 'TOOL_CALLS',
      quantity: 1,
      idempotencyKey: `toolcall:${ctx.agentRunId ?? 'standalone'}:${correlationId}`,
      actorId: ctx.userId ?? undefined,
      subjectType: 'tool',
      subjectId: toolName,
    },
    db,
  );
}
