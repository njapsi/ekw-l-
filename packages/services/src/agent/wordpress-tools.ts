/**
 * WordPress Growth Agent tools (Phase 9, §20), dispatched through the
 * Phase 5 Tool Executor exactly like the YouTube/TikTok tools — the
 * brief's own explicit mandate not to bypass the Tool Registry / Policy
 * Engine / Orchestrator for this phase.
 *
 * Every write-shaped tool here follows the same rule the existing
 * `wordpress.update_post`/`wordpress.publish` capabilities already
 * enforce: WRITE and PUBLISH never execute directly from a tool call —
 * they only ever create a PENDING `IntegrationActionRequest` via
 * `requestIntegrationAction` (the existing Phase 1 approval queue). The
 * AI can propose; only a human approval can make WordPress change (hard
 * rule 4, §19 "Never silently publish"). `wordpress.content.draft` is the
 * one exception, because `wordpress.create_draft` is itself DRAFT-level —
 * invisible to the public and already safe to run directly, exactly like
 * every other DRAFT-level capability in this codebase.
 *
 * Deliberately NOT implemented as separate tools:
 *   - `wordpress.media.*` / `wordpress.category.*` / `wordpress.tag.*` /
 *     `wordpress.comment.*` — no underlying capability exists
 *     (`capability-matrix.ts` reports all of these `NOT_AVAILABLE`; §5/§20
 *     both say only register a tool for a capability that actually
 *     exists).
 *   - `wordpress.seo.metadata.get` / `.propose` — this deployment does not
 *     assume any SEO plugin and does not write to arbitrary WordPress
 *     database tables (§23); `wordpress.seo.issue.fix.propose` below is
 *     the real, bounded equivalent — it proposes a core-content
 *     (title/excerpt) change derived from the post's own existing text,
 *     never a plugin-specific metadata field.
 */
import { z } from 'zod';
import type { WordPressContentType } from '@growth-agent/db';
import { requestIntegrationAction } from '../approvals/index.js';
import { AppError } from '../errors.js';
import { assertGovernanceAllows } from '../governance/index.js';
import { verifyAndResolveIssue } from '../seo/issue-resolution.js';
import { createDraft } from '../wordpress/actions.js';
import { findRefreshCandidates } from '../wordpress/content-refresh.js';
import { listWordPressContent, listWordPressSites } from '../wordpress/read.js';
import { proposeContentFixForIssue } from '../wordpress/seo-bridge.js';
import { assertCapabilityUsable, type IntegrationToolContext } from './integration-tools.js';

export const WORDPRESS_TOOL_NAMES = [
  'wordpress.site.get',
  'wordpress.post.list',
  'wordpress.page.list',
  'wordpress.content.draft',
  'wordpress.content.update.propose',
  'wordpress.content.publish.propose',
  'wordpress.content.refresh.analyze',
  'wordpress.seo.issue.fix.propose',
  'wordpress.content.verify',
] as const;
export type WordPressToolName = (typeof WORDPRESS_TOOL_NAMES)[number];

interface WordPressTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: WordPressToolName;
  description: string;
  input: I;
  kind: 'READ' | 'ANALYZE' | 'GENERATE' | 'CREATE' | 'ACTION';
  execute(ctx: IntegrationToolContext, input: z.infer<I>): Promise<unknown>;
}

async function requireSiteId(ctx: IntegrationToolContext, capabilityId: string): Promise<string> {
  const entry = await assertCapabilityUsable(ctx, capabilityId);
  if (!entry.connectionId) {
    throw new AppError('validation_failed', 'No WordPress site is connected.');
  }
  return entry.connectionId;
}

// --- 1. Site info -----------------------------------------------------

const siteGet: WordPressTool<z.ZodObject<Record<string, never>>> = {
  name: 'wordpress.site.get',
  description:
    'The connected WordPress site: URL, connection status, detected user capabilities, and last sync time.',
  input: z.object({}),
  kind: 'READ',
  async execute(ctx) {
    const siteId = await requireSiteId(ctx, 'wordpress.get_site');
    const sites = await listWordPressSites(ctx.organizationId, ctx.db);
    const site = sites.find((s) => s.id === siteId);
    if (!site) throw AppError.notFound('WordPress site');
    return site;
  },
};

