/**
 * Site-architecture analysis (docs/SEO-ENGINE.md, "SITE ARCHITECTURE"). Given
 * every crawled page + its outbound edges + the sitemap URL set, compute:
 * crawl depth (BFS from seeds), orphan pages, pages with no inbound internal
 * links, broken internal links, redirect chains/loops, duplicate URL variants,
 * canonical conflicts, and duplicate title / description / content clusters.
 *
 * Pure — operates on plain records, no DB.
 */
import { NEAR_DUPLICATE_THRESHOLD, hammingDistance } from './fingerprint.js';
import { urlPathDepth } from './url.js';

export interface GraphPage {
  normalizedUrl: string;
  httpStatus: number | null;
  redirectChain: Array<{ from: string; to: string; status: number }>;
  indexable: boolean;
  noindex: boolean;
  title: string | null;
  metaDescription: string | null;
  contentHash: string | null;
  simhash: string | null;
  canonicalUrl: string | null;
  wordCount: number | null;
  outboundLinks: Array<{ toNormalizedUrl: string; isInternal: boolean; isNofollow: boolean }>;
}

export interface DuplicateCluster {
  key: string;
  urls: string[];
}

export interface GraphAnalysis {
  /** normalizedUrl → shortest crawl distance from a seed (Infinity ⇒ unreachable). */
  depthByUrl: Map<string, number>;
  /** Pages reachable only via the sitemap / discovery, never linked from another page. */
  orphanPages: string[];
  /** Pages with zero inbound internal links (excluding seeds). */
  noInboundPages: string[];
  /** Internal links whose target returned 4xx (or is known-broken). */
  brokenInternalLinks: Array<{ from: string; to: string; status: number | null }>;
  redirectChains: Array<{ url: string; hops: number }>;
  redirectLoops: string[];
  /** Groups of URLs that normalize differently but share identical content. */
  duplicateUrlVariants: DuplicateCluster[];
  duplicateTitleGroups: DuplicateCluster[];
  duplicateDescriptionGroups: DuplicateCluster[];
  duplicateContentClusters: DuplicateCluster[];
  canonicalConflicts: Array<{ url: string; canonicalUrl: string; problem: string }>;
  excessiveDepthPages: string[];
  excessiveUrlDepthPages: string[];
  parameterExplosionPaths: Array<{ path: string; variants: number }>;
  inboundCountByUrl: Map<string, number>;
}

export interface GraphInput {
  pages: GraphPage[];
  seeds: string[];
  /** URLs listed in the site's sitemap(s), normalized. */
  sitemapUrls: string[];
  maxDepth: number;
  excessiveUrlDepth?: number;
}

