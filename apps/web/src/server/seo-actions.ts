'use server';

import { revalidatePath } from 'next/cache';
import { isAppError, security, seo, usage } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';
import { seoAuditorConfigured } from '@/lib/seo';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  /** For addWebsite: where to go next. */
  websiteId?: string;
  crawlId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function addWebsiteAction(url: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('integration:manage');
    const site = await seo.addWebsite({ organizationId: org.id, userId: user.id, url });
    revalidatePath('/app/seo');
    return {
      ok: true,
      message: `Added ${site.hostname}. Verify ownership to run a full crawl.`,
      websiteId: site.id,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function verifyWebsiteAction(websiteId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('integration:manage');
    const res = await seo.verifyWebsite({ organizationId: org.id, websiteId, userId: user.id });
    revalidatePath('/app/seo');
    revalidatePath(`/app/seo/${websiteId}`);
    return res.verified
      ? { ok: true, message: `Verified via ${res.method}.` }
      : { ok: false, error: res.detail };
  } catch (e) {
    return toError(e);
  }
}

export async function startCrawlAction(
  websiteId: string,
  request: {
    maxPages?: number;
    maxDepth?: number;
    renderMode?: 'STATIC' | 'AUTO' | 'HEADLESS';
  } = {},
): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('crawl:run');
    // Abuse throttle ahead of the monthly quota (SECURITY-AUDIT.md H-2).
    const rl = await security.checkRateLimit({
      key: `crawl-start:${org.id}`,
      limit: 10,
      windowSec: 600,
    });
    if (!rl.ok) {
      return { ok: false, error: 'Too many crawls started recently. Please wait a few minutes.' };
    }
    // Server-side limit enforcement — the browser is never trusted (ADR-0025).
    // CRAWLS is reservable; CRAWL_PAGES is a pre-flight "page budget exhausted"
    // gate (the exact page count is recorded after the crawl runs).
    await usage.enforceUsage({ organizationId: org.id, meter: 'CRAWLS', amount: 1 });
    await usage.enforceUsage({ organizationId: org.id, meter: 'CRAWL_PAGES', amount: 1 });
    const { crawlId, result } = await seo.startCrawl({
      organizationId: org.id,
      userId: user.id,
      websiteId,
      request,
    });
    await usage.recordUsage({
      organizationId: org.id,
      meter: 'CRAWLS',
      quantity: 1,
      idempotencyKey: `crawl:${crawlId}`,
      actorId: user.id,
      subjectType: 'crawl',
      subjectId: crawlId,
    });
    if (result.pagesCrawled > 0) {
      await usage.recordUsage({
        organizationId: org.id,
        meter: 'CRAWL_PAGES',
        quantity: result.pagesCrawled,
        idempotencyKey: `crawl_pages:${crawlId}`,
        actorId: user.id,
        subjectType: 'crawl',
        subjectId: crawlId,
      });
    }
    revalidatePath(`/app/seo/${websiteId}`);
    revalidatePath(`/app/seo/${websiteId}/crawls/${crawlId}`);
    const detail =
      result.status === 'BLOCKED'
        ? 'The target blocked crawling (robots.txt or kill switch). Nothing was evaded.'
        : `${result.status.toLowerCase()} — ${result.pagesCrawled} page(s), ${result.issuesFound} issue(s)` +
          (result.overallScore != null ? `, score ${result.overallScore}/100` : '');
    return { ok: true, message: `Crawl ${detail}.`, crawlId };
  } catch (e) {
    return toError(e);
  }
}

export async function pauseCrawlAction(crawlId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('crawl:run');
    await seo.requestCrawlPause({ organizationId: org.id, crawlId, userId: user.id });
    return { ok: true, message: 'Pause requested — the crawl will stop between pages.' };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelCrawlAction(crawlId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('crawl:run');
    await seo.requestCrawlCancel({ organizationId: org.id, crawlId, userId: user.id });
    return { ok: true, message: 'Cancellation requested.' };
  } catch (e) {
    return toError(e);
  }
}

export async function resumeCrawlAction(crawlId: string): Promise<ActionResult> {
  try {
    const { org, user } = await requirePermission('crawl:run');
    const result = await seo.resumeCrawl({ organizationId: org.id, crawlId, userId: user.id });
    return { ok: true, message: `Resumed — ${result.status.toLowerCase()}.` };
  } catch (e) {
    return toError(e);
  }
}

export async function runSeoAuditSummaryAction(crawlId: string): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('agent:run');
    if (!seoAuditorConfigured()) {
      return { ok: false, error: 'No AI provider configured. Set an API key to run the auditor.' };
    }
    const res = await seo.runSeoAuditSummaryJob({
      organizationId: org.id,
      crawlId,
      trigger: 'dashboard',
    });
    revalidatePath(`/app/seo`);
    return {
      ok: true,
      message: res.usedModel
        ? `Summary ready: ${res.recommendationIds.length} recommendation(s).`
        : 'Not enough crawl data yet — produced a minimal summary.',
    };
  } catch (e) {
    return toError(e);
  }
}

/**
 * Run the AI SEO Agent over a completed crawl. It reasons over stored crawl data
 * via restricted read-only tools — it does not crawl or change the website. Works
 * with or without an AI provider (deterministic engine + machine-readability
 * analysis either way; the model only refines wording and answers questions).
 */
export async function runSeoAgentAction(
  crawlId: string,
  input: { question?: string; goals?: string } = {},
): Promise<ActionResult & { answer?: string }> {
  try {
    const { org, user } = await requirePermission('agent:run');
    await usage.enforceAiUserLimit({ organizationId: org.id, userId: user.id, scope: 'seo-agent' });
    await usage.enforceAiBudget({ organizationId: org.id });
    const res = await seo.runSeoAgentJob({
      organizationId: org.id,
      crawlId,
      trigger: 'dashboard',
      question: input.question?.trim() || undefined,
      goals: input.goals
        ? input.goals
            .split(/[\n;]+/)
            .map((g) => g.trim())
            .filter(Boolean)
        : undefined,
    });
    revalidatePath('/app/seo', 'layout');
    const rc = res.report.recommendations.length;
    return {
      ok: true,
      answer: res.answer ?? undefined,
      message: res.answer
        ? res.answer
        : `Analysis ready: ${rc} ranked recommendation(s), machine-readability ${res.report.aiReadability.overallScore}/100.` +
          (res.usedModel && !res.grounded
            ? ' (Model wording could not be grounded and was replaced with templates; the numbers are unaffected.)'
            : ''),
    };
  } catch (e) {
    return toError(e);
  }
}
