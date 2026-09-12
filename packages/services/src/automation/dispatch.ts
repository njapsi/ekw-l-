/**
 * Maps an automation task type to the underlying job wrapper. Returns a compact
 * `output` summary that is stored on the `AutomationRun`. Nothing here performs
 * an external publish (ADR-0027).
 *
 * Bespoke logic:
 *   - SEO_ISSUE_ALERT   → checks the latest completed crawl; opens a `Task`
 *                         when a new critical/high issue is present.
 *   - CONTENT_OPPORTUNITY → runs one Growth Agent turn and opens a `Task` from
 *                           the top recommendation.
 */
import { type Db } from '@growth-agent/db';
import { createTask } from '../agent/tasks.js';
import { runGrowthAgentTurnJob } from '../agent/jobs.js';
import { runMonetizationScanJob } from '../monetization/jobs.js';
import { generateReportJob } from '../reports/jobs.js';
import { getPrimaryChannel } from '../youtube/read.js';
import { runYouTubeAnalystJob } from '../youtube/jobs.js';
import { getPrimaryAccount } from '../tiktok/read.js';
import { runTikTokAnalystJob } from '../tiktok/jobs.js';
import { listWebsites, getCrawlOverview } from '../seo/read.js';
import { startCrawl } from '../seo/jobs.js';
import { AppError } from '../errors.js';
import type { AutomationTaskTypeKey } from './schemas.js';

export interface DispatchContext {
  organizationId: string;
  /** The rule owner — every downstream job runs as this user. */
  ownerId: string;
  ruleId: string;
  runId: string;
  config: Record<string, unknown>;
}

export interface DispatchResult {
  summary: string;
  /** Anything worth showing in the run log; kept small. */
  detail?: Record<string, unknown>;
}

export async function dispatchTask(
  taskType: AutomationTaskTypeKey,
  ctx: DispatchContext,
  db: Db,
): Promise<DispatchResult> {
  switch (taskType) {
    case 'YOUTUBE_ANALYSIS':
      return runYouTubeAnalysis(ctx, db);
    case 'TIKTOK_ANALYSIS':
      return runTikTokAnalysis(ctx, db);
    case 'WEBSITE_CRAWL':
      return runWebsiteCrawl(ctx, db);
    case 'SEO_ISSUE_ALERT':
      return runSeoIssueAlert(ctx, db);
    case 'MONETIZATION_SCAN':
      return runMonetizationScanTask(ctx, db);
    case 'GROWTH_REPORT':
      return runGrowthReport(ctx, db);
    case 'CONTENT_OPPORTUNITY':
      return runContentOpportunity(ctx, db);
    default: {
      const _x: never = taskType;
      throw new Error(`unknown automation task type ${String(_x)}`);
    }
  }
}

// --- task implementations -------------------------------------------

async function runYouTubeAnalysis(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const channel = await getPrimaryChannel(ctx.organizationId, db);
  if (!channel) throw new AppError('validation_failed', 'No YouTube channel is connected.');
  const res = await runYouTubeAnalystJob(
    { organizationId: ctx.organizationId, channelId: channel.id, trigger: 'automation' },
    db,
  );
  return {
    summary: `Analysed YouTube channel "${channel.title}".`,
    detail: {
      agentRunId: (res as { agentRunId?: string }).agentRunId ?? null,
      channelId: channel.id,
    },
  };
}

async function runTikTokAnalysis(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const account = await getPrimaryAccount(ctx.organizationId, db);
  if (!account) throw new AppError('validation_failed', 'No TikTok account is connected.');
  const res = await runTikTokAnalystJob(
    { organizationId: ctx.organizationId, accountId: account.id, trigger: 'automation' },
    db,
  );
  return {
    summary: `Analysed TikTok account "${account.displayName ?? account.username ?? account.id}".`,
    detail: {
      agentRunId: (res as { agentRunId?: string }).agentRunId ?? null,
      accountId: account.id,
    },
  };
}

async function resolveWebsiteId(ctx: DispatchContext, db: Db): Promise<string> {
  const configured = typeof ctx.config.websiteId === 'string' ? ctx.config.websiteId : null;
  const sites = await listWebsites(ctx.organizationId, db);
  if (configured) {
    const hit = sites.find((s) => s.id === configured);
    if (!hit) throw new AppError('validation_failed', 'The configured website no longer exists.');
    return hit.id;
  }
  const verified = sites.find((s) => s.verified) ?? sites[0];
  if (!verified) throw new AppError('validation_failed', 'No website is registered.');
  return verified.id;
}

async function runWebsiteCrawl(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const websiteId = await resolveWebsiteId(ctx, db);
  const { crawlId, result } = await startCrawl(
    { organizationId: ctx.organizationId, userId: ctx.ownerId, websiteId },
    { db },
  );
  return {
    summary: `Crawl ${result.status.toLowerCase()} — ${result.pagesCrawled} page(s), ${result.issuesFound} issue(s).`,
    detail: { crawlId, status: result.status, pagesCrawled: result.pagesCrawled },
  };
}

