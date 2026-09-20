/**
 * Dynamic capability discovery (Phase 5, Parts 8-10, 51).
 *
 * "Tool" and "capability" are deliberately different words here. A tool
 * (`tool-registry.ts`) is a concrete, globally-registered, executable
 * function. A *capability* is what this specific organization can actually
 * do with it right now, given its connections, its plan, and its governance
 * policy — the same tool can be `usable` for one org and `UNAVAILABLE` for
 * another with an expired token. This module computes that per-org view
 * once per turn so the planner never offers (and the model is never told
 * about) a tool that would immediately fail.
 *
 * It is a read composition over data that already exists — the Connection
 * Center (`integrations/center.ts`) and org governance
 * (`governance/index.ts`) — plus one MCP-specific extension. No new I/O
 * primitive is introduced.
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { actionClassForLevel, decide, getGovernancePolicy } from '../governance/index.js';
import { getConnectionCenter } from '../integrations/center.js';
import { INTEGRATIONS, type IntegrationKey } from '../integrations/contract.js';
import { listEnabledMcpTools } from '../mcp/registry.js';
import { evaluateToolPolicy, type ToolPolicyOutcome } from './policy-engine.js';

export interface DiscoveredCapability {
  id: string;
  label: string;
  category: 'READ' | 'ANALYZE' | 'GENERATE' | 'CREATE' | 'UPDATE' | 'PUBLISH' | 'DELETE';
  integration: string;
  outcome: ToolPolicyOutcome;
  reason: string;
}

const LEVEL_CATEGORY: Record<string, DiscoveredCapability['category']> = {
  READ: 'READ',
  DRAFT: 'CREATE',
  WRITE: 'UPDATE',
  PUBLISH: 'PUBLISH',
  DANGEROUS: 'DELETE',
};

/**
 * Every capability this organization can exercise right now, grouped by
 * integration, with the exact reason for anything not usable — never a bare
 * "unavailable". Mirrors the brief's example shape (Part 9): an integration
 * with no connection reports no capabilities rather than a placeholder
 * "UNAVAILABLE" bucket, since there is nothing more specific to say.
 */
export async function discoverCapabilities(
  organizationId: string,
  db: Db = prisma,
): Promise<Record<string, DiscoveredCapability[]>> {
  const [entries, policy, mcpTools] = await Promise.all([
    getConnectionCenter(organizationId, new Date(), db),
    getGovernancePolicy(organizationId, db),
    listEnabledMcpTools(organizationId, db),
  ]);

  const byIntegration: Record<string, DiscoveredCapability[]> = {};

  for (const entry of entries) {
    if (!entry.descriptor.implemented || !entry.configured) continue;
    const key = entry.descriptor.key;
    const caps = entry.capabilities.map((cap): DiscoveredCapability => {
      const actionClass = actionClassForLevel(cap.level);
      const gov = decide(policy, key, actionClass, { viaAgent: true });
      const decision = evaluateToolPolicy({
        actionClass,
        level: cap.level,
        connection: entry.state,
        governance: gov,
        quotaExceeded: null,
        rateLimited: false,
      });
      return {
        id: cap.id,
        label: cap.label,
        category: LEVEL_CATEGORY[cap.level] ?? 'READ',
        integration: key,
        outcome: cap.usable ? decision.outcome : 'UNAVAILABLE',
        reason: cap.usable
          ? decision.reason
          : (cap.unavailableReason ?? entry.diagnostic.explanation),
      };
    });
    if (caps.length) byIntegration[key] = caps;
  }

  if (mcpTools.length) {
    byIntegration.MCP = mcpTools.map((t): DiscoveredCapability => {
      const gov = decide(policy, 'MCP', 'analyze', { viaAgent: true });
      const decision = evaluateToolPolicy({
        actionClass: 'analyze',
        level: 'READ',
        connection: t.serverConnected ? 'CONNECTED' : 'NOT_CONNECTED',
        governance: gov,
        quotaExceeded: null,
        rateLimited: false,
      });
      return {
        id: t.namespacedName,
        label: t.name,
        category: 'READ',
        integration: 'MCP',
        outcome: decision.outcome,
        reason: decision.reason,
      };
    });
  }

  return byIntegration;
}

/** Flat list of only the capability ids usable right now — what a planner
 *  should actually offer the model, never the full catalogue (Part 51). */
export async function usableCapabilityIds(
  organizationId: string,
  db: Db = prisma,
): Promise<string[]> {
  const grouped = await discoverCapabilities(organizationId, db);
  return Object.values(grouped)
    .flat()
    .filter((c) => c.outcome === 'ALLOW' || c.outcome === 'REQUIRE_APPROVAL')
    .map((c) => c.id);
}

export function implementedIntegrationKeys(): IntegrationKey[] {
  return Object.keys(INTEGRATIONS) as IntegrationKey[];
}
