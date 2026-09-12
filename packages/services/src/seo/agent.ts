/**
 * The AI SEO Agent (master instruction "PHASE 6 — AI SEO AGENT").
 *
 * It does NOT crawl. It gathers evidence exclusively through the restricted,
 * read-only `seo.*` tools (`agent-tools.ts`) — each call is logged on the
 * `AgentRun` — then:
 *   - ranks recommendations deterministically (`recommendation-engine.ts`)
 *   - builds the four action plans
 *   - runs the machine-readability analysis (`ai-readability.ts`)
 *   - optionally answers a free-form question and refines the prose with the
 *     model, always grounded against a deterministic fact sheet; if the model's
 *     wording cannot be grounded it is dropped and deterministic templates are
 *     used (the numbers are unaffected)
 *
 * Nothing here modifies a production website, and nothing predicts or promises
 * search rankings.
 */
import type { AIProvider } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import {
  checkGroundingFields,
  type GroundingField,
  type GroundingIssue,
} from '../agents/grounding.js';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import {
  type Correlation,
  bindGscAgentTools,
  correlate,
  describeGscAgentTools,
  getPerformanceForAgent,
} from '../searchconsole/index.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import {
  type SeoAgentToolContext,
  type SeoToolCallRecord,
  bindSeoAgentTools,
  describeSeoAgentTools,
} from './agent-tools.js';
import { SeoAgentModelOutput } from './agent-schema.js';
import {
  analyzeAiReadability,
  type AiReadabilityReport,
  type ReadabilityPage,
} from './ai-readability.js';
import {
  type EngineIssue,
  type RankedRecommendation,
  rankRecommendations,
} from './recommendation-engine.js';
import type { CrawlScore } from './scoring.js';

const log = createLogger('seo.agent');

export type SeoAgentModel = Pick<AIProvider, 'generateObject'>;

export interface RunSeoAgentDeps {
  db?: Db;
  model?: SeoAgentModel;
}

export interface RunSeoAgentOptions {
  organizationId: string;
  /** One of crawlId / websiteId is required. */
  crawlId?: string;
  websiteId?: string;
  /** A free-form question for the agent to answer from the crawl data. */
  question?: string;
  /** The user's goals, used to nudge business-importance in the ranking. */
  goals?: string[];
  trigger?: string;
}

export interface SeoAgentReport {
  generatedAt: string;
  organizationId: string;
  websiteId: string;
  crawlId: string;
  hostname: string;
  dataCoverage: string;
  overview: {
    overallScore: number | null;
    grade: string | null;
    pagesCrawled: number;
    totalIssues: number;
    bySeverity: Record<string, number>;
    categoryScores: Array<{ category: string; score: number }>;
  };
  question: { text: string; answer: string; grounded: boolean } | null;
  executiveSummary: string;
  /**
   * Search Console evidence combined with the crawl. `connected: false` when no
   * verified+selected GSC property matches this site. Every metric here is
   * Google's own reported figure from a stored snapshot — never synthesised.
   */
  searchConsole: SeoAgentSearchConsoleBlock;
  recommendations: RankedRecommendation[];
  actionPlans: {
    quickWins: RankedRecommendation[];
    highImpact: RankedRecommendation[];
    technicalProjects: RankedRecommendation[];
    longTerm: RankedRecommendation[];
  };
  priorityModel: ReturnType<typeof rankRecommendations>['priorityModel'];
  aiReadability: AiReadabilityReport;
  toolCalls: SeoToolCallRecord[];
  toolCatalogue: ReturnType<typeof describeSeoAgentTools>;
  narrativeSource: 'model' | 'deterministic';
  disclaimers: string[];
}

