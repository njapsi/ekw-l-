import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { AppError } from '../errors.js';
import {
  createMcpServer,
  deleteMcpServer,
  getEnabledMcpToolByNamespacedName,
  getMcpServer,
  listEnabledMcpTools,
  listMcpServers,
  listMcpServerTools,
  resolveMcpConnectionSecret,
  setMcpServerEnabled,
  setMcpServerTrustLevel,
  setMcpToolEnabled,
  upsertDiscoveredTools,
} from './registry.js';

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

interface ServerRow {
  id: string;
  organizationId: string;
  name: string;
  endpoint: string;
  transport: string;
  authKind: string;
  credentialCipher: string | null;
  credentialIv: string | null;
  credentialAuthTag: string | null;
  keyId: string | null;
  trustLevel: string;
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
}

interface ToolRow {
  id: string;
  mcpServerId: string;
  organizationId: string;
  name: string;
  namespacedName: string;
  description: string | null;
  inputSchema: unknown;
  riskLevel: string;
  enabled: boolean;
  discoveredAt: Date;
  updatedAt: Date;
}

/** A tiny, purpose-built fake for the two MCP tables — the shared
 *  `testing/memory-db.ts` helper does not join relations, and both
 *  `registry.ts` queries need a real `tools`/`server` join. */
function fakeDb() {
  const servers: ServerRow[] = [];
  const tools: ToolRow[] = [];
  let n = 0;
  const id = (p: string) => `${p}${n++}`;

  const serverView = (s: ServerRow) => ({
    ...s,
    tools: tools.filter((t) => t.mcpServerId === s.id).map((t) => ({ enabled: t.enabled })),
  });

  const db = {
    mcpServer: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        servers.filter((s) => s.organizationId === where.organizationId).map(serverView),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; organizationId: string; name?: string } }) => {
          const s = servers.find(
            (s) =>
              s.organizationId === where.organizationId &&
              (where.id === undefined || s.id === where.id) &&
              (where.name === undefined || s.name === where.name),
          );
          return s ? serverView(s) : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<ServerRow> }) => {
        const row: ServerRow = {
          id: id('s'),
          createdAt: new Date(),
          updatedAt: new Date(),
          protocolVersion: null,
          serverVersion: null,
          lastError: null,
          lastCheckAt: null,
          lastCheckOk: null,
          createdById: null,
          ...data,
        } as ServerRow;
        servers.push(row);
        return serverView(row);
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ServerRow> }) => {
          const s = servers.find((s) => s.id === where.id)!;
          Object.assign(s, data, { updatedAt: new Date() });
          return serverView(s);
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = servers.findIndex((s) => s.id === where.id);
        servers.splice(idx, 1);
      }),
    },
    mcpServerTool: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        tools.filter((t) => matchTool(t, where, servers)).map((t) => toolView(t, servers)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const t = tools.find((t) => matchTool(t, where, servers));
        return t ? toolView(t, servers) : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { mcpServerId_name: { mcpServerId: string; name: string } };
          create: Partial<ToolRow>;
          update: Partial<ToolRow>;
        }) => {
          const existing = tools.find(
            (t) =>
              t.mcpServerId === where.mcpServerId_name.mcpServerId &&
              t.name === where.mcpServerId_name.name,
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return { ...existing };
          }
          const row: ToolRow = {
            id: id('t'),
            discoveredAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as ToolRow;
          tools.push(row);
          return { ...row };
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ToolRow> }) => {
        const t = tools.find((t) => t.id === where.id)!;
        Object.assign(t, data, { updatedAt: new Date() });
        return { ...t };
      }),
    },
  };
  return { db: db as unknown as Db, servers, tools };
}

function toolView(t: ToolRow, servers: ServerRow[]) {
  const s = servers.find((s) => s.id === t.mcpServerId);
  return {
    ...t,
    server: s ? { id: s.id, name: s.name, status: s.status, enabled: s.enabled } : null,
  };
}

