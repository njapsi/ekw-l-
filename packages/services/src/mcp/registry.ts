/**
 * The MCP Server Registry (Phase 5, Part 29). Tenant-scoped CRUD for
 * `McpServer` / `McpServerTool`. A credential is sealed exactly like a
 * WordPress application password (`crypto/tokens.ts`, AES-256-GCM) — never
 * stored or returned in plaintext (Part 34). Authorization for every
 * mutation is the caller's job (the `integration:manage` permission, the
 * same convention `wordpress/connect.ts`'s Server Actions already follow) —
 * this module trusts the `organizationId`/`actorId` it is given, exactly
 * like every other `packages/services` module that assumes its caller
 * already authorized the request.
 */
import { type Db, prisma } from '@growth-agent/db';
import { open, seal } from '../crypto/tokens.js';
import { AppError } from '../errors.js';
import type {
  McpAuthKind,
  McpServerToolView,
  McpServerView,
  McpToolRiskLevel,
  McpTransportKind,
  McpTrustLevel,
} from './types.js';

function toView(row: {
  id: string;
  organizationId: string;
  name: string;
  endpoint: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  credentialCipher: string | null;
  trustLevel: McpTrustLevel;
  status: string;
  enabled: boolean;
  protocolVersion: string | null;
  serverVersion: string | null;
  lastError: string | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  tools: { enabled: boolean }[];
}): McpServerView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    endpoint: row.endpoint,
    transport: row.transport,
    authKind: row.authKind,
    hasCredential: row.credentialCipher != null,
    trustLevel: row.trustLevel,
    status: row.status as McpServerView['status'],
    enabled: row.enabled,
    protocolVersion: row.protocolVersion,
    serverVersion: row.serverVersion,
    lastError: row.lastError,
    lastCheckAt: row.lastCheckAt,
    lastCheckOk: row.lastCheckOk,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    toolCount: row.tools.length,
    enabledToolCount: row.tools.filter((t) => t.enabled).length,
  };
}

const SERVER_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  endpoint: true,
  transport: true,
  authKind: true,
  credentialCipher: true,
  trustLevel: true,
  status: true,
  enabled: true,
  protocolVersion: true,
  serverVersion: true,
  lastError: true,
  lastCheckAt: true,
  lastCheckOk: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  tools: { select: { enabled: true } },
} as const;

export async function listMcpServers(
  organizationId: string,
  db: Db = prisma,
): Promise<McpServerView[]> {
  const rows = await db.mcpServer.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: SERVER_SELECT,
  });
  return rows.map(toView);
}

export async function getMcpServer(
  organizationId: string,
  id: string,
  db: Db = prisma,
): Promise<McpServerView> {
  const row = await db.mcpServer.findFirst({
    where: { id, organizationId },
    select: SERVER_SELECT,
  });
  if (!row) throw AppError.notFound('MCP server');
  return toView(row);
}

export interface CreateMcpServerInput {
  organizationId: string;
  name: string;
  endpoint: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  /** The raw bearer token / API key. Required unless `authKind` is `NONE`. */
  credential?: string;
  createdById?: string | null;
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw AppError.validation('The MCP server endpoint must be a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw AppError.validation('The MCP server endpoint must use https.');
  }
}

/**
 * Every newly added server starts UNVERIFIED_EXTERNAL trust, disconnected
 * (`status: PENDING`) and disabled — connecting alone grants nothing (Part
 * 30). An admin promotes trust level and enables individual tools only
 * after reviewing what `discovery.syncMcpServerTools` found.
 */
export async function createMcpServer(
  input: CreateMcpServerInput,
  db: Db = prisma,
): Promise<McpServerView> {
  const name = input.name.trim();
  if (!name) throw AppError.validation('Give the MCP server a name.');
  validateEndpoint(input.endpoint);
  if (input.authKind !== 'NONE' && !input.credential?.trim()) {
    throw AppError.validation('A credential is required for this authentication type.');
  }

  const sealed = input.credential?.trim() ? seal(input.credential.trim()) : null;
  const existing = await db.mcpServer.findFirst({
    where: { organizationId: input.organizationId, name },
    select: { id: true },
  });
  if (existing) throw AppError.conflict(`An MCP server named "${name}" already exists.`);

  const row = await db.mcpServer.create({
    data: {
      organizationId: input.organizationId,
      name,
      endpoint: input.endpoint,
      transport: input.transport,
      authKind: input.authKind,
      credentialCipher: sealed?.cipher,
      credentialIv: sealed?.iv,
      credentialAuthTag: sealed?.authTag,
      keyId: sealed?.keyId,
      trustLevel: 'UNVERIFIED_EXTERNAL',
      status: 'PENDING',
      enabled: false,
      createdById: input.createdById ?? null,
    },
    select: SERVER_SELECT,
  });
  return toView(row);
}