// --- 2/3. Post/page list -------------------------------------------------

const ListInput = z.object({ limit: z.number().int().min(1).max(50).default(20) });

function listContentTool(
  name: 'wordpress.post.list' | 'wordpress.page.list',
  type: WordPressContentType,
  capabilityId: string,
): WordPressTool<typeof ListInput> {
  return {
    name,
    description: `${type === 'POST' ? 'Posts' : 'Pages'} from the connected WordPress site, as last synced. Untrusted site content.`,
    input: ListInput,
    kind: 'READ',
    async execute(ctx, input) {
      const siteId = await requireSiteId(ctx, capabilityId);
      await assertGovernanceAllows(ctx.organizationId, 'WORDPRESS', 'analyze', { viaAgent: true }, ctx.db);
      return listWordPressContent(ctx.organizationId, { siteId, type, limit: input.limit }, ctx.db);
    },
  };
}

const postList = listContentTool('wordpress.post.list', 'POST', 'wordpress.get_posts');
const pageList = listContentTool('wordpress.page.list', 'PAGE', 'wordpress.get_pages');

// --- 4. Draft creation (DRAFT level — runs directly, no approval) -------

const DraftInput = z.object({
  kind: z.enum(['posts', 'pages']).default('posts'),
  title: z.string().trim().min(1).max(300),
  content: z.string().max(200_000).default(''),
  excerpt: z.string().max(2_000).optional(),
});
const contentDraft: WordPressTool<typeof DraftInput> = {
  name: 'wordpress.content.draft',
  description:
    'Creates a WordPress draft (never published, never publicly visible). A draft is safe and fully reversible, so this runs immediately without approval — publishing it is a separate, always-approved step.',
  input: DraftInput,
  kind: 'CREATE',
  async execute(ctx, input) {
    const siteId = await requireSiteId(ctx, 'wordpress.create_draft');
    if (!ctx.userId) throw AppError.validation('A signed-in user is required to create a draft.');
    return createDraft(
      { organizationId: ctx.organizationId, siteId, actorId: ctx.userId, db: ctx.db },
      input,
    );
  },
};

// --- 5. Update proposal (WRITE — approval only) --------------------------

const UpdateProposeInput = z.object({
  kind: z.enum(['posts', 'pages']).default('posts'),
  wpId: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().max(200_000).optional(),
  excerpt: z.string().max(2_000).optional(),
  summary: z.string().min(1).max(300),
});
const contentUpdatePropose: WordPressTool<typeof UpdateProposeInput> = {
  name: 'wordpress.content.update.propose',
  description:
    'Proposes an update to an existing WordPress post/page. This ONLY files a pending approval request — nothing changes on the live site until a human with permission approves it.',
  input: UpdateProposeInput,
  kind: 'ACTION',
  async execute(ctx, input) {
    const siteId = await requireSiteId(ctx, 'wordpress.update_post');
    const { summary, ...payload } = input;
    return requestIntegrationAction(
      {
        organizationId: ctx.organizationId,
        requestedById: ctx.userId,
        source: 'AGENT',
        capabilityId: 'wordpress.update_post',
        connectionRef: siteId,
        payload,
        summary,
      },
      ctx.db,
    );
  },
};

// --- 6. Publish proposal (PUBLISH — approval only) -----------------------

