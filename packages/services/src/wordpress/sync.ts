import { type Db, type WordPressContentType, type WordPressSite, prisma } from '@growth-agent/db';
import type { WordPressClientOptions, WpContentKind, WpPost } from './client.js';
import { titleOf, toPlainText } from './client.js';
import { clientForSite } from './connect.js';

/** Hard ceiling per content type per sync (10 pages × 100). */
export const MAX_PAGES_PER_TYPE = 10;

export interface WordPressSyncResult {
  posts: number;
  pages: number;
  /** True when a type had more than the ceiling; stale rows are then kept. */
  truncated: boolean;
}

const KIND_TO_TYPE: Record<WpContentKind, WordPressContentType> = { posts: 'POST', pages: 'PAGE' };

function toRow(p: WpPost) {
  const modified = p.modified_gmt ? new Date(`${p.modified_gmt}Z`) : null;
  return {
    status: p.status.slice(0, 32),
    title: titleOf(p).slice(0, 500),
    link: p.link?.slice(0, 2000) ?? null,
    slug: p.slug?.slice(0, 500) ?? null,
    excerpt: toPlainText(p.excerpt?.rendered ?? p.excerpt?.raw, 500) || null,
    modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified : null,
    syncedAt: new Date(),
  };
}

/**
 * Mirror posts and pages exactly as WordPress returns them. Drafts are only
 * read when the user can edit (`context=edit`); a read-only account sees
 * published content only — we never pretend otherwise.
 *
 * Rows WordPress no longer returns are removed, but only after a *complete*
 * pagination; a truncated sync never deletes, so a partial read cannot make
 * content look deleted.
 */
export async function syncWordPressContent(
  site: WordPressSite,
  db: Db = prisma,
  clientOpts: WordPressClientOptions = {},
): Promise<WordPressSyncResult> {
  const client = clientForSite(site, clientOpts);
  const canEdit = site.detectedCapabilities.includes('edit_posts');
  const result: WordPressSyncResult = { posts: 0, pages: 0, truncated: false };

  for (const kind of ['posts', 'pages'] as const) {
    const type = KIND_TO_TYPE[kind];
    const seen: number[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await client.listContent(kind, page, { edit: canEdit });
      totalPages = res.totalPages;
      for (const item of res.items) {
        seen.push(item.id);
        const row = toRow(item);
        await db.wordPressContent.upsert({
          where: {
            wordPressSiteId_type_wpId: { wordPressSiteId: site.id, type, wpId: item.id },
          },
          create: {
            ...row,
            organizationId: site.organizationId,
            wordPressSiteId: site.id,
            wpId: item.id,
            type,
          },
          update: row,
        });
      }
      page += 1;
    } while (page <= totalPages && page <= MAX_PAGES_PER_TYPE);

    const complete = totalPages <= MAX_PAGES_PER_TYPE;
    if (!complete) result.truncated = true;
    if (complete) {
      await db.wordPressContent.deleteMany({
        where: {
          organizationId: site.organizationId,
          wordPressSiteId: site.id,
          type,
          wpId: { notIn: seen },
        },
      });
    }
    if (kind === 'posts') result.posts = seen.length;
    else result.pages = seen.length;
  }
  return result;
}