export interface SeoAgentSearchConsoleBlock {
  connected: boolean;
  reason?: string;
  property?: { siteUrl: string; propertyType: string; permissionLevel: string };
  dataThrough?: string | null;
  /** ctr/position null when the window had zero impressions — nothing to average, and Google never reports a real 0. */
  totals?: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  pagesWithImpressions?: number;
  topQueries?: Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  topPages?: Array<{
    url: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  /** Deterministic crawler×GSC correlations, each with the three labelled fields. */
  correlations: Correlation[];
  /** Optional grounded model interpretation (labelled crawler/GSC/interpretation). */
  note?: string;
  disclaimers: string[];
}

export interface RunSeoAgentResult {
  agentRunId: string;
  report: SeoAgentReport;
  recommendationIds: string[];
  answer: string | null;
  grounded: boolean;
  usedModel: boolean;
}

const SYSTEM = `You are the AI SEO Agent for a growth tool. You reason over the results of a technical crawl that has ALREADY run. You never crawl a website yourself and you cannot change a website.

Rules you must follow exactly:
- Work ONLY from the FACT SHEET and the DATA BUNDLE provided. Do not use outside knowledge about this site.
- Every free-text claim you make MUST cite evidenceFactIds that appear in the FACT SHEET.
- Do NOT state any number that is not in the FACT SHEET (small counts, years and 0-100 scores are fine).
- The DATA BUNDLE has TWO evidence sources. When you write the searchConsoleNote, label every sentence as "Crawler evidence:", "Search Console evidence:" or "AI interpretation:". Crawler evidence comes from our technical crawl; Search Console evidence is Google's own reported metric for a trailing window with a 2-3 day lag. Never state a Search Console number that is not in the FACT SHEET.
- NEVER promise, guarantee or predict search rankings, traffic or indexing outcomes. Speak only about crawl efficiency, machine readability and the relationship between the two data sources, and phrase effects as a likely direction.
- Distinguish established search-engine guidance from experimental AI-search guidance where relevant.
- Be concrete and reference issue codes and affected-page counts.
- If a question was asked, answer it directly and briefly using the data; if the data cannot answer it, say so.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

interface FactSheet {
  lines: string[];
  factIds: Set<string>;
  numbers: number[];
}

function buildFactSheet(args: {
  hostname: string;
  scores: CrawlScore | null;
  pagesCrawled: number;
  bySeverity: Record<string, number>;
  totalIssues: number;
  recommendations: RankedRecommendation[];
  readability: AiReadabilityReport;
  architecture: Record<string, unknown>;
  sitemap: Record<string, unknown> | null;
  robots: Record<string, unknown>;
  schema: Record<string, unknown>;
  searchConsole: SeoAgentSearchConsoleBlock | null;
}): FactSheet {
  const lines: string[] = [];
  const factIds = new Set<string>();
  const numbers: number[] = [];
  const push = (id: string, label: string, value: string | number) => {
    factIds.add(id);
    lines.push(`- [${id}] ${label}: ${value}`);
    if (typeof value === 'number') numbers.push(value);
  };

  push('site_host', 'Website', args.hostname);
  push('pages_crawled', 'Pages crawled', args.pagesCrawled);
  push('issues_total', 'Total issues', args.totalIssues);
  if (args.scores) {
    push('score_overall', 'Overall score (0-100)', args.scores.overall);
    push('score_grade', 'Overall grade', args.scores.grade);
    for (const c of args.scores.categories)
      push(`score_${c.category}`, `Score: ${c.category}`, c.score);
  }
  for (const [sev, n] of Object.entries(args.bySeverity))
    push(`issues_${sev.toLowerCase()}`, `Issues at severity ${sev}`, n);

  args.recommendations.slice(0, 20).forEach((r) => {
    push(`rec_${r.code}_priority`, `Priority score for ${r.code}`, r.priorityScore);
    push(`rec_${r.code}_affected`, `Affected URLs for ${r.code}`, r.evidence.affectedUrlCount);
    push(`rec_${r.code}_plan`, `Action plan bucket for ${r.code}`, r.actionPlan);
    push(`rec_${r.code}_difficulty`, `Difficulty for ${r.code}`, r.difficulty);
  });

  push('airead_overall', 'AI-readability overall score', args.readability.overallScore);
  for (const s of args.readability.signals)
    push(`airead_${s.key}`, `AI-readability: ${s.label} (${s.guidance})`, s.score);

  for (const key of [
    'orphanPages',
    'redirectChains',
    'redirectLoops',
    'duplicateTitleGroups',
    'duplicateContentClusters',
    'indexablePages',
    'nonIndexablePages',
  ]) {
    const v = args.architecture[key];
    if (typeof v === 'number') push(`arch_${key}`, `Architecture: ${key}`, v);
  }
  if (args.sitemap) {
    for (const key of [
      'declared',
      'urls',
      'inSitemapNotCrawled',
      'crawledNotInSitemap',
      'nonIndexableInSitemap',
    ]) {
      const v = args.sitemap[key];
      if (typeof v === 'number') push(`sitemap_${key}`, `Sitemap: ${key}`, v);
    }
  }
  push('robots_present', 'robots.txt present', String(Boolean(args.robots.present)));
  push(
    'robots_fully_disallowed',
    'robots.txt fully disallows our crawler',
    String(Boolean(args.robots.fullyDisallowed)),
  );
  const schemaWithout = args.schema.indexablePagesWithoutStructuredData;
  if (typeof schemaWithout === 'number')
    push('schema_without', 'Indexable pages with no structured data', schemaWithout);
  push(
    'schema_entity_consistent',
    'Site-identity entity name is consistent',
    String(Boolean(args.schema.entityNameConsistent)),
  );

  const sc = args.searchConsole;
  if (sc?.connected && sc.totals) {
    push('gsc_connected', 'Search Console property connected', 'true');
    push('gsc_data_through', 'Search Console data through (date)', sc.dataThrough ?? 'unknown');
    push('gsc_total_clicks', 'Search Console total clicks (window)', sc.totals.clicks);
    push(
      'gsc_total_impressions',
      'Search Console total impressions (window)',
      sc.totals.impressions,
    );
    // null when the window had zero impressions — there is nothing to
    // average, and Google never reports a real position of 0. Omit the fact
    // rather than fabricate a 0 the model could cite as a measurement.
    if (sc.totals.ctr != null) {
      push(
        'gsc_avg_ctr_pct',
        'Search Console average CTR (%)',
        Math.round(sc.totals.ctr * 1000) / 10,
      );
    }
    if (sc.totals.position != null) {
      push(
        'gsc_avg_position',
        'Search Console average position',
        Math.round(sc.totals.position * 10) / 10,
      );
    }
    push(
      'gsc_pages_with_impressions',
      'Pages with Search Console impressions',
      sc.pagesWithImpressions ?? 0,
    );
    (sc.topQueries ?? []).slice(0, 5).forEach((q, i) => {
      push(
        `gsc_top_query_${i}`,
        `Search Console top query #${i + 1}`,
        `${q.query} (${q.impressions} impr, ${q.clicks} clicks)`,
      );
    });
    const c = sc.correlations;
    push(
      'gsc_corr_issue_on_impression_page',
      'Correlations: crawl issue on an impression-earning page',
      c.filter((x) => x.kind === 'crawl_issue_on_impression_page').length,
    );
    push(
      'gsc_corr_impressions_low_ctr',
      'Correlations: impressions but low CTR',
      c.filter((x) => x.kind === 'impressions_but_low_ctr').length,
    );
    push(
      'gsc_corr_sitemap_weak_links',
      'Correlations: sitemap page with weak internal linking',
      c.filter((x) => x.kind === 'sitemap_page_weak_internal_links').length,
    );
  } else {
    push('gsc_connected', 'Search Console property connected', 'false');
  }

  return { lines, factIds, numbers };
}

