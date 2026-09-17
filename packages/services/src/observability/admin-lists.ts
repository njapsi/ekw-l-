/**
 * Paged, platform-wide entity lists for the `/admin` pages. Every query uses an
 * explicit `select` so token/cipher columns can never be pulled in, and free
 * text that could carry a secret (`lastError`, crawl `error`) is scrubbed.
 */
import { type Db, type Prisma, prisma } from '@growth-agent/db';
import { scrubSecrets } from './scrub.js';

const DEFAULT_PAGE_SIZE = 25;

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function paging(opts: { page?: number; pageSize?: number }): {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
} {
  const pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

function pageResult<T>(rows: T[], total: number, page: number, pageSize: number): Page<T> {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** `cus_1a2b…wxyz` — enough to correlate with Stripe, not enough to be the value. */
export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.length <= 8) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

// --- Users -----------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  staffLevel: string | null;
  memberships: number;
  deleted: boolean;
  createdAt: string;
}

export async function listUsers(
  db: Db = prisma,
  opts: { q?: string; page?: number } = {},
): Promise<Page<UserRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.UserWhereInput = opts.q
    ? {
        OR: [
          { email: { contains: opts.q, mode: 'insensitive' } },
          { name: { contains: opts.q, mode: 'insensitive' } },
        ],
      }
    : {};
  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        createdAt: true,
        deletedAt: true,
        platformStaff: { select: { level: true } },
        _count: { select: { memberships: true } },
      },
    }),
    db.user.count({ where }),
  ]);
  return pageResult(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      emailVerified: Boolean(u.emailVerified),
      staffLevel: u.platformStaff?.level ?? null,
      memberships: u._count.memberships,
      deleted: Boolean(u.deletedAt),
      createdAt: u.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}

// --- Organizations -------------------------------------------------

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  tier: string;
  subscriptionStatus: string | null;
  members: number;
  deleted: boolean;
  createdAt: string;
}

export async function listOrganizations(
  db: Db = prisma,
  opts: { q?: string; page?: number } = {},
): Promise<Page<OrganizationRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.OrganizationWhereInput = opts.q
    ? {
        OR: [
          { name: { contains: opts.q, mode: 'insensitive' } },
          { slug: { contains: opts.q, mode: 'insensitive' } },
        ],
      }
    : {};
  const [rows, total] = await Promise.all([
    db.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        deletedAt: true,
        subscription: { select: { tier: true, status: true } },
        _count: { select: { memberships: true } },
      },
    }),
    db.organization.count({ where }),
  ]);
  return pageResult(
    rows.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      tier: o.subscription?.tier ?? 'FREE',
      subscriptionStatus: o.subscription?.status ?? null,
      members: o._count.memberships,
      deleted: Boolean(o.deletedAt),
      createdAt: o.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}

export interface OrganizationDetail {
  id: string;
  name: string;
  slug: string;
  deleted: boolean;
  createdAt: string;
  subscription: {
    tier: string;
    status: string;
    interval: string;
    seats: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
    stripeCustomer: string | null;
    stripeSubscription: string | null;
  } | null;
  members: Array<{
    userId: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    joinedAt: string;
  }>;
  usage: Array<{ meter: string; used: number; limit: number | null }>;
  recentAgentRuns: Array<{
    id: string;
    agent: string;
    status: string;
    costUsd: number;
    createdAt: string;
  }>;
  recentCrawls: Array<{
    id: string;
    status: string;
    pagesCrawled: number;
    issuesFound: number;
    createdAt: string;
  }>;
  recentAudit: Array<{ id: string; action: string; actorType: string; createdAt: string }>;
}

