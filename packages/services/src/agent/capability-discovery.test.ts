import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { DEFAULT_POLICY } from '../governance/index.js';

const getConnectionCenter = vi.fn();
vi.mock('../integrations/center.js', () => ({
  getConnectionCenter: (...a: unknown[]) =>
    (getConnectionCenter as (...x: unknown[]) => unknown)(...a),
}));

const listEnabledMcpTools = vi.fn(async () => [] as unknown[]);
vi.mock('../mcp/registry.js', () => ({
  listEnabledMcpTools: (...a: unknown[]) =>
    (listEnabledMcpTools as (...x: unknown[]) => unknown)(...a),
}));

const { discoverCapabilities, usableCapabilityIds } = await import('./capability-discovery.js');

afterEach(() => {
  vi.clearAllMocks();
  listEnabledMcpTools.mockResolvedValue([]);
});

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    descriptor: { key: 'WORDPRESS', implemented: true },
    state: 'CONNECTED',
    diagnostic: { explanation: 'connected fine' },
    capabilities: [
      {
        id: 'wordpress.get_posts',
        label: 'Posts',
        level: 'READ',
        usable: true,
        unavailableReason: undefined,
      },
      {
        id: 'wordpress.publish',
        label: 'Publish',
        level: 'PUBLISH',
        usable: true,
        unavailableReason: undefined,
      },
    ],
    configured: true,
    ...overrides,
  };
}

describe('discoverCapabilities', () => {
  it('groups usable capabilities by integration with an ALLOW/REQUIRE_APPROVAL outcome', async () => {
    getConnectionCenter.mockResolvedValue([entry()]);
    const db = {} as Db;
    const grouped = await discoverCapabilitiesWithPolicy(db, DEFAULT_POLICY);
    expect(grouped.WORDPRESS).toHaveLength(2);
    const read = grouped.WORDPRESS!.find((c) => c.id === 'wordpress.get_posts')!;
    expect(read.outcome).toBe('ALLOW');
    const publish = grouped.WORDPRESS!.find((c) => c.id === 'wordpress.publish')!;
    expect(publish.outcome).toBe('REQUIRE_APPROVAL');
  });

  it('an unconfigured or unimplemented integration contributes no capabilities', async () => {
    getConnectionCenter.mockResolvedValue([
      entry({ configured: false }),
      entry({ descriptor: { key: 'TIKTOK', implemented: false }, configured: true }),
    ]);
    const grouped = await discoverCapabilitiesWithPolicy({} as Db, DEFAULT_POLICY);
    expect(Object.keys(grouped)).toHaveLength(0);
  });

  it('a capability the connection state marks unusable reports UNAVAILABLE with a concrete reason, not a bare label', async () => {
    getConnectionCenter.mockResolvedValue([
      entry({
        state: 'REAUTH_REQUIRED',
        capabilities: [
          {
            id: 'wordpress.get_posts',
            label: 'Posts',
            level: 'READ',
            usable: false,
            unavailableReason: 'Reconnect required.',
          },
        ],
      }),
    ]);
    const grouped = await discoverCapabilitiesWithPolicy({} as Db, DEFAULT_POLICY);
    expect(grouped.WORDPRESS![0]!.outcome).toBe('UNAVAILABLE');
    expect(grouped.WORDPRESS![0]!.reason).toBe('Reconnect required.');
  });

  it('never offers a capability a connection has, when governance disables that action class', async () => {
    getConnectionCenter.mockResolvedValue([entry()]);
    const policy = structuredClone(DEFAULT_POLICY);
    policy.integrations.WORDPRESS.publish = 'disabled';
    const grouped = await discoverCapabilitiesWithPolicy({} as Db, policy);
    const publish = grouped.WORDPRESS!.find((c) => c.id === 'wordpress.publish')!;
    expect(publish.outcome).toBe('DENY');
  });

  it('includes an MCP bucket only when at least one MCP tool is enabled', async () => {
    getConnectionCenter.mockResolvedValue([]);
    listEnabledMcpTools.mockResolvedValue([
      {
        serverId: 's1',
        serverName: 'S',
        serverConnected: true,
        toolId: 't1',
        name: 'search',
        namespacedName: 'mcp.s.search',
        riskLevel: 'HIGH',
        inputSchema: {},
      },
    ]);
    const grouped = await discoverCapabilitiesWithPolicy({} as Db, DEFAULT_POLICY);
    expect(grouped.MCP).toHaveLength(1);
    expect(grouped.MCP![0]!.outcome).toBe('ALLOW');
  });
});

describe('usableCapabilityIds', () => {
  it('returns only ALLOW/REQUIRE_APPROVAL capability ids, never an unavailable one', async () => {
    getConnectionCenter.mockResolvedValue([
      entry({
        capabilities: [
          {
            id: 'wordpress.get_posts',
            label: 'Posts',
            level: 'READ',
            usable: true,
            unavailableReason: undefined,
          },
          {
            id: 'wordpress.update_post',
            label: 'Update',
            level: 'WRITE',
            usable: false,
            unavailableReason: 'not usable',
          },
        ],
      }),
    ]);
    const gov = await import('../governance/index.js');
    const spy = vi.spyOn(gov, 'getGovernancePolicy').mockResolvedValue(DEFAULT_POLICY);
    try {
      const ids = await usableCapabilityIds('org1', {} as Db);
      expect(ids).toEqual(['wordpress.get_posts']);
    } finally {
      spy.mockRestore();
    }
  });
});

// Helper: getGovernancePolicy is not mocked directly (it reads from `db`),
// so tests inject the policy by stubbing the db call it depends on via a
// tiny local re-import seam instead of re-mocking governance for every case.
async function discoverCapabilitiesWithPolicy(db: Db, policy: typeof DEFAULT_POLICY) {
  const gov = await import('../governance/index.js');
  const spy = vi.spyOn(gov, 'getGovernancePolicy').mockResolvedValue(policy);
  try {
    return await discoverCapabilities('org1', db);
  } finally {
    spy.mockRestore();
  }
}
