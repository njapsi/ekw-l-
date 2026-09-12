/**
 * SEO orchestration entry points — the functions the web Server Actions and the
 * `seo-crawl` worker queue both call (ADR-0013 pattern: runs inline now, ready
 * to move to the queue).
 */
import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import { AppError } from '../errors.js';
import { type SeoAgentModel, type RunSeoAgentResult, runSeoAgent } from './agent.js';
import { type RunAuditSummaryResult, runCrawlAuditSummary } from './audit-summary.js';
import { type ControlSignal, type RunCrawlResult, runCrawl } from './crawler.js';
import { crawlingHalted } from './killswitch.js';
import { type PlanOptions, planCrawl } from './plan.js';
import { CrawlRequest } from './schemas.js';
import { assertSafeUrl } from './ssrf.js';
import { generateVerificationToken } from './verify.js';
import { normalizeUrl, parseUrl, registrableDomain } from './url.js';
import type { DnsLookupFn } from './ssrf.js';
import type { Transport } from './fetch.js';
import type { PageRenderer } from './render.js';

export interface AddWebsiteInput {
  organizationId: string;
  userId: string;
  url: string;
}

export async function addWebsite(
  input: AddWebsiteInput,
  deps: { db?: Db; lookup?: DnsLookupFn } = {},
): Promise<{ id: string; hostname: string; verificationToken: string }> {
  const db = deps.db ?? prisma;
  let parsed: URL;
  try {
    parsed = parseUrl(input.url.trim());
  } catch (e) {
    throw AppError.validation(`Invalid website URL: ${e instanceof Error ? e.message : 'bad URL'}`);
  }
  // Reject internal / private targets up front.
  try {
    await assertSafeUrl(parsed.toString(), { lookup: deps.lookup });
  } catch (e) {
    throw AppError.validation(
      `That URL cannot be added: ${e instanceof Error ? e.message : 'blocked target'}`,
    );
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const hostname = parsed.hostname.toLowerCase();

  const existing = await db.website.findFirst({
    where: { organizationId: input.organizationId, hostname },
  });
  if (existing) throw new AppError('already_exists', 'That website is already registered.');

  const site = await db.website.create({
    data: {
      organizationId: input.organizationId,
      url: origin,
      hostname,
      verificationToken: generateVerificationToken(),
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'seo.website.added',
      targetType: 'website',
      targetId: site.id,
      metadata: { hostname, registrableDomain: registrableDomain(hostname) },
    },
    db,
  );
  return { id: site.id, hostname, verificationToken: site.verificationToken };
}

export interface StartCrawlInput {
  organizationId: string;
  userId: string;
  websiteId: string;
  request?: CrawlRequest;
}

export interface CrawlRunDeps {
  db?: Db;
  lookup?: DnsLookupFn;
  transport?: Transport;
  renderer?: PageRenderer;
  planOptions?: PlanOptions;
  now?: () => number;
}

/** Plan + create the `Crawl` row + run it to completion. */
export async function startCrawl(
  input: StartCrawlInput,
  deps: CrawlRunDeps = {},
): Promise<{ crawlId: string; result: RunCrawlResult }> {
  const db = deps.db ?? prisma;
  if (crawlingHalted(input.organizationId)) {
    throw new AppError('rate_limited', 'Crawling is temporarily disabled by the operator.');
  }
  const site = await db.website.findFirst({
    where: { id: input.websiteId, organizationId: input.organizationId },
  });
  if (!site) throw AppError.notFound('Website');

  const request = CrawlRequest.parse(input.request ?? {});
  const plan = await planCrawl(
    { id: site.id, url: site.url, hostname: site.hostname, verified: site.verified },
    request,
    { ...deps.planOptions, fetchOptions: { lookup: deps.lookup, transport: deps.transport } },
  );

  const crawl = await db.crawl.create({
    data: {
      websiteId: site.id,
      organizationId: input.organizationId,
      requestedById: input.userId,
      status: 'QUEUED',
      renderMode: plan.config.renderMode,
      config: plan.config,
    },
  });

  // Cache robots.txt on the website row.
  if (plan.robots.body != null) {
    await db.website.update({
      where: { id: site.id },
      data: { robotsTxtCache: plan.robots.body, robotsFetchedAt: new Date() },
    });
  }

  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'seo.crawl.started',
      targetType: 'crawl',
      targetId: crawl.id,
      metadata: {
        maxPages: plan.config.maxPages,
        maxDepth: plan.config.maxDepth,
        renderMode: plan.config.renderMode,
        publicSampleOnly: plan.config.publicSampleOnly,
      },
    },
    db,
  );

  const checkControl = async (): Promise<ControlSignal> => {
    const row = await db.crawl.findUnique({
      where: { id: crawl.id },
      select: { cancelRequested: true, pauseRequested: true },
    });
    if (row?.cancelRequested) return 'cancel';
    if (row?.pauseRequested) return 'pause';
    return 'continue';
  };

  const result = await runCrawl(
    { id: crawl.id, organizationId: input.organizationId, websiteId: site.id },
    plan,
    {
      db,
      lookup: deps.lookup,
      transport: deps.transport,
      renderer: deps.renderer,
      now: deps.now,
      checkControl,
    },
  );

  await recordAudit(
    {
      organizationId: input.organizationId,
      action: 'seo.crawl.finished',
      actorType: 'SYSTEM',
      targetType: 'crawl',
      targetId: crawl.id,
      metadata: { status: result.status, pages: result.pagesCrawled, issues: result.issuesFound },
    },
    db,
  );

  const blocked = result.status === 'BLOCKED';
  await createNotification(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      kind: blocked ? 'seo.crawl.blocked' : 'seo.crawl.finished',
      level: blocked ? 'WARNING' : 'SUCCESS',
      title: blocked ? `Crawl blocked: ${site.hostname}` : `Crawl finished: ${site.hostname}`,
      body: blocked
        ? `The crawl of ${site.hostname} was refused by the target (robots.txt or bot protection). We did not attempt to evade it.`
        : `Crawled ${result.pagesCrawled} page(s) of ${site.hostname} and found ${result.issuesFound} issue(s).`,
      linkPath: `/app/seo/${site.id}/crawls/${crawl.id}`,
      dedupeKey: `crawl:${crawl.id}:done`,
      sourceType: 'crawl',
      sourceId: crawl.id,
    },
    db,
  );

  return { crawlId: crawl.id, result };
}

