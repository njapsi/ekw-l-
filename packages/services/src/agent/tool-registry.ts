/**
 * Agent Tool Registry (Phase 4 Parts 6-8, 25, 29-31; extended Phase 5 Parts
 * 5-8, 51 with research tools and per-org MCP tools).
 *
 * This module does not implement any tool itself — every native tool it
 * lists is `integration-tools.ts`'s existing, already-audited, closed
 * allowlist (Phase 1); every research tool is `research/tools.ts`'s
 * two-tool surface (Phase 5); every MCP tool is one an org's admin has
 * explicitly enabled (`mcp/registry.ts`). What this module adds is the
 * metadata shape the brief asks for (category / risk level / provider type
 * / permission level) and the bridge that turns the *native* allowlist into
 * real, model-driven function-calling via `packages/ai`'s `ToolDefinition`
 * (Phase 4's `tools`/`maxSteps` addition to `generateText`).
 *
 * The model can only ever select a tool from this exact list — there is no
 * path from a model's output to an arbitrary function call. Authorization
 * for a native/research tool call is unchanged and lives inside its own
 * `execute`; an MCP tool call's authorization is `mcp/execute.ts` + the
 * Policy Engine. Either way, this registry only *describes* what exists so
 * it can be reasoned about and audited as one catalogue — it does not
 * itself decide whether a call may run.
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import type { ToolDefinition } from '@growth-agent/ai';
import { listEnabledMcpTools } from '../mcp/registry.js';
import type { RESEARCH_TOOL_NAMES } from '../research/tools.js';
import { RESEARCH_TOOLS } from '../research/tools.js';
import {
  INTEGRATION_TOOLS,
  type IntegrationToolContext,
  type IntegrationToolName,
  runIntegrationTool,
} from './integration-tools.js';
import { YOUTUBE_TOOLS, type YouTubeToolName } from './youtube-tools.js';

/** LOW → read-only or purely observational. MEDIUM → creates a pending,
 * human-approved request but commits nothing itself. HIGH/CRITICAL describe
 * an MCP tool whose trust level (Part 30) puts it in that band — no native
 * tool carries them, since the closed allowlist has no tool that could
 * itself publish/delete. */
export type ToolRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ToolProviderType = 'INTERNAL' | 'INTEGRATION' | 'MCP';

export type ToolCategory = 'READ' | 'ANALYSIS' | 'GENERATION' | 'ACTION';

export interface AgentToolMetadata {
  name: string;
  description: string;
  category: ToolCategory;
  /** Null for a tool that isn't scoped to one connected platform. */
  integration: string | null;
  riskLevel: ToolRiskLevel;
  /** Whether *this tool's own effect* (not the account-side action it may
   * eventually cause) needs a human decision. `propose_action` never
   * executes anything itself — it only files a request — so this is
   * always false here; the real approval gate is `requestIntegrationAction`
   * + `decideActionRequest`, independent of this flag. */
  requiresApproval: boolean;
  providerType: ToolProviderType;
  organizationScoped: true;
}

const METADATA: Record<IntegrationToolName, Omit<AgentToolMetadata, 'name' | 'description'>> = {
  'integrations.list_connections': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'integrations.get_capabilities': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.list_content': {
    category: 'READ',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'integrations.propose_action': {
    category: 'ACTION',
    integration: null,
    riskLevel: 'MEDIUM',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
};

const RESEARCH_METADATA: Record<
  (typeof RESEARCH_TOOL_NAMES)[number],
  Omit<AgentToolMetadata, 'name' | 'description'>
> = {
  'research.fetch': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'research.search': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
};

/** Category/risk metadata for the YouTube Growth Agent tools (Phase 6, Part
 * 62). Every one is READ or ANALYZE/GENERATE against already-synced,
 * already-connected data — none writes to YouTube (`youtube-tools.ts`'s own
 * header explains why no publish tool exists), so risk stays LOW throughout,
 * matching the native read tools above. */
const YOUTUBE_METADATA: Record<YouTubeToolName, Omit<AgentToolMetadata, 'name' | 'description'>> = {
  'youtube.channel.get': {
    category: 'READ',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.channel.analytics': {
    category: 'READ',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.video.list': {
    category: 'READ',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.content.performance': {
    category: 'ANALYSIS',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.content.compare': {
    category: 'ANALYSIS',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.content.patterns': {
    category: 'ANALYSIS',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.content.opportunities': {
    category: 'ANALYSIS',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.content.calendar.generate': {
    category: 'GENERATION',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.experiment.create': {
    category: 'GENERATION',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'youtube.report.generate': {
    category: 'GENERATION',
    integration: 'YOUTUBE',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
};

/** The static catalogue — native + research + YouTube tools, identical for
 * every organization. Never exposes a handler, only the description of what
 * exists (Part 57). Use `listOrgToolMetadata` for the per-org catalogue
 * that also includes enabled MCP tools. */
export function listToolMetadata(): AgentToolMetadata[] {
  const native = Object.values(INTEGRATION_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...METADATA[tool.name],
  }));
  const research = Object.values(RESEARCH_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...RESEARCH_METADATA[tool.name],
  }));
  const youtube = Object.values(YOUTUBE_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...YOUTUBE_METADATA[tool.name],
  }));
  return [...native, ...research, ...youtube];
}

/**
 * The catalogue this organization's agent runtime can actually select from
 * right now (Part 51) — the static list plus every MCP tool this org's
 * admin has enabled, on a server that is itself enabled. Nothing here
 * implies the tool will succeed (a disconnected server still shows as
 * UNAVAILABLE via the Policy Engine at call time) — this is discovery, not
 * an authorization decision.
 */
export async function listOrgToolMetadata(
  organizationId: string,
  db: Db = prisma,
): Promise<AgentToolMetadata[]> {
  const [staticTools, mcpTools] = await Promise.all([
    Promise.resolve(listToolMetadata()),
    listEnabledMcpTools(organizationId, db),
  ]);
  const mcp: AgentToolMetadata[] = mcpTools.map((t) => ({
    name: t.namespacedName,
    description: `${t.name} (via ${t.serverName})`,
    category: 'READ',
    integration: 'MCP',
    riskLevel: t.riskLevel,
    requiresApproval: false,
    providerType: 'MCP',
    organizationScoped: true,
  }));
  return [...staticTools, ...mcp];
}

export function deriveRiskLevel(name: IntegrationToolName): ToolRiskLevel {
  return METADATA[name].riskLevel;
}

/**
 * Builds the real, model-callable tool set for one turn. Every `execute`
 * closes over the caller's own `IntegrationToolContext` (server-derived
 * organizationId/userId — never taken from the model) and dispatches
 * through the existing `runIntegrationTool`, so authorization, governance
 * and the untrusted-content boundary are exactly what they already were —
 * this function only adapts the allowlist to `packages/ai`'s calling
 * convention.
 */
export function buildAgentToolDefinitions(ctx: IntegrationToolContext): ToolDefinition[] {
  return Object.values(INTEGRATION_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input,
    execute: async (input: unknown) => runIntegrationTool(tool.name, ctx, input),
  }));
}
