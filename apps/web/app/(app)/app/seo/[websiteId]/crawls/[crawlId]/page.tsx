import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { seo } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@growth-agent/ui';
import { RunAuditSummaryButton } from '@/components/app/seo/seo-actions';
import { SeoAgentPanel } from '@/components/app/seo/seo-agent-panel';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { seoAuditorConfigured } from '@/lib/seo';

export const metadata: Metadata = { title: 'Crawl results — SEO' };

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const SEVERITY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  CRITICAL: 'destructive',
  HIGH: 'destructive',
  MEDIUM: 'secondary',
  LOW: 'outline',
  INFO: 'outline',
};

interface CategoryScore {
  category: string;
  score: number;
  issueCount: number;
}

export default async function CrawlResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; crawlId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { websiteId, crawlId } = await params;
  const { cursor } = await searchParams;
  const { org } = await requireActiveOrg();
  // None of these four reads depend on another's result — only on org.id /
  // crawlId / websiteId, all already resolved above — so they run
  // concurrently instead of one round-trip after another.
  const [overview, { issues, nextCursor, total: totalIssues }, auditorRun, agentReport] =
    await Promise.all([
      seo.getCrawlOverview(org.id, crawlId),
      seo.listCrawlIssues(org.id, crawlId, { limit: 100, cursor }),
      seo.latestAuditorRun(org.id),
      seo.latestSeoAgentReport(org.id, websiteId),
    ]);
  if (!overview || overview.crawl.website.id !== websiteId) notFound();

  const { crawl } = overview;
  const scores = crawl.scores;
  const categories: CategoryScore[] = scores?.categories ?? [];
  const agent = agentReport?.report as SeoAgentReportShape | null;
  const agentForThisCrawl = agent && agent.crawlId === crawlId ? agent : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Crawl of ${crawl.website.hostname}`}
        description={`${crawl.status.toLowerCase()} · ${relDate(crawl.createdAt)} · ${
          crawl.pagesCrawled
        } pages · ${crawl.issuesFound} issues`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/app/seo/${websiteId}`}>Back</Link>
          </Button>
        }
      />

      {crawl.status === 'BLOCKED' ? (
        <Alert variant="destructive">
          <AlertTitle>Crawl blocked</AlertTitle>
          <AlertDescription>
            {crawl.blockedReason ?? 'The target refused crawling.'} We did not attempt to evade it.
          </AlertDescription>
        </Alert>
      ) : null}

      {scores ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="text-base">
                Overall score <span className="text-2xl font-semibold">{scores.overall}</span>
                <span className="text-muted-foreground">/100 · grade {scores.grade}</span>
              </CardTitle>
            </div>
            <CardDescription>{scores.note}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-3">
              {categories.map((c) => (
                <div key={c.category} className="bg-muted/40 rounded-md p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm capitalize">{c.category.replace(/_/g, ' ')}</span>
                    <span className="font-semibold">{c.score}</span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {c.issueCount} issue(s) · weight{' '}
                    {Math.round(
                      (scores.weights[c.category as keyof typeof scores.weights] ?? 0) * 100,
                    )}
                    %
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Alert>
          <AlertTitle>No scores</AlertTitle>
          <AlertDescription>
            This crawl{' '}
            {crawl.status === 'COMPLETED'
              ? 'produced no scoreable pages'
              : `is ${crawl.status.toLowerCase()}`}
            .
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">AI summary</CardTitle>
            <RunAuditSummaryButton
              crawlId={crawlId}
              disabled={!seoAuditorConfigured() || crawl.status !== 'COMPLETED'}
            />
          </div>
          <CardDescription>
            A grounded plain-language read of this crawl. Every statement cites a crawl fact; the
            model may not invent numbers or predict rankings.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {auditorRun?.output ? (
            <AuditSummary output={auditorRun.output as Record<string, unknown>} />
          ) : (
            <p className="text-muted-foreground">
              {seoAuditorConfigured()
                ? 'No summary yet — generate one above.'
                : 'Set an AI provider key to enable the auditor.'}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI SEO Agent</CardTitle>
          <CardDescription>
            Reasons over this crawl’s data (issues, pages, link graph, sitemap, robots, structured
            data, architecture) to rank fixes, build action plans, answer questions and score
            machine readability. It never crawls or changes the site.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          <SeoAgentPanel crawlId={crawlId} canRun={crawl.status === 'COMPLETED'} />
          {agentForThisCrawl ? (
            <AgentReport report={agentForThisCrawl} generatedAt={agentReport?.createdAt ?? null} />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Issues ({totalIssues}){issues.length < totalIssues ? ` — showing ${issues.length}` : ''}
          </CardTitle>
          <CardDescription>
            Grouped by severity. Each issue has evidence and a recommended fix. Issues explain
            crawl-efficiency and machine-readability impact — not ranking outcomes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {issues.length === 0 ? (
            <p className="text-muted-foreground">No issues found in this crawl.</p>
          ) : (
            SEVERITY_ORDER.filter((s) => issues.some((i) => i.severity === s)).map((sev) => (
              <div key={sev} className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide">{sev}</h4>
                <ul className="divide-border divide-y">
                  {issues
                    .filter((i) => i.severity === sev)
                    .map((i) => (
                      <li key={i.id} className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={SEVERITY_VARIANT[i.severity]}>
                            {i.severity.toLowerCase()}
                          </Badge>
                          <span className="text-muted-foreground font-mono text-xs">{i.code}</span>
                          <span className="text-xs capitalize">
                            {i.category.replace(/_/g, ' ')}
                          </span>
                          {i.affectedUrlCount > 1 ? (
                            <span className="text-muted-foreground text-xs">
                              {i.affectedUrlCount} URLs
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 font-medium">{i.title}</p>
                        <p className="text-muted-foreground">{i.detail}</p>
                        {i.normalizedUrl ? (
                          <p className="text-muted-foreground truncate font-mono text-xs">
                            {i.normalizedUrl}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs">
                          <span className="font-medium">Fix:</span> {i.recommendedFix}{' '}
                          <span className="text-muted-foreground">
                            (confidence {Math.round(i.confidence * 100)}%)
                          </span>
                        </p>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {nextCursor ? (
        <Link
          href={`/app/seo/${websiteId}/crawls/${crawlId}?${new URLSearchParams({ cursor: nextCursor })}`}
          className="text-sm underline"
        >
          Load more issues
        </Link>
      ) : null}

      {crawl.summary ? <ArchitectureCard summary={crawl.summary} /> : null}
    </div>
  );
}

interface AgentRec {
  code: string;
  category: string;
  title: string;
  whyItMatters: string;
  howToFix: string;
  expectedBenefit: string;
  difficulty: string;
  confidence: number;
  priorityScore: number;
  actionPlan: string;
  affectedPages: string[];
  evidence: { affectedUrlCount: number };
}
interface AgentSignal {
  key: string;
  label: string;
  guidance: 'established' | 'experimental';
  score: number;
  findings: string[];
}
interface SeoAgentReportShape {
  crawlId: string;
  executiveSummary: string;
  narrativeSource: 'model' | 'deterministic';
  dataCoverage: string;
  question: { text: string; answer: string; grounded: boolean } | null;
  recommendations: AgentRec[];
  actionPlans: {
    quickWins: AgentRec[];
    highImpact: AgentRec[];
    technicalProjects: AgentRec[];
    longTerm: AgentRec[];
  };
  aiReadability: {
    overallScore: number;
    signals: AgentSignal[];
    establishedGuidance: string[];
    experimentalGuidance: string[];
    notes: string[];
  };
  toolCalls: Array<{ tool: string; ok: boolean }>;
  disclaimers: string[];
}

const PLAN_LABELS: Record<string, string> = {
  quickWins: 'Quick Wins',
  highImpact: 'High Impact',
  technicalProjects: 'Technical Projects',
  longTerm: 'Long-Term Improvements',
};

function AgentReport({
  report,
  generatedAt,
}: {
  report: SeoAgentReportShape;
  generatedAt: Date | null;
}) {
  return (
    <div className="space-y-5 border-t pt-4">
      <div>
        <p className="font-medium">{report.executiveSummary}</p>
        <p className="text-muted-foreground text-xs">
          {report.dataCoverage} · narrative: {report.narrativeSource} · {report.toolCalls.length}{' '}
          tool call(s){generatedAt ? ` · ${relDate(generatedAt)}` : ''}
        </p>
      </div>

      {report.question ? (
        <div className="bg-muted/40 rounded-md p-3">
          <p className="text-muted-foreground text-xs">Q: {report.question.text}</p>
          <p>{report.question.answer}</p>
        </div>
      ) : null}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Action plans</h3>
        {(['quickWins', 'highImpact', 'technicalProjects', 'longTerm'] as const).map((k) => {
          const recs = report.actionPlans[k];
          if (recs.length === 0) return null;
          return (
            <div key={k}>
              <p className="text-xs font-semibold uppercase tracking-wide">{PLAN_LABELS[k]}</p>
              <ul className="divide-border divide-y">
                {recs.map((r) => (
                  <li key={r.code} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">priority {r.priorityScore}</Badge>
                      <span className="text-muted-foreground font-mono text-xs">{r.code}</span>
                      <span className="text-xs">
                        {r.difficulty} effort · {r.evidence.affectedUrlCount} URL(s) · conf{' '}
                        {Math.round(r.confidence * 100)}%
                      </span>
                    </div>
                    <p className="mt-1 font-medium">{r.title}</p>
                    <p className="text-muted-foreground">
                      <span className="font-medium">Why it matters:</span> {r.whyItMatters}
                    </p>
                    <p className="text-xs">
                      <span className="font-medium">How to fix:</span> {r.howToFix}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">Expected benefit:</span> {r.expectedBenefit}
                    </p>
                    {r.affectedPages.length > 0 ? (
                      <p className="text-muted-foreground truncate font-mono text-xs">
                        {r.affectedPages.slice(0, 5).join(' · ')}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          Machine readability — {report.aiReadability.overallScore}/100
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {report.aiReadability.signals.map((s) => (
            <div key={s.key} className="bg-muted/40 rounded-md p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs">{s.label}</span>
                <span className="font-semibold">{s.score}</span>
              </div>
              <span className="text-muted-foreground text-[10px] uppercase">{s.guidance}</span>
            </div>
          ))}
        </div>
        {report.aiReadability.establishedGuidance.length > 0 ? (
          <div>
            <p className="text-xs font-semibold">Established search-engine guidance</p>
            <ul className="text-muted-foreground list-disc pl-5 text-xs">
              {report.aiReadability.establishedGuidance.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {report.aiReadability.experimentalGuidance.length > 0 ? (
          <div>
            <p className="text-xs font-semibold">Experimental AI-search guidance</p>
            <ul className="text-muted-foreground list-disc pl-5 text-xs">
              {report.aiReadability.experimentalGuidance.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <ul className="text-muted-foreground list-disc pl-5 text-xs">
        {report.disclaimers.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
    </div>
  );
}

function AuditSummary({ output }: { output: Record<string, unknown> }) {
  const headline = typeof output.headline === 'string' ? output.headline : null;
  const overview = typeof output.overview === 'string' ? output.overview : null;
  const actions = Array.isArray(output.prioritizedActions) ? output.prioritizedActions : [];
  const disclaimers = Array.isArray(output.disclaimers) ? output.disclaimers : [];
  return (
    <div className="space-y-3">
      {headline ? <p className="font-medium">{headline}</p> : null}
      {overview ? <p className="text-muted-foreground">{overview}</p> : null}
      {actions.length > 0 ? (
        <ol className="list-decimal space-y-2 pl-5">
          {actions.map((a: Record<string, unknown>, idx: number) => (
            <li key={idx}>
              <span className="font-medium">{String(a.title ?? '')}</span>{' '}
              <span className="text-muted-foreground text-xs">
                ({String(a.priority ?? '')} priority, {String(a.effort ?? '')} effort)
              </span>
              <p className="text-muted-foreground">{String(a.rationale ?? '')}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {disclaimers.length > 0 ? (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {disclaimers.map((d: unknown, i: number) => (
            <li key={i}>{String(d)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ArchitectureCard({ summary }: { summary: Record<string, unknown> }) {
  const rows: Array<[string, unknown]> = [
    ['Indexable pages', summary.indexablePages],
    ['Non-indexable pages', summary.nonIndexablePages],
    ['Orphan pages', summary.orphanPages],
    ['Broken internal links', summary.brokenInternalLinks],
    ['Redirect chains', summary.redirectChains],
    ['Redirect loops', summary.redirectLoops],
    ['Duplicate title groups', summary.duplicateTitleGroups],
    ['Near-duplicate content clusters', summary.duplicateContentClusters],
    ['Rendered pages', summary.renderedPages],
    ['Average response (ms)', summary.averageResponseMs],
  ];
  const depth = (summary.byDepth as Record<string, number> | undefined) ?? {};
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Site architecture</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
        <dl className="space-y-1">
          {rows.map(([k, v]) => (
            <div key={k} className="border-border/50 flex justify-between border-b py-1">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v == null ? '—' : String(v)}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-muted-foreground mb-1">Pages by crawl depth</p>
          <ul className="space-y-1">
            {Object.entries(depth)
              .sort(([a], [b]) =>
                a === 'unreachable' ? 1 : b === 'unreachable' ? -1 : Number(a) - Number(b),
              )
              .map(([d, n]) => (
                <li key={d} className="flex justify-between">
                  <span>depth {d}</span>
                  <span>{n}</span>
                </li>
              ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
