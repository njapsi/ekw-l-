/**
 * Machine-readability analysis for the AI SEO Agent (master instruction
 * "AI-READABILITY"). Deterministic scoring over already-collected crawl data of
 * nine signals: semantic HTML, structured data, entity consistency, page
 * hierarchy, descriptive URLs, internal links, clear content relationships,
 * metadata, and machine-readable signals.
 *
 * Each signal is labelled with the maturity of the advice behind it:
 *   - `established` — long-standing, documented search-engine guidance
 *   - `experimental` — oriented at AI-search / LLM-agent consumption, where best
 *     practice is still emerging
 *
 * No signal or recommendation predicts or promises search rankings.
 */
export type Guidance = 'established' | 'experimental';

export interface ReadabilityPage {
  normalizedUrl: string;
  indexable: boolean;
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  headingLevels: number[];
  wordCount: number | null;
  jsonLdTypes: string[];
  landmarkCount: number;
  hasMainLandmark: boolean;
  canonicalIsSelf: boolean | null;
  inboundInternalCount: number;
  internalLinkCount: number;
  csrLikely: boolean;
}

export interface ReadabilitySchemaInfo {
  typeHistogram: Record<string, number>;
  indexablePages: number;
  indexablePagesWithoutStructuredData: number;
  pagesWithParseErrorCount: number;
  entityNameConsistent: boolean;
  organizationEntityNames: Array<{ name: string; count: number }>;
}

export interface ReadabilityInput {
  pages: ReadabilityPage[];
  schema: ReadabilitySchemaInfo;
  architecture: {
    orphanPages: number;
    redirectChains: number;
    duplicateTitleGroups: number;
    duplicateContentClusters: number;
  };
  robots: { present: boolean; fullyDisallowed: boolean };
  sitemapDeclared: number;
  issueCodes: string[];
}

export interface SignalScore {
  key: string;
  label: string;
  guidance: Guidance;
  score: number;
  weight: number;
  findings: string[];
}

export interface AiReadabilityReport {
  overallScore: number;
  signals: SignalScore[];
  establishedGuidance: string[];
  experimentalGuidance: string[];
  notes: string[];
}

function pct(n: number, d: number): number {
  return d === 0 ? 100 : Math.round((n / d) * 100);
}

function headingOrderOk(levels: number[]): boolean {
  let prev = 0;
  for (const l of levels) {
    if (prev !== 0 && l > prev + 1) return false;
    prev = l;
  }
  return true;
}

/** Human-readable URL heuristic: lowercase words, hyphen-separated, shallow, no
 * long query string, no bare numeric / hex-id slug. */
function isDescriptiveUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return true; // home page
  if (segs.length > 5) return false;
  if (url.search.length > 40) return false;
  const last = segs[segs.length - 1] ?? '';
  if (/^[0-9]+$/.test(last)) return false; // /product/48213
  if (/^[0-9a-f]{16,}$/i.test(last)) return false; // hex id
  if (/[A-Z]/.test(url.pathname)) return false; // mixed case
  if (/[_ %]/.test(url.pathname)) return false; // underscores / spaces
  return segs.every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z]+)?$/.test(s));
}

const KEY_SCHEMA_TYPES = ['Organization', 'WebSite', 'BreadcrumbList', 'Article', 'Product'];

