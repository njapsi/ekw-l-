/**
 * The SEO → WordPress execution bridge (Phase 9, §22 — "a critical
 * architectural requirement"). WordPress becomes an execution layer for the
 * existing AI SEO Agent's findings: given one `CrawlIssue`, this module
 * matches it to a synced `WordPressContent` row by URL, derives a proposed
 * fix, and files it through the existing approval queue
 * (`approvals/requestIntegrationAction`) — it never writes to WordPress
 * itself. No separate SEO engine is created here; every fact this module
 * uses (the issue, the page, the post's own existing text) already exists
 * — nothing is invented.
 *
 * Only two issue families are actionable through a core WordPress
 * post/page field, because only `title`/`excerpt`/`content`/`slug` are
 * writable at all (`wordpress/actions.ts`):
 *   - `MISSING_TITLE` / `TITLE_LENGTH`      → propose a `title` change
 *   - `MISSING_META_DESCRIPTION` / `META_DESCRIPTION_LENGTH` → propose an
 *     `excerpt` change (many WordPress themes/SEO setups fall back to the
 *     excerpt for the meta description when no plugin overrides it — this
 *     is disclosed as an approximation, never claimed as a guaranteed fix)
 * Every other issue code is refused with an honest explanation rather than
 * a fabricated proposal (hard rule 1).
 */
import { type Db, prisma } from '@growth-agent/db';
import { requestIntegrationAction } from '../approvals/index.js';
import { AppError } from '../errors.js';
import { normalizeUrl, registrableDomain } from '../seo/url.js';
import { toPlainText } from './client.js';
import { clientForSite, requireWordPressSite } from './connect.js';
import { contentHash } from './hash.js';

const TITLE_CODES = new Set(['MISSING_TITLE', 'TITLE_LENGTH']);
const META_DESCRIPTION_CODES = new Set(['MISSING_META_DESCRIPTION', 'META_DESCRIPTION_LENGTH']);
const ACTIONABLE_CODES = new Set([...TITLE_CODES, ...META_DESCRIPTION_CODES]);

export interface ActionableSeoIssue {
  id: string;
  code: string;
  title: string;
  url: string | null;
  severity: string;
  status: string;
  /** Whether a synced WordPress post/page was found matching this URL. */
  hasWordPressMatch: boolean;
}

/**
 * Open SEO issues on the website matching this WordPress site's hostname,
 * restricted to the two code families `proposeContentFixForIssue` can act
 * on — everything else genuinely cannot be routed through a WordPress
 * content update (only title/excerpt/content/slug are writable at all).
 */
