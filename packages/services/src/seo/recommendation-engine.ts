/**
 * Deterministic recommendation engine for the AI SEO Agent (master instruction
 * "RECOMMENDATION ENGINE" + "ACTION PLANS"). Given the crawl's issues (gathered
 * via the restricted `seo.get_issues` tool), it:
 *
 *   1. groups issues by stable `code`
 *   2. scores each group on six published factors — severity, reach (affected
 *      URLs), business importance, estimated impact, implementation difficulty,
 *      confidence — into a 0-100 `priorityScore`
 *   3. buckets the results into the four action plans (Quick Wins / High Impact
 *      / Technical Projects / Long-Term Improvements)
 *
 * All numbers here are deterministic. The model (if configured) only refines the
 * prose fields, and its output is grounded-checked before it is used.
 *
 * Nothing in this module predicts or promises search rankings.
 */
import type { IssueCategory, IssueSeverity } from './schemas.js';

export interface EngineIssue {
  code: string;
  category: string;
  severity: IssueSeverity;
  normalizedUrl: string | null;
  title: string;
  detail: string;
  recommendedFix: string;
  confidence: number;
  affectedUrlCount: number;
  evidence?: Record<string, unknown> | null;
}

export type Difficulty = 'trivial' | 'small' | 'medium' | 'large';
export type ActionPlan = 'quick_win' | 'high_impact' | 'technical_project' | 'long_term';

export interface PriorityFactors {
  severityScore: number;
  reachScore: number;
  businessImportance: number;
  estimatedImpact: number;
  easeScore: number;
  confidence: number;
}

export interface RankedRecommendation {
  code: string;
  category: string;
  title: string;
  /** "Problem" — what is wrong. */
  problem: string;
  /** "Evidence" — the auditor's evidence plus a sample of affected URLs. */
  evidence: {
    detail: string;
    auditorEvidence: Record<string, unknown> | null;
    affectedUrlSample: string[];
    affectedUrlCount: number;
  };
  /** "Why it matters" — crawl-efficiency / machine-readability impact. */
  whyItMatters: string;
  /** "How to fix it". */
  howToFix: string;
  /** "Affected pages". */
  affectedPages: string[];
  /** "Expected benefit" — phrased as a direction, never a ranking guarantee. */
  expectedBenefit: string;
  /** "Implementation difficulty". */
  difficulty: Difficulty;
  /** "Confidence" 0-1. */
  confidence: number;
  priorityScore: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  businessImportanceLabel: 'high' | 'medium' | 'low';
  factors: PriorityFactors;
  actionPlan: ActionPlan;
}

export interface ActionPlans {
  quickWins: RankedRecommendation[];
  highImpact: RankedRecommendation[];
  technicalProjects: RankedRecommendation[];
  longTerm: RankedRecommendation[];
}

export interface EngineResult {
  recommendations: RankedRecommendation[];
  actionPlans: ActionPlans;
  priorityModel: {
    weights: Record<keyof PriorityFactors, number>;
    severityScale: Record<IssueSeverity, number>;
    note: string;
  };
}

// --- factor weights (published) --------------------------------------

const WEIGHTS: Record<keyof PriorityFactors, number> = {
  severityScore: 0.3,
  reachScore: 0.22,
  businessImportance: 0.16,
  estimatedImpact: 0.18,
  easeScore: 0.08,
  confidence: 0.06,
};

const SEVERITY_SCALE: Record<IssueSeverity, number> = {
  CRITICAL: 1,
  HIGH: 0.75,
  MEDIUM: 0.45,
  LOW: 0.2,
  INFO: 0.05,
};

const DIFFICULTY_EASE: Record<Difficulty, number> = {
  trivial: 1,
  small: 0.8,
  medium: 0.5,
  large: 0.25,
};

const CATEGORY_IMPACT: Record<string, number> = {
  indexability: 1,
  crawlability: 0.95,
  architecture: 0.7,
  structured_data: 0.65,
  internal_linking: 0.55,
  metadata: 0.55,
  performance: 0.5,
  security: 0.5,
  internationalization: 0.4,
};

// --- per-code metadata --------------------------------------------

interface CodeMeta {
  difficulty: Difficulty;
  businessImportance: 'high' | 'medium' | 'low';
  why: string;
  benefit: string;
}

const BIZ_SCALE = { high: 1, medium: 0.6, low: 0.3 } as const;