export async function requestCrawlPause(
  input: { organizationId: string; crawlId: string; userId: string },
  db: Db = prisma,
): Promise<void> {
  const crawl = await db.crawl.findFirst({
    where: { id: input.crawlId, organizationId: input.organizationId },
  });
  if (!crawl) throw AppError.notFound('Crawl');
  await db.crawl.update({ where: { id: crawl.id }, data: { pauseRequested: true } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'seo.crawl.pause_requested',
      targetType: 'crawl',
      targetId: crawl.id,
    },
    db,
  );
}

export async function requestCrawlCancel(
  input: { organizationId: string; crawlId: string; userId: string },
  db: Db = prisma,
): Promise<void> {
  const crawl = await db.crawl.findFirst({
    where: { id: input.crawlId, organizationId: input.organizationId },
  });
  if (!crawl) throw AppError.notFound('Crawl');
  await db.crawl.update({ where: { id: crawl.id }, data: { cancelRequested: true } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'seo.crawl.cancel_requested',
      targetType: 'crawl',
      targetId: crawl.id,
    },
    db,
  );
}

/**
 * Resume a PAUSED crawl. The in-memory frontier is not persisted (ADR-0018), so
 * a resume re-runs the crawl pass on the same `Crawl` row; pages are upserted so
 * previously-seen URLs are simply refreshed.
 */
export async function resumeCrawl(
  input: { organizationId: string; crawlId: string; userId: string },
  deps: CrawlRunDeps = {},
): Promise<RunCrawlResult> {
  const db = deps.db ?? prisma;
  const crawl = await db.crawl.findFirst({
    where: { id: input.crawlId, organizationId: input.organizationId },
    include: { website: true },
  });
  if (!crawl) throw AppError.notFound('Crawl');
  if (crawl.status !== 'PAUSED') throw AppError.validation('Only a paused crawl can be resumed.');

  const request = CrawlRequest.parse({});
  const site = crawl.website;
  const plan = await planCrawl(
    { id: site.id, url: site.url, hostname: site.hostname, verified: site.verified },
    { ...request, ...(crawl.config as object) },
    { ...deps.planOptions, fetchOptions: { lookup: deps.lookup, transport: deps.transport } },
  );
  await db.crawl.update({
    where: { id: crawl.id },
    data: { pauseRequested: false, status: 'RUNNING' },
  });

  const checkControl = async (): Promise<ControlSignal> => {
    const row = await db.crawl.findUnique({
      where: { id: crawl.id },
      select: { cancelRequested: true, pauseRequested: true },
    });
    if (row?.cancelRequested) return 'cancel';
    if (row?.pauseRequested) return 'pause';
    return 'continue';
  };

  return runCrawl(
    { id: crawl.id, organizationId: input.organizationId, websiteId: site.id },
    plan,
    {
      db,
      lookup: deps.lookup,
      transport: deps.transport,
      renderer: deps.renderer,
      now: deps.now,
      checkControl,
    },
  );
}

/** Run the SEO Auditor Agent for a completed crawl. */
export async function runSeoAuditSummaryJob(
  input: { organizationId: string; crawlId: string; trigger?: string },
  db: Db = prisma,
): Promise<RunAuditSummaryResult> {
  const registry = createRegistryFromEnv();
  let model;
  try {
    model = registry.getForRole('analyst').provider;
  } catch {
    throw new AppError(
      'provider_unavailable',
      'No AI provider is configured. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) to run the auditor.',
    );
  }
  return runCrawlAuditSummary({ db, model }, input);
}

/**
 * Run the AI SEO Agent over an existing crawl (reasons over stored data via the
 * restricted read-only tools; never crawls). The model is optional — without an
 * AI provider the agent still produces the full deterministic report + ranked
 * recommendations + action plans + machine-readability analysis.
 */
export async function runSeoAgentJob(
  input: {
    organizationId: string;
    crawlId?: string;
    websiteId?: string;
    question?: string;
    goals?: string[];
    trigger?: string;
  },
  db: Db = prisma,
): Promise<RunSeoAgentResult> {
  const registry = createRegistryFromEnv();
  let model: SeoAgentModel | undefined;
  try {
    model = registry.getForRole('analyst').provider;
  } catch {
    model = undefined; // deterministic-only run
  }
  return runSeoAgent({ db, model }, input);
}

/** Convenience: normalize a URL the way the crawler stores it (for links in UI). */
export function normalizeForDisplay(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}
