/**
 * Agent Tool Registry (Phase 4, Parts 6-8, 25, 29-31).
 *
 * This module does not implement any tool itself — every tool it lists is
 * `integration-tools.ts`'s existing, already-audited, closed allowlist
 * (Phase 1). What's new here is the metadata shape the brief asks for
 * (category / risk level / provider type / permission level) and the
 * bridge that turns that allowlist into real, model-driven function-calling
 * via `packages/ai`'s `ToolDefinition` (Phase 4's `tools`/`maxSteps`
 * addition to `generateText`).
 *
 * The model can only ever select a tool from this exact list — there is no
 * path from a model's output to an arbitrary function call. Authorization
 * is unchanged and still lives inside each tool's own `execute` (via
 * `assertCapabilityUsable` / `assertGovernanceAllows`), never here; this
 * registry only *describes* what already exists so it can be reasoned about
 * and audited as one catalogue.
 */
import type { ToolDefinition } from '@growth-agent/ai';
import {
  INTEGRATION_TOOLS,
  type IntegrationToolContext,
  type IntegrationToolName,
  runIntegrationTool,
} from './integration-tools.js';

/** LOW → read-only or purely observational. MEDIUM → creates a pending,
 * human-approved request but commits nothing itself. HIGH/CRITICAL are
 * reserved for a future tool that could itself publish/delete — none exists
 * in the closed allowlist today, so no tool currently carries them. */
export type ToolRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Where a tool's implementation lives. MCP is a placeholder for Phase 25's
 * future work — nothing registers an MCP tool today (see docs/AGENT-RUNTIME.md
 * §MCP readiness); the type exists so a future MCP tool is a data addition,
 * not an architecture change. */
export type ToolProviderType = 'INTERNAL' | 'INTEGRATION' | 'MCP';

export type ToolCategory = 'READ' | 'ANALYSIS' | 'GENERATION' | 'ACTION';

export interface AgentToolMetadata {
  name: IntegrationToolName;
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

/** The full catalogue, for admin/observability display (Part 57) — never
 * exposes a handler, only the description of what exists. */
export function listToolMetadata(): AgentToolMetadata[] {
  return Object.values(INTEGRATION_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...METADATA[tool.name],
  }));
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