function matchTool(t: ToolRow, where: Record<string, unknown>, servers: ServerRow[]): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'server') {
      const s = servers.find((s) => s.id === t.mcpServerId);
      const cond = v as { enabled?: boolean };
      if (!s || (cond.enabled !== undefined && s.enabled !== cond.enabled)) return false;
      continue;
    }
    if ((t as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

describe('MCP server registry', () => {
  it('creates a server disabled, UNVERIFIED_EXTERNAL, PENDING, with the credential sealed', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'Analytics Research',
        endpoint: 'https://mcp.example.com/sse',
        transport: 'SSE',
        authKind: 'BEARER_TOKEN',
        credential: 'super-secret-token',
      },
      db,
    );
    expect(server.enabled).toBe(false);
    expect(server.trustLevel).toBe('UNVERIFIED_EXTERNAL');
    expect(server.status).toBe('PENDING');
    expect(server.hasCredential).toBe(true);
    // The view never carries the raw credential.
    expect(JSON.stringify(server)).not.toContain('super-secret-token');
  });

  it('rejects a non-https endpoint', async () => {
    const { db } = fakeDb();
    await expect(
      createMcpServer(
        {
          organizationId: 'org1',
          name: 'x',
          endpoint: 'http://insecure.example.com',
          transport: 'SSE',
          authKind: 'NONE',
        },
        db,
      ),
    ).rejects.toThrow();
  });

  it('requires a credential when authKind is not NONE', async () => {
    const { db } = fakeDb();
    await expect(
      createMcpServer(
        {
          organizationId: 'org1',
          name: 'x',
          endpoint: 'https://x.example.com',
          transport: 'SSE',
          authKind: 'API_KEY',
        },
        db,
      ),
    ).rejects.toThrow(/credential/i);
  });

  it('rejects a duplicate name within the same organization', async () => {
    const { db } = fakeDb();
    await createMcpServer(
      {
        organizationId: 'org1',
        name: 'dup',
        endpoint: 'https://a.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await expect(
      createMcpServer(
        {
          organizationId: 'org1',
          name: 'dup',
          endpoint: 'https://b.example.com',
          transport: 'SSE',
          authKind: 'NONE',
        },
        db,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('roundtrips a sealed credential through resolveMcpConnectionSecret', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'API_KEY',
        credential: 'my-api-key',
      },
      db,
    );
    const secret = await resolveMcpConnectionSecret('org1', server.id, db);
    expect(secret.credential).toBe('my-api-key');
  });

  it('never resolves a server belonging to a different organization (tenant isolation)', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await expect(getMcpServer('org2', server.id, db)).rejects.toThrow();
    await expect(resolveMcpConnectionSecret('org2', server.id, db)).rejects.toThrow();
  });

  it('setMcpServerEnabled / setMcpServerTrustLevel update only the target row', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    const enabled = await setMcpServerEnabled('org1', server.id, true, db);
    expect(enabled.enabled).toBe(true);
    const trusted = await setMcpServerTrustLevel('org1', server.id, 'TRUSTED', db);
    expect(trusted.trustLevel).toBe('TRUSTED');
  });

  it('deleteMcpServer removes the row', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await deleteMcpServer('org1', server.id, db);
    expect(await listMcpServers('org1', db)).toHaveLength(0);
  });
});

describe('MCP tool gating', () => {
  it('a discovered tool starts disabled and stays disabled across re-discovery', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await upsertDiscoveredTools(
      'org1',
      server.id,
      [
        {
          name: 'search',
          namespacedName: 'mcp.s.search',
          description: 'd',
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      db,
    );
    const tools = await listMcpServerTools('org1', server.id, db);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.enabled).toBe(false);

    // Manually enable it, then re-run discovery — enabled must survive.
    await setMcpToolEnabled('org1', server.id, tools[0]!.id, true, db);
    await upsertDiscoveredTools(
      'org1',
      server.id,
      [
        {
          name: 'search',
          namespacedName: 'mcp.s.search',
          description: 'd2',
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      db,
    );
    const after = await listMcpServerTools('org1', server.id, db);
    expect(after[0]!.enabled).toBe(true);
    expect(after[0]!.description).toBe('d2');
  });

  it('listEnabledMcpTools requires BOTH the server and the tool to be enabled', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await upsertDiscoveredTools(
      'org1',
      server.id,
      [
        {
          name: 'search',
          namespacedName: 'mcp.s.search',
          description: null,
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      db,
    );
    const tools = await listMcpServerTools('org1', server.id, db);

    // Tool enabled, server disabled → not usable.
    await setMcpToolEnabled('org1', server.id, tools[0]!.id, true, db);
    expect(await listEnabledMcpTools('org1', db)).toHaveLength(0);

    // Both enabled → usable.
    await setMcpServerEnabled('org1', server.id, true, db);
    expect(await listEnabledMcpTools('org1', db)).toHaveLength(1);

    // Server enabled, tool disabled → not usable.
    await setMcpToolEnabled('org1', server.id, tools[0]!.id, false, db);
    expect(await listEnabledMcpTools('org1', db)).toHaveLength(0);
  });

  it('getEnabledMcpToolByNamespacedName re-checks both gates, never trusting a cached lookup', async () => {
    const { db } = fakeDb();
    const server = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S',
        endpoint: 'https://s.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await upsertDiscoveredTools(
      'org1',
      server.id,
      [
        {
          name: 'search',
          namespacedName: 'mcp.s.search',
          description: null,
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      db,
    );
    expect(await getEnabledMcpToolByNamespacedName('org1', 'mcp.s.search', db)).toBeNull();

    const tools = await listMcpServerTools('org1', server.id, db);
    await setMcpServerEnabled('org1', server.id, true, db);
    await setMcpToolEnabled('org1', server.id, tools[0]!.id, true, db);
    expect(await getEnabledMcpToolByNamespacedName('org1', 'mcp.s.search', db)).not.toBeNull();
  });

  it('setMcpToolEnabled refuses a tool id from a different server', async () => {
    const { db } = fakeDb();
    const s1 = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S1',
        endpoint: 'https://a.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    const s2 = await createMcpServer(
      {
        organizationId: 'org1',
        name: 'S2',
        endpoint: 'https://b.example.com',
        transport: 'SSE',
        authKind: 'NONE',
      },
      db,
    );
    await upsertDiscoveredTools(
      'org1',
      s1.id,
      [
        {
          name: 't',
          namespacedName: 'mcp.s1.t',
          description: null,
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      db,
    );
    const [tool] = await listMcpServerTools('org1', s1.id, db);
    await expect(setMcpToolEnabled('org1', s2.id, tool!.id, true, db)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