function minimalReport(
  opts: RunSeoAgentOptions,
  hostname: string,
  crawlId: string,
  reason: string,
): SeoAgentReport {
  return {
    generatedAt: new Date().toISOString(),
    organizationId: opts.organizationId,
    websiteId: '',
    crawlId,
    hostname,
    dataCoverage: reason,
    overview: {
      overallScore: null,
      grade: null,
      pagesCrawled: 0,
      totalIssues: 0,
      bySeverity: {},
      categoryScores: [],
    },
    question: opts.question ? { text: opts.question, answer: reason, grounded: true } : null,
    executiveSummary: reason,
    searchConsole: {
      connected: false,
      reason: 'Not evaluated — there is not enough crawl data to correlate.',
      correlations: [],
      disclaimers: [],
    },
    recommendations: [],
    actionPlans: { quickWins: [], highImpact: [], technicalProjects: [], longTerm: [] },
    priorityModel: rankRecommendations({ issues: [], pagesCrawled: 1 }).priorityModel,
    aiReadability: analyzeAiReadability({
      pages: [],
      schema: {
        typeHistogram: {},
        indexablePages: 0,
        indexablePagesWithoutStructuredData: 0,
        pagesWithParseErrorCount: 0,
        entityNameConsistent: true,
        organizationEntityNames: [],
      },
      architecture: {
        orphanPages: 0,
        redirectChains: 0,
        duplicateTitleGroups: 0,
        duplicateContentClusters: 0,
      },
      robots: { present: false, fullyDisallowed: false },
      sitemapDeclared: 0,
      issueCodes: [],
    }),
    toolCalls: [],
    toolCatalogue: describeSeoAgentTools(),
    narrativeSource: 'deterministic',
    disclaimers: [
      reason,
      'Run a fuller crawl for a complete analysis. This agent does not predict or promise search rankings.',
    ],
  };
}