const CODE_META: Record<string, CodeMeta> = {
  ROBOTS_FULL_DISALLOW: {
    difficulty: 'small',
    businessImportance: 'high',
    why: 'Search engines and AI crawlers that honour robots.txt will not fetch any page, so nothing on the site can be discovered or cited.',
    benefit: 'Allows compliant crawlers to reach the site at all.',
  },
  ROBOTS_BLOCKS_IMPORTANT_PATH: {
    difficulty: 'small',
    businessImportance: 'high',
    why: 'A path that appears in the sitemap or navigation is blocked from crawling, so those pages cannot be indexed or read by AI systems.',
    benefit: 'Makes the affected section crawlable again.',
  },
  SERVER_ERROR: {
    difficulty: 'medium',
    businessImportance: 'high',
    why: 'Repeated 5xx responses waste crawl budget and can cause crawlers to slow down or drop the whole site.',
    benefit: 'Restores reliable access so crawl budget is spent on real pages.',
  },
  BROKEN_INTERNAL_LINK: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Internal links to 4xx URLs send crawlers and users to dead ends and dilute the internal link graph.',
    benefit: 'Keeps crawl paths and user journeys intact.',
  },
  FETCH_FAILED: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Pages that time out or refuse the connection are never analysed and may not be indexed.',
    benefit: 'Lets the page be fetched and evaluated.',
  },
  REDIRECT_CHAIN: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Every extra redirect hop costs crawl budget and latency; some crawlers stop following after a few.',
    benefit: 'Reduces wasted requests and speeds up resolution to the final URL.',
  },
  REDIRECT_LOOP: {
    difficulty: 'small',
    businessImportance: 'high',
    why: 'A looping URL never resolves, so the destination content is unreachable.',
    benefit: 'Makes the destination reachable.',
  },
  NOINDEX_ON_LINKED_PAGE: {
    difficulty: 'trivial',
    businessImportance: 'high',
    why: 'A page that is prominently linked but marked noindex will not appear in search results or AI answers — often unintentional.',
    benefit: 'Restores eligibility for indexing if the exclusion was unintended.',
  },
  CANONICAL_CONFLICT: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Conflicting canonical signals (chains, error targets, noindex targets) leave crawlers to guess which URL is authoritative.',
    benefit: 'Gives crawlers one unambiguous canonical URL per page.',
  },
  EXCESSIVE_PARAMETERS: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Many parameter permutations of one page spread crawl budget thin and create near-duplicates.',
    benefit: 'Concentrates crawl budget on canonical, useful URLs.',
  },
  DUPLICATE_TITLE: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Identical titles across pages make it hard for crawlers and users to tell pages apart.',
    benefit: 'Each page gets a distinct, descriptive label.',
  },
  DUPLICATE_META_DESCRIPTION: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Duplicate descriptions provide no per-page signal and are usually ignored.',
    benefit: 'Gives each page a tailored snippet (or lets the engine generate one).',
  },
  DUPLICATE_CONTENT_CLUSTER: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Near-identical pages compete with each other and waste crawl budget.',
    benefit: 'Consolidates signals onto one primary URL.',
  },
  DUPLICATE_URL_VARIANTS: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Multiple URLs serving identical content split link equity and crawl attention.',
    benefit: 'One canonical URL carries the full signal.',
  },
  ORPHAN_PAGE: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'A page with no internal links is hard for crawlers to discover and signals low importance.',
    benefit: 'Makes the page discoverable through the link graph.',
  },
  THIN_INTERNAL_LINKING: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Pages with almost no inbound internal links are crawled infrequently and read as low priority.',
    benefit: 'Improves discovery frequency and topical context.',
  },
  EXCESSIVE_CRAWL_DEPTH: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Pages many clicks from the home page are crawled less often.',
    benefit: 'Brings important pages closer to the entry points.',
  },
  EXCESSIVE_URL_DEPTH: {
    difficulty: 'large',
    businessImportance: 'low',
    why: 'Deeply nested URL paths often signal a structure that is hard to reason about.',
    benefit: 'A flatter, more predictable structure is easier to model.',
  },
  MISSING_TITLE: {
    difficulty: 'small',
    businessImportance: 'high',
    why: 'The title is the primary label in search results and AI citations; without it the page is under-described.',
    benefit: 'Gives the page a clear, machine-readable label.',
  },
  TITLE_LENGTH: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'Very long titles are truncated; very short ones under-describe the page.',
    benefit: 'A well-sized title conveys the page topic fully.',
  },
  MISSING_META_DESCRIPTION: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Without a description the engine synthesises the snippet, which may not reflect the page well.',
    benefit: 'A tailored summary for result and preview surfaces.',
  },
  META_DESCRIPTION_LENGTH: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'Off-length descriptions are truncated or padded.',
    benefit: 'A right-sized summary displays in full.',
  },
  MISSING_H1: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'No <h1> weakens the page’s topical signal and its document outline.',
    benefit: 'A clear primary heading anchors the page topic.',
  },
  MULTIPLE_H1: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'Multiple <h1>s make the document outline ambiguous.',
    benefit: 'A single <h1> gives a clean outline.',
  },
  HEADING_ORDER: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Skipped heading levels break the outline for assistive tech and parsers.',
    benefit: 'A sequential heading structure is machine-readable.',
  },
  MISSING_IMAGE_ALT: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Images without alt text carry no textual meaning for crawlers or assistive tech.',
    benefit: 'Image content becomes describable and searchable.',
  },
  NO_VIEWPORT_META: {
    difficulty: 'trivial',
    businessImportance: 'medium',
    why: 'Without a viewport tag the page may render poorly on mobile — a signal search engines use.',
    benefit: 'The page renders correctly on mobile devices.',
  },
  NO_SEMANTIC_LANDMARKS: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Without landmark elements, parsers and AI agents cannot reliably identify the primary content region.',
    benefit: 'The main content region becomes unambiguous to machines.',
  },
  INVALID_JSONLD: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'A JSON-LD block that fails to parse is ignored entirely, so that structured data is lost.',
    benefit: 'The structured data is parsed and usable.',
  },
  NO_STRUCTURED_DATA: {
    difficulty: 'large',
    businessImportance: 'medium',
    why: 'Without schema.org markup, engines and AI systems must infer entities and relationships from prose.',
    benefit: 'Explicit entities and relationships are available to machines.',
  },
  OG_TAGS_INCOMPLETE: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Incomplete Open Graph tags make shared links render poorly.',
    benefit: 'Shared links show a proper title, description and image.',
  },
  SLOW_RESPONSE: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'Slow server responses reduce how much of the site gets crawled per visit.',
    benefit: 'More of the site is crawled in each visit.',
  },
  LARGE_HTML: {
    difficulty: 'medium',
    businessImportance: 'low',
    why: 'Very large HTML payloads slow parsing and rendering.',
    benefit: 'Faster parsing and rendering of the page.',
  },
  CONTENT_REQUIRES_JS: {
    difficulty: 'large',
    businessImportance: 'high',
    why: 'If the primary content is only present after client-side rendering, crawlers and AI systems that do not execute JavaScript see a near-empty page.',
    benefit: 'The primary content is present in the initial HTML for every consumer.',
  },
  HTTP_NOT_HTTPS: {
    difficulty: 'medium',
    businessImportance: 'high',
    why: 'Non-HTTPS pages are marked "Not secure" by browsers and are treated as lower quality.',
    benefit: 'Secure transport and a trust signal for every visitor and crawler.',
  },
  MIXED_CONTENT: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'HTTP subresources on an HTTPS page are blocked or downgraded by browsers.',
    benefit: 'All resources load securely.',
  },
  MISSING_HSTS: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Without HSTS a first request can be downgraded to HTTP.',
    benefit: 'Enforces HTTPS on subsequent visits.',
  },
  MISSING_X_CONTENT_TYPE_OPTIONS: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'Allowing MIME sniffing is a minor hardening gap.',
    benefit: 'Removes a small attack surface.',
  },
  MISSING_HTML_LANG: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'No declared language hampers assistive tech and language targeting.',
    benefit: 'The page language is explicit for every consumer.',
  },
  HREFLANG_INVALID: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Invalid hreflang codes are ignored, so language/region targeting does not work.',
    benefit: 'Correct language/region alternates are understood.',
  },
  HREFLANG_NO_RETURN_TAG: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'hreflang annotations must be reciprocal or they are discarded.',
    benefit: 'The hreflang cluster is honoured.',
  },
  ROBOTS_SYNTAX: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'Malformed robots.txt lines are ignored and can hide mistakes.',
    benefit: 'A clean robots.txt that behaves predictably.',
  },
  ROBOTS_NO_SITEMAP_DIRECTIVE: {
    difficulty: 'trivial',
    businessImportance: 'low',
    why: 'A Sitemap: line in robots.txt helps crawlers find the sitemap.',
    benefit: 'Faster sitemap discovery.',
  },
  SITEMAP_NONINDEXABLE_URL: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'Sitemaps should list canonical, indexable URLs only; noindex/blocked/redirected entries send mixed signals.',
    benefit: 'The sitemap becomes a reliable list of what to index.',
  },
  SITEMAP_COVERAGE_GAP: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'Indexable pages missing from the sitemap are discovered more slowly.',
    benefit: 'Faster discovery of all indexable pages.',
  },
  SITEMAP_INVALID_XML: {
    difficulty: 'small',
    businessImportance: 'medium',
    why: 'A sitemap that fails to parse cannot be used by crawlers at all.',
    benefit: 'The sitemap can be consumed.',
  },
};

