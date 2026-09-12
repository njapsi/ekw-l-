import { describe, expect, it } from 'vitest';
import {
  type ReadabilityInput,
  type ReadabilityPage,
  analyzeAiReadability,
} from './ai-readability.js';

function page(over: Partial<ReadabilityPage>): ReadabilityPage {
  return {
    normalizedUrl: 'https://x.com/blog/a-good-post',
    indexable: true,
    httpStatus: 200,
    title: 'A good descriptive title for the page',
    metaDescription: 'A tailored description of this page that is long enough.',
    h1Count: 1,
    headingLevels: [1, 2, 2, 3],
    wordCount: 800,
    jsonLdTypes: ['Article'],
    landmarkCount: 4,
    hasMainLandmark: true,
    canonicalIsSelf: true,
    inboundInternalCount: 4,
    internalLinkCount: 12,
    csrLikely: false,
    ...over,
  };
}

function input(over: Partial<ReadabilityInput> = {}): ReadabilityInput {
  return {
    pages: [
      page({ normalizedUrl: 'https://x.com/' }),
      page({}),
      page({ normalizedUrl: 'https://x.com/blog/second-post' }),
    ],
    schema: {
      typeHistogram: { Article: 3, Organization: 1, WebSite: 1, BreadcrumbList: 1 },
      indexablePages: 3,
      indexablePagesWithoutStructuredData: 0,
      pagesWithParseErrorCount: 0,
      entityNameConsistent: true,
      organizationEntityNames: [{ name: 'Acme Inc', count: 3 }],
    },
    architecture: {
      orphanPages: 0,
      redirectChains: 0,
      duplicateTitleGroups: 0,
      duplicateContentClusters: 0,
    },
    robots: { present: true, fullyDisallowed: false },
    sitemapDeclared: 1,
    issueCodes: [],
    ...over,
  };
}

describe('analyzeAiReadability', () => {
  it('a well-structured site scores high across signals', () => {
    const r = analyzeAiReadability(input());
    expect(r.overallScore).toBeGreaterThan(75);
    expect(r.signals).toHaveLength(9);
    expect(r.signals.every((s) => s.score >= 0 && s.score <= 100)).toBe(true);
  });

  it('labels each signal established or experimental', () => {
    const r = analyzeAiReadability(input());
    const experimental = r.signals.filter((s) => s.guidance === 'experimental').map((s) => s.key);
    expect(experimental).toEqual(expect.arrayContaining(['entity_consistency', 'machine_signals']));
    expect(r.notes.join(' ')).toMatch(/established.*long-standing.*[Ee]xperimental/is);
  });

  it('separates established from experimental guidance lists', () => {
    const r = analyzeAiReadability(
      input({
        schema: {
          typeHistogram: {},
          indexablePages: 3,
          indexablePagesWithoutStructuredData: 3,
          pagesWithParseErrorCount: 1,
          entityNameConsistent: false,
          organizationEntityNames: [
            { name: 'Acme', count: 2 },
            { name: 'Acme Inc.', count: 1 },
          ],
        },
      }),
    );
    expect(r.establishedGuidance.length).toBeGreaterThan(0);
    expect(r.experimentalGuidance.length).toBeGreaterThan(0);
    expect(r.experimentalGuidance.join(' ')).toMatch(/AI systems|AI answer engines|AI crawlers/i);
  });

  it('penalises CSR-dependent content and missing structured data', () => {
    const good = analyzeAiReadability(input());
    const bad = analyzeAiReadability(
      input({
        pages: [
          page({ csrLikely: true, jsonLdTypes: [], landmarkCount: 0, hasMainLandmark: false }),
          page({ csrLikely: true, jsonLdTypes: [], landmarkCount: 0, hasMainLandmark: false }),
          page({ csrLikely: true, jsonLdTypes: [], landmarkCount: 0, hasMainLandmark: false }),
        ],
        schema: {
          typeHistogram: {},
          indexablePages: 3,
          indexablePagesWithoutStructuredData: 3,
          pagesWithParseErrorCount: 0,
          entityNameConsistent: true,
          organizationEntityNames: [],
        },
      }),
    );
    expect(bad.overallScore).toBeLessThan(good.overallScore);
    expect(bad.signals.find((s) => s.key === 'machine_signals')!.score).toBeLessThan(
      good.signals.find((s) => s.key === 'machine_signals')!.score,
    );
  });

  it('flags non-descriptive URLs', () => {
    const r = analyzeAiReadability(
      input({
        pages: [
          page({ normalizedUrl: 'https://x.com/p?id=48213&ref=xyz&a=1&b=2&c=3' }),
          page({ normalizedUrl: 'https://x.com/CATEGORY/Item_Name' }),
          page({ normalizedUrl: 'https://x.com/a/b/c/d/e/f/g' }),
        ],
      }),
    );
    expect(r.signals.find((s) => s.key === 'descriptive_urls')!.score).toBeLessThan(50);
  });

  it('notes low confidence when few content pages were crawled', () => {
    const r = analyzeAiReadability(input({ pages: [page({})] }));
    expect(r.notes.join(' ')).toMatch(/low-confidence/i);
  });

  it('never promises rankings', () => {
    const r = analyzeAiReadability(input());
    const text = JSON.stringify(r).toLowerCase();
    expect(text).not.toMatch(/guarantee|will rank|higher ranking/);
    expect(r.notes.join(' ')).toMatch(/does not predict or promise search rankings/i);
  });
});