export async function getOrganizationDetail(
  db: Db,
  orgId: string,
): Promise<OrganizationDetail | null> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      deletedAt: true,
      subscription: true,
      memberships: {
        select: {
          role: true,
          status: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!org) return null;

  const [counters, agentRuns, crawls, audit] = await Promise.all([
    db.usageCounter.findMany({
      where: { organizationId: orgId, periodEnd: { gte: new Date() } },
      select: { meter: true, used: true, limitValue: true, periodEnd: true },
    }),
    db.agentRun.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, agent: true, status: true, costUsd: true, createdAt: true },
    }),
    db.crawl.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, pagesCrawled: true, issuesFound: true, createdAt: true },
    }),
    db.auditLog.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, action: true, actorType: true, createdAt: true },
    }),
  ]);

  const sub = org.subscription;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    deleted: Boolean(org.deletedAt),
    createdAt: org.createdAt.toISOString(),
    subscription: sub
      ? {
          tier: sub.tier,
          status: sub.status,
          interval: sub.interval,
          seats: sub.seats,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
          stripeCustomer: maskId(sub.stripeCustomerId),
          stripeSubscription: maskId(sub.stripeSubscriptionId),
        }
      : null,
    members: org.memberships.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      status: m.status,
      joinedAt: m.createdAt.toISOString(),
    })),
    usage: counters.map((c) => ({
      meter: c.meter,
      used: Number(c.used),
      limit: c.limitValue != null ? Number(c.limitValue) : null,
    })),
    recentAgentRuns: agentRuns.map((r) => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      costUsd: Number(r.costUsd),
      createdAt: r.createdAt.toISOString(),
    })),
    recentCrawls: crawls.map((c) => ({
      id: c.id,
      status: c.status,
      pagesCrawled: c.pagesCrawled,
      issuesFound: c.issuesFound,
      createdAt: c.createdAt.toISOString(),
    })),
    recentAudit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      actorType: a.actorType,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// --- Subscriptions -----------------------------------------------

export interface SubscriptionRow {
  id: string;
  org: { id: string; name: string; slug: string };
  tier: string;
  status: string;
  interval: string;
  seats: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  stripeCustomer: string | null;
  stripeSubscription: string | null;
}

export async function listSubscriptions(
  db: Db = prisma,
  opts: { page?: number; tier?: string; status?: string } = {},
): Promise<Page<SubscriptionRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.SubscriptionWhereInput = {};
  if (opts.tier) where.tier = opts.tier as Prisma.SubscriptionWhereInput['tier'];
  if (opts.status) where.status = opts.status as Prisma.SubscriptionWhereInput['status'];
  const [rows, total] = await Promise.all([
    db.subscription.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        tier: true,
        status: true,
        interval: true,
        seats: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        trialEndsAt: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
    }),
    db.subscription.count({ where }),
  ]);
  return pageResult(
    rows.map((s) => ({
      id: s.id,
      org: s.organization,
      tier: s.tier,
      status: s.status,
      interval: s.interval,
      seats: s.seats,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      stripeCustomer: maskId(s.stripeCustomerId),
      stripeSubscription: maskId(s.stripeSubscriptionId),
    })),
    total,
    page,
    pageSize,
  );
}

// --- Agent runs -------------------------------------------------

export interface AgentRunRow {
  id: string;
  organizationId: string;
  agent: string;
  status: string;
  trigger: string | null;
  model: string | null;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number | null;
  createdAt: string;
}

export async function listAgentRuns(
  db: Db = prisma,
  opts: { page?: number; status?: string; agent?: string; organizationId?: string } = {},
): Promise<Page<AgentRunRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.AgentRunWhereInput = {};
  if (opts.status) where.status = opts.status as Prisma.AgentRunWhereInput['status'];
  if (opts.agent) where.agent = opts.agent;
  if (opts.organizationId) where.organizationId = opts.organizationId;
  const [rows, total] = await Promise.all([
    db.agentRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        organizationId: true,
        agent: true,
        status: true,
        trigger: true,
        model: true,
        provider: true,
        tokensPrompt: true,
        tokensCompletion: true,
        costUsd: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    }),
    db.agentRun.count({ where }),
  ]);
  return pageResult(
    rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      agent: r.agent,
      status: r.status,
      trigger: r.trigger,
      model: r.model,
      provider: r.provider,
      promptTokens: r.tokensPrompt,
      completionTokens: r.tokensCompletion,
      costUsd: Number(r.costUsd),
      durationMs:
        r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}

// --- Crawler jobs ---------------------------------------------

export interface CrawlRow {
  id: string;
  organizationId: string;
  hostname: string;
  status: string;
  renderMode: string;
  pagesCrawled: number;
  pagesQueued: number;
  issuesFound: number;
  error: string | null;
  blockedReason: string | null;
  durationMs: number | null;
  createdAt: string;
}