export async function runSeoAgent(
  deps: RunSeoAgentDeps,
  opts: RunSeoAgentOptions,
): Promise<RunSeoAgentResult> {
  const db = deps.db ?? prisma;
  if (!opts.crawlId && !opts.websiteId) {
    throw AppError.validation('Provide a crawlId or a websiteId for the SEO agent.');
  }
  const ctx: SeoAgentToolContext = { organizationId: opts.organizationId, db };
  const tools = bindSeoAgentTools(ctx);
  const toolCalls: SeoToolCallRecord[] = [];

  const callTool = async <T>(
    name: SeoToolCallRecord['tool'],
    fn: () => Promise<unknown>,
    input: Record<string, unknown>,
  ): Promise<T> => {
    try {
      const result = (await fn()) as T;
      toolCalls.push({ tool: name, input, ok: true });
      return result;
    } catch (e) {
      toolCalls.push({
        tool: name,
        input,
        ok: false,
        error: e instanceof Error ? e.message : 'error',
      });
      throw e;
    }
  };

  const ref = opts.crawlId ? { crawlId: opts.crawlId } : { websiteId: opts.websiteId };

  const crawlData = await callTool<{
    crawlId: string;
    websiteId: string;
    hostname: string;
    status: string;
    pagesCrawled: number;
    scores: CrawlScore | null;
    summary: (Record<string, unknown> & { byStatusClass?: Record<string, number> }) | null;
  }>('seo.get_crawl', () => tools.get_crawl(ref), ref);

  const run = await db.agentRun.create({
    data: {
      organizationId: opts.organizationId,
      agent: 'seo-agent',
      status: 'RUNNING',
      trigger: opts.trigger ?? 'manual',
      input: {
        crawlId: crawlData.crawlId,
        websiteId: crawlData.websiteId,
        question: opts.question ?? null,
        goals: opts.goals ?? [],
      },
      startedAt: new Date(),
    },
  });

  if (crawlData.status !== 'COMPLETED' || crawlData.pagesCrawled < 3) {
    const report = scrubModelOutput(
      minimalReport(
        opts,
        crawlData.hostname,
        crawlData.crawlId,
        crawlData.status !== 'COMPLETED'
          ? `The crawl is ${crawlData.status.toLowerCase()}, so there is nothing to analyse yet.`
          : `Only ${crawlData.pagesCrawled} page(s) were crawled — not enough for a full analysis.`,
      ),
    );
    report.websiteId = crawlData.websiteId;
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', output: report as never, finishedAt: new Date() },
    });
    return {
      agentRunId: run.id,
      report,
      recommendationIds: [],
      answer: report.question?.answer ?? null,
      grounded: true,
      usedModel: false,
    };
  }

  const crawlRef = { crawlId: crawlData.crawlId };
  const [issuesData, archData, sitemapData, robotsData, schemaData, thinLinks, pagesData] =
    await Promise.all([
      callTool<{ issues: EngineIssue[] }>(
        'seo.get_issues',
        () => tools.get_issues({ ...crawlRef, limit: 400 }),
        { ...crawlRef, limit: 400 },
      ),
      callTool<Record<string, unknown>>(
        'seo.get_site_architecture',
        () => tools.get_site_architecture(crawlRef),
        crawlRef,
      ),
      callTool<{ sitemap: Record<string, unknown> | null }>(
        'seo.get_sitemap',
        () => tools.get_sitemap(crawlRef),
        crawlRef,
      ),
      callTool<Record<string, unknown>>(
        'seo.get_robots',
        () => tools.get_robots(crawlRef),
        crawlRef,
      ),
      callTool<Record<string, unknown>>(
        'seo.get_schema',
        () => tools.get_schema(crawlRef),
        crawlRef,
      ),
      callTool<{ pages: Array<{ normalizedUrl: string }> }>(
        'seo.get_internal_links',
        () => tools.get_internal_links({ ...crawlRef, view: 'thin_pages', limit: 100 }),
        { ...crawlRef, view: 'thin_pages', limit: 100 },
      ),
      callTool<{
        pages: Array<{
          normalizedUrl: string;
          discoveredVia: string;
          indexable: boolean;
          httpStatus: number | null;
          title: string | null;
          titleLength: number | null;
          metaDescription: string | null;
          h1Count: number;
          wordCount: number | null;
          jsonLdTypes: string[];
          landmarkCount: number;
          hasMainLandmark: boolean;
          canonicalIsSelf: boolean | null;
          inboundInternalCount: number;
          internalLinkCount: number;
          csrLikely: boolean;
        }>;
      }>('seo.get_page', () => tools.get_page({ ...crawlRef, filter: 'all', limit: 200 }), {
        ...crawlRef,
        filter: 'all',
        limit: 200,
      }),
    ]);
  void thinLinks;

  const issues = issuesData.issues ?? [];
  const engine = rankRecommendations({
    issues,
    pagesCrawled: crawlData.pagesCrawled,
    goals: opts.goals,
  });

  const readabilityPages: ReadabilityPage[] = (pagesData.pages ?? []).map((p) => ({
    normalizedUrl: p.normalizedUrl,
    indexable: p.indexable,
    httpStatus: p.httpStatus,
    title: p.title,
    metaDescription: p.metaDescription,
    h1Count: p.h1Count,
    headingLevels: [], // per-page outline is not selected here; hierarchy uses h1 counts
    wordCount: p.wordCount,
    jsonLdTypes: p.jsonLdTypes ?? [],
    landmarkCount: p.landmarkCount ?? 0,
    hasMainLandmark: p.hasMainLandmark ?? false,
    canonicalIsSelf: p.canonicalIsSelf,
    inboundInternalCount: p.inboundInternalCount ?? 0,
    internalLinkCount: p.internalLinkCount ?? 0,
    csrLikely: p.csrLikely ?? false,
  }));

  const aiReadability = analyzeAiReadability({
    pages: readabilityPages,
    schema: {
      typeHistogram: (schemaData.typeHistogram as Record<string, number>) ?? {},
      indexablePages: (schemaData.indexablePages as number) ?? 0,
      indexablePagesWithoutStructuredData:
        (schemaData.indexablePagesWithoutStructuredData as number) ?? 0,
      pagesWithParseErrorCount: (schemaData.pagesWithParseErrorCount as number) ?? 0,
      entityNameConsistent: Boolean(schemaData.entityNameConsistent),
      organizationEntityNames:
        (schemaData.organizationEntityNames as Array<{ name: string; count: number }>) ?? [],
    },
    architecture: {
      orphanPages: (archData.orphanPages as number) ?? 0,
      redirectChains: (archData.redirectChains as number) ?? 0,
      duplicateTitleGroups: (archData.duplicateTitleGroups as number) ?? 0,
      duplicateContentClusters: (archData.duplicateContentClusters as number) ?? 0,
    },
    robots: {
      present: Boolean(robotsData.present),
      fullyDisallowed: Boolean(robotsData.fullyDisallowed),
    },
    sitemapDeclared: (sitemapData.sitemap as { declared?: number } | null)?.declared ?? 0,
    issueCodes: [...new Set(issues.map((i) => i.code))],
  });

  const bySeverity: Record<string, number> = {};
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;

  // --- Search Console evidence (crawler × GSC), when a property matches -----
  const searchConsoleBlock = await gatherSearchConsole({
    organizationId: opts.organizationId,
    db,
    hostname: crawlData.hostname,
    pages: pagesData.pages ?? [],
    issues,
    callTool,
  });

  const factSheet = buildFactSheet({
    hostname: crawlData.hostname,
    scores: crawlData.scores,
    pagesCrawled: crawlData.pagesCrawled,
    bySeverity,
    totalIssues: issues.length,
    recommendations: engine.recommendations,
    readability: aiReadability,
    architecture: archData,
    sitemap: sitemapData.sitemap ?? null,
    robots: robotsData,
    schema: schemaData,
    searchConsole: searchConsoleBlock,
  });

  // --- Optional model narrative + Q&A, grounded --------------------
  let executiveSummary = deterministicSummary(crawlData, engine.recommendations, aiReadability);
  let answer: string | null = opts.question
    ? deterministicAnswer(opts.question, engine, aiReadability, archData, robotsData)
    : null;
  let narrativeSource: 'model' | 'deterministic' = 'deterministic';
  let grounded = true;
  let usedModel = false;
  let usage: Awaited<ReturnType<SeoAgentModel['generateObject']>>['usage'] | null = null;
  const refinedNotes = new Map<string, string>();

  if (deps.model) {
    usedModel = true;
    const dataBundle = JSON.stringify(
      {
        topRecommendations: engine.recommendations.slice(0, 15).map((r) => ({
          code: r.code,
          category: r.category,
          priorityScore: r.priorityScore,
          actionPlan: r.actionPlan,
          affectedUrlCount: r.evidence.affectedUrlCount,
          difficulty: r.difficulty,
        })),
        aiReadabilitySignals: aiReadability.signals.map((s) => ({
          key: s.key,
          score: s.score,
          guidance: s.guidance,
        })),
        architecture: archData,
        sitemap: sitemapData.sitemap,
        robots: { present: robotsData.present, fullyDisallowed: robotsData.fullyDisallowed },
        searchConsole: searchConsoleBlock.connected
          ? {
              source: 'Google Search Console (official API, trailing window, ~2-3 day lag)',
              property: searchConsoleBlock.property,
              dataThrough: searchConsoleBlock.dataThrough,
              totals: searchConsoleBlock.totals,
              topQueries: searchConsoleBlock.topQueries,
              topPages: searchConsoleBlock.topPages,
              correlations: searchConsoleBlock.correlations,
            }
          : { connected: false, reason: searchConsoleBlock.reason },
      },
      null,
      1,
    ).slice(0, 12000);

    let prompt = `FACT SHEET (cite these ids):
${factSheet.lines.join('\n')}

DATA BUNDLE (already gathered via the restricted seo.* tools — do not ask for more):
${dataBundle}

${opts.question ? `${wrapUntrusted('USER_QUESTION', opts.question)}\n` : ''}${opts.goals?.length ? `${wrapUntrusted('USER_GOALS', opts.goals.join('; '))}\n` : ''}
Produce the structured output: a grounded executiveSummary, short whyItMatters refinements for the highest-priority issue codes, an aiReadabilityNote, ${searchConsoleBlock.connected ? 'a searchConsoleNote that ties the crawler findings to the Search Console evidence (label every sentence "Crawler evidence:", "Search Console evidence:" or "AI interpretation:"), ' : ''}${opts.question ? 'a direct answer to the question, ' : ''}and disclaimers. Cite fact ids for every free-text field.`;

    let modelOut: SeoAgentModelOutput | null = null;
    let issuesFound: GroundingIssue[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await deps.model.generateObject({
        schema: SeoAgentModelOutput,
        system: SYSTEM,
        prompt,
      });
      usage = res.usage;
      modelOut = res.object;
      issuesFound = checkGroundingFields(
        flattenModelOutput(modelOut),
        factSheet.factIds,
        factSheet.numbers,
      );
      if (issuesFound.length === 0) break;
      log.warn(
        { agentRunId: run.id, attempt, issues: issuesFound },
        'seo agent narrative failed grounding; retrying',
      );
      prompt = `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these and resubmit:\n${issuesFound
        .map((i) => `- ${i.path}: ${i.problem}`)
        .join(
          '\n',
        )}\nCite only fact ids from the FACT SHEET, state no numbers not in it, and make no ranking guarantees.`;
    }

    if (modelOut && issuesFound.length === 0) {
      narrativeSource = 'model';
      executiveSummary = modelOut.executiveSummary;
      if (modelOut.answer.trim()) answer = modelOut.answer.trim();
      for (const n of modelOut.recommendationNotes) refinedNotes.set(n.code, n.whyItMatters);
      if (modelOut.aiReadabilityNote.trim())
        aiReadability.notes.unshift(modelOut.aiReadabilityNote.trim());
      if (searchConsoleBlock.connected && modelOut.searchConsoleNote.trim())
        searchConsoleBlock.note = modelOut.searchConsoleNote.trim();
    } else {
      // Grounding could not be satisfied — keep the deterministic wording. The
      // numbers are all deterministic, so nothing unsafe ships.
      grounded = false;
      log.warn(
        { agentRunId: run.id },
        'seo agent narrative dropped; using deterministic templates',
      );
    }
  }

  const recommendations = engine.recommendations.map((r) => {
    const note = refinedNotes.get(r.code);
    return note ? { ...r, whyItMatters: note } : r;
  });
  const actionPlans = {
    quickWins: recommendations.filter((r) => r.actionPlan === 'quick_win'),
    highImpact: recommendations.filter((r) => r.actionPlan === 'high_impact'),
    technicalProjects: recommendations.filter((r) => r.actionPlan === 'technical_project'),
    longTerm: recommendations.filter((r) => r.actionPlan === 'long_term'),
  };

  // Scrub before anything is persisted or returned (docs/AI-SECURITY-AUDIT.md
  // finding 2) — defense-in-depth against a secret-shaped string reaching a
  // user, whether from the model's free-text narrative or the deterministic
  // templates.
  const report: SeoAgentReport = scrubModelOutput({
    generatedAt: new Date().toISOString(),
    organizationId: opts.organizationId,
    websiteId: crawlData.websiteId,
    crawlId: crawlData.crawlId,
    hostname: crawlData.hostname,
    dataCoverage: `Analysed ${crawlData.pagesCrawled} crawled pages and ${issues.length} issues from crawl ${crawlData.crawlId}. No new crawling was performed.`,
    overview: {
      overallScore: crawlData.scores?.overall ?? null,
      grade: crawlData.scores?.grade ?? null,
      pagesCrawled: crawlData.pagesCrawled,
      totalIssues: issues.length,
      bySeverity,
      categoryScores: (crawlData.scores?.categories ?? []).map((c) => ({
        category: c.category,
        score: c.score,
      })),
    },
    question: opts.question ? { text: opts.question, answer: answer ?? '', grounded } : null,
    executiveSummary,
    searchConsole: searchConsoleBlock,
    recommendations,
    actionPlans,
    priorityModel: engine.priorityModel,
    aiReadability,
    toolCalls,
    toolCatalogue: [...describeSeoAgentTools(), ...describeGscAgentTools()],
    narrativeSource,
    disclaimers: [
      'Recommendations describe crawl-efficiency and machine-readability impact. They are not a prediction or guarantee of search rankings or traffic.',
      'The agent reasoned over stored crawl data only; it did not crawl the site and cannot modify it.',
      ...(searchConsoleBlock.connected
        ? [
            'Search Console figures are Google’s own reported metrics for a trailing window with a 2–3 day lag; they are shown as evidence, not as a target.',
          ]
        : []),
    ],
  });

  // Persist recommendations from the scrubbed report so the DB and the
  // returned/persisted AgentRun output never diverge.
  const recommendationIds: string[] = [];
  for (const r of report.recommendations) {
    const row = await db.recommendation.create({
      data: {
        organizationId: opts.organizationId,
        domain: 'SEO',
        sourceAgentRunId: run.id,
        subjectRef: crawlData.websiteId,
        title: r.title,
        explanation: r.whyItMatters,
        reasoning: r.evidence.detail,
        priority: r.priority,
        effort: r.difficulty,
        confidence: r.confidence,
        expectedImpact: r.expectedBenefit,
        recommendedActions: [r.howToFix],
        implementationInstructions: r.howToFix,
        evidence: {
          code: r.code,
          category: r.category,
          factors: r.factors,
          affectedUrlSample: r.affectedPages,
          affectedUrlCount: r.evidence.affectedUrlCount,
          auditorEvidence: r.evidence.auditorEvidence,
        } as never,
        priorityScore: r.priorityScore,
        actionPlan: r.actionPlan,
        affectedUrlCount: r.evidence.affectedUrlCount,
        businessImportance: r.businessImportanceLabel,
      },
    });
    recommendationIds.push(row.id);
  }

  await db.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      output: report as never,
      finishedAt: new Date(),
      tokensPrompt: usage?.promptTokens ?? 0,
      tokensCompletion: usage?.completionTokens ?? 0,
      costUsd: usage?.estimatedCostUsd ?? 0,
      model: usage?.model,
      provider: usage?.provider,
    },
  });
  await recordAudit(
    {
      organizationId: opts.organizationId,
      action: 'seo.agent.completed',
      actorType: 'AGENT',
      targetType: 'agent_run',
      targetId: run.id,
      metadata: {
        crawlId: crawlData.crawlId,
        recommendations: recommendationIds.length,
        toolCalls: toolCalls.length,
        narrativeSource,
        grounded,
      },
    },
    db,
  );

  return { agentRunId: run.id, report, recommendationIds, answer, grounded, usedModel };
}

