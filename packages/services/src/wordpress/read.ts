import { type Db, type WordPressContentType, prisma } from '@growth-agent/db';

/** Secret-free projection of a site — the credential columns never leave the service. */
const SITE_SELECT = {
  id: true,
  siteUrl: true,
  siteName: true,
  username: true,
  status: true,
  detectedCapabilities: true,
  lastError: true,
  lastCheckAt: true,
  lastCheckOk: true,
  createdAt: true,
} as const;

export async function listWordPressSites(organizationId: string, db: Db = prisma) {
  return db.wordPressSite.findMany({
    where: { organizationId, status: { not: 'REVOKED' } },
    select: SITE_SELECT,
    orderBy: { createdAt: 'asc' },
  });
}

export async function listWordPressContent(
  organizationId: string,
  opts: { siteId?: string; type?: WordPressContentType; limit?: number } = {},
  db: Db = prisma,
) {
  return db.wordPressContent.findMany({
    where: {
      organizationId,
      ...(opts.siteId ? { wordPressSiteId: opts.siteId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
    },
    select: {
      id: true,
      wordPressSiteId: true,
      wpId: true,
      type: true,
      status: true,
      title: true,
      link: true,
      slug: true,
      excerpt: true,
      modifiedAt: true,
      syncedAt: true,
    },
    orderBy: { modifiedAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 200),
  });
}