async function runSeoIssueAlert(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const websiteId = await resolveWebsiteId(ctx, db);
  const severity: 'critical' | 'high' = ctx.config.severity === 'high' ? 'high' : 'critical';
  const minSeverity = severity === 'high' ? ['CRITICAL', 'HIGH'] : ['CRITICAL'];

  const latest = await db.crawl.findFirst({
    where: { organizationId: ctx.organizationId, websiteId, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
  });
  if (!latest) {
    return { summary: 'No completed crawl to check yet.', detail: { websiteId } };
  }
  const overview = await getCrawlOverview(ctx.organizationId, latest.id, db);
  const bySeverity = overview?.issues.bySeverity ?? {};
  const hits = minSeverity.reduce((n, s) => n + (bySeverity[s] ?? 0), 0);

  if (hits === 0) {
    return {
      summary: 'No critical SEO issues in the latest crawl.',
      detail: { crawlId: latest.id },
    };
  }

  // Only open a task when this crawl has not already produced one.
  const existing = await db.task.findFirst({
    where: {
      organizationId: ctx.organizationId,
      domain: 'SEO',
      affectedRefs: { has: `crawl:${latest.id}` },
    },
  });
  if (existing) {
    return {
      summary: `${hits} issue(s) present — a task was already opened for this crawl.`,
      detail: { crawlId: latest.id, taskId: existing.id },
    };
  }

  const topIssues = await db.crawlIssue.findMany({
    where: { crawlId: latest.id, severity: { in: minSeverity as never } },
    orderBy: [{ severity: 'asc' }, { affectedUrlCount: 'desc' }],
    take: 5,
  });
  const task = await createTask(
    {
      organizationId: ctx.organizationId,
      userId: ctx.ownerId,
      title: `SEO alert: ${hits} ${severity === 'high' ? 'critical/high' : 'critical'} issue(s) on ${overview?.crawl.website.hostname ?? 'your site'}`,
      description: `An automation found ${hits} issue(s) at or above "${severity}" in the latest crawl.`,
      instructions: topIssues
        .map((i, n) => `${n + 1}. [${i.severity}] ${i.code} — ${i.recommendedFix || i.detail}`)
        .join('\n'),
      priority: 'high',
      domain: 'SEO',
      affectedRefs: [`crawl:${latest.id}`, `website:${websiteId}`],
    },
    db,
  );
  return {
    summary: `Opened a task for ${hits} SEO issue(s).`,
    detail: { crawlId: latest.id, taskId: task.id, issueCount: hits },
  };
}

async function runMonetizationScanTask(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const res = await runMonetizationScanJob(
    { organizationId: ctx.organizationId, userId: ctx.ownerId, trigger: 'automation' },
    db,
  );
  const n = (res as { opportunities?: unknown[] }).opportunities?.length;
  return {
    summary: `Monetization scan complete${typeof n === 'number' ? ` — ${n} opportunit${n === 1 ? 'y' : 'ies'}` : ''}.`,
    detail: { agentRunId: (res as { agentRunId?: string }).agentRunId ?? null },
  };
}

async function runGrowthReport(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const reportType = typeof ctx.config.reportType === 'string' ? ctx.config.reportType : 'GROWTH';
  const websiteId = typeof ctx.config.websiteId === 'string' ? ctx.config.websiteId : undefined;
  const res = await generateReportJob(
    {
      organizationId: ctx.organizationId,
      userId: ctx.ownerId,
      type: reportType as never,
      params: websiteId ? { websiteId } : undefined,
    },
    db,
  );
  if (res.status === 'FAILED') {
    throw new AppError('internal_error', res.error ?? 'Report generation failed.', {
      expose: false,
    });
  }
  return {
    summary: `Generated a ${reportType} report.`,
    detail: { reportId: res.reportId },
  };
}

async function runContentOpportunity(ctx: DispatchContext, db: Db): Promise<DispatchResult> {
  const turn = await runGrowthAgentTurnJob(
    {
      organizationId: ctx.organizationId,
      userId: ctx.ownerId,
      message:
        'What is my single biggest content opportunity right now? Answer with one concrete recommendation.',
      trigger: 'automation',
    },
    db,
  );
  const rec = [...turn.blocks.recommendations].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  )[0];
  if (!rec) {
    return {
      summary: 'The agent did not surface a content opportunity this time.',
      detail: { agentRunId: turn.agentRunId },
    };
  }
  const task = await createTask(
    {
      organizationId: ctx.organizationId,
      userId: ctx.ownerId,
      title: `Content opportunity: ${rec.title}`,
      description: `${rec.problem}\n\nWhy it matters: ${rec.whyItMatters}\nExpected benefit: ${rec.expectedBenefit}`,
      instructions: rec.howToFix,
      priority: rec.priority,
      domain: rec.domain,
      affectedUrls: rec.affectedUrls,
      affectedRefs: rec.affectedRefs,
      sourceConversationId: turn.conversationId,
    },
    db,
  );
  return {
    summary: `Opened a task for the biggest content opportunity: "${rec.title}".`,
    detail: { agentRunId: turn.agentRunId, taskId: task.id, conversationId: turn.conversationId },
  };
}

function priorityRank(p: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p] ?? 4;
}
