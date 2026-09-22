/**
 * The WordPress content-refresh engine (Phase 9, §15/§29). Identifies
 * synced WordPress content that may benefit from an update — deterministic,
 * evidence-based, never a fabricated traffic or ranking signal (hard rule
 * 1). Every factor here is either a real synced field (`WordPressContent
 * .modifiedAt`) or a real crawl finding (`CrawlPage.wordCount`, matched
 * `CrawlIssue` rows) — when the corresponding website has never been
 * crawled, or a piece of content has no matching crawled page, that factor
 * is honestly `0`/`null`, never guessed.
 */
import { type Db, type WordPressContentType, prisma } from '@growth-agent/db';
import { normalizeUrl, registrableDomain } from '../seo/url.js';
import { listWordPressContent } from './read.js';

export interface RefreshCandidate {
  wordPressContentId: string;
  wpId: number;
  type: WordPressContentType;
  title: string;
  link: string | null;
  ageDays: number | null;
  wordCount: number | null;
  issueCount: number;
  criticalIssueCount: number;
  score: number;
  evidence: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Documented, fixed weights — sum to 1. A model never chooses these. */
const WEIGHTS = { age: 0.25, issues: 0.45, thinContent: 0.3 } as const;
/** Age fully saturates the age factor at one year — an arbitrary but fixed,
 *  documented cutoff, not derived from the data itself. */
const AGE_SATURATION_DAYS = 365;
const THIN_CONTENT_WORDS = 300;
const SHORT_CONTENT_WORDS = 600;

function ageScore(ageDays: number | null): number {
  if (ageDays == null) return 0;
  return Math.min(1, ageDays / AGE_SATURATION_DAYS);
}
function issueScore(issueCount: number, criticalCount: number): number {
  return Math.min(1, (criticalCount * 2 + issueCount) / 10);
}
function thinContentScore(wordCount: number | null): number {
  if (wordCount == null) return 0;
  if (wordCount < THIN_CONTENT_WORDS) return 1;
  if (wordCount < SHORT_CONTENT_WORDS) return 0.5;
  return 0;
}

function confidenceFor(hasCrawlMatch: boolean, ageDays: number | null): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (hasCrawlMatch && ageDays != null) return 'HIGH';
  if (hasCrawlMatch || ageDays != null) return 'MEDIUM';
  return 'LOW';
}

/**
 * Find refresh candidates among an organization's synced WordPress content.
 * Cross-references the most recent completed crawl of the matching website
 * (by hostname) when one exists; content with no crawl match is still
 * scored on age alone, with that fact disclosed via `confidence`.
 */
export async function findRefreshCandidates(
  organizationId: string,
  opts: { siteId?: string; limit?: number } = {},
  db: Db = prisma,
): Promise<RefreshCandidate[]> {
  const content = await listWordPressContent(organizationId, { siteId: opts.siteId, limit: 200 }, db);
  if (content.length === 0) return [];

  const site = opts.siteId
    ? await db.wordPressSite.findFirst({ where: { id: opts.siteId, organizationId } })
    : await db.wordPressSite.findFirst({ where: { organizationId, status: { not: 'REVOKED' } } });

  let pageByUrl = new Map<string, { wordCount: number | null }>();
  let issuesByUrl = new Map<string, { total: number; critical: number }>();

  if (site) {
    const domain = registrableDomain(new URL(site.siteUrl).hostname);
    const website = await db.website.findFirst({ where: { organizationId, hostname: domain } });
    if (website) {
      const crawl = await db.crawl.findFirst({
        where: { organizationId, websiteId: website.id, status: 'COMPLETED' },
        orderBy: { finishedAt: 'desc' },
      });
      if (crawl) {
        const [pages, issues] = await Promise.all([
          db.crawlPage.findMany({
            where: { crawlId: crawl.id },
            select: { normalizedUrl: true, wordCount: true },
          }),
          db.crawlIssue.findMany({
            where: { crawlId: crawl.id },
            select: { normalizedUrl: true, severity: true },
          }),
        ]);
        pageByUrl = new Map(pages.map((p) => [p.normalizedUrl, { wordCount: p.wordCount }]));
        const acc = new Map<string, { total: number; critical: number }>();
        for (const issue of issues) {
          if (!issue.normalizedUrl) continue;
          const e = acc.get(issue.normalizedUrl) ?? { total: 0, critical: 0 };
          e.total++;
          if (issue.severity === 'CRITICAL') e.critical++;
          acc.set(issue.normalizedUrl, e);
        }
        issuesByUrl = acc;
      }
    }
  }

  const now = Date.now();
  const candidates: RefreshCandidate[] = content
    .filter((c) => c.status === 'publish')
    .map((c) => {
      let normalized: string | null = null;
      try {
        normalized = c.link ? normalizeUrl(c.link) : null;
      } catch {
        normalized = null;
      }
      const page = normalized ? pageByUrl.get(normalized) : undefined;
      const issues = normalized ? issuesByUrl.get(normalized) : undefined;
      const ageDays = c.modifiedAt ? Math.floor((now - c.modifiedAt.getTime()) / 86_400_000) : null;
      const wordCount = page?.wordCount ?? null;
      const issueCount = issues?.total ?? 0;
      const criticalIssueCount = issues?.critical ?? 0;

      const score =
        ageScore(ageDays) * WEIGHTS.age +
        issueScore(issueCount, criticalIssueCount) * WEIGHTS.issues +
        thinContentScore(wordCount) * WEIGHTS.thinContent;

      const evidence: string[] = [];
      if (ageDays != null) evidence.push(`Last modified ${ageDays} day(s) ago.`);
      if (issueCount > 0) {
        evidence.push(
          `${issueCount} SEO issue(s) found on this page in the latest crawl${criticalIssueCount > 0 ? ` (${criticalIssueCount} critical)` : ''}.`,
        );
      }
      if (wordCount != null && wordCount < SHORT_CONTENT_WORDS) {
        evidence.push(`${wordCount} words — below this deployment's ${SHORT_CONTENT_WORDS}-word freshness threshold.`);
      }
      if (evidence.length === 0) evidence.push('No age, SEO-issue, or word-count signal is available for this page yet.');

      return {
        wordPressContentId: c.id,
        wpId: c.wpId,
        type: c.type,
        title: c.title,
        link: c.link,
        ageDays,
        wordCount,
        issueCount,
        criticalIssueCount,
        score: Math.round(score * 100) / 100,
        evidence,
        confidence: confidenceFor(Boolean(page || issues), ageDays),
      };
    })
    .sort((a, b) => b.score - a.score);

  return candidates.slice(0, opts.limit ?? 20);
}