const CATEGORY_FALLBACK: Record<string, CodeMeta> = {
  indexability: {
    difficulty: 'small',
    businessImportance: 'high',
    why: 'This affects whether pages can be indexed and cited.',
    benefit: 'Improves indexing eligibility.',
  },
  crawlability: {
    difficulty: 'medium',
    businessImportance: 'high',
    why: 'This affects how efficiently crawlers can reach the site’s content.',
    benefit: 'More content is reached per crawl.',
  },
  architecture: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'This affects how discoverable and well-organised the content is.',
    benefit: 'A clearer structure for crawlers and users.',
  },
  internal_linking: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'This affects discovery and topical context via the internal link graph.',
    benefit: 'Better discovery and context.',
  },
  metadata: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'This affects how pages are labelled and summarised.',
    benefit: 'Clearer per-page labelling.',
  },
  structured_data: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'This affects how machine-readable the page’s entities are.',
    benefit: 'More explicit entity data.',
  },
  performance: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'This affects parse/render speed and crawl throughput.',
    benefit: 'Faster pages and more crawling.',
  },
  security: {
    difficulty: 'medium',
    businessImportance: 'medium',
    why: 'This affects transport security and trust signals.',
    benefit: 'A more secure, trusted site.',
  },
  internationalization: {
    difficulty: 'small',
    businessImportance: 'low',
    why: 'This affects language and region targeting.',
    benefit: 'Correct locale handling.',
  },
};

