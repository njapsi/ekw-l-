/**
 * Daily growth brief and weekly strategy review (Phase 10, §28/§29) —
 * deterministic fact-gathering from the same read functions the reporting
 * engine and automation dispatcher already use (never a new data source),
 * with an optional grounded narrative pass dropped on any failure. Delivered
 * via the existing `Notification` system — no new persistence for brief
 * history (a disclosed, deliberate scope cut; see `docs/GROWTH-MISSIONS.md`).
 */
import { type Db, prisma } from '@growth-agent/db';
import type { AIProvider } from '@growth-agent/ai';
import { z } from 'zod';
import { loadOrgContext } from '../agent/context.js';
import { getChannelOverview } from '../youtube/read.js';
import { getAccountOverview } from '../tiktok/read.js';
import { findRefreshCandidates } from '../wordpress/content-refresh.js';
import { createNotification } from '../notifications/index.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { listMissions } from './crud.js';

export interface BriefSection {
  heading: string;
  body: string;
}

export interface GrowthBrief {
  greeting: string;
  sections: BriefSection[];
  recommendedActions: string[];
  generatedAt: Date;
}

async function gatherFacts(organizationId: string, db: Db): Promise<BriefSection[]> {
  const ctx = await loadOrgContext(organizationId, db);
  const sections: BriefSection[] = [];

  if (ctx.youtube.connected) {
    const overview = await getChannelOverview(organizationId, db).catch(() => null);
    sections.push({
      heading: 'YouTube',
      body: overview
        ? `${overview.performers.high} video(s) are high performers, ${overview.performers.low} are low performers, out of ${overview.counts.videosSynced} synced.`
        : `"${ctx.youtube.channelTitle ?? 'Your channel'}" is connected; run a sync for a full picture.`,
    });
  }
  if (ctx.tiktok.connected) {
    const overview = await getAccountOverview(organizationId, db).catch(() => null);
    sections.push({
      heading: 'TikTok',
      body: overview
        ? overview.themes[0]
          ? `Your top content theme is "#${overview.themes[0].tag}" across ${overview.themes[0].videos} video(s).`
          : `${overview.performers.high} video(s) are high performers, ${overview.performers.low} are low performers.`
        : `"${ctx.tiktok.displayName ?? 'Your account'}" is connected; run a sync for a full picture.`,
    });
  }
  if (ctx.seo.latestCrawl) {
    sections.push({
      heading: 'Website',
      body: `Latest crawl of ${ctx.seo.latestCrawl.hostname}: ${ctx.seo.latestCrawl.issuesFound} issue(s) found across ${ctx.seo.latestCrawl.pagesCrawled} pages.`,
    });
  }
  if (ctx.wordpress.connected) {
    const candidates = await findRefreshCandidates(organizationId, { limit: 3 }, db).catch(() => []);
    const worthRefreshing = candidates.filter((c) => c.score > 0).length;
    sections.push({
      heading: 'WordPress',
      body:
        worthRefreshing > 0
          ? `${worthRefreshing} article(s) have a real refresh opportunity — real age/word-count/SEO-issue signals.`
          : 'No pages currently stand out as refresh candidates.',
    });
  }

  const activeMissions = await listMissions(organizationId, { status: ['ACTIVE'] }, db);
  if (activeMissions.length > 0) {
    sections.push({
      heading: 'Active missions',
      body: `${activeMissions.length} mission(s) in progress: ${activeMissions.map((m) => `"${m.name}"`).join(', ')}.`,
    });
  }

  if (sections.length === 0) {
    sections.push({ heading: 'Nothing connected yet', body: 'Connect a platform to start seeing a daily brief.' });
  }
  return sections;
}

export type BriefModel = Pick<AIProvider, 'generateObject'>;

const RecommendedActions = z.object({ actions: z.array(z.string().max(200)).max(5) });

export async function buildDailyBrief(
  organizationId: string,
  db: Db = prisma,
  model?: BriefModel,
): Promise<GrowthBrief> {
  const sections = await gatherFacts(organizationId, db);
  let recommendedActions: string[] = [];
  if (model) {
    try {
      const res = await model.generateObject({
        schema: RecommendedActions,
        system: `You suggest up to three concrete next actions from real facts only, one short sentence each. Never invent a fact not given to you.\n\n${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`,
        prompt: wrapUntrusted('FACTS', sections.map((s) => `${s.heading}: ${s.body}`).join('\n')),
      });
      recommendedActions = res.object.actions;
    } catch {
      recommendedActions = [];
    }
  }
  return { greeting: 'Good morning', sections, recommendedActions, generatedAt: new Date() };
}

export async function deliverDailyBrief(organizationId: string, brief: GrowthBrief, db: Db = prisma): Promise<void> {
  const body = brief.sections.map((s) => `${s.heading}: ${s.body}`).join('\n');
  const dateKey = brief.generatedAt.toISOString().slice(0, 10);
  await createNotification(
    {
      organizationId,
      kind: 'mission.daily_brief',
      level: 'INFO',
      title: 'Your daily growth brief',
      body: brief.recommendedActions.length > 0 ? `${body}\n\nRecommended: ${brief.recommendedActions.join(' ')}` : body,
      linkPath: '/app/missions',
      dedupeKey: `mission:daily-brief:${organizationId}:${dateKey}`,
      sourceType: 'growth_mission',
    },
    db,
  );
}

