/** Part 6-7: the shared source model behind every `KnowledgeEvidence` and
 * `ResearchCitation` row. */
import { createHash } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import type { KnowledgeSourceType } from '@growth-agent/db';
import { trustLevelFor } from './schemas.js';

export interface CreateSourceInput {
  organizationId: string;
  type: KnowledgeSourceType;
  url?: string;
  title?: string;
  publisher?: string;
  author?: string;
  publishedAt?: Date;
  content?: string;
  metadata?: Record<string, unknown>;
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Reuse an existing source for the same org+url+contentHash rather than
 * creating a duplicate row every time the same page/document is referenced
 * again (Part 83's idempotency requirement).
 */
export async function createOrReuseSource(input: CreateSourceInput, db: Db = prisma) {
  const contentHash = input.content ? contentHashOf(input.content) : undefined;
  if (input.url) {
    const existing = await db.knowledgeSource.findFirst({
      where: {
        organizationId: input.organizationId,
        url: input.url,
        ...(contentHash ? { contentHash } : {}),
      },
      orderBy: { retrievedAt: 'desc' },
    });
    if (existing) {
      return db.knowledgeSource.update({
        where: { id: existing.id },
        data: { lastVerifiedAt: new Date() },
      });
    }
  }
  return db.knowledgeSource.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      url: input.url,
      title: input.title,
      publisher: input.publisher,
      author: input.author,
      publishedAt: input.publishedAt,
      contentHash,
      trustLevel: trustLevelFor(input.type),
      metadata: input.metadata as never,
    },
  });
}

export async function getSource(organizationId: string, sourceId: string, db: Db = prisma) {
  return db.knowledgeSource.findFirst({ where: { id: sourceId, organizationId } });
}

export async function listSources(
  organizationId: string,
  opts: { type?: KnowledgeSourceType; limit?: number } = {},
  db: Db = prisma,
) {
  return db.knowledgeSource.findMany({
    where: { organizationId, ...(opts.type ? { type: opts.type } : {}) },
    orderBy: { retrievedAt: 'desc' },
    take: opts.limit ?? 50,
  });
}