export async function listCrawls(
  db: Db = prisma,
  opts: { page?: number; status?: string } = {},
): Promise<Page<CrawlRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.CrawlWhereInput = {};
  if (opts.status) where.status = opts.status as Prisma.CrawlWhereInput['status'];
  const [rows, total] = await Promise.all([
    db.crawl.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        organizationId: true,
        status: true,
        renderMode: true,
        pagesCrawled: true,
        pagesQueued: true,
        issuesFound: true,
        error: true,
        blockedReason: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        website: { select: { hostname: true } },
      },
    }),
    db.crawl.count({ where }),
  ]);
  return pageResult(
    rows.map((c) => ({
      id: c.id,
      organizationId: c.organizationId,
      hostname: c.website?.hostname ?? '—',
      status: c.status,
      renderMode: c.renderMode,
      pagesCrawled: c.pagesCrawled,
      pagesQueued: c.pagesQueued,
      issuesFound: c.issuesFound,
      error: c.error ? scrubSecrets(c.error).slice(0, 300) : null,
      blockedReason: c.blockedReason,
      durationMs:
        c.startedAt && c.finishedAt ? c.finishedAt.getTime() - c.startedAt.getTime() : null,
      createdAt: c.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}

// --- API integrations --------------------------------------

export interface OAuthConnectionRow {
  id: string;
  organizationId: string;
  provider: string;
  displayName: string | null;
  scopeCount: number;
  status: string;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  health: {
    ok: boolean;
    detail: string | null;
    quotaUnitsUsedToday: number | null;
    lastCheckAt: string;
  } | null;
  createdAt: string;
}

export async function listOAuthConnections(
  db: Db = prisma,
  opts: { page?: number; provider?: string; status?: string } = {},
): Promise<Page<OAuthConnectionRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.OAuthConnectionWhereInput = {};
  if (opts.provider) where.provider = opts.provider as Prisma.OAuthConnectionWhereInput['provider'];
  if (opts.status) where.status = opts.status as Prisma.OAuthConnectionWhereInput['status'];
  const [rows, total] = await Promise.all([
    db.oAuthConnection.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take,
      // Explicit select — the *Cipher / *Iv / *AuthTag / keyId columns are never
      // read here (docs/SECURITY.md).
      select: {
        id: true,
        organizationId: true,
        provider: true,
        displayName: true,
        scopes: true,
        status: true,
        expiresAt: true,
        lastRefreshedAt: true,
        lastError: true,
        createdAt: true,
        health: {
          select: { ok: true, detail: true, quotaUnitsUsedToday: true, lastCheckAt: true },
        },
      },
    }),
    db.oAuthConnection.count({ where }),
  ]);
  return pageResult(
    rows.map((c) => ({
      id: c.id,
      organizationId: c.organizationId,
      provider: c.provider,
      displayName: c.displayName,
      scopeCount: c.scopes.length,
      status: c.status,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      lastRefreshedAt: c.lastRefreshedAt?.toISOString() ?? null,
      lastError: c.lastError ? scrubSecrets(c.lastError).slice(0, 300) : null,
      health: c.health
        ? {
            ok: c.health.ok,
            detail: c.health.detail ? scrubSecrets(c.health.detail).slice(0, 200) : null,
            quotaUnitsUsedToday: c.health.quotaUnitsUsedToday,
            lastCheckAt: c.health.lastCheckAt.toISOString(),
          }
        : null,
      createdAt: c.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}

// --- Audit logs ------------------------------------------

export interface AuditLogRow {
  id: string;
  action: string;
  actorType: string;
  actorEmail: string | null;
  orgSlug: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  createdAt: string;
}

export async function listAuditLogs(
  db: Db = prisma,
  opts: { page?: number; action?: string; organizationId?: string; actorId?: string } = {},
): Promise<Page<AuditLogRow>> {
  const { skip, take, page, pageSize } = paging(opts);
  const where: Prisma.AuditLogWhereInput = {};
  if (opts.action) where.action = { contains: opts.action, mode: 'insensitive' };
  if (opts.organizationId) where.organizationId = opts.organizationId;
  if (opts.actorId) where.actorId = opts.actorId;
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        action: true,
        actorType: true,
        targetType: true,
        targetId: true,
        ip: true,
        createdAt: true,
        organization: { select: { slug: true } },
        actor: { select: { email: true } },
      },
    }),
    db.auditLog.count({ where }),
  ]);
  return pageResult(
    rows.map((a) => ({
      id: a.id,
      action: a.action,
      actorType: a.actorType,
      actorEmail: a.actor?.email ?? null,
      orgSlug: a.organization?.slug ?? null,
      targetType: a.targetType,
      targetId: a.targetId,
      ip: a.ip,
      createdAt: a.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  );
}
