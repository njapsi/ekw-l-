/**
 * Organization data export (Phase 19 — FORENSIC-AUDIT M-2, the DSR "portability"
 * half). Assembles one JSON document from the org's rows across every tenant
 * table. Every query is scoped by `organizationId`; takes are bounded so a very
 * large org cannot OOM the process.
 */
import { type Db, prisma } from '@growth-agent/db';

const CAP = 5000;

export interface OrganizationExport {
  exportedAt: string;
  organization: unknown;
  members: unknown;
  invitations: unknown;
  integrations: unknown;
  youtube: { channels: unknown; videos: unknown };
  tiktok: { accounts: unknown; videos: unknown; publishes: unknown };
  seo: { websites: unknown; crawls: unknown; issues: unknown };
  ai: { conversations: unknown; messages: unknown; memories: unknown };
  recommendations: unknown;
  contentIdeas: unknown;
  repurposeProjects: unknown;
  contentAssets: unknown;
  monetization: { opportunities: unknown; revenueEntries: unknown; businessProfile: unknown };
  reports: unknown;
  tasks: unknown;
  automations: { rules: unknown; runs: unknown };
  billing: {
    subscription: unknown;
    entitlements: unknown;
    invoices: unknown;
    usageRecords: unknown;
  };
  notifications: unknown;
  auditLog: unknown;
}

export async function exportOrganizationData(
  organizationId: string,
  db: Db = prisma,
): Promise<OrganizationExport> {
  const where = { organizationId };
  const [
    organization,
    members,
    invitations,
    integrations,
    ytChannels,
    ytVideos,
    ttAccounts,
    ttVideos,
    ttPublishes,
    websites,
    crawls,
    crawlIssues,
    conversations,
    messages,
    memories,
    recommendations,
    contentIdeas,
    repurposeProjects,
    contentAssets,
    opportunities,
    revenueEntries,
    businessProfile,
    reports,
    tasks,
    autoRules,
    autoRuns,
    subscription,
    entitlements,
    invoices,
    usageRecords,
    notifications,
    auditLog,
  ] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId } }),
    db.membership.findMany({
      where,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    db.invitation.findMany({ where }),
    db.oAuthConnection.findMany({
      where,
      // Never export the encrypted token material.
      select: {
        id: true,
        provider: true,
        externalAccountId: true,
        displayName: true,
        scopes: true,
        status: true,
        createdAt: true,
      },
    }),
    db.youTubeChannel.findMany({ where, take: CAP }),
    db.youTubeVideo.findMany({ where, take: CAP }),
    db.tikTokAccount.findMany({ where, take: CAP }),
    db.tikTokVideo.findMany({ where, take: CAP }),
    db.tikTokPublish.findMany({ where, take: CAP }),
    db.website.findMany({ where, take: CAP }),
    db.crawl.findMany({ where, take: CAP }),
    db.crawlIssue.findMany({ where, take: CAP }),
    db.aIConversation.findMany({ where, take: CAP }),
    db.aIMessage.findMany({ where, take: CAP }),
    db.orgMemory.findMany({ where, take: CAP }),
    db.recommendation.findMany({ where, take: CAP }),
    db.contentIdea.findMany({ where, take: CAP }),
    db.repurposeProject.findMany({ where, take: CAP }),
    db.contentAsset.findMany({ where, take: CAP }),
    db.monetizationOpportunity.findMany({ where, take: CAP }),
    db.revenueEntry.findMany({ where, take: CAP }),
    db.businessProfile.findUnique({ where: { organizationId } }),
    db.report.findMany({ where, take: CAP }),
    db.task.findMany({ where, take: CAP }),
    db.automationRule.findMany({ where, take: CAP }),
    db.automationRun.findMany({ where, take: CAP }),
    db.subscription.findUnique({ where: { organizationId } }),
    db.entitlement.findMany({ where }),
    db.invoice.findMany({ where, take: CAP }),
    db.usageRecord.findMany({ where, take: CAP }),
    db.notification.findMany({ where, take: CAP }),
    db.auditLog.findMany({ where, take: CAP, orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    organization,
    members,
    invitations,
    integrations,
    youtube: { channels: ytChannels, videos: ytVideos },
    tiktok: { accounts: ttAccounts, videos: ttVideos, publishes: ttPublishes },
    seo: { websites, crawls, issues: crawlIssues },
    ai: { conversations, messages, memories },
    recommendations,
    contentIdeas,
    repurposeProjects,
    contentAssets,
    monetization: { opportunities, revenueEntries, businessProfile },
    reports,
    tasks,
    automations: { rules: autoRules, runs: autoRuns },
    billing: { subscription, entitlements, invoices, usageRecords },
    notifications,
    auditLog,
  };
}

/** Stable, JSON-safe serialisation (Prisma returns BigInt / Date / Decimal). */
export function serializeExport(data: OrganizationExport): string {
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Date) return value.toISOString();
      // Prisma Decimal exposes toString
      if (
        value &&
        typeof value === 'object' &&
        'toFixed' in value &&
        's' in value &&
        'e' in value
      ) {
        return (value as { toString(): string }).toString();
      }
      return value as unknown;
    },
    2,
  );
}
