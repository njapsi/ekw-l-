/**
 * SEO issue resolution tracking (Phase 9, §22/§29/§32). `CrawlIssue.status`
 * (`OPEN|FIXED|REGRESSED|IGNORED`) has existed since the crawler shipped,
 * but nothing ever wrote `FIXED`/`REGRESSED`/`IGNORED` — this module is the
 * first real writer. It never claims a fix without re-checking the live
 * page: a single-page re-fetch through the same SSRF-safe client and HTML
 * extraction the crawler itself uses, re-evaluating only the one condition
 * that produced the issue's code. Issue codes with no bounded, reliable
 * single-page check honestly report that a full re-crawl is needed instead
 * of guessing.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { extractPage, type ExtractedPage } from './html.js';
import { fetchPage } from './fetch.js';

const log = createLogger('seo.issue-resolution');

/** Issue codes this module can verify from a single fresh fetch — each maps
 *  to one deterministic condition over `ExtractedPage`, the exact same
 *  fields `rules.ts`'s crawler-time check reads. Anything else needs a full
 *  re-crawl (multi-page context, e.g. `ORPHAN_PAGE`, `REDIRECT_CHAIN`). */
const VERIFIABLE_CODES: Record<string, (p: ExtractedPage) => boolean> = {
  // Returns true when the issue would STILL be raised today.
  MISSING_META_DESCRIPTION: (p) => !p.metaDescription || p.metaDescription.trim().length === 0,
  META_DESCRIPTION_LENGTH: (p) =>
    p.metaDescriptionLength != null && (p.metaDescriptionLength < 50 || p.metaDescriptionLength > 160),
  MISSING_TITLE: (p) => !p.title || p.title.trim().length === 0,
  TITLE_LENGTH: (p) => p.titleLength != null && (p.titleLength < 15 || p.titleLength > 60),
  MISSING_IMAGE_ALT: (p) => p.imagesMissingAlt > 0,
  NO_VIEWPORT_META: (p) => !p.viewportMeta,
  HEADING_ORDER: (p) => !p.headingOrderOk,
  NO_SEMANTIC_LANDMARKS: (p) => p.landmarkCount === 0,
};

export interface IssueVerificationResult {
  verified: boolean;
  resolved: boolean | null;
  reason: string;
}

/**
 * Re-fetches the issue's URL and, for a supported code, re-evaluates the
 * single condition that raised it. Updates `CrawlIssue.status` — `FIXED` if
 * it no longer reproduces, `REGRESSED` if a previously-`FIXED` issue is
 * back, otherwise left `OPEN`. Never marks anything resolved without a real
 * re-check.
 */
export async function verifyAndResolveIssue(
  input: { organizationId: string; issueId: string; actorId?: string | null },
  db: Db = prisma,
): Promise<IssueVerificationResult> {
  const issue = await db.crawlIssue.findFirst({
    where: { id: input.issueId, organizationId: input.organizationId },
    include: { page: { select: { url: true } } },
  });
  if (!issue) throw AppError.notFound('SEO issue');

  const url = issue.page?.url ?? issue.normalizedUrl;
  if (!url) {
    return { verified: false, resolved: null, reason: 'This issue has no associated page URL to re-check.' };
  }

  const check = VERIFIABLE_CODES[issue.code];
  if (!check) {
    return {
      verified: false,
      resolved: null,
      reason: `Verifying "${issue.code}" needs a full site re-crawl — single-page verification is not supported for this issue type yet.`,
    };
  }

  const outcome = await fetchPage(url);
  if (!outcome.ok) {
    return { verified: false, resolved: null, reason: `Could not re-fetch the page (${outcome.reason}: ${outcome.detail}).` };
  }
  if (!outcome.isHtml) {
    return { verified: false, resolved: null, reason: 'The re-fetched page is not HTML.' };
  }

  const extracted = extractPage(outcome.body, outcome.finalUrl);
  const stillPresent = check(extracted);

  if (stillPresent) {
    if (issue.status === 'FIXED') {
      await db.crawlIssue.update({ where: { id: issue.id }, data: { status: 'REGRESSED' } });
      await recordAudit(
        {
          organizationId: input.organizationId,
          actorId: input.actorId ?? null,
          action: 'seo.issue.regressed',
          targetType: 'crawl_issue',
          targetId: issue.id,
          metadata: { code: issue.code, url },
        },
        db,
      );
    }
    return { verified: true, resolved: false, reason: 'The issue is still present on the live page.' };
  }

  await db.crawlIssue.update({ where: { id: issue.id }, data: { status: 'FIXED' } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: 'seo.issue.resolved',
      targetType: 'crawl_issue',
      targetId: issue.id,
      metadata: { code: issue.code, url },
    },
    db,
  );
  return { verified: true, resolved: true, reason: 'The issue no longer reproduces on the live page.' };
}

/** Best-effort wrapper for callers (e.g. the approval executor's post
 *  -execute hook) that must never let a verification failure break the
 *  action that triggered it. */
export async function tryVerifyAndResolveIssue(
  input: { organizationId: string; issueId: string; actorId?: string | null },
  db: Db = prisma,
): Promise<IssueVerificationResult | null> {
  try {
    return await verifyAndResolveIssue(input, db);
  } catch (err) {
    log.warn({ err: String(err), issueId: input.issueId }, 'SEO issue verification failed');
    return null;
  }
}