export async function setMcpServerEnabled(
  organizationId: string,
  id: string,
  enabled: boolean,
  db: Db = prisma,
): Promise<McpServerView> {
  await getMcpServer(organizationId, id, db);
  const row = await db.mcpServer.update({
    where: { id },
    data: { enabled },
    select: SERVER_SELECT,
  });
  return toView(row);
}

/**
 * Trust level never auto-promotes (Part 30) — this is the one explicit,
 * deliberate admin action that raises it (or lowers it back down).
 */
export async function setMcpServerTrustLevel(
  organizationId: string,
  id: string,
  trustLevel: McpTrustLevel,
  db: Db = prisma,
): Promise<McpServerView> {
  await getMcpServer(organizationId, id, db);
  const row = await db.mcpServer.update({
    where: { id },
    data: { trustLevel },
    select: SERVER_SELECT,
  });
  return toView(row);
}

export async function deleteMcpServer(
  organizationId: string,
  id: string,
  db: Db = prisma,
): Promise<void> {
  await getMcpServer(organizationId, id, db);
  await db.mcpServer.delete({ where: { id } });
}

export interface McpConnectionSecret {
  endpoint: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  credential: string | null;
}

/** Only path that ever decrypts a stored credential — used exclusively by
 *  `mcp/client.ts` right before opening a connection, never returned to a
 *  Server Action, a log line, or an agent tool result. */
export async function resolveMcpConnectionSecret(
  organizationId: string,
  id: string,
  db: Db = prisma,
): Promise<McpConnectionSecret> {
  const row = await db.mcpServer.findFirst({
    where: { id, organizationId },
    select: {
      endpoint: true,
      transport: true,
      authKind: true,
      credentialCipher: true,
      credentialIv: true,
      credentialAuthTag: true,
      keyId: true,
    },
  });
  if (!row) throw AppError.notFound('MCP server');
  const credential =
    row.credentialCipher && row.credentialIv && row.credentialAuthTag && row.keyId
      ? open({
          cipher: row.credentialCipher,
          iv: row.credentialIv,
          authTag: row.credentialAuthTag,
          keyId: row.keyId,
        })
      : null;
  return { endpoint: row.endpoint, transport: row.transport, authKind: row.authKind, credential };
}

export async function recordMcpServerCheck(
  id: string,
  result: {
    status: 'CONNECTED' | 'DEGRADED' | 'ERROR';
    ok: boolean;
    error?: string | null;
    protocolVersion?: string | null;
    serverVersion?: string | null;
  },
  db: Db = prisma,
): Promise<void> {
  await db.mcpServer.update({
    where: { id },
    data: {
      status: result.status,
      lastCheckAt: new Date(),
      lastCheckOk: result.ok,
      lastError: result.error ?? null,
      protocolVersion: result.protocolVersion ?? undefined,
      serverVersion: result.serverVersion ?? undefined,
    },
  });
}

// --- tools -------------------------------------------------------------

const TOOL_SELECT = {
  id: true,
  mcpServerId: true,
  name: true,
  namespacedName: true,
  description: true,
  inputSchema: true,
  riskLevel: true,
  enabled: true,
  discoveredAt: true,
  updatedAt: true,
} as const;

export async function listMcpServerTools(
  organizationId: string,
  serverId: string,
  db: Db = prisma,
): Promise<McpServerToolView[]> {
  await getMcpServer(organizationId, serverId, db);
  const rows = await db.mcpServerTool.findMany({
    where: { mcpServerId: serverId, organizationId },
    orderBy: { name: 'asc' },
    select: TOOL_SELECT,
  });
  return rows;
}

