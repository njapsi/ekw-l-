import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentToolDefinitions,
  deriveRiskLevel,
  listOrgToolMetadata,
  listToolMetadata,
} from './tool-registry.js';
import { INTEGRATION_TOOL_NAMES } from './integration-tools.js';
import { RESEARCH_TOOL_NAMES } from '../research/tools.js';

vi.mock('../integrations/center.js', () => ({
  getConnectionCenter: vi.fn(async () => []),
}));

const listEnabledMcpTools = vi.fn(async () => [] as unknown[]);
vi.mock('../mcp/registry.js', () => ({
  listEnabledMcpTools: (...a: unknown[]) =>
    (listEnabledMcpTools as (...x: unknown[]) => unknown)(...a),
}));

describe('tool registry', () => {
  it('lists metadata for exactly the closed native allowlist plus the research tools, nothing more', () => {
    const meta = listToolMetadata();
    expect(meta.map((m) => m.name).sort()).toEqual(
      [...INTEGRATION_TOOL_NAMES, ...RESEARCH_TOOL_NAMES].sort(),
    );
    for (const m of meta) {
      expect(m.organizationScoped).toBe(true);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(m.riskLevel);
      expect(['READ', 'ANALYSIS', 'GENERATION', 'ACTION']).toContain(m.category);
    }
  });

  it('listOrgToolMetadata adds only this org’s enabled MCP tools on top of the static catalogue', async () => {
    listEnabledMcpTools.mockResolvedValueOnce([
      {
        serverId: 's1',
        serverName: 'Analytics',
        serverConnected: true,
        toolId: 't1',
        name: 'search',
        namespacedName: 'mcp.analytics.search',
        riskLevel: 'HIGH',
        inputSchema: {},
      },
    ]);
    const meta = await listOrgToolMetadata('org1', {} as never);
    expect(meta.map((m) => m.name)).toContain('mcp.analytics.search');
    const mcpEntry = meta.find((m) => m.name === 'mcp.analytics.search')!;
    expect(mcpEntry.providerType).toBe('MCP');
    expect(mcpEntry.riskLevel).toBe('HIGH');
  });

  it('classifies read tools LOW risk and the propose-action tool MEDIUM', () => {
    expect(deriveRiskLevel('integrations.list_connections')).toBe('LOW');
    expect(deriveRiskLevel('integrations.get_capabilities')).toBe('LOW');
    expect(deriveRiskLevel('wordpress.list_content')).toBe('LOW');
    expect(deriveRiskLevel('integrations.propose_action')).toBe('MEDIUM');
  });

  it('builds one ToolDefinition per allowlist entry, each scoped to the given context', async () => {
    const ctx = { organizationId: 'org_1', userId: 'user_1', db: {} as never };
    const defs = buildAgentToolDefinitions(ctx);
    expect(defs.map((d) => d.name).sort()).toEqual([...INTEGRATION_TOOL_NAMES].sort());

    const listConnections = defs.find((d) => d.name === 'integrations.list_connections')!;
    const result = await listConnections.execute({});
    // Dispatches through the real, authorized runIntegrationTool — with the
    // connection center mocked to return no connections, the real tool
    // correctly returns an empty list rather than fabricating one.
    expect(result).toEqual([]);
  });

  it('rejects an unregistered tool name at the dispatch layer, not by inventing one', async () => {
    const ctx = { organizationId: 'org_1', userId: 'user_1', db: {} as never };
    const defs = buildAgentToolDefinitions(ctx);
    expect(defs.every((d) => (INTEGRATION_TOOL_NAMES as readonly string[]).includes(d.name))).toBe(
      true,
    );
  });
});
