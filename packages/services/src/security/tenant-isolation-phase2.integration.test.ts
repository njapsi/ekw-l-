import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrationTool } from '../agent/integration-tools.js';
import { requestIntegrationAction } from '../approvals/index.js';
import { authenticateApiKey, createApiKey, revokeApiKey } from '../apikeys/index.js';
import { listAuditEvents } from '../audit/query.js';
import { createUserSession, revokeSessionByHandle, sessionHandle } from '../auth/sessions.js';
import {
  getGovernancePolicy,
  updateGovernancePolicy,
  DEFAULT_POLICY,
} from '../governance/index.js';
import { removeMember, updateMemberRole } from '../organizations/members.js';
import { runIntegrationSync } from '../sync/index.js';
import { exportUserData } from '../users/account.js';
import { requireWordPressSite } from '../wordpress/connect.js';
import { assertJobAuthorized } from './job-auth.js';

/**
 * Phase 2 cross-tenant isolation against a real PostgreSQL (Part 20/21/33).
 * Organization A must never read, modify or delete anything of organization
 * B's — through the service layer, background-job authorization, agent tools
 * or API keys. Self-skips without a database; runs in CI.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    )
  : false;

const tag = `iso2_${Date.now()}`;
interface Fixture {
  orgId: string;
  ownerId: string;
  memberId: string;
  wpSiteId: string;
  sessionId: string;
}
let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  if (!prisma || !reachable) return;
  const mk = async (k: string): Promise<Fixture> => {
    const owner = await prisma.user.create({ data: { email: `${tag}-${k}-owner@example.com` } });
    const member = await prisma.user.create({ data: { email: `${tag}-${k}-member@example.com` } });
    const org = await prisma.organization.create({
      data: {
        name: `${tag} ${k}`,
        slug: `${tag}-${k}`,
        memberships: {
          create: [
            { userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
            { userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
          ],
        },
      },
    });
    const site = await prisma.wordPressSite.create({
      data: {
        organizationId: org.id,
        siteUrl: `https://${tag}-${k}.example.com`,
        username: 'editor',
        credentialCipher: 'c',
        credentialIv: 'i',
        credentialAuthTag: 't',
        keyId: 'k',
        detectedCapabilities: ['read', 'edit_posts', 'publish_posts'],
        lastCheckAt: new Date(),
        lastCheckOk: true,
      },
    });
    await prisma.auditLog.create({
      data: { organizationId: org.id, actorId: owner.id, action: 'organization.updated' },
    });
    const { sessionId } = await createUserSession(
      { userId: owner.id, authMethod: 'password' },
      prisma,
    );
    return { orgId: org.id, ownerId: owner.id, memberId: member.id, wpSiteId: site.id, sessionId };
  };
  A = await mk('a');
  B = await mk('b');
});

afterAll(async () => {
  if (prisma && reachable && A && B) {
    await prisma.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [A.ownerId, A.memberId, B.ownerId, B.memberId] } },
    });
  }
  await prisma?.$disconnect();
});

const maybe = reachable ? it : it.skip;

describe('Phase 2 cross-tenant isolation (integration)', () => {
  it('self-skips without a database', () => {
    if (!reachable)
      console.warn('[integration] no DATABASE_URL — skipping Phase 2 isolation tests');
    expect(true).toBe(true);
  });

  maybe('A cannot resolve B’s WordPress site', async () => {
    await expect(requireWordPressSite(A.orgId, B.wpSiteId, prisma!)).rejects.toThrow(/not found/);
  });

  maybe('A cannot request an external action against B’s connection', async () => {
    await expect(
      requestIntegrationAction(
        {
          organizationId: A.orgId,
          requestedById: A.ownerId,
          capabilityId: 'wordpress.publish',
          connectionRef: B.wpSiteId,
          payload: { wpId: 1 },
          summary: 'cross-tenant',
        },
        prisma!,
      ),
    ).rejects.toThrow(/not found/);
    expect(
      await prisma!.integrationActionRequest.count({ where: { connectionRef: B.wpSiteId } }),
    ).toBe(0);
  });

  maybe('A cannot sync B’s connection', async () => {
    await expect(
      runIntegrationSync(
        { organizationId: A.orgId, key: 'WORDPRESS', connectionRef: B.wpSiteId, trigger: 'MANUAL' },
        prisma!,
      ),
    ).rejects.toThrow(/not found/);
  });

  maybe('A cannot read B’s audit log', async () => {
    const { events } = await listAuditEvents(A.ownerId, A.orgId, {}, prisma!);
    const bRows = await prisma!.auditLog.findMany({
      where: { organizationId: B.orgId },
      select: { id: true },
    });
    const ids = new Set(events.map((e) => e.id));
    expect(bRows.some((r) => ids.has(r.id))).toBe(false);
    await expect(listAuditEvents(A.ownerId, B.orgId, {}, prisma!)).rejects.toThrow();
  });

  maybe('A cannot change roles in, or remove members of, B', async () => {
    await expect(
      updateMemberRole(A.ownerId, B.orgId, { targetUserId: B.memberId, role: 'ADMIN' }, prisma!),
    ).rejects.toThrow();
    await expect(removeMember(A.ownerId, B.orgId, B.memberId, prisma!)).rejects.toThrow();
    // …nor reach B's member through A's organization id.
    await expect(
      updateMemberRole(A.ownerId, A.orgId, { targetUserId: B.memberId, role: 'ADMIN' }, prisma!),
    ).rejects.toThrow(/not found/i);
  });

  maybe('an API key resolves only to its own organization; B cannot revoke A’s key', async () => {
    const { key, id } = await createApiKey(
      A.ownerId,
      A.orgId,
      { name: 'it', scopes: ['seo:read'] },
      prisma!,
    );
    expect((await authenticateApiKey(key, prisma!)).organizationId).toBe(A.orgId);
    await expect(revokeApiKey(B.ownerId, B.orgId, id, prisma!)).rejects.toThrow(/not found/);
    await expect(revokeApiKey(B.ownerId, A.orgId, id, prisma!)).rejects.toThrow();
  });

  maybe('governance of A does not affect B', async () => {
    const p = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as typeof DEFAULT_POLICY;
    p.integrations.WORDPRESS.publish = 'disabled';
    await updateGovernancePolicy(A.ownerId, A.orgId, p, prisma!);
    expect((await getGovernancePolicy(B.orgId, prisma!)).integrations.WORDPRESS.publish).toBe(
      'approval_required',
    );
    await expect(updateGovernancePolicy(A.ownerId, B.orgId, p, prisma!)).rejects.toThrow();
  });

  maybe('a background job for A cannot run as a member of B', async () => {
    await expect(
      assertJobAuthorized(
        { organizationId: B.orgId, actorUserId: A.ownerId },
        'agent.run',
        prisma!,
      ),
    ).rejects.toThrow();
  });

  maybe('agent tools scoped to A never see B’s WordPress', async () => {
    const out = (await runIntegrationTool(
      'integrations.list_connections',
      { organizationId: A.orgId, userId: A.ownerId, db: prisma! },
      {},
    )) as Array<{ integration: string; account: string | null }>;
    const wp = out.find((c) => c.integration === 'WORDPRESS');
    expect(wp?.account ?? '').not.toContain(`${tag}-b`);
  });

  maybe('A cannot sign out B’s sessions', async () => {
    await expect(
      revokeSessionByHandle(A.ownerId, sessionHandle(B.sessionId), A.sessionId, {}, prisma!),
    ).rejects.toThrow(/not found/);
    const row = await prisma!.userSession.findUnique({ where: { id: B.sessionId } });
    expect(row?.revokedAt).toBeNull();
  });

  maybe('a personal export contains no other user’s data', async () => {
    const data = await exportUserData(A.ownerId, prisma!);
    const text = JSON.stringify(data);
    expect(text).not.toContain(`${tag}-b-owner`);
    expect(text).not.toContain(B.orgId);
  });
});