export async function listActionableSeoIssuesForSite(
  organizationId: string,
  siteId: string,
  db: Db = prisma,
): Promise<ActionableSeoIssue[]> {
  const site = await requireWordPressSite(organizationId, siteId, db);
  const domain = registrableDomain(new URL(site.siteUrl).hostname);
  const website = await db.website.findFirst({ where: { organizationId, hostname: domain } });
  if (!website) return [];
  const crawl = await db.crawl.findFirst({
    where: { organizationId, websiteId: website.id, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
  });
  if (!crawl) return [];

  const [issues, content] = await Promise.all([
    db.crawlIssue.findMany({
      where: { crawlId: crawl.id, status: 'OPEN', code: { in: [...ACTIONABLE_CODES] } },
      include: { page: { select: { url: true } } },
      orderBy: { severity: 'desc' },
      take: 50,
    }),
    db.wordPressContent.findMany({
      where: { organizationId, wordPressSiteId: siteId, link: { not: null } },
      select: { link: true },
    }),
  ]);

  const wpUrls = new Set(
    content
      .map((c) => {
        try {
          return c.link ? normalizeUrl(c.link) : null;
        } catch {
          return null;
        }
      })
      .filter((u): u is string => u != null),
  );

  return issues.map((issue) => {
    const url = issue.page?.url ?? issue.normalizedUrl;
    let normalized: string | null = null;
    try {
      normalized = url ? normalizeUrl(url) : null;
    } catch {
      normalized = null;
    }
    return {
      id: issue.id,
      code: issue.code,
      title: issue.title,
      url,
      severity: issue.severity,
      status: issue.status,
      hasWordPressMatch: normalized != null && wpUrls.has(normalized),
    };
  });
}

export interface FixProposal {
  field: 'title' | 'excerpt';
  currentValue: string;
  proposedValue: string;
  rationale: string;
  /** Always true here — the derivation source is disclosed, never a
   *  fabricated fact (hard rule 1, §17). */
  derivedFromExistingContent: true;
}

const MIN_META_LEN = 50;
const MAX_META_LEN = 160;
const MIN_TITLE_LEN = 15;
const MAX_TITLE_LEN = 60;

/** Pure — builds the proposal text from content WordPress already has.
 *  Never invents new claims about the page; only truncates/reuses existing
 *  text. Returns `null` when there is nothing to derive a proposal from. */
export function buildFixProposal(
  code: string,
  current: { title: string; excerpt: string; content: string },
): FixProposal | null {
  if (TITLE_CODES.has(code)) {
    const source = current.title || toPlainText(current.content, 200);
    if (!source) return null;
    const proposed =
      source.length > MAX_TITLE_LEN
        ? `${source.slice(0, MAX_TITLE_LEN - 1)}…`
        : source.length < MIN_TITLE_LEN && current.content
          ? toPlainText(current.content, MAX_TITLE_LEN)
          : source;
    if (!proposed || proposed === current.title) return null;
    return {
      field: 'title',
      currentValue: current.title,
      proposedValue: proposed,
      rationale:
        code === 'MISSING_TITLE'
          ? 'This page has no title. The proposed title is derived from its existing body text — review and rewrite before approving.'
          : `The current title is ${current.title.length < MIN_TITLE_LEN ? 'shorter' : 'longer'} than the recommended ${MIN_TITLE_LEN}-${MAX_TITLE_LEN} characters. The proposed title reuses the existing text, adjusted to length.`,
      derivedFromExistingContent: true,
    };
  }

  if (META_DESCRIPTION_CODES.has(code)) {
    const source = current.excerpt || toPlainText(current.content, MAX_META_LEN + 40);
    if (!source) return null;
    const trimmed = source.length > MAX_META_LEN ? `${source.slice(0, MAX_META_LEN - 1)}…` : source;
    if (trimmed.length < MIN_META_LEN && !current.content) return null;
    if (trimmed === current.excerpt) return null;
    return {
      field: 'excerpt',
      currentValue: current.excerpt,
      proposedValue: trimmed,
      rationale:
        'Many WordPress sites use the excerpt as the meta description when no SEO plugin overrides it — this is an approximation, not a guaranteed fix for every theme/plugin combination. The proposed excerpt is derived from the post\'s own existing text.',
      derivedFromExistingContent: true,
    };
  }

  return null;
}

export async function proposeContentFixForIssue(
  input: { organizationId: string; userId: string; issueId: string; siteId: string },
  db: Db = prisma,
) {
  const issue = await db.crawlIssue.findFirst({
    where: { id: input.issueId, organizationId: input.organizationId },
    include: { page: { select: { url: true } } },
  });
  if (!issue) throw AppError.notFound('SEO issue');
  const url = issue.page?.url ?? issue.normalizedUrl;
  if (!url) throw AppError.validation('This issue has no associated page URL.');

  if (!TITLE_CODES.has(issue.code) && !META_DESCRIPTION_CODES.has(issue.code)) {
    throw AppError.validation(
      `"${issue.code}" cannot be fixed through a WordPress content update — only title and excerpt/meta-description issues can be. This is a real limitation, not a missing feature: only title/excerpt/content/slug are writable at all.`,
    );
  }

  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    throw AppError.validation('The issue URL could not be parsed.');
  }
  const candidates = await db.wordPressContent.findMany({
    where: { organizationId: input.organizationId, wordPressSiteId: input.siteId, link: { not: null } },
  });
  const match = candidates.find((c) => {
    try {
      return c.link ? normalizeUrl(c.link) === normalized : false;
    } catch {
      return false;
    }
  });
  if (!match) {
    throw AppError.validation('No synced WordPress content matches this issue\'s URL.');
  }

  const site = await requireWordPressSite(input.organizationId, input.siteId, db);
  const client = clientForSite(site);
  const post = await client.getPost(match.type === 'PAGE' ? 'pages' : 'posts', match.wpId);
  const current = {
    title: post.title?.raw ?? post.title?.rendered ?? '',
    excerpt: post.excerpt?.raw ?? post.excerpt?.rendered ?? '',
    content: post.content?.raw ?? post.content?.rendered ?? '',
  };

  const proposal = buildFixProposal(issue.code, current);
  if (!proposal) {
    throw AppError.validation(
      'There is not enough existing text on this page to derive a safe proposal — write the fix manually.',
    );
  }

  const payload = {
    kind: match.type === 'PAGE' ? ('pages' as const) : ('posts' as const),
    wpId: match.wpId,
    [proposal.field]: proposal.proposedValue,
    expectedContentHash: contentHash(current),
  };

  const row = await requestIntegrationAction(
    {
      organizationId: input.organizationId,
      requestedById: input.userId,
      source: 'AGENT',
      capabilityId: 'wordpress.update_post',
      connectionRef: input.siteId,
      payload,
      summary: `Fix SEO issue "${issue.title}" on ${url} (${proposal.field}).`,
      sourceCrawlIssueId: issue.id,
    },
    db,
  );

  return { request: row, proposal };
}