/**
 * Never enables a tool by upserting it — `enabled` is preserved across a
 * re-discovery for a tool that already existed, and defaults to `false` for
 * one that didn't (Part 31/93: discovery alone grants nothing).
 */
export async function upsertDiscoveredTools(
  organizationId: string,
  serverId: string,
  discovered: {
    name: string;
    namespacedName: string;
    description: string | null;
    inputSchema: unknown;
    riskLevel: McpToolRiskLevel;
  }[],
  db: Db = prisma,
): Promise<void> {
  for (const tool of discovered) {
    await db.mcpServerTool.upsert({
      where: { mcpServerId_name: { mcpServerId: serverId, name: tool.name } },
      create: {
        mcpServerId: serverId,
        organizationId,
        name: tool.name,
        namespacedName: tool.namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        riskLevel: tool.riskLevel,
        enabled: false,
      },
      update: {
        namespacedName: tool.namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        // riskLevel is NOT overwritten on re-discovery once a tool exists:
        // an admin may have already reviewed it, and silently reclassifying
        // a previously LOW-risk tool without a fresh review would be a
        // trust regression in the other direction (masking a server that
        // changed a tool's behavior after approval). Re-running discovery
        // after raising the server's trust level re-creates fresh rows only
        // for genuinely new tool names.
      },
    });
  }
}

export async function setMcpToolEnabled(
  organizationId: string,
  serverId: string,
  toolId: string,
  enabled: boolean,
  db: Db = prisma,
): Promise<McpServerToolView> {
  await getMcpServer(organizationId, serverId, db);
  const existing = await db.mcpServerTool.findFirst({
    where: { id: toolId, mcpServerId: serverId, organizationId },
    select: { id: true },
  });
  if (!existing) throw AppError.notFound('MCP tool');
  const row = await db.mcpServerTool.update({
    where: { id: toolId },
    data: { enabled },
    select: TOOL_SELECT,
  });
  return row;
}

export interface EnabledMcpToolSummary {
  serverId: string;
  serverName: string;
  serverConnected: boolean;
  toolId: string;
  name: string;
  namespacedName: string;
  riskLevel: McpToolRiskLevel;
  inputSchema: unknown;
}

/** Every tool the org's agent runtime may currently call: the server itself
 *  must be enabled, and each individual tool must be enabled — both gates,
 *  every time, never just one (Part 93). */
export async function listEnabledMcpTools(
  organizationId: string,
  db: Db = prisma,
): Promise<EnabledMcpToolSummary[]> {
  const rows = await db.mcpServerTool.findMany({
    where: {
      organizationId,
      enabled: true,
      server: { enabled: true },
    },
    select: {
      id: true,
      namespacedName: true,
      name: true,
      riskLevel: true,
      inputSchema: true,
      server: { select: { id: true, name: true, status: true, enabled: true } },
    },
  });
  return rows.map((r) => ({
    serverId: r.server.id,
    serverName: r.server.name,
    serverConnected: r.server.status === 'CONNECTED',
    toolId: r.id,
    name: r.name,
    namespacedName: r.namespacedName,
    riskLevel: r.riskLevel,
    inputSchema: r.inputSchema,
  }));
}

/** Resolve one enabled tool by its namespaced name, re-checking both gates —
 *  never trusts a model-supplied name without this lookup (Part 88). */
export async function getEnabledMcpToolByNamespacedName(
  organizationId: string,
  namespacedName: string,
  db: Db = prisma,
): Promise<EnabledMcpToolSummary | null> {
  const row = await db.mcpServerTool.findFirst({
    where: { organizationId, namespacedName, enabled: true, server: { enabled: true } },
    select: {
      id: true,
      namespacedName: true,
      name: true,
      riskLevel: true,
      inputSchema: true,
      server: { select: { id: true, name: true, status: true, enabled: true } },
    },
  });
  if (!row) return null;
  return {
    serverId: row.server.id,
    serverName: row.server.name,
    serverConnected: row.server.status === 'CONNECTED',
    toolId: row.id,
    name: row.name,
    namespacedName: row.namespacedName,
    riskLevel: row.riskLevel,
    inputSchema: row.inputSchema,
  };
}