export function analyzeAiReadability(input: ReadabilityInput): AiReadabilityReport {
  const indexable = input.pages.filter((p) => p.indexable);
  const contentPages = indexable.filter((p) => (p.wordCount ?? 0) > 120);
  const denom = Math.max(1, contentPages.length);
  const established: string[] = [];
  const experimental: string[] = [];
  const notes: string[] = [];

  // 1. Semantic HTML (established)
  const withMain = contentPages.filter((p) => p.hasMainLandmark).length;
  const withLandmarks = contentPages.filter((p) => p.landmarkCount >= 2).length;
  const semanticScore = Math.round(pct(withMain, denom) * 0.6 + pct(withLandmarks, denom) * 0.4);
  const semanticFindings = [
    `${pct(withMain, denom)}% of content pages use a <main> landmark; ${pct(withLandmarks, denom)}% use ≥2 landmark elements.`,
  ];
  if (semanticScore < 70)
    established.push(
      'Wrap primary content in <main> and use <nav>/<header>/<footer>/<article> so the content region is unambiguous.',
    );

  // 2. Structured data (established + experimental)
  const sdCoverage = pct(
    input.schema.indexablePages - input.schema.indexablePagesWithoutStructuredData,
    Math.max(1, input.schema.indexablePages),
  );
  const hasKeyTypes = KEY_SCHEMA_TYPES.filter((t) => (input.schema.typeHistogram[t] ?? 0) > 0);
  const errPenalty = Math.min(30, input.schema.pagesWithParseErrorCount * 5);
  const structuredScore = Math.max(
    0,
    Math.round(sdCoverage * 0.7 + (hasKeyTypes.length / KEY_SCHEMA_TYPES.length) * 30 - errPenalty),
  );
  const structuredFindings = [
    `${sdCoverage}% of indexable pages carry JSON-LD. Key types present: ${hasKeyTypes.join(', ') || 'none'}.`,
  ];
  if (input.schema.pagesWithParseErrorCount > 0)
    structuredFindings.push(
      `${input.schema.pagesWithParseErrorCount} page(s) have JSON-LD that fails to parse.`,
    );
  if (structuredScore < 70)
    established.push(
      'Add schema.org JSON-LD for the site’s core entities (Organization, WebSite, BreadcrumbList) and per-template types (Article, Product).',
    );
  experimental.push(
    'AI answer engines lean on explicit entity markup; a connected @graph with @id references helps them resolve who/what a page is about.',
  );

  // 3. Entity consistency (experimental)
  const names = input.schema.organizationEntityNames;
  const entityScore = names.length === 0 ? 55 : input.schema.entityNameConsistent ? 95 : 40;
  const entityFindings =
    names.length === 0
      ? [
          'No Organization / WebSite entity is declared anywhere, so there is no canonical site identity to check.',
        ]
      : input.schema.entityNameConsistent
        ? [`One consistent site-identity name is used: "${names[0]?.name}".`]
        : [
            `Multiple site-identity names are declared: ${names.map((n) => `"${n.name}"`).join(', ')}.`,
          ];
  if (!input.schema.entityNameConsistent && names.length > 1)
    experimental.push(
      'Use one consistent Organization/WebSite name and @id across the whole site so AI systems resolve a single entity.',
    );
  if (names.length === 0)
    experimental.push(
      'Declare a site-wide Organization and WebSite entity (with sameAs links to authoritative profiles) to give AI systems a canonical identity.',
    );

  // 4. Page hierarchy (established)
  const withH1 = contentPages.filter((p) => p.h1Count >= 1).length;
  const oneH1 = contentPages.filter((p) => p.h1Count === 1).length;
  const orderedOutline = contentPages.filter((p) => headingOrderOk(p.headingLevels)).length;
  const hierarchyScore = Math.round(
    pct(withH1, denom) * 0.4 + pct(oneH1, denom) * 0.3 + pct(orderedOutline, denom) * 0.3,
  );
  const hierarchyFindings = [
    `${pct(withH1, denom)}% of content pages have an <h1> (${pct(oneH1, denom)}% exactly one); ${pct(orderedOutline, denom)}% have a non-skipping heading outline.`,
  ];
  if (hierarchyScore < 75)
    established.push(
      'Give every page exactly one descriptive <h1> and use heading levels sequentially.',
    );

  // 5. Descriptive URLs (established)
  const descriptive = indexable.filter((p) => isDescriptiveUrl(p.normalizedUrl)).length;
  const urlScore = pct(descriptive, Math.max(1, indexable.length));
  const urlFindings = [
    `${urlScore}% of indexable URLs are human-readable (lowercase, hyphen-separated words, shallow, no id-only slugs).`,
  ];
  if (urlScore < 70)
    established.push(
      'Use lowercase, hyphen-separated, word-based URL paths; avoid id-only slugs and long query strings on indexable pages.',
    );

  // 6. Internal links (established)
  const orphanRate = pct(input.architecture.orphanPages, Math.max(1, indexable.length));
  const lowInbound = indexable.filter((p) => p.inboundInternalCount <= 1).length;
  const lowInboundRate = pct(lowInbound, Math.max(1, indexable.length));
  const avgInternal =
    indexable.length > 0
      ? Math.round(indexable.reduce((s, p) => s + p.internalLinkCount, 0) / indexable.length)
      : 0;
  const linkScore = Math.max(0, Math.round(100 - orphanRate * 1.5 - lowInboundRate * 0.6));
  const linkFindings = [
    `${orphanRate}% of indexable pages are orphaned; ${lowInboundRate}% have ≤1 inbound internal link; average ${avgInternal} internal links per page.`,
  ];
  if (linkScore < 75)
    established.push(
      'Link every important page from at least one relevant hub or navigation element; add contextual internal links between related pages.',
    );

  // 7. Clear content relationships (established)
  const hasBreadcrumb = (input.schema.typeHistogram.BreadcrumbList ?? 0) > 0;
  const selfCanonical = indexable.filter((p) => p.canonicalIsSelf !== false).length;
  const canonRate = pct(selfCanonical, Math.max(1, indexable.length));
  const hreflangBroken =
    input.issueCodes.includes('HREFLANG_NO_RETURN_TAG') ||
    input.issueCodes.includes('HREFLANG_INVALID');
  const relScore = Math.round(
    (hasBreadcrumb ? 35 : 10) + canonRate * 0.5 + (hreflangBroken ? 0 : 15),
  );
  const relFindings = [
    `Breadcrumb structured data ${hasBreadcrumb ? 'is present' : 'is absent'}; ${canonRate}% of indexable pages self-canonicalise${hreflangBroken ? '; hreflang annotations have problems' : ''}.`,
  ];
  if (!hasBreadcrumb)
    established.push(
      'Add BreadcrumbList structured data so the page’s place in the hierarchy is explicit.',
    );

  // 8. Metadata (established)
  const withTitle = contentPages.filter((p) => p.title && p.title.length >= 10).length;
  const withDesc = contentPages.filter((p) => p.metaDescription).length;
  const dupPenalty = Math.min(25, input.architecture.duplicateTitleGroups * 4);
  const metaScore = Math.max(
    0,
    Math.round(pct(withTitle, denom) * 0.6 + pct(withDesc, denom) * 0.4 - dupPenalty),
  );
  const metaFindings = [
    `${pct(withTitle, denom)}% of content pages have a usable <title>; ${pct(withDesc, denom)}% have a meta description; ${input.architecture.duplicateTitleGroups} duplicate-title group(s).`,
  ];
  if (metaScore < 75)
    established.push(
      'Give every indexable page a unique, descriptive title and a tailored meta description.',
    );

  // 9. Machine-readable signals — composite (established core + experimental)
  const csrRate = pct(indexable.filter((p) => p.csrLikely).length, Math.max(1, indexable.length));
  const crawlSignals =
    (input.robots.present && !input.robots.fullyDisallowed ? 25 : 0) +
    (input.sitemapDeclared > 0 ? 25 : 0) +
    Math.round((structuredScore / 100) * 25) +
    Math.round((semanticScore / 100) * 25);
  const machineScore = Math.max(0, Math.round(crawlSignals - csrRate * 0.4));
  const machineFindings = [
    `robots.txt ${input.robots.present ? 'present' : 'absent'}${input.robots.fullyDisallowed ? ' (full disallow!)' : ''}; ${input.sitemapDeclared} sitemap(s) declared; ${csrRate}% of indexable pages depend on client-side rendering.`,
  ];
  if (csrRate > 10)
    experimental.push(
      'Ensure the primary content is in the server-rendered HTML — many AI crawlers and agents do not execute JavaScript.',
    );
  experimental.push(
    'Expose a clean XML sitemap and consider a machine-readable content feed; keep the main content free of interstitials so it is easy to extract.',
  );

  const signals: SignalScore[] = [
    {
      key: 'semantic_html',
      label: 'Semantic HTML',
      guidance: 'established',
      score: semanticScore,
      weight: 0.13,
      findings: semanticFindings,
    },
    {
      key: 'structured_data',
      label: 'Structured data',
      guidance: 'established',
      score: structuredScore,
      weight: 0.16,
      findings: structuredFindings,
    },
    {
      key: 'entity_consistency',
      label: 'Entity consistency',
      guidance: 'experimental',
      score: entityScore,
      weight: 0.1,
      findings: entityFindings,
    },
    {
      key: 'page_hierarchy',
      label: 'Page hierarchy',
      guidance: 'established',
      score: hierarchyScore,
      weight: 0.12,
      findings: hierarchyFindings,
    },
    {
      key: 'descriptive_urls',
      label: 'Descriptive URLs',
      guidance: 'established',
      score: urlScore,
      weight: 0.1,
      findings: urlFindings,
    },
    {
      key: 'internal_links',
      label: 'Internal links',
      guidance: 'established',
      score: linkScore,
      weight: 0.12,
      findings: linkFindings,
    },
    {
      key: 'content_relationships',
      label: 'Clear content relationships',
      guidance: 'established',
      score: relScore,
      weight: 0.09,
      findings: relFindings,
    },
    {
      key: 'metadata',
      label: 'Metadata',
      guidance: 'established',
      score: metaScore,
      weight: 0.1,
      findings: metaFindings,
    },
    {
      key: 'machine_signals',
      label: 'Machine-readable signals',
      guidance: 'experimental',
      score: machineScore,
      weight: 0.08,
      findings: machineFindings,
    },
  ];

  const overallScore = Math.round(signals.reduce((s, sig) => s + sig.score * sig.weight, 0));

  if (contentPages.length < 3)
    notes.push('Few content pages were crawled, so these signal scores are low-confidence.');
  notes.push(
    '"Established" signals reflect long-standing search-engine guidance. "Experimental" signals target AI-search / LLM-agent consumption, where best practice is still emerging.',
  );
  notes.push(
    'This analysis describes machine readability. It does not predict or promise search rankings.',
  );

  return {
    overallScore,
    signals,
    establishedGuidance: [...new Set(established)],
    experimentalGuidance: [...new Set(experimental)],
    notes,
  };
}