function metaFor(code: string, category: string): CodeMeta {
  return (
    CODE_META[code] ??
    CATEGORY_FALLBACK[category] ?? {
      difficulty: 'medium',
      businessImportance: 'low',
      why: 'This is a technical issue flagged by the crawler.',
      benefit: 'Resolves the flagged issue.',
    }
  );
}

const GOAL_KEYWORDS: Record<string, string[]> = {
  indexability: ['index', 'indexed', 'indexing', 'noindex', 'not found', 'discover'],
  crawlability: ['crawl', 'crawler', 'googlebot', 'robots', 'blocked'],
  architecture: ['structure', 'architecture', 'orphan', 'navigation', 'hierarchy'],
  internal_linking: ['internal link', 'linking', 'link equity'],
  structured_data: ['schema', 'structured data', 'json-ld', 'rich result', 'entity'],
  metadata: ['title', 'meta description', 'metadata', 'snippet'],
  performance: ['speed', 'performance', 'core web vitals', 'slow'],
  security: ['https', 'ssl', 'secure', 'mixed content'],
  internationalization: ['hreflang', 'language', 'locale', 'international', 'region'],
};

function goalBoost(category: string, goals: string[]): number {
  if (goals.length === 0) return 0;
  const kws = GOAL_KEYWORDS[category] ?? [];
  const hay = goals.join(' ').toLowerCase();
  return kws.some((k) => hay.includes(k)) ? 0.15 : 0;
}