export function analyzeGraph(input: GraphInput): GraphAnalysis {
  const { pages } = input;
  const known = new Set(pages.map((p) => p.normalizedUrl));
  const byUrl = new Map(pages.map((p) => [p.normalizedUrl, p]));
  const seeds = input.seeds.filter((s) => known.has(s));
  const excessiveUrlDepth = input.excessiveUrlDepth ?? 4;

  // --- BFS crawl depth over followed internal edges ---
  const depthByUrl = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const inboundCountByUrl = new Map<string, number>();
  for (const p of pages) {
    const outs: string[] = [];
    for (const l of p.outboundLinks) {
      if (!l.isInternal || l.isNofollow) continue;
      if (!known.has(l.toNormalizedUrl)) continue;
      outs.push(l.toNormalizedUrl);
      if (l.toNormalizedUrl !== p.normalizedUrl) {
        inboundCountByUrl.set(
          l.toNormalizedUrl,
          (inboundCountByUrl.get(l.toNormalizedUrl) ?? 0) + 1,
        );
      }
    }
    adjacency.set(p.normalizedUrl, outs);
  }

  const queue: string[] = [];
  for (const s of seeds) {
    depthByUrl.set(s, 0);
    queue.push(s);
  }
  while (queue.length > 0) {
    const u = queue.shift() as string;
    const d = depthByUrl.get(u) ?? 0;
    for (const v of adjacency.get(u) ?? []) {
      if (!depthByUrl.has(v)) {
        depthByUrl.set(v, d + 1);
        queue.push(v);
      }
    }
  }

  // --- Orphans + no-inbound ---
  const sitemapSet = new Set(input.sitemapUrls);
  const orphanPages: string[] = [];
  const noInboundPages: string[] = [];
  for (const p of pages) {
    if (seeds.includes(p.normalizedUrl)) continue;
    const inbound = inboundCountByUrl.get(p.normalizedUrl) ?? 0;
    if (inbound === 0) {
      noInboundPages.push(p.normalizedUrl);
      // "Orphan" = known to exist (sitemap or crawled) but unreachable by links.
      if (sitemapSet.has(p.normalizedUrl) || !depthByUrl.has(p.normalizedUrl)) {
        orphanPages.push(p.normalizedUrl);
      }
    }
  }

  // --- Broken internal links + redirect analysis ---
  const brokenInternalLinks: GraphAnalysis['brokenInternalLinks'] = [];
  for (const p of pages) {
    for (const l of p.outboundLinks) {
      if (!l.isInternal) continue;
      const target = byUrl.get(l.toNormalizedUrl);
      if (target && target.httpStatus != null && target.httpStatus >= 400) {
        brokenInternalLinks.push({
          from: p.normalizedUrl,
          to: l.toNormalizedUrl,
          status: target.httpStatus,
        });
      }
    }
  }

  const redirectChains: GraphAnalysis['redirectChains'] = [];
  const redirectLoops: string[] = [];
  for (const p of pages) {
    if (p.redirectChain.length > 1)
      redirectChains.push({ url: p.normalizedUrl, hops: p.redirectChain.length });
    const seen = new Set<string>();
    for (const hop of p.redirectChain) {
      if (seen.has(hop.to)) {
        redirectLoops.push(p.normalizedUrl);
        break;
      }
      seen.add(hop.to);
    }
  }

  // --- Duplicate clusters ---
  const duplicateTitleGroups = clusterBy(
    pages.filter((p) => p.title),
    (p) => (p.title ?? '').trim().toLowerCase(),
  );
  const duplicateDescriptionGroups = clusterBy(
    pages.filter((p) => p.metaDescription),
    (p) => (p.metaDescription ?? '').trim().toLowerCase(),
  );
  const duplicateUrlVariants = clusterBy(
    pages.filter((p) => p.contentHash && p.wordCount != null && p.wordCount > 20),
    (p) => p.contentHash as string,
  );
  const duplicateContentClusters = clusterBySimhash(
    pages.filter((p) => p.simhash && p.wordCount != null && p.wordCount > 40),
  );

  // --- Canonical conflicts ---
  const canonicalConflicts: GraphAnalysis['canonicalConflicts'] = [];
  for (const p of pages) {
    if (!p.canonicalUrl) continue;
    const canonicalTarget = byUrl.get(p.canonicalUrl);
    if (p.canonicalUrl !== p.normalizedUrl && canonicalTarget) {
      if (canonicalTarget.canonicalUrl && canonicalTarget.canonicalUrl !== p.canonicalUrl) {
        canonicalConflicts.push({
          url: p.normalizedUrl,
          canonicalUrl: p.canonicalUrl,
          problem: 'canonical target itself canonicalises elsewhere (canonical chain)',
        });
      }
      if (canonicalTarget.httpStatus != null && canonicalTarget.httpStatus >= 400) {
        canonicalConflicts.push({
          url: p.normalizedUrl,
          canonicalUrl: p.canonicalUrl,
          problem: `canonical target returns HTTP ${canonicalTarget.httpStatus}`,
        });
      }
      if (canonicalTarget.noindex) {
        canonicalConflicts.push({
          url: p.normalizedUrl,
          canonicalUrl: p.canonicalUrl,
          problem: 'canonical target is noindex',
        });
      }
    }
  }

  // --- Depth thresholds ---
  const excessiveDepthPages = pages
    .filter((p) => {
      const d = depthByUrl.get(p.normalizedUrl);
      return d != null && d > input.maxDepth;
    })
    .map((p) => p.normalizedUrl);
  const excessiveUrlDepthPages = pages
    .filter((p) => urlPathDepth(p.normalizedUrl) > excessiveUrlDepth)
    .map((p) => p.normalizedUrl);

  // --- Parameter explosion ---
  const paramCounts = new Map<string, Set<string>>();
  for (const p of pages) {
    try {
      const u = new URL(p.normalizedUrl);
      if (![...u.searchParams.keys()].length) continue;
      const key = `${u.origin}${u.pathname}`;
      if (!paramCounts.has(key)) paramCounts.set(key, new Set());
      paramCounts.get(key)!.add(u.search);
    } catch {
      /* ignore */
    }
  }
  const parameterExplosionPaths = [...paramCounts.entries()]
    .filter(([, variants]) => variants.size >= 10)
    .map(([path, variants]) => ({ path, variants: variants.size }));

  return {
    depthByUrl,
    orphanPages,
    noInboundPages,
    brokenInternalLinks,
    redirectChains,
    redirectLoops: [...new Set(redirectLoops)],
    duplicateUrlVariants,
    duplicateTitleGroups,
    duplicateDescriptionGroups,
    duplicateContentClusters,
    canonicalConflicts,
    excessiveDepthPages,
    excessiveUrlDepthPages,
    parameterExplosionPaths,
    inboundCountByUrl,
  };
}

function clusterBy(pages: GraphPage[], keyFn: (p: GraphPage) => string): DuplicateCluster[] {
  const groups = new Map<string, string[]>();
  for (const p of pages) {
    const k = keyFn(p);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p.normalizedUrl);
  }
  return [...groups.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([key, urls]) => ({ key, urls }));
}

/**
 * Bucket pages by the top 16 bits (4 hex chars) of their simhash before the
 * pairwise Hamming-distance compare, instead of scanning every existing
 * cluster for every page. A naive full pairwise scan is O(n²) in the COMMON
 * case — most pages on a real site are not near-duplicates of each other, so
 * the cluster list grows roughly linearly with the page count — and at scale
 * (tens of thousands of pages, well under the 200,000 page ceiling) that hangs
 * the finalize step for a very long time (CRAWLER-SECURITY-AUDIT.md HIGH-1).
 * This is a standard single-band LSH trade-off: two near-duplicate pages whose
 * simhash happens to differ in the top 16 bits are missed, which is acceptable
 * for a heuristic dedup signal, not a correctness-critical value.
 */
function clusterBySimhash(pages: GraphPage[]): DuplicateCluster[] {
  const buckets = new Map<string, Array<{ anchor: string; urls: string[] }>>();
  for (const p of pages) {
    const sh = p.simhash as string;
    if (!sh) continue;
    const bucketKey = sh.slice(0, 4);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      buckets.set(bucketKey, bucket);
    }
    const hit = bucket.find((c) => hammingDistance(c.anchor, sh) <= NEAR_DUPLICATE_THRESHOLD);
    if (hit) hit.urls.push(p.normalizedUrl);
    else bucket.push({ anchor: sh, urls: [p.normalizedUrl] });
  }
  return [...buckets.values()]
    .flat()
    .filter((c) => c.urls.length > 1)
    .map((c) => ({ key: c.anchor, urls: c.urls }));
}
