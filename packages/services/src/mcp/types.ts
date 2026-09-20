/**
 * Shared MCP types (Phase 5, Parts 28-40). Kept separate from `registry.ts`
 * and `discovery.ts` so both can import the same shapes without a cycle.
 */
import type {
  McpAuthKind,
  McpServerStatus,
  McpToolRiskLevel,
  McpTransportKind,
  McpTrustLevel,
} from '@growth-agent/db';

export type { McpAuthKind, McpServerStatus, McpToolRiskLevel, McpTransportKind, McpTrustLevel };

/** Never carries `credentialCipher`/`credentialIv`/`credentialAuthTag`/`keyId`
 *  — those exist only inside `registry.ts`'s own decrypt path, right before
 *  a connection attempt, and are never returned to a caller (Part 34). */
export interface McpServerView {
  id: string;
  organizationId: string;
  name: string;
  endpoint: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  hasCredential: boolean;
  trustLevel: McpTrustLevel;
  status: McpServerStatus;
  enabled: boolean;
  protocolVersion: string | null;
  serverVersion: string | null;
  lastError: string | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  toolCount: number;
  enabledToolCount: number;
}

export interface McpServerToolView {
  id: string;
  mcpServerId: string;
  name: string;
  namespacedName: string;
  description: string | null;
  inputSchema: unknown;
  riskLevel: McpToolRiskLevel;
  enabled: boolean;
  discoveredAt: Date;
  updatedAt: Date;
}

/** A tool discovered live from the server's `tools/list`, before it is
 *  matched against (and upserted into) `McpServerTool` rows. */
export interface DiscoveredMcpTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export class McpError extends Error {
  constructor(
    readonly code:
      | 'unsupported_transport'
      | 'connection_failed'
      | 'protocol_error'
      | 'name_collision'
      | 'timeout'
      | 'not_found'
      | 'disabled'
      | 'oversized_output'
      | 'tool_error',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'McpError';
  }
}
