import { type Db, prisma } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { assertGovernanceAllows } from '../governance/index.js';
import type { WordPressClientOptions, WpContentKind } from './client.js';
import { clientForSite, explainWordPressError, requireWordPressSite } from './connect.js';
import { contentHash } from './hash.js';

/** `title`/`excerpt`/`content` come back as `{rendered?, raw?}` — `raw` is
 *  populated because every call in this file authenticates with
 *  `context=edit`. Falls back to `rendered` (HTML) so a hash can always be
 *  computed even if `raw` were ever absent. */
function fieldOf(f: { raw?: string; rendered?: string } | undefined): string {
  return f?.raw ?? f?.rendered ?? '';
}

/**
 * WordPress write operations. Only `createDraft` runs directly: a draft is
 * invisible to the public and fully reversible, so it is a DRAFT-level
 * capability with no approval step. `updatePost` (WRITE) and `publishPost`
 * (PUBLISH) are exported only as *executors* for the approval queue
 * (`approvals/`) — no Server Action or agent tool calls them directly.
 */

const Kind = z.enum(['posts', 'pages']);

export const CreateDraftPayload = z.object({
  kind: Kind.default('posts'),
  title: z.string().trim().min(1).max(300),
  content: z.string().max(200_000).default(''),
  excerpt: z.string().max(2_000).optional(),
});
export type CreateDraftPayload = z.infer<typeof CreateDraftPayload>;

export const UpdatePostPayload = z
  .object({
    kind: Kind.default('posts'),
    wpId: z.number().int().positive(),
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(200_000).optional(),
    excerpt: z.string().max(2_000).optional(),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,200}$/, 'Slug may only contain lowercase letters, digits and dashes.')
      .optional(),
    /** Version-safety (Phase 9, §30): the content hash the proposal was
     *  built against. If the live WordPress content no longer matches this
     *  hash at execution time, the update is refused rather than silently
     *  overwriting a change made elsewhere since the proposal was approved. */
    expectedContentHash: z.string().length(64).optional(),
  })
  .refine((p) => p.title ?? p.content ?? p.excerpt ?? p.slug, {
    message: 'Nothing to change.',
  });
export type UpdatePostPayload = z.infer<typeof UpdatePostPayload>;

export const PublishPostPayload = z.object({
  kind: Kind.default('posts'),
  wpId: z.number().int().positive(),
});
export type PublishPostPayload = z.infer<typeof PublishPostPayload>;

function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw AppError.validation(r.error.issues[0]?.message ?? 'Invalid input.');
  return r.data;
}

interface Ctx {
  organizationId: string;
  siteId: string;
  actorId: string;
  db?: Db;
  clientOpts?: WordPressClientOptions;
}

function need(caps: string[], cap: string, what: string) {
  if (!caps.includes(cap)) {
    throw AppError.forbidden(
      `The connected WordPress user cannot ${what} (missing the "${cap}" capability). Reconnect with an account that has an Editor or Author role.`,
    );
  }
}

const editCap = (kind: WpContentKind) => (kind === 'pages' ? 'edit_pages' : 'edit_posts');
const publishCap = (kind: WpContentKind) => (kind === 'pages' ? 'publish_pages' : 'publish_posts');
const editPublishedCap = (kind: WpContentKind) =>
  kind === 'pages' ? 'edit_published_pages' : 'edit_published_posts';

/**
 * Dry-run mode (Phase 4, Part 36): `AGENT_DRY_RUN=true` makes every write
 * below stop after its real authorization/connection/capability checks —
 * the same checks a live run would fail on are still exercised — but
 * returns a simulated, clearly-labelled result instead of calling
 * WordPress. Never gated on anything client-supplied; it is a deployment
 * -wide switch for safe development/staging, not a per-request flag.
 */
function isDryRun(): boolean {
  return process.env.AGENT_DRY_RUN === 'true' || process.env.AGENT_DRY_RUN === '1';
}