// --- deterministic fallbacks -------------------------------------

function deterministicSummary(
  crawl: { pagesCrawled: number; scores: CrawlScore | null },
  recs: RankedRecommendation[],
  readability: AiReadabilityReport,
): string {
  const top = recs
    .slice(0, 3)
    .map((r) => r.code)
    .join(', ');
  const score = crawl.scores
    ? `overall score ${crawl.scores.overall}/100 (grade ${crawl.scores.grade})`
    : 'no overall score';
  return `Across ${crawl.pagesCrawled} crawled pages the site has ${score}. The highest-priority issues are ${top || 'none'}. Machine-readability scores ${readability.overallScore}/100. These are crawl-efficiency and machine-readability observations, not ranking predictions.`;
}

function deterministicAnswer(
  question: string,
  engine: ReturnType<typeof rankRecommendations>,
  readability: AiReadabilityReport,
  arch: Record<string, unknown>,
  robots: Record<string, unknown>,
): string {
  const q = question.toLowerCase();
  const orphanCount = typeof arch.orphanPages === 'number' ? arch.orphanPages : 0;
  const codes = (...cs: string[]) => engine.recommendations.filter((r) => cs.includes(r.code));
  const list = (recs: RankedRecommendation[]) =>
    recs.length
      ? recs
          .map(
            (r) => `${r.code} (${r.evidence.affectedUrlCount} URL(s), priority ${r.priorityScore})`,
          )
          .join('; ')
      : 'none found in this crawl';

  if (/block|blocked|robots/.test(q)) {
    const blocked = robots.fullyDisallowed
      ? 'robots.txt disallows all crawling for our user-agent. '
      : '';
    return `${blocked}Blocking-related findings: ${list(codes('ROBOTS_FULL_DISALLOW', 'ROBOTS_BLOCKS_IMPORTANT_PATH', 'NOINDEX_ON_LINKED_PAGE'))}.`;
  }
  if (/index|indexab|finding|discover|not found|not being found/.test(q)) {
    return `Indexability-related findings: ${list(codes('NOINDEX_ON_LINKED_PAGE', 'ROBOTS_BLOCKS_IMPORTANT_PATH', 'CANONICAL_CONFLICT', 'SERVER_ERROR', 'BROKEN_INTERNAL_LINK', 'ORPHAN_PAGE'))}. Orphan pages: ${orphanCount}.`;
  }
  if (/canonical/.test(q)) {
    return `Canonical findings: ${list(codes('CANONICAL_CONFLICT', 'DUPLICATE_URL_VARIANTS'))}.`;
  }
  if (/orphan/.test(q)) {
    return `The crawl found ${orphanCount} orphan page(s). ${list(codes('ORPHAN_PAGE', 'THIN_INTERNAL_LINKING'))}.`;
  }
  if (/internal link|linking|should receive/.test(q)) {
    return `Internal-linking findings: ${list(codes('ORPHAN_PAGE', 'THIN_INTERNAL_LINKING', 'EXCESSIVE_CRAWL_DEPTH'))}. Internal-links readability signal scores ${readability.signals.find((s) => s.key === 'internal_links')?.score ?? 'n/a'}/100.`;
  }
  if (/sitemap/.test(q)) {
    return `Sitemap findings: ${list(codes('SITEMAP_NONINDEXABLE_URL', 'SITEMAP_COVERAGE_GAP', 'SITEMAP_INVALID_XML'))}.`;
  }
  if (/structured data|schema|json-?ld/.test(q)) {
    return `Structured-data findings: ${list(codes('NO_STRUCTURED_DATA', 'INVALID_JSONLD'))}. Structured-data readability signal scores ${readability.signals.find((s) => s.key === 'structured_data')?.score ?? 'n/a'}/100.`;
  }
  if (/ai agent|machine|machine understanding|machine readab|structure this website/.test(q)) {
    const weak = readability.signals
      .filter((s) => s.score < 70)
      .map((s) => `${s.label} (${s.score}/100, ${s.guidance})`);
    return `Machine-readability overall ${readability.overallScore}/100. Weakest signals: ${weak.join('; ') || 'none'}. See established vs experimental guidance in the report.`;
  }
  if (/fix first|priorit|which.*problems/.test(q)) {
    return `Highest-priority issues: ${
      engine.recommendations
        .slice(0, 5)
        .map((r) => `${r.code} (priority ${r.priorityScore}, ${r.actionPlan})`)
        .join('; ') || 'none'
    }.`;
  }
  return `The crawl produced ${engine.recommendations.length} ranked recommendation(s). Top: ${
    engine.recommendations
      .slice(0, 3)
      .map((r) => r.code)
      .join(', ') || 'none'
  }. See the action plans for the full breakdown.`;
}

