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
import type { RESEARCH_PROJECT_TOOL_NAMES } from '../research/project-tools.js';
import { RESEARCH_PROJECT_TOOLS } from '../research/project-tools.js';
import type { KNOWLEDGE_TOOL_NAMES } from '../knowledge/tools.js';
import { KNOWLEDGE_TOOLS } from '../knowledge/tools.js';
import {
  INTEGRATION_TOOLS,
  type IntegrationToolContext,
  type IntegrationToolName,
  runIntegrationTool,
} from './integration-tools.js';
import { YOUTUBE_TOOLS, type YouTubeToolName } from './youtube-tools.js';
import { TIKTOK_TOOLS, type TikTokToolName } from './tiktok-tools.js';
import { WORDPRESS_TOOLS, type WordPressToolName } from './wordpress-tools.js';

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

/** Category/risk metadata for the `ResearchProject` tools (Phase 11). Every
 * one is READ or a bounded GENERATION (creating a project only enqueues
 * work, it never fetches anything itself outside the engine's own SSRF-safe,
 * usage-metered path) — no ACTION-category tool here, matching `research.*`'s
 * existing all-LOW-risk precedent. */
const RESEARCH_PROJECT_METADATA: Record<
  (typeof RESEARCH_PROJECT_TOOL_NAMES)[number],
  Omit<AgentToolMetadata, 'name' | 'description'>
> = {
  'research.project.create': {
    category: 'GENERATION',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'research.project.get': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'research.project.list': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
};

/** Category/risk metadata for the Knowledge/Memory/Evidence tools (Phase
 * 11). Every one operates on the org's own stored knowledge, never an
 * external system — LOW risk throughout, no approval gate, matching the
 * native read tools' precedent. `knowledge.create`/`update`/`archive` are
 * GENERATION/ACTION but still LOW risk: the worst case is a wrong (or
 * later-corrected) knowledge item, not an external side effect, and every
 * write already goes through the same validation + audit log a human editing
 * the Knowledge Center UI would. */
const KNOWLEDGE_METADATA: Record<
  (typeof KNOWLEDGE_TOOL_NAMES)[number],
  Omit<AgentToolMetadata, 'name' | 'description'>
> = {
  'knowledge.search': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'knowledge.get': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'knowledge.create': {
    category: 'GENERATION',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'knowledge.update': {
    category: 'ACTION',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'knowledge.archive': {
    category: 'ACTION',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'memory.propose': {
    category: 'GENERATION',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'memory.search': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'evidence.search': {
    category: 'READ',
    integration: null,
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTERNAL',
    organizationScoped: true,
  },
  'evidence.get': {
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

/** Category/risk metadata for the TikTok Growth Agent tools (Phase 7, §24).
 * Every tool but one is READ or ANALYZE/GENERATE against already-synced,
 * already-connected data, so risk stays LOW. `tiktok.content.publish.draft`
 * is the one exception: it creates a real, pending TikTok publish draft (a
 * genuine external action, even though it can never submit on its own) —
 * MEDIUM risk, category ACTION, `requiresApproval: true`, matching
 * `integrations.propose_action`'s exact treatment above. */
const TIKTOK_METADATA: Record<TikTokToolName, Omit<AgentToolMetadata, 'name' | 'description'>> = {
  'tiktok.account.get': {
    category: 'READ',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.video.list': {
    category: 'READ',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.performance': {
    category: 'ANALYSIS',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.compare': {
    category: 'ANALYSIS',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.patterns': {
    category: 'ANALYSIS',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.opportunities': {
    category: 'ANALYSIS',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.calendar.generate': {
    category: 'GENERATION',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.experiment.create': {
    category: 'GENERATION',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.report.generate': {
    category: 'GENERATION',
    integration: 'TIKTOK',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'tiktok.content.publish.draft': {
    category: 'ACTION',
    integration: 'TIKTOK',
    riskLevel: 'MEDIUM',
    requiresApproval: true,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
};

/** Category/risk metadata for the WordPress Growth Agent tools (Phase 9,
 * §20-21). Read/draft/analyze tools are LOW risk. The two proposal tools
 * (`update.propose`/`publish.propose`) and the SEO-fix-proposal tool are
 * MEDIUM risk, category ACTION, `requiresApproval: true` — every one of
 * them only ever files a pending `IntegrationActionRequest`, never writes
 * to WordPress directly, matching `integrations.propose_action`'s exact
 * treatment. */
const WORDPRESS_METADATA: Record<
  WordPressToolName,
  Omit<AgentToolMetadata, 'name' | 'description'>
> = {
  'wordpress.site.get': {
    category: 'READ',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.post.list': {
    category: 'READ',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.page.list': {
    category: 'READ',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.content.draft': {
    category: 'GENERATION',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.content.update.propose': {
    category: 'ACTION',
    integration: 'WORDPRESS',
    riskLevel: 'MEDIUM',
    requiresApproval: true,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.content.publish.propose': {
    category: 'ACTION',
    integration: 'WORDPRESS',
    riskLevel: 'MEDIUM',
    requiresApproval: true,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.content.refresh.analyze': {
    category: 'ANALYSIS',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.seo.issue.fix.propose': {
    category: 'ACTION',
    integration: 'WORDPRESS',
    riskLevel: 'MEDIUM',
    requiresApproval: true,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
  'wordpress.content.verify': {
    category: 'ANALYSIS',
    integration: 'WORDPRESS',
    riskLevel: 'LOW',
    requiresApproval: false,
    providerType: 'INTEGRATION',
    organizationScoped: true,
  },
};

/** The static catalogue — native + research + YouTube + TikTok + WordPress
 * tools, identical for every organization. Never exposes a handler, only
 * the description of what exists (Part 57). Use `listOrgToolMetadata` for
 * the per-org catalogue that also includes enabled MCP tools. */
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
  const tiktok = Object.values(TIKTOK_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...TIKTOK_METADATA[tool.name],
  }));
  const wordpress = Object.values(WORDPRESS_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...WORDPRESS_METADATA[tool.name],
  }));
  const researchProjects = Object.values(RESEARCH_PROJECT_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...RESEARCH_PROJECT_METADATA[tool.name],
  }));
  const knowledge = Object.values(KNOWLEDGE_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...KNOWLEDGE_METADATA[tool.name],
  }));
  return [
    ...native,
    ...research,
    ...youtube,
    ...tiktok,
    ...wordpress,
    ...researchProjects,
    ...knowledge,
  ];
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