export interface WeeklyReview {
  facts: string[];
  interpretations: string[];
  recommendations: string[];
  generatedAt: Date;
}

/** Facts vs. interpretations vs. recommendations, kept explicitly separate
 *  (§29) — every "fact" line here is a real read; "interpretations" are
 *  clearly labelled as such, never presented as equally certain. */
export async function buildWeeklyReview(organizationId: string, db: Db = prisma): Promise<WeeklyReview> {
  const sections = await gatherFacts(organizationId, db);
  const missions = await listMissions(organizationId, { status: ['ACTIVE', 'COMPLETED'] }, db);

  const facts = sections.map((s) => `${s.heading}: ${s.body}`);
  const interpretations: string[] = [];
  const recommendations: string[] = [];

  for (const m of missions) {
    facts.push(`Mission "${m.name}" is ${m.status.toLowerCase()} (${m.taskCount} task(s) planned).`);
    if (m.status === 'ACTIVE' && m.loopFailureCount > 0) {
      interpretations.push(`"${m.name}" has had ${m.loopFailureCount} recent tick failure(s) — worth checking its activity log.`);
      recommendations.push(`Review "${m.name}"'s recent task failures in its mission detail page.`);
    }
  }
  if (missions.length === 0) {
    interpretations.push('No missions are active yet, so there is nothing being autonomously worked on this week.');
    recommendations.push('Create a Growth Mission to start working toward a specific goal.');
  }

  return { facts, interpretations, recommendations, generatedAt: new Date() };
}

export async function deliverWeeklyReview(organizationId: string, review: WeeklyReview, db: Db = prisma): Promise<void> {
  const weekKey = getIsoWeekKey(review.generatedAt);
  const body = [
    `Facts: ${review.facts.join(' ')}`,
    review.interpretations.length ? `Interpretations: ${review.interpretations.join(' ')}` : null,
    review.recommendations.length ? `Recommendations: ${review.recommendations.join(' ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  await createNotification(
    {
      organizationId,
      kind: 'mission.weekly_review',
      level: 'INFO',
      title: 'Your weekly strategy review',
      body,
      linkPath: '/app/missions',
      dedupeKey: `mission:weekly-review:${organizationId}:${weekKey}`,
      sourceType: 'growth_mission',
    },
    db,
  );
}

function getIsoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Organizations worth a brief: at least one connected platform or an
 *  active mission. A plain, tenant-scope-ok platform sweep — mirrors
 *  `automation/runner.ts::dueAutomations`'s own "scheduler sweep across all
 *  orgs, each execution then scoped to its own row" pattern; there is no
 *  single "acting user" for a scheduled cross-org digest; the delivered
 *  notification itself is org-wide (no `userId`) and reads nothing outside
 *  the org it was gathered for. */
async function orgsWorthBriefing(db: Db): Promise<string[]> {
  const [withYoutube, withTiktok, withWordpress, withWebsite, withMission] = await Promise.all([
    db.oAuthConnection.findMany({ where: { provider: 'YOUTUBE', status: { not: 'REVOKED' } }, select: { organizationId: true }, distinct: ['organizationId'] }),
    db.oAuthConnection.findMany({ where: { provider: 'TIKTOK', status: { not: 'REVOKED' } }, select: { organizationId: true }, distinct: ['organizationId'] }),
    db.wordPressSite.findMany({ where: { status: { not: 'REVOKED' } }, select: { organizationId: true }, distinct: ['organizationId'] }),
    db.website.findMany({ select: { organizationId: true }, distinct: ['organizationId'] }),
    db.growthMission.findMany({ where: { status: 'ACTIVE' }, select: { organizationId: true }, distinct: ['organizationId'] }),
  ]);
  const ids = new Set<string>();
  for (const rows of [withYoutube, withTiktok, withWordpress, withWebsite, withMission]) {
    for (const r of rows) ids.add(r.organizationId);
  }
  return [...ids];
}

export async function runDailyBriefSweep(db: Db = prisma): Promise<{ delivered: number }> {
  const orgIds = await orgsWorthBriefing(db);
  let delivered = 0;
  for (const organizationId of orgIds) {
    try {
      const brief = await buildDailyBrief(organizationId, db);
      await deliverDailyBrief(organizationId, brief, db);
      delivered += 1;
    } catch {
      // One org's failure must never stop the sweep for the rest.
    }
  }
  return { delivered };
}

export async function runWeeklyReviewSweep(db: Db = prisma): Promise<{ delivered: number }> {
  const orgIds = await orgsWorthBriefing(db);
  let delivered = 0;
  for (const organizationId of orgIds) {
    try {
      const review = await buildWeeklyReview(organizationId, db);
      await deliverWeeklyReview(organizationId, review, db);
      delivered += 1;
    } catch {
      // One org's failure must never stop the sweep for the rest.
    }
  }
  return { delivered };
}