function flattenModelOutput(o: SeoAgentModelOutput): GroundingField[] {
  const fields: GroundingField[] = [
    {
      path: 'executiveSummary',
      text: o.executiveSummary,
      factIds: o.executiveSummaryEvidenceFactIds,
    },
  ];
  if (o.answer.trim())
    fields.push({ path: 'answer', text: o.answer, factIds: o.answerEvidenceFactIds });
  if (o.aiReadabilityNote.trim())
    fields.push({
      path: 'aiReadabilityNote',
      text: o.aiReadabilityNote,
      factIds: o.aiReadabilityEvidenceFactIds,
    });
  if (o.searchConsoleNote.trim())
    fields.push({
      path: 'searchConsoleNote',
      text: o.searchConsoleNote,
      factIds: o.searchConsoleEvidenceFactIds,
    });
  o.recommendationNotes.forEach((n, i) =>
    fields.push({
      path: `recommendationNotes[${i}]`,
      text: n.whyItMatters,
      factIds: n.evidenceFactIds,
    }),
  );
  o.disclaimers.forEach((d, i) => fields.push({ path: `disclaimers[${i}]`, text: d }));
  return fields;
}

// --- Search Console gathering + correlation ------------------------

interface GatherScInput {
  organizationId: string;
  db: Db;
  hostname: string;
  pages: Array<{
    normalizedUrl: string;
    title: string | null;
    titleLength: number | null;
    metaDescription: string | null;
    inboundInternalCount: number;
    indexable: boolean;
    httpStatus: number | null;
    discoveredVia?: string;
  }>;
  issues: EngineIssue[];
  callTool: <T>(
    name: string,
    fn: () => Promise<unknown>,
    input: Record<string, unknown>,
  ) => Promise<T>;
}

