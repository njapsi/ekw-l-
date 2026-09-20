import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';

const getEnabledMcpToolByNamespacedName = vi.fn();
const resolveMcpConnectionSecret = vi.fn(async () => ({
  endpoint: 'https://mcp.example.com',
  transport: 'SSE' as const,
  authKind: 'NONE' as const,
  credential: null,
}));
vi.mock('./registry.js', () => ({ getEnabledMcpToolByNamespacedName, resolveMcpConnectionSecret }));

const withMcpConnection = vi.fn();
vi.mock('./client.js', () => ({
  withMcpConnection: (...args: unknown[]) =>
    (withMcpConnection as (...a: unknown[]) => unknown)(...args),
  MCP_MAX_OUTPUT_CHARS: 30,
}));

const getGovernancePolicy = vi.fn(async () => ({}) as never);
const decide = vi.fn(() => ({ allowed: true, requiresApproval: false }) as const);
vi.mock('../governance/index.js', () => ({ getGovernancePolicy, decide }));

const { executeMcpTool } = await import('./execute.js');

afterEach(() => {
  vi.clearAllMocks();
  getEnabledMcpToolByNamespacedName.mockReset();
  decide.mockReturnValue({ allowed: true, requiresApproval: false });
});

const TOOL = {
  serverId: 's1',
  serverName: 'S',
  serverConnected: true,
  toolId: 't1',
  name: 'search',
  namespacedName: 'mcp.s.search',
  riskLevel: 'HIGH' as const,
  inputSchema: {},
};

describe('executeMcpTool', () => {
  it('fails cleanly when the tool is not enabled (or does not exist)', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(null);
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.status).toBe('FAILED');
    expect(env.error?.code).toBe('VALIDATION_FAILED');
  });

  it('reports UNAVAILABLE when the server is not connected, without attempting a call', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue({ ...TOOL, serverConnected: false });
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.status).toBe('FAILED');
    expect(env.error?.code).toBe('UNAVAILABLE');
    expect(withMcpConnection).not.toHaveBeenCalled();
  });

  it('denies when governance disallows MCP tools for this org', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    decide.mockReturnValue({ allowed: false, reason: 'MCP disabled by policy' } as never);
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.status).toBe('FAILED');
    expect(withMcpConnection).not.toHaveBeenCalled();
  });

  it('succeeds and returns the tool text output, scrubbed', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    withMcpConnection.mockImplementation(async (_id, _secret, fn) =>
      fn({ callTool: async () => ({ content: [{ type: 'text', text: 'short result' }] }) }),
    );
    const env = await executeMcpTool('org1', 'mcp.s.search', { q: 'x' }, {} as Db);
    expect(env.status).toBe('SUCCESS');
    expect(env.data?.text).toBe('short result');
    expect(env.data?.truncated).toBe(false);
  });

  it('truncates output beyond the size cap and reports a warning', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    const longText = 'x'.repeat(100); // MCP_MAX_OUTPUT_CHARS mocked to 30
    withMcpConnection.mockImplementation(async (_id, _secret, fn) =>
      fn({ callTool: async () => ({ content: [{ type: 'text', text: longText }] }) }),
    );
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.status).toBe('SUCCESS');
    expect(env.data?.text.length).toBe(30);
    expect(env.data?.truncated).toBe(true);
    expect(env.warnings.length).toBeGreaterThan(0);
  });

  it('surfaces a server-marked tool error via isError, still as SUCCESS envelope status', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    withMcpConnection.mockImplementation(async (_id, _secret, fn) =>
      fn({ callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }) }),
    );
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.data?.isError).toBe(true);
  });

  it('maps a connection failure to a retryable PROVIDER_ERROR', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    withMcpConnection.mockRejectedValue(new Error('network down'));
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.status).toBe('FAILED');
    expect(env.error?.code).toBe('PROVIDER_ERROR');
    expect(env.error?.retryable).toBe(true);
  });

  it('never leaks a secret-shaped string in the returned data', async () => {
    getEnabledMcpToolByNamespacedName.mockResolvedValue(TOOL);
    withMcpConnection.mockImplementation(async (_id, _secret, fn) =>
      fn({
        callTool: async () => ({
          content: [{ type: 'text', text: 'sk_live_abcdefghijklmnopqrstuvwxyz012345' }],
        }),
      }),
    );
    const env = await executeMcpTool('org1', 'mcp.s.search', {}, {} as Db);
    expect(env.data?.text).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz012345');
  });
});