export async function createDraft(ctx: Ctx, raw: unknown) {
  const db = ctx.db ?? prisma;
  const payload = validate(CreateDraftPayload, raw);
  const site = await requireWordPressSite(ctx.organizationId, ctx.siteId, db);
  // An org can switch WordPress drafting off entirely (AI governance).
  await assertGovernanceAllows(ctx.organizationId, 'WORDPRESS', 'draft', { viaAgent: false }, db);
  need(site.detectedCapabilities, editCap(payload.kind), 'create drafts');
  if (isDryRun()) {
    return { wpId: -1, status: 'draft' as const, link: null, dryRun: true };
  }
  try {
    const post = await clientForSite(site, ctx.clientOpts).createPost(payload.kind, {
      title: payload.title,
      content: payload.content,
      ...(payload.excerpt ? { excerpt: payload.excerpt } : {}),
      status: 'draft',
    });
    if (post.status !== 'draft') {
      // Should be impossible (we asked for a draft). If WordPress ever did
      // otherwise the user must know immediately rather than find out later.
      throw new AppError(
        'provider_unavailable',
        `WordPress created the item with status "${post.status}" instead of "draft". Check it in WordPress.`,
      );
    }
    await recordAudit({
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: 'wordpress.draft_created',
      targetType: 'wordpress_site',
      targetId: site.id,
      metadata: { wpId: post.id, kind: payload.kind },
    });
    return { wpId: post.id, status: post.status, link: post.link ?? null };
  } catch (err) {
    throw explainWordPressError(err);
  }
}

/** Approval-queue executor (WRITE). */
export async function executeUpdatePost(ctx: Ctx, raw: unknown) {
  const db = ctx.db ?? prisma;
  const payload = validate(UpdatePostPayload, raw);
  const site = await requireWordPressSite(ctx.organizationId, ctx.siteId, db);
  need(site.detectedCapabilities, editCap(payload.kind), 'edit content');
  if (isDryRun()) {
    return { wpId: payload.wpId, status: 'draft' as const, link: null, dryRun: true };
  }
  try {
    const client = clientForSite(site, ctx.clientOpts);
    const current = await client.getPost(payload.kind, payload.wpId);
    if (current.status === 'publish') {
      need(site.detectedCapabilities, editPublishedCap(payload.kind), 'edit published content');
    }
    const { kind, wpId, expectedContentHash, ...fields } = payload;
    if (expectedContentHash) {
      const liveHash = contentHash({
        title: fieldOf(current.title),
        excerpt: fieldOf(current.excerpt),
        content: fieldOf(current.content),
      });
      if (liveHash !== expectedContentHash) {
        throw AppError.conflict(
          'This content changed on WordPress since the update was proposed. Review the current content and resubmit.',
        );
      }
    }
    const updated = await client.updatePost(kind, wpId, fields);
    return { wpId: updated.id, status: updated.status, link: updated.link ?? null };
  } catch (err) {
    throw explainWordPressError(err);
  }
}

/** Approval-queue executor (PUBLISH). Idempotent: already-published is success. */
export async function executePublishPost(ctx: Ctx, raw: unknown) {
  const db = ctx.db ?? prisma;
  const payload = validate(PublishPostPayload, raw);
  const site = await requireWordPressSite(ctx.organizationId, ctx.siteId, db);
  need(site.detectedCapabilities, publishCap(payload.kind), 'publish');
  if (isDryRun()) {
    return { wpId: payload.wpId, status: 'publish' as const, link: null, dryRun: true };
  }
  try {
    const client = clientForSite(site, ctx.clientOpts);
    const current = await client.getPost(payload.kind, payload.wpId);
    if (current.status === 'publish') {
      return {
        wpId: current.id,
        status: current.status,
        link: current.link ?? null,
        alreadyPublished: true,
      };
    }
    if (!['draft', 'pending'].includes(current.status)) {
      throw AppError.conflict(
        `Only drafts or pending items can be published from Growth Agent (this one is "${current.status}").`,
      );
    }
    const updated = await client.updatePost(payload.kind, payload.wpId, { status: 'publish' });
    return {
      wpId: updated.id,
      status: updated.status,
      link: updated.link ?? null,
      alreadyPublished: false,
    };
  } catch (err) {
    throw explainWordPressError(err);
  }
}
