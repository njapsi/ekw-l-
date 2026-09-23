/**
 * Part 13-14: document ingestion. This deployment has no object storage
 * (`docs/FORENSIC-AUDIT.md`, still true — confirmed again in this phase's own
 * audit) and no binary document parser dependency, so ingestion accepts
 * plain text (pasted or typed) and public URLs (fetched through the
 * existing SSRF-safe crawler client) — never a PDF/DOCX upload. That
 * limitation is disclosed in `docs/KNOWLEDGE-INTELLIGENCE.md` rather than
 * built around with a new heavy dependency this phase doesn't need
 * (CLAUDE.md hard rule 9: avoid unnecessary dependencies).
 *
 * Pipeline: Upload/URL → (fetch, if a URL) → chunk → embed (best-effort) →
 * one `KnowledgeItem` (type DOCUMENT) + N `KnowledgeEmbedding` rows.
 * Fetched web content is untrusted and is never itself passed to a model
 * here — only stored as data; any later agent use wraps it with
 * `wrapUntrusted` (see `context-assembly.ts`).
 */
import { type Db, prisma } from '@growth-agent/db';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { researchFetch } from '../research/fetch.js';
import { chunkDocument } from './chunking.js';
import type { EmbeddingCapableModel } from './embeddings.js';
import { storeChunks } from './embeddings.js';
import { createKnowledgeItem } from './items.js';
import { KNOWLEDGE_TYPES } from './schemas.js';

export const IngestDocumentInput = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(KNOWLEDGE_TYPES).default('DOCUMENT'),
  text: z.string().min(1).max(100_000).optional(),
  url: z.string().url().max(2000).optional(),
  importance: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
});
export type IngestDocumentInputT = z.infer<typeof IngestDocumentInput>;

export interface IngestDocumentResult {
  knowledgeId: string;
  chunkCount: number;
  embeddedCount: number;
  fromUrl: boolean;
}

export async function ingestDocument(
  rawInput: IngestDocumentInputT,
  opts: { organizationId: string; createdById: string | null; model?: EmbeddingCapableModel },
  db: Db = prisma,
): Promise<IngestDocumentResult> {
  const input = IngestDocumentInput.parse(rawInput);
  if (!input.text && !input.url) {
    throw AppError.validation('Provide either `text` or a `url` to ingest.');
  }

  let content = input.text ?? '';
  let source: { type: 'USER_INPUT' | 'WEB_RESEARCH'; url?: string; title?: string; contentHash?: string } = {
    type: 'USER_INPUT',
  };

  if (input.url) {
    const fetched = await researchFetch(input.url);
    if (!fetched.ok) throw AppError.validation(fetched.reason);
    content = fetched.citation.excerpt;
    source = {
      type: 'WEB_RESEARCH',
      url: fetched.citation.sourceUrl,
      title: fetched.citation.title ?? undefined,
      contentHash: fetched.citation.contentHash,
    };
  }

  const chunks = chunkDocument(content);
  const item = await createKnowledgeItem(
    {
      type: input.type,
      scope: 'ORGANIZATION',
      title: input.title,
      content: content.slice(0, 20_000),
      classification: input.url ? 'EXTERNAL_SOURCE' : 'USER_PROVIDED',
      importance: input.importance,
      status: 'ACTIVE',
      source,
    },
    { organizationId: opts.organizationId, createdById: opts.createdById },
    db,
  );

  const { stored, embedded } = await storeChunks(opts.organizationId, item.id, chunks, opts.model, db);
  return { knowledgeId: item.id, chunkCount: stored, embeddedCount: embedded, fromUrl: Boolean(input.url) };
}
