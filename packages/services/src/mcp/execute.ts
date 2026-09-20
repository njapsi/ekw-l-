/**
 * Executes one enabled MCP tool (Phase 5, Parts 33-36, 88, 96). Every rule
 * that already governs a native tool call applies here too:
 *
 *   - the org/user identity comes from the caller's own server-derived
 *     context, never from the tool name or arguments;
 *   - the Policy Engine — not the model, not the MCP server's own claims —
 *     decides whether the call may run;
 *   - both gates are re-checked from the database on every single call
 *     (the server must be enabled AND this specific tool must be enabled),
 *     never cached from a previous turn (Part 88);
 *   - the server's output is untrusted data. It is size-capped, and the
 *     caller is responsible for wrapping it with `wrapUntrusted` before any
 *     model ever sees it (the same convention every other agent tool
 *     follows) — this module returns plain data, it does not build prompts.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { decide, getGovernancePolicy } from '../governance/index.js';
import { failed, success, type ToolResultEnvelope } from '../agent/tool-envelope.js';
import { evaluateToolPolicy } from '../agent/policy-engine.js';
import { MCP_MAX_OUTPUT_CHARS, withMcpConnection } from './client.js';
import { getEnabledMcpToolByNamespacedName, resolveMcpConnectionSecret } from './registry.js';
import { McpError } from './types.js';

export interface McpToolResultData {
  text: string;
  isError: boolean;
  truncated: boolean;
}

export async function executeMcpTool(
  organizationId: string,
  namespacedName: string,
  args: Record<string, unknown>,
  db: Db = prisma,
): Promise<ToolResultEnvelope<McpToolResultData>> {
  const start = Date.now();
  const correlationId = randomUUID();
  const provider = `mcp:${namespacedName}`;

  const tool = await getEnabledMcpToolByNamespacedName(organizationId, namespacedName, db);
  if (!tool) {
    return failed({
      tool: namespacedName,
      provider,
      durationMs: Date.now() - start,
      code: 'VALIDATION_FAILED',
      message: 'This MCP tool does not exist, or has not been enabled by an organization admin.',
      correlationId,
    });
  }

  const policy = await getGovernancePolicy(organizationId, db);
  const gov = decide(policy, 'MCP', 'analyze', { viaAgent: true });
  const decision = evaluateToolPolicy({
    actionClass: 'analyze',
    level: 'READ',
    connection: tool.serverConnected ? 'CONNECTED' : 'NOT_CONNECTED',
    governance: gov,
    quotaExceeded: null,
    rateLimited: false,
  });
  if (decision.outcome !== 'ALLOW') {
    return failed({
      tool: namespacedName,
      provider,
      durationMs: Date.now() - start,
      code: decision.outcome === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'UNAVAILABLE',
      message: decision.reason,
      correlationId,
    });
  }

  try {
    const secret = await resolveMcpConnectionSecret(organizationId, tool.serverId, db);
    const result = await withMcpConnection(tool.serverId, secret, (conn) =>
      conn.callTool(tool.name, args),
    );

    const rawText = result.content
      .map((c) => c.text ?? '')
      .join('\n')
      .trim();
    // The server's output is untrusted (Part 36) and unbounded in principle;
    // never let it grow the turn's prompt/storage without limit.
    const truncated = rawText.length > MCP_MAX_OUTPUT_CHARS;
    const text = truncated ? rawText.slice(0, MCP_MAX_OUTPUT_CHARS) : rawText;

    const data = scrubModelOutput({ text, isError: Boolean(result.isError), truncated });
    return success({
      tool: namespacedName,
      provider,
      durationMs: Date.now() - start,
      data,
      warnings: truncated ? ['Output was truncated because it exceeded the size limit.'] : [],
      resourceReferences: [correlationId],
    });
  } catch (e) {
    const mcpErr = e instanceof McpError ? e : null;
    return failed({
      tool: namespacedName,
      provider,
      durationMs: Date.now() - start,
      code: mcpErr?.code === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR',
      message: mcpErr?.message ?? 'The MCP server could not be reached.',
      retryable: mcpErr?.retryable ?? true,
      correlationId,
    });
  }
}