async function gatherSearchConsole(input: GatherScInput): Promise<SeoAgentSearchConsoleBlock> {
  const empty: SeoAgentSearchConsoleBlock = {
    connected: false,
    reason:
      'No verified Search Console property is connected and selected for this site. The analysis used crawler data only.',
    correlations: [],
    disclaimers: [],
  };

  let hit: Awaited<ReturnType<typeof getPerformanceForAgent>>;
  try {
    hit = await getPerformanceForAgent(input.organizationId, input.hostname, input.db);
  } catch (err) {
    return {
      ...empty,
      reason: `Search Console lookup failed: ${err instanceof Error ? err.message : 'error'}`,
    };
  }
  if (!hit) return empty;

  const tools = bindGscAgentTools({ organizationId: input.organizationId, db: input.db });
  // Record the reads on the AgentRun for auditability (same pattern as seo.*).
  await input
    .callTool('gsc.get_property', () => tools.get_property({ hostname: input.hostname }), {
      hostname: input.hostname,
    })
    .catch(() => undefined);
  await input
    .callTool('gsc.get_performance', () => tools.get_performance({ hostname: input.hostname }), {
      hostname: input.hostname,
    })
    .catch(() => undefined);

  const perf = hit.performance;
  const top = (rows: typeof perf.byQuery, key: 'query' | 'url') =>
    rows
      .slice()
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10)
      .map((r) => ({
        [key]: r.keys[0] ?? '',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })) as never;

  const sitemapUrls = input.pages
    .filter((p) => p.discoveredVia === 'sitemap')
    .map((p) => p.normalizedUrl);

  const { correlations, counts, pagesWithImpressions } = correlate({
    byPage: perf.byPage,
    pages: input.pages.map((p) => ({
      normalizedUrl: p.normalizedUrl,
      title: p.title,
      titleLength: p.titleLength ?? (p.title ? p.title.length : null),
      metaDescription: p.metaDescription,
      inboundInternalCount: p.inboundInternalCount,
      indexable: p.indexable,
      httpStatus: p.httpStatus,
    })),
    issues: input.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      normalizedUrl: i.normalizedUrl,
      title: i.title,
    })),
    sitemapUrls,
  });
  void counts;

  return {
    connected: true,
    property: {
      siteUrl: hit.property.siteUrl,
      propertyType: hit.property.propertyType,
      permissionLevel: hit.property.permissionLevel,
    },
    dataThrough: hit.dataThrough ? hit.dataThrough.toISOString().slice(0, 10) : null,
    totals: perf.totals,
    pagesWithImpressions,
    topQueries: top(perf.byQuery, 'query'),
    topPages: top(perf.byPage, 'url'),
    correlations,
    disclaimers: [
      'Search Console evidence and crawler evidence are distinct; each correlation names its source. The interpretation is ours, not Google’s.',
    ],
  };
}