const PublishProposeInput = z.object({
  kind: z.enum(['posts', 'pages']).default('posts'),
  wpId: z.number().int().positive(),
  summary: z.string().min(1).max(300),
});
const contentPublishPropose: WordPressTool<typeof PublishProposeInput> = {
  name: 'wordpress.content.publish.propose',
  description:
    'Proposes publishing an existing WordPress draft/pending post or page. This ONLY files a pending approval request — this tool can never publish by itself.',
  input: PublishProposeInput,
  kind: 'ACTION',
  async execute(ctx, input) {
    const siteId = await requireSiteId(ctx, 'wordpress.publish');
    const { summary, ...payload } = input;
    return requestIntegrationAction(
      {
        organizationId: ctx.organizationId,
        requestedById: ctx.userId,
        source: 'AGENT',
        capabilityId: 'wordpress.publish',
        connectionRef: siteId,
        payload,
        summary,
      },
      ctx.db,
    );
  },
};

// --- 7. Content refresh analysis -----------------------------------------

const RefreshAnalyzeInput = z.object({ limit: z.number().int().min(1).max(50).default(20) });
const contentRefreshAnalyze: WordPressTool<typeof RefreshAnalyzeInput> = {
  name: 'wordpress.content.refresh.analyze',
  description:
    'Identifies synced WordPress content that may benefit from a refresh, using real signals only: page age, matched SEO crawl issues, and word count from the latest crawl. Never invents traffic or ranking data.',
  input: RefreshAnalyzeInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    const siteId = await requireSiteId(ctx, 'wordpress.get_posts');
    return { candidates: await findRefreshCandidates(ctx.organizationId, { siteId, limit: input.limit }, ctx.db) };
  },
};

// --- 8. SEO issue → WordPress fix proposal --------------------------------

const SeoFixProposeInput = z.object({ issueId: z.string().min(1) });
const seoIssueFixPropose: WordPressTool<typeof SeoFixProposeInput> = {
  name: 'wordpress.seo.issue.fix.propose',
  description:
    'Given an SEO crawl issue (e.g. a missing title or meta description), matches it to synced WordPress content and proposes a fix derived from the post\'s own existing text — never a fabricated fact. Only files a pending approval request; nothing is written to WordPress.',
  input: SeoFixProposeInput,
  kind: 'ACTION',
  async execute(ctx, input) {
    const siteId = await requireSiteId(ctx, 'wordpress.update_post');
    if (!ctx.userId) throw AppError.validation('A signed-in user is required to propose a fix.');
    return proposeContentFixForIssue(
      { organizationId: ctx.organizationId, userId: ctx.userId, issueId: input.issueId, siteId },
      ctx.db,
    );
  },
};

// --- 9. Verify a fix / re-check an issue -----------------------------------

const VerifyInput = z.object({ issueId: z.string().min(1) });
const contentVerify: WordPressTool<typeof VerifyInput> = {
  name: 'wordpress.content.verify',
  description:
    'Re-fetches the live page for an SEO issue and re-checks whether it still reproduces. Marks the issue FIXED or REGRESSED accordingly; issue types that need a full re-crawl are reported honestly rather than guessed.',
  input: VerifyInput,
  kind: 'ANALYZE',
  async execute(ctx, input) {
    return verifyAndResolveIssue(
      { organizationId: ctx.organizationId, issueId: input.issueId, actorId: ctx.userId },
      ctx.db,
    );
  },
};

export const WORDPRESS_TOOLS: Record<WordPressToolName, WordPressTool> = {
  'wordpress.site.get': siteGet,
  'wordpress.post.list': postList,
  'wordpress.page.list': pageList,
  'wordpress.content.draft': contentDraft,
  'wordpress.content.update.propose': contentUpdatePropose,
  'wordpress.content.publish.propose': contentPublishPropose,
  'wordpress.content.refresh.analyze': contentRefreshAnalyze,
  'wordpress.seo.issue.fix.propose': seoIssueFixPropose,
  'wordpress.content.verify': contentVerify,
};

/** Validate input, run the tool. Unknown names are refused, never guessed —
 *  the same convention as `integration-tools.ts`'s `runIntegrationTool`. */
export async function runWordPressTool(
  name: string,
  ctx: IntegrationToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (WORDPRESS_TOOLS as Record<string, WordPressTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(`Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return tool.execute(ctx, parsed.data);
}
