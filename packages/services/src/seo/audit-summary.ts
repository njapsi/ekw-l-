/**
 * SEO Auditor Agent — turns a finished crawl into a grounded plain-language
 * summary + prioritized `Recommendation`s (docs/AI-ARCHITECTURE.md). The model
 * only ever sees a deterministic FACT SHEET built from the crawl's scores +
 * issue counts + the top issues; it must cite fact ids and may not invent
 * numbers or promise rankings. Reuses the shared grounding check.
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
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE } from '../security/untrusted.js';
import { CrawlAuditAnalysis } from './analyst-schema.js';
import type { CrawlScore } from './scoring.js';

const log = createLogger('seo.auditor');

export class SeoAuditGroundingError extends AppError {
  constructor(readonly issues: GroundingIssue[]) {
    super(
      'provider_unavailable',
      `The audit summary could not be grounded in the crawl data (${issues.length} issue(s)); it was discarded rather than shown.`,
    );
    this.name = 'SeoAuditGroundingError';
  }
}

export type AuditModel = Pick<AIProvider, 'generateObject'>;

export interface RunAuditSummaryDeps {
  db?: Db;
  model: AuditModel;
}

export interface RunAuditSummaryOptions {
  organizationId: string;
  crawlId: string;
  trigger?: string;
}

export interface RunAuditSummaryResult {
  agentRunId: string;
  analysis: CrawlAuditAnalysis;
  recommendationIds: string[];
  grounded: boolean;
  usedModel: boolean;
}

interface Fact {
  id: string;
  label: string;
  value: string;
  numeric: number | null;
}

const SYSTEM = `You are the SEO Auditor Agent for a growth tool. You summarize ONE finished technical crawl of ONE website.

Rules you must follow exactly:
- Work ONLY from the FACT SHEET. Do not use outside knowledge about this site.
- Every observation and action MUST list evidenceFactIds that appear in the FACT SHEET.
- Do NOT state any number that is not in the FACT SHEET (small counts, years and 0-100 scores are fine).
- NEVER promise or guarantee search rankings, traffic, or indexing outcomes. Describe likely direction and machine-readability / crawl-efficiency impact only.
- If coverage is thin (few pages), say so in dataCoverage and produce fewer, higher-confidence actions.
- Be concrete: tie each action to the issue codes and page counts it addresses.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

function buildFactSheet(input: {
  websiteUrl: string;
  score: CrawlScore;
  pagesCrawled: number;
  issues: Array<{
    code: string;
    category: string;
    severity: string;
    affectedUrlCount: number;
    title: string;
  }>;
  summary: Record<string, unknown> | null;
}): { facts: Fact[]; factIds: Set<string>; numbers: number[] } {
  const facts: Fact[] = [];
  const push = (id: string, label: string, value: string | number) =>
    facts.push({
      id,
      label,
      value: String(value),
      numeric: typeof value === 'number' ? value : null,
    });

  push('site_url', 'Website', input.websiteUrl);
  push('pages_crawled', 'Pages crawled', input.pagesCrawled);
  push('score_overall', 'Overall score (0-100)', input.score.overall);
  push('score_grade', 'Overall grade', input.score.grade);
  for (const c of input.score.categories) {
    push(`score_${c.category}`, `Score: ${c.category}`, c.score);
    push(`issues_${c.category}`, `Issue count: ${c.category}`, c.issueCount);
  }

  const bySeverity = new Map<string, number>();
  for (const i of input.issues) bySeverity.set(i.severity, (bySeverity.get(i.severity) ?? 0) + 1);
  for (const [sev, n] of bySeverity)
    push(`issues_severity_${sev.toLowerCase()}`, `Issues at severity ${sev}`, n);
  push('issues_total', 'Total issues', input.issues.length);

  const topIssues = [...input.issues]
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        b.affectedUrlCount - a.affectedUrlCount,
    )
    .slice(0, 15);
  topIssues.forEach((i, idx) => {
    push(
      `issue_${idx}_${i.code}`,
      `Issue ${i.code} (${i.severity}, ${i.category})`,
      `${i.title} — affects ${i.affectedUrlCount} URL(s)`,
    );
    push(`issue_${idx}_${i.code}_count`, `${i.code} affected URLs`, i.affectedUrlCount);
  });

  if (input.summary) {
    for (const key of [
      'indexablePages',
      'nonIndexablePages',
      'orphanPages',
      'brokenInternalLinks',
      'redirectChains',
      'redirectLoops',
      'renderedPages',
    ]) {
      const v = input.summary[key];
      if (typeof v === 'number') push(`summary_${key}`, `Crawl summary: ${key}`, v);
    }
  }

  const factIds = new Set(facts.map((f) => f.id));
  const numbers = facts.map((f) => f.numeric).filter((n): n is number => n != null);
  return { facts, factIds, numbers };
}

function severityRank(s: string): number {
  return { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 }[s] ?? 0;
}

function flatten(a: CrawlAuditAnalysis): GroundingField[] {
  const fields: GroundingField[] = [
    { path: 'headline', text: a.headline },
    { path: 'overview', text: a.overview },
    { path: 'dataCoverage', text: a.dataCoverage },
  ];
  a.keyObservations.forEach((o, i) =>
    fields.push({ path: `keyObservations[${i}]`, text: o.text, factIds: o.evidenceFactIds }),
  );
  a.prioritizedActions.forEach((ac, i) => {
    fields.push({
      path: `prioritizedActions[${i}]`,
      text: `${ac.title} ${ac.rationale} ${ac.expectedImpact} ${ac.recommendedActions.join(' ')}`,
      factIds: ac.evidenceFactIds,
    });
  });
  a.disclaimers.forEach((d, i) => fields.push({ path: `disclaimers[${i}]`, text: d }));
  return fields;
}

function minimalReport(url: string, reason: string): CrawlAuditAnalysis {
  return CrawlAuditAnalysis.parse({
    headline: `Crawl of ${url}: limited data`,
    overview: reason,
    dataCoverage: reason,
    keyObservations: [],
    prioritizedActions: [],
    disclaimers: [
      reason,
      'Run a fuller crawl (more pages, verified ownership) for a complete audit. This tool does not predict or promise search rankings.',
    ],
  });
}

export async function runCrawlAuditSummary(
  deps: RunAuditSummaryDeps,
  opts: RunAuditSummaryOptions,
): Promise<RunAuditSummaryResult> {
  const db = deps.db ?? prisma;

  const crawl = await db.crawl.findFirst({
    where: { id: opts.crawlId, organizationId: opts.organizationId },
    include: { website: true },
  });
  if (!crawl) throw AppError.notFound('Crawl');
  if (crawl.status !== 'COMPLETED') {
    throw AppError.validation('The crawl has not completed, so there is nothing to summarize yet.');
  }

  const issues = await db.crawlIssue.findMany({
    where: { crawlId: crawl.id },
    select: { code: true, category: true, severity: true, affectedUrlCount: true, title: true },
  });

  const run = await db.agentRun.create({
    data: {
      organizationId: opts.organizationId,
      agent: 'seo-auditor',
      status: 'RUNNING',
      trigger: opts.trigger ?? 'manual',
      input: { crawlId: crawl.id, pages: crawl.pagesCrawled, issues: issues.length },
      startedAt: new Date(),
    },
  });

  const score = crawl.scores as unknown as CrawlScore | null;
  if (!score || crawl.pagesCrawled < 3) {
    const analysis = scrubModelOutput(
      minimalReport(
        crawl.website.url,
        `Only ${crawl.pagesCrawled} page(s) were crawled — not enough for a full audit summary.`,
      ),
    );
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', output: analysis as never, finishedAt: new Date() },
    });
    return {
      agentRunId: run.id,
      analysis,
      recommendationIds: [],
      grounded: true,
      usedModel: false,
    };
  }

  const sheet = buildFactSheet({
    websiteUrl: crawl.website.url,
    score,
    pagesCrawled: crawl.pagesCrawled,
    issues,
    summary: crawl.summary as Record<string, unknown> | null,
  });

  const factLines = sheet.facts.map((f) => `- [${f.id}] ${f.label}: ${f.value}`).join('\n');
  let prompt = `FACT SHEET for the crawl of ${crawl.website.url}:
${factLines}

Produce the structured audit summary. Cite fact ids for every observation and action. Focus the prioritized actions on the highest-severity, highest-scale issues.`;

  let analysis: CrawlAuditAnalysis | null = null;
  let groundingIssues: GroundingIssue[] = [];
  let usage: Awaited<ReturnType<AuditModel['generateObject']>>['usage'] | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await deps.model.generateObject({
      schema: CrawlAuditAnalysis,
      system: SYSTEM,
      prompt,
    });
    usage = res.usage;
    analysis = res.object;
    groundingIssues = checkGroundingFields(flatten(analysis), sheet.factIds, sheet.numbers);
    if (groundingIssues.length === 0) break;
    log.warn(
      { agentRunId: run.id, attempt, issues: groundingIssues },
      'audit summary failed grounding; retrying',
    );
    prompt = `${prompt}

YOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and resubmit:
${groundingIssues.map((i) => `- ${i.path}: ${i.problem}`).join('\n')}
Cite only fact ids from the FACT SHEET, state no numbers not in it, and make no ranking guarantees.`;
  }

  if (analysis && groundingIssues.length === 0) {
    analysis = scrubModelOutput(analysis);
  }

  if (!analysis || groundingIssues.length > 0) {
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        error: `grounding failed: ${groundingIssues.map((i) => `${i.path} ${i.problem}`).join('; ')}`,
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
        action: 'seo.auditor.rejected',
        actorType: 'AGENT',
        targetType: 'agent_run',
        targetId: run.id,
        metadata: { issues: groundingIssues.length },
      },
      db,
    );
    throw new SeoAuditGroundingError(groundingIssues);
  }

  const recommendationIds: string[] = [];
  for (const action of analysis.prioritizedActions) {
    const rec = await db.recommendation.create({
      data: {
        organizationId: opts.organizationId,
        domain: 'SEO',
        sourceAgentRunId: run.id,
        subjectRef: crawl.websiteId,
        title: action.title,
        explanation: action.rationale,
        reasoning: action.rationale,
        priority: action.priority,
        effort: action.effort,
        confidence: 0.7,
        expectedImpact: action.expectedImpact,
        recommendedActions: action.recommendedActions,
        implementationInstructions: action.recommendedActions.join('\n'),
        evidence: {
          factIds: action.evidenceFactIds,
          facts: action.evidenceFactIds
            .map((id) => sheet.facts.find((f) => f.id === id))
            .filter(Boolean)
            .map((f) => ({
              origin: 'crawl',
              reference: f!.id,
              statement: `${f!.label}: ${f!.value}`,
            })),
        } as never,
      },
    });
    recommendationIds.push(rec.id);
  }

  await db.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      output: analysis as never,
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
      action: 'seo.auditor.completed',
      actorType: 'AGENT',
      targetType: 'agent_run',
      targetId: run.id,
      metadata: { recommendations: recommendationIds.length },
    },
    db,
  );

  return { agentRunId: run.id, analysis, recommendationIds, grounded: true, usedModel: true };
}
