/**
 * SEO scoring (docs/SEO-ENGINE.md "SEO SCORE"). Deliberately NOT a single
 * opaque number: we compute a 0–100 score per category from the issues found
 * (severity-weighted deductions, scaled by how much of the site is affected),
 * then combine them into an overall score with a **transparent, published**
 * weighting. The weights and the per-severity penalties are returned alongside
 * the scores so the UI can show the maths.
 */
import type { IssueDraft } from './rules.js';
import { ISSUE_CATEGORIES, type IssueCategory, type IssueSeverity } from './schemas.js';

/** Points removed from a category's 100 per issue, before affected-scale scaling. */
export const SEVERITY_PENALTY: Record<IssueSeverity, number> = {
  CRITICAL: 40,
  HIGH: 15,
  MEDIUM: 6,
  LOW: 2,
  INFO: 0.5,
};

/** Overall-score weighting. Sums to 1. Published in the UI + docs. */
export const CATEGORY_WEIGHTS: Record<IssueCategory, number> = {
  indexability: 0.2,
  crawlability: 0.18,
  architecture: 0.12,
  internal_linking: 0.1,
  metadata: 0.12,
  structured_data: 0.08,
  performance: 0.1,
  security: 0.08,
  internationalization: 0.02,
};

export interface CategoryScore {
  category: IssueCategory;
  score: number;
  issueCount: number;
  weightedPenalty: number;
  bySeverity: Record<IssueSeverity, number>;
}

export interface CrawlScore {
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: CategoryScore[];
  weights: Record<IssueCategory, number>;
  severityPenalties: Record<IssueSeverity, number>;
  /** Pages considered when scaling penalties. */
  pagesAnalyzed: number;
  note: string;
}

function gradeFor(score: number): CrawlScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function scoreCrawl(issues: IssueDraft[], pagesAnalyzed: number): CrawlScore {
  const pages = Math.max(1, pagesAnalyzed);
  const categories: CategoryScore[] = ISSUE_CATEGORIES.map((category) => {
    const catIssues = issues.filter((i) => i.category === category);
    const bySeverity: Record<IssueSeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    };
    let penalty = 0;
    for (const issue of catIssues) {
      bySeverity[issue.severity]++;
      const base = SEVERITY_PENALTY[issue.severity];
      // Scale by how much of the site is affected: a site-wide issue hurts more
      // than a one-page issue, but with diminishing returns (sqrt).
      const affectedFraction = Math.min(1, issue.affectedUrlCount / pages);
      const scale = 0.4 + 0.6 * Math.sqrt(affectedFraction);
      penalty += base * scale * issue.confidence;
    }
    const score = Math.max(0, Math.round(100 - penalty));
    return {
      category,
      score,
      issueCount: catIssues.length,
      weightedPenalty: Math.round(penalty),
      bySeverity,
    };
  });

  const overall = Math.round(
    categories.reduce((sum, c) => sum + c.score * CATEGORY_WEIGHTS[c.category], 0),
  );

  return {
    overall,
    grade: gradeFor(overall),
    categories,
    weights: CATEGORY_WEIGHTS,
    severityPenalties: SEVERITY_PENALTY,
    pagesAnalyzed: pages,
    note: 'Scores are diagnostic, not a ranking prediction. Each category starts at 100 and loses points per issue, scaled by severity, confidence, and how much of the site is affected. The overall score is the published weighted average of the categories.',
  };
}
