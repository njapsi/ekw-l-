import { PrismaClient } from '@growth-agent/db';
import type { BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/**
 * Shared support for the DB-backed e2e specs (journey/failures/security —
 * `authed.spec.ts` predates this file and keeps its own copy of the same
 * pattern). Every one of these specs needs a real database, so they
 * **self-skip** unless `E2E_AUTHED=1` and the DB is reachable — CI provides
 * both (see `.github/workflows/ci.yml`); a plain `pnpm test:e2e` run skips
 * them, exactly like `authed.spec.ts` already does.
 *
 * Rather than driving a real magic-link (needs a mail transport) or the dev
 * credentials provider (prod-disabled — Phase 14), every spec mints the same
 * JWE session cookie NextAuth would issue, for rows it seeds directly via
 * Prisma. See docs/E2E-TESTING.md for why this is the only practical option.
 */

export const AUTHED = process.env.E2E_AUTHED === '1';
export const DB_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
export const SECRET = process.env.AUTH_SECRET ?? 'e2e-insecure-secret-value-0123456789';
export const COOKIE = 'authjs.session-token'; // http origin ⇒ no __Secure- prefix
export const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100';

export const prisma =
  AUTHED && DB_URL ? new PrismaClient({ datasources: { db: { url: DB_URL } } }) : null;

export async function checkReachable(): Promise<boolean> {
  if (!prisma) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function tag(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface OrgMember {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export interface SeededUser {
  id: string;
  email: string;
  name: string;
  isPlatformStaff?: boolean;
  orgs: OrgMember[];
}

/** Initials as `UserMenu` computes them, for locating the account menu trigger. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Mint the exact session cookie NextAuth would issue and attach it to `context`. */
export async function signIn(context: BrowserContext, who: SeededUser): Promise<void> {
  const value = await encode({
    salt: COOKIE,
    secret: SECRET,
    token: {
      uid: who.id,
      email: who.email,
      name: who.name,
      picture: null,
      orgs: who.orgs,
      isPlatformStaff: who.isPlatformStaff ?? false,
      sv: 0,
    },
  });
  await context.addCookies([{ name: COOKIE, value, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
}

// --- seed helpers -----------------------------------------------------

/** A user + org + OWNER membership, ready to sign in as. */
export async function seedOrg(
  db: PrismaClient,
  t: string,
  opts: { role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' } = {},
) {
  const user = await db.user.create({
    data: { email: `${t}-owner@example.com`, name: 'QA Owner', emailVerified: new Date() },
  });
  const org = await db.organization.create({
    data: {
      name: 'QA Org',
      slug: `${t}-org`,
      memberships: { create: [{ userId: user.id, role: opts.role ?? 'OWNER', status: 'ACTIVE' }] },
    },
  });
  return { userId: user.id, email: `${t}-owner@example.com`, orgId: org.id, orgSlug: org.slug };
}

/** A verified website — there is no verification bypass in the product; this
 * mirrors the exact row shape `verifyWebsite()` itself writes on success. */
export async function seedVerifiedWebsite(
  db: PrismaClient,
  organizationId: string,
  url: string,
): Promise<{ id: string; hostname: string }> {
  const hostname = new URL(url).hostname;
  const site = await db.website.create({
    data: {
      organizationId,
      url,
      hostname,
      verified: true,
      verificationMethod: 'DNS_TXT',
      verificationToken: `qa-${Math.random().toString(36).slice(2, 10)}`,
      verifiedAt: new Date(),
    },
  });
  return { id: site.id, hostname: site.hostname };
}

export async function seedCrawl(
  db: PrismaClient,
  input: {
    websiteId: string;
    organizationId: string;
    status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
    blockedReason?: string;
    pagesCrawled?: number;
  },
) {
  return db.crawl.create({
    data: {
      websiteId: input.websiteId,
      organizationId: input.organizationId,
      status: input.status ?? 'COMPLETED',
      renderMode: 'STATIC',
      config: { maxPages: 50, maxDepth: 3 },
      pagesCrawled: input.pagesCrawled ?? 5,
      issuesFound: 0,
      blockedReason: input.blockedReason,
      startedAt: new Date(),
      finishedAt: input.status === 'RUNNING' ? null : new Date(),
    },
  });
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

/** `count` deterministic issues spread across every severity, plus website scoping. */
export async function seedCrawlIssues(
  db: PrismaClient,
  input: { crawlId: string; websiteId: string; organizationId: string; count: number },
) {
  const rows = Array.from({ length: input.count }, (_, i) => ({
    crawlId: input.crawlId,
    websiteId: input.websiteId,
    organizationId: input.organizationId,
    code: `QA_ISSUE_${i}`,
    category: 'metadata',
    severity: SEVERITIES[i % SEVERITIES.length]!,
    normalizedUrl: `https://example.com/page-${i}`,
    title: `QA seeded issue ${i}`,
    detail: 'Seeded directly for e2e — deterministic, not from a real crawl.',
    recommendedFix: 'n/a — test fixture',
    confidence: 0.8,
    affectedUrlCount: 1,
  }));
  // crawl_issues has no createMany-friendly unique-safe path here since ids
  // are cuid()-generated per row; createMany is fine, nothing collides.
  await db.crawlIssue.createMany({ data: rows });
  await db.crawl.update({ where: { id: input.crawlId }, data: { issuesFound: input.count } });
}

export async function seedYouTubeConnected(
  db: PrismaClient,
  organizationId: string,
  status: 'ACTIVE' | 'ERROR' | 'REVOKED' = 'ACTIVE',
) {
  const conn = await db.oAuthConnection.create({
    data: {
      organizationId,
      provider: 'YOUTUBE',
      externalAccountId: 'UC_qa_channel',
      displayName: 'QA Test Channel',
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      // Never decrypted in these tests — dummy cipher material is enough to
      // satisfy the schema and render a "connected" state.
      accessTokenCipher: 'qa-fixture-cipher',
      tokenIv: 'qa-fixture-iv',
      tokenAuthTag: 'qa-fixture-tag',
      keyId: 'qa-fixture-key',
      status,
      lastError: status === 'ERROR' ? 'Token refresh failed (seeded fixture).' : null,
    },
  });
  await db.youTubeChannel.create({
    data: {
      organizationId,
      oauthConnectionId: conn.id,
      channelId: 'UC_qa_channel',
      title: 'QA Test Channel',
      subscriberCount: 1000n,
      viewCount: 50000n,
      videoCount: 10,
    },
  });
  return conn;
}

export async function seedMonetizationOpportunity(db: PrismaClient, organizationId: string) {
  return db.monetizationOpportunity.create({
    data: {
      organizationId,
      channel: 'SPONSORSHIP',
      title: 'QA seeded sponsorship opportunity',
      description: 'Seeded directly for e2e — not from a real scan.',
      potentialBasis: 'Seeded fixture; not a real estimate.',
      requiredActions: ['Reach out to a relevant brand.'],
    },
  });
}

export async function cleanupOrg(db: PrismaClient, orgId: string, userIds: string[]) {
  await db.organization.deleteMany({ where: { id: orgId } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
}