function priorityBand(score: number): RankedRecommendation['priority'] {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function bucket(rec: RankedRecommendation): ActionPlan {
  const easy = rec.difficulty === 'trivial' || rec.difficulty === 'small';
  const hard = rec.difficulty === 'large';
  const structural = ['indexability', 'crawlability', 'architecture', 'structured_data'].includes(
    rec.category,
  );
  if (rec.priorityScore >= 45 && easy) return 'quick_win';
  if (rec.priorityScore >= 55 && structural && !easy) return 'high_impact';
  if (hard) return 'technical_project';
  if (rec.priorityScore >= 15) return 'long_term';
  return 'long_term';
}

export interface RankInput {
  issues: EngineIssue[];
  pagesCrawled: number;
  goals?: string[];
  /** Optional: sample affected URLs per code, when the caller has them. */
  affectedUrlsByCode?: Record<string, string[]>;
}

export function rankRecommendations(input: RankInput): EngineResult {
  const goals = input.goals ?? [];
  const pages = Math.max(1, input.pagesCrawled);

  // Group issues by code.
  const groups = new Map<string, EngineIssue[]>();
  for (const issue of input.issues) {
    const g = groups.get(issue.code) ?? [];
    g.push(issue);
    groups.set(issue.code, g);
  }

  const recommendations: RankedRecommendation[] = [];
  for (const [code, groupIssues] of groups) {
    const first = groupIssues[0]!;
    const category = first.category;
    const meta = metaFor(code, category);

    const worstSeverity = groupIssues
      .map((i) => i.severity)
      .sort((a, b) => SEVERITY_SCALE[b] - SEVERITY_SCALE[a])[0]!;
    const totalAffected = groupIssues.reduce((s, i) => s + Math.max(1, i.affectedUrlCount), 0);
    const avgConfidence = groupIssues.reduce((s, i) => s + i.confidence, 0) / groupIssues.length;

    const frac = Math.min(1, totalAffected / pages);
    const severityScore = SEVERITY_SCALE[worstSeverity];
    const reachScore = 0.3 + 0.7 * Math.sqrt(frac);
    const businessImportance = Math.min(
      1,
      BIZ_SCALE[meta.businessImportance] + goalBoost(category, goals),
    );
    const estimatedImpact = (CATEGORY_IMPACT[category] ?? 0.5) * (0.5 + 0.5 * reachScore);
    const easeScore = DIFFICULTY_EASE[meta.difficulty];
    const confidence = avgConfidence;

    const factors: PriorityFactors = {
      severityScore,
      reachScore,
      businessImportance,
      estimatedImpact,
      easeScore,
      confidence,
    };
    const priorityScore = Math.round(
      100 *
        (WEIGHTS.severityScore * severityScore +
          WEIGHTS.reachScore * reachScore +
          WEIGHTS.businessImportance * businessImportance +
          WEIGHTS.estimatedImpact * estimatedImpact +
          WEIGHTS.easeScore * easeScore +
          WEIGHTS.confidence * confidence),
    );

    const affectedFromIssues = groupIssues
      .map((i) => i.normalizedUrl)
      .filter((u): u is string => Boolean(u));
    const affectedPages = [
      ...new Set([...(input.affectedUrlsByCode?.[code] ?? []), ...affectedFromIssues]),
    ].slice(0, 20);

    const rec: RankedRecommendation = {
      code,
      category,
      title: first.title,
      problem: first.title,
      evidence: {
        detail: first.detail,
        auditorEvidence: (first.evidence as Record<string, unknown> | null) ?? null,
        affectedUrlSample: affectedPages,
        affectedUrlCount: totalAffected,
      },
      whyItMatters: meta.why,
      howToFix: first.recommendedFix,
      affectedPages,
      expectedBenefit: `${meta.benefit} This is a machine-readability / crawl-efficiency improvement, not a guarantee of higher search rankings.`,
      difficulty: meta.difficulty,
      confidence,
      priorityScore,
      priority: priorityBand(priorityScore),
      businessImportanceLabel: meta.businessImportance,
      factors,
      actionPlan: 'long_term',
    };
    rec.actionPlan = bucket(rec);
    recommendations.push(rec);
  }

  recommendations.sort((a, b) => b.priorityScore - a.priorityScore);

  const actionPlans: ActionPlans = {
    quickWins: recommendations.filter((r) => r.actionPlan === 'quick_win'),
    highImpact: recommendations.filter((r) => r.actionPlan === 'high_impact'),
    technicalProjects: recommendations.filter((r) => r.actionPlan === 'technical_project'),
    longTerm: recommendations.filter((r) => r.actionPlan === 'long_term'),
  };

  return {
    recommendations,
    actionPlans,
    priorityModel: {
      weights: WEIGHTS,
      severityScale: SEVERITY_SCALE,
      note: 'priorityScore = 100 × Σ(weightᵢ × factorᵢ) over severity, reach (affected URLs, √-damped), business importance (with an optional goal boost), estimated impact (by category × reach), implementation ease and confidence. It ranks fix order; it is not a ranking prediction.',
    },
  };
}

export type { IssueCategory };
