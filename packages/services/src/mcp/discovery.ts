/**
 * MCP tool discovery (Phase 5, Part 31): authenticate → discover → validate
 * → namespace → classify risk → store, with every discovered tool disabled
 * by default. Nothing here ever grants a tool the ability to run; that is a
 * separate, explicit admin action (`registry.setMcpToolEnabled`).
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { withMcpConnection } from './client.js';
import {
  getMcpServer,
  recordMcpServerCheck,
  resolveMcpConnectionSecret,
  upsertDiscoveredTools,
} from './registry.js';
import type { McpServerToolView, McpToolRiskLevel, McpTrustLevel } from './types.js';
import { McpError } from './types.js';

/** Every tool name already claimed by a native or research tool — an MCP
 *  tool can never shadow one of these (Part 32), regardless of what a
 *  server calls its own tool. */
const RESERVED_PREFIXES = [
  'integrations.',
  'wordpress.',
  'research.',
  'youtube.',
  'tiktok.',
  'seo.',
  'search_console.',
];

export function namespaceTool(serverSlug: string, rawName: string): string {
  return `mcp.${serverSlug}.${rawName}`;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

/**
 * Trust level alone decides a newly-discovered tool's starting risk (Part
 * 31) — never a guess based on the tool's name or description, which a
 * malicious server fully controls. INTERNAL/TRUSTED servers still start at
 * MEDIUM, not LOW: even a server we trust to be who it says it is can still
 * have a buggy or overly broad tool, and LOW should be reserved for tools
 * this codebase's own audit has actually reviewed by hand.
 */
export function classifyRisk(trustLevel: McpTrustLevel): McpToolRiskLevel {
  switch (trustLevel) {
    case 'INTERNAL':
      return 'MEDIUM';
    case 'TRUSTED':
      return 'MEDIUM';
    case 'VERIFIED_EXTERNAL':
      return 'HIGH';
    case 'UNVERIFIED_EXTERNAL':
      return 'CRITICAL';
  }
}

/** Reject anything that is not a plausible JSON Schema object, and cap its
 *  size — a hostile server can otherwise ship an enormous or deeply nested
 *  schema purely to burn memory on every future discovery run. */
function validSchema(schema: unknown): boolean {
  if (schema === null || schema === undefined) return true; // treated as {}
  if (typeof schema !== 'object' || Array.isArray(schema)) return false;
  return JSON.stringify(schema).length <= 50_000;
}

export interface SyncResult {
  discovered: number;
  skipped: { name: string; reason: string }[];
  tools: McpServerToolView[];
}

export async function syncMcpServerTools(
  organizationId: string,
  serverId: string,
  db: Db = prisma,
): Promise<SyncResult> {
  const server = await getMcpServer(organizationId, serverId, db);
  const secret = await resolveMcpConnectionSecret(organizationId, serverId, db);
  const slug = slugify(server.name);
  const skipped: { name: string; reason: string }[] = [];

  try {
    const discovered = await withMcpConnection(serverId, secret, (conn) => conn.tools());

    const accepted: {
      name: string;
      namespacedName: string;
      description: string | null;
      inputSchema: unknown;
      riskLevel: McpToolRiskLevel;
    }[] = [];
    const seen = new Set<string>();

    for (const tool of discovered) {
      if (!tool.name || tool.name.length > 200) {
        skipped.push({ name: tool.name || '(empty)', reason: 'invalid tool name' });
        continue;
      }
      if (seen.has(tool.name)) {
        skipped.push({ name: tool.name, reason: 'duplicate name in this discovery response' });
        continue;
      }
      seen.add(tool.name);
      const namespacedName = namespaceTool(slug, tool.name);
      if (RESERVED_PREFIXES.some((p) => namespacedName.startsWith(p) || tool.name.startsWith(p))) {
        skipped.push({ name: tool.name, reason: 'collides with a reserved native tool namespace' });
        continue;
      }
      if (!validSchema(tool.inputSchema)) {
        skipped.push({
          name: tool.name,
          reason: 'input schema is missing, malformed, or too large',
        });
        continue;
      }
      accepted.push({
        name: tool.name,
        namespacedName,
        description: tool.description?.slice(0, 2_000) ?? null,
        inputSchema: tool.inputSchema ?? {},
        riskLevel: classifyRisk(server.trustLevel),
      });
    }

    await upsertDiscoveredTools(organizationId, serverId, accepted, db);
    await recordMcpServerCheck(serverId, { status: 'CONNECTED', ok: true }, db);

    const tools = await db.mcpServerTool.findMany({
      where: { mcpServerId: serverId, organizationId },
      orderBy: { name: 'asc' },
    });
    return { discovered: accepted.length, skipped, tools: tools };
  } catch (e) {
    const message = e instanceof McpError ? e.message : e instanceof Error ? e.message : String(e);
    await recordMcpServerCheck(serverId, { status: 'ERROR', ok: false, error: message }, db);
    throw e instanceof McpError ? e : new McpError('connection_failed', message, true);
  }
}
