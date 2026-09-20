import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import {
  createMcpServer,
  getMcpServer,
  listEnabledMcpTools,
  listMcpServers,
  resolveMcpConnectionSecret,
  setMcpServerEnabled,
  setMcpToolEnabled,
  upsertDiscoveredTools,
} from './registry.js';

/**
 * Cross-tenant isolation for the Phase 5 MCP tables, end to end against a
 * real database — the same self-skipping convention every other
 * `*.integration.test.ts` in this repo uses (Phase 2's own fix: the
 * reachability probe runs at module load, before `it`/`it.skip` is chosen,
 * not inside `beforeAll`).
 *
 * Property under test: an `McpServer` / `McpServerTool` created for org A is
 * never visible, resolvable, or mutable from org B — not through
 * `getMcpServer`, not through `resolveMcpConnectionSecret` (which would
 * otherwise leak a sealed credential across tenants), and not through
 * `setMcpServerEnabled` / `setMcpToolEnabled`.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
let reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    )
  : false;

const tag = `mcpiso_${Date.now()}`;
type Fixture = { orgId: string; userId: string; serverId: string; toolId: string };
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }

  const mk = async (k: string) => {
    const user = await prisma.user.create({ data: { email: `${tag}-${k}@example.com` } });
    const org = await prisma.organization.create({
      data: {
        name: k,
        slug: `${tag}-${k}`,
        memberships: { create: { userId: user.id, role: 'OWNER', status: 'ACTIVE' } },
      },
    });
    const server = await createMcpServer(
      {
        organizationId: org.id,
        name: `${k}-server`,
        endpoint: 'https://mcp.example.com/sse',
        transport: 'SSE',
        authKind: 'API_KEY',
        credential: `${tag}-${k}-secret`,
        createdById: user.id,
      },
      prisma,
    );
    await upsertDiscoveredTools(
      org.id,
      server.id,
      [
        {
          name: 'search',
          namespacedName: `mcp.${k}-server.search`,
          description: 'test tool',
          inputSchema: {},
          riskLevel: 'HIGH',
        },
      ],
      prisma,
    );
    await setMcpServerEnabled(org.id, server.id, true, prisma);
    const tools = await prisma.mcpServerTool.findMany({ where: { mcpServerId: server.id } });
    await setMcpToolEnabled(org.id, server.id, tools[0]!.id, true, prisma);
    return { orgId: org.id, userId: user.id, serverId: server.id, toolId: tools[0]!.id };
  };

  A = await mk('a');
  B = await mk('b');
});

afterAll(async () => {
  if (prisma && reachable) {
    await prisma.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [A.userId, B.userId] } } });
  }
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

describe('MCP tenant isolation (integration)', () => {
  it('self-skips without a database', () => {
    if (!reachable)
      console.warn('[integration] no DATABASE_URL — skipping MCP tenant-isolation tests');
    expect(true).toBe(true);
  });

  maybe()('org A sees only its own server in listMcpServers', async () => {
    const servers = await listMcpServers(A.orgId, prisma!);
    expect(servers.map((s) => s.id)).toEqual([A.serverId]);
  });

  maybe()('org A cannot getMcpServer for org B’s server id', async () => {
    const err = await getMcpServer(A.orgId, B.serverId, prisma!).catch((e: unknown) => e);
    expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
  });

  maybe()(
    'org A cannot resolve org B’s connection secret through its own org id (no cross-tenant credential leak)',
    async () => {
      const err = await resolveMcpConnectionSecret(A.orgId, B.serverId, prisma!).catch(
        (e: unknown) => e,
      );
      expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
    },
  );

  maybe()('org A cannot enable/disable org B’s server', async () => {
    const err = await setMcpServerEnabled(A.orgId, B.serverId, false, prisma!).catch(
      (e: unknown) => e,
    );
    expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
    // Confirm B's server state is actually untouched.
    const stillEnabled = await getMcpServer(B.orgId, B.serverId, prisma!);
    expect(stillEnabled.enabled).toBe(true);
  });

  maybe()('org A cannot enable/disable org B’s tool', async () => {
    const err = await setMcpToolEnabled(A.orgId, B.serverId, B.toolId, false, prisma!).catch(
      (e: unknown) => e,
    );
    expect(isAppError(err) && err.code === 'resource_not_found').toBe(true);
  });

  maybe()('listEnabledMcpTools for org A never includes org B’s tool', async () => {
    const tools = await listEnabledMcpTools(A.orgId, prisma!);
    expect(tools.map((t) => t.toolId)).toEqual([A.toolId]);
    expect(tools.map((t) => t.toolId)).not.toContain(B.toolId);
  });

  maybe()(
    'each org’s own resolveMcpConnectionSecret returns its own distinct credential',
    async () => {
      const a = await resolveMcpConnectionSecret(A.orgId, A.serverId, prisma!);
      const b = await resolveMcpConnectionSecret(B.orgId, B.serverId, prisma!);
      expect(a.credential).toBe(`${tag}-a-secret`);
      expect(b.credential).toBe(`${tag}-b-secret`);
      expect(a.credential).not.toBe(b.credential);
    },
  );
});
