/**
 * Org-scoped reads for the Monetization dashboard (master instruction
 * "MONETIZATION DASHBOARD"): current opportunities, potential opportunities,
 * recommended actions, completed opportunities, and revenue tracking.
 */
import { type Db, prisma } from '@growth-agent/db';
import { getBusinessProfile } from './profile.js';
import { getRevenueSummary, listRevenueEntries } from './revenue.js';

export async function getMonetizationDashboard(organizationId: string, db: Db = prisma) {
  const [opps, profile, revenueSummary, revenueEntries, latestRun] = await Promise.all([
    db.monetizationOpportunity.findMany({
      where: { organizationId },
      orderBy: [{ priorityScore: 'desc' }, { updatedAt: 'desc' }],
    }),
    getBusinessProfile(organizationId, db),
    getRevenueSummary(organizationId, db),
    listRevenueEntries(organizationId, db),
    db.agentRun.findFirst({
      where: { organizationId, agent: 'monetization-analyst' },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const shape = (o: (typeof opps)[number]) => ({
    id: o.id,
    channel: o.channel,
    title: o.title,
    description: o.description,
    status: o.status,
    evidence: (o.evidence as Array<{ statement: string; kind: string }>) ?? [],
    audienceFit: o.audienceFit,
    difficulty: o.difficulty,
    potential: o.potential,
    potentialBasis: o.potentialBasis,
    requiredActions: o.requiredActions,
    confidence: o.confidence,
    isEstimate: o.isEstimate,
    priorityScore: o.priorityScore,
    dismissedReason: o.dismissedReason,
    completedNote: o.completedNote,
    updatedAt: o.updatedAt,
  });

  return {
    // Current: active or in progress.
    current: opps.filter((o) => o.status === 'ACTIVE' || o.status === 'IN_PROGRESS').map(shape),
    // Potential: suggested, not started.
    potential: opps.filter((o) => o.status === 'SUGGESTED').map(shape),
    completed: opps.filter((o) => o.status === 'COMPLETED').map(shape),
    dismissed: opps.filter((o) => o.status === 'DISMISSED').map(shape),
    // Recommended actions: the top suggested opportunities' first action.
    recommendedActions: opps
      .filter((o) => o.status === 'SUGGESTED' || o.status === 'IN_PROGRESS')
      .slice(0, 6)
      .map((o) => ({
        opportunityId: o.id,
        channel: o.channel,
        title: o.title,
        action: o.requiredActions[0] ?? 'Review this opportunity.',
        priorityScore: o.priorityScore,
      })),
    revenue: {
      summary: revenueSummary,
      entries: revenueEntries.map((e) => ({
        id: e.id,
        channel: e.channel,
        source: e.source,
        amount: Number(e.amount),
        currency: e.currency,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        isRecurring: e.isRecurring,
        note: e.note,
      })),
    },
    profileComplete: Boolean(
      profile && (profile.niche || profile.audienceDescription || profile.offerings.length),
    ),
    lastScanAt: latestRun?.createdAt ?? null,
    lastScanOverview: (latestRun?.output as { overview?: string } | null)?.overview ?? null,
  };
}
