/**
 * Part 16-17: the embedding provider seam + pgvector storage/retrieval.
 *
 * `packages/ai`'s `EmbedOptions`/`embed()` are provider-agnostic (Phase 11
 * adds the first real implementation, OpenAI's `text-embedding-3-small`, in
 * `packages/ai/src/providers/index.ts` — this module never talks to a
 * provider SDK directly). When no provider has embedding support configured
 * (`typeof model.embed !== 'function'`, or the call fails), every function
 * here degrades to a no-op / empty result rather than throwing — retrieval
 * then falls back to keyword + metadata ranking only (Part 17's own
 * instruction: "Do not rank solely by vector similarity").
 *
 * `knowledge_embeddings.embedding` is a Prisma `Unsupported("vector(1536)")`
 * column, so every read/write here goes through `$executeRaw`/`$queryRaw`.
 * If the `vector` Postgres extension was never installed (this migration's
 * `CREATE EXTENSION` failed or was skipped), these raw queries throw — caught
 * and logged once per call, never surfaced to the caller as a hard failure.
 */
import { randomUUID } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import type { AIProvider } from '@growth-agent/ai';
import { createLogger } from '@growth-agent/observability';
import { recordUsage } from '../usage/index.js';
import type { DocumentChunk } from './chunking.js';

const log = createLogger('knowledge.embeddings');

export type EmbeddingCapableModel = Pick<AIProvider, 'embed' | 'name'>;

const EMBEDDING_MODEL_ID = 'text-embedding-3-small';
const EMBEDDING_VERSION = 'v1';

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** Embeds a batch of texts, metering the real cost. Returns `null` (never
 * throws) when no provider is configured or the call fails. */
export async function embedTexts(
  organizationId: string,
  model: EmbeddingCapableModel | undefined,
  texts: string[],
  idempotencyKey: string,
  db: Db = prisma,
): Promise<number[][] | null> {
  if (!model?.embed || texts.length === 0) return null;
  try {
    const result = await model.embed({ values: texts });
    await recordUsage(
      {
        organizationId,
        meter: 'AI_TOKENS',
        quantity: result.usage.totalTokens,
        idempotencyKey,
        subjectType: 'embedding',
        costUsd: result.usage.estimatedCostUsd,
      },
      db,
    ).catch(() => undefined);
    return result.embeddings;
  } catch (e) {
    log.warn({ organizationId, err: String(e) }, 'embedding call failed; continuing without vectors');
    return null;
  }
}

/**
 * Stores every chunk as a `KnowledgeEmbedding` row. A chunk that got a real
 * vector is inserted via raw SQL (the only way to write the `vector` column);
 * a chunk with no vector (provider unavailable/failed) is still stored
 * through the ordinary Prisma Client call, `embedding` left null, so keyword
 * retrieval still has the chunk text to search even without semantic search.
 */
export async function storeChunks(
  organizationId: string,
  knowledgeId: string,
  chunks: DocumentChunk[],
  model: EmbeddingCapableModel | undefined,
  db: Db = prisma,
): Promise<{ stored: number; embedded: number }> {
  if (chunks.length === 0) return { stored: 0, embedded: 0 };
  const vectors = await embedTexts(
    organizationId,
    model,
    chunks.map((c) => c.text),
    `embed:${knowledgeId}:${chunks.length}`,
    db,
  );

  let embedded = 0;
  for (const chunk of chunks) {
    const vec = vectors?.[chunk.index];
    const chunkMetadata = { heading: chunk.heading, paragraphIndex: chunk.paragraphIndex };
    if (vec) {
      try {
        await db.$executeRaw`
          INSERT INTO "knowledge_embeddings"
            ("id", "organizationId", "knowledgeId", "chunkIndex", "chunkText", "chunkMetadata", "embedding", "embeddingModel", "embeddingVersion", "createdAt")
          VALUES
            (${randomUUID()}, ${organizationId}, ${knowledgeId}, ${chunk.index}, ${chunk.text}, ${JSON.stringify(chunkMetadata)}::jsonb, ${vectorLiteral(vec)}::vector, ${EMBEDDING_MODEL_ID}, ${EMBEDDING_VERSION}, now())
          ON CONFLICT ("knowledgeId", "chunkIndex") DO UPDATE SET
            "chunkText" = EXCLUDED."chunkText",
            "chunkMetadata" = EXCLUDED."chunkMetadata",
            "embedding" = EXCLUDED."embedding",
            "embeddingModel" = EXCLUDED."embeddingModel",
            "embeddingVersion" = EXCLUDED."embeddingVersion"
        `;
        embedded++;
        continue;
      } catch (e) {
        log.warn({ organizationId, knowledgeId, err: String(e) }, 'vector insert failed; storing text only');
      }
    }
    await db.knowledgeEmbedding.upsert({
      where: { knowledgeId_chunkIndex: { knowledgeId, chunkIndex: chunk.index } },
      create: {
        organizationId,
        knowledgeId,
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        chunkMetadata: chunkMetadata as never,
      },
      update: { chunkText: chunk.text, chunkMetadata: chunkMetadata as never },
    });
  }
  return { stored: chunks.length, embedded };
}

export interface VectorMatch {
  knowledgeId: string;
  chunkText: string;
  /** Cosine distance (`<=>`), 0 = identical, 2 = opposite. Lower is better. */
  distance: number;
}

/** Cosine-similarity search over this org's chunks. Returns `[]` (never
 * throws) when embeddings aren't available at all — the caller falls back to
 * keyword ranking. */
export async function vectorSearch(
  organizationId: string,
  model: EmbeddingCapableModel | undefined,
  query: string,
  limit = 20,
  db: Db = prisma,
): Promise<VectorMatch[]> {
  if (!model?.embed) return [];
  const vectors = await embedTexts(organizationId, model, [query], `embed:query:${randomUUID()}`, db);
  const queryVector = vectors?.[0];
  if (!queryVector) return [];
  try {
    const literal = vectorLiteral(queryVector);
    return await db.$queryRaw<VectorMatch[]>`
      SELECT "knowledgeId", "chunkText", ("embedding" <=> ${literal}::vector) AS distance
      FROM "knowledge_embeddings"
      WHERE "organizationId" = ${organizationId} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${literal}::vector
      LIMIT ${limit}
    `;
  } catch (e) {
    log.warn({ organizationId, err: String(e) }, 'vector search failed; the pgvector extension may be unavailable');
    return [];
  }
}

export async function deleteEmbeddingsForKnowledge(knowledgeId: string, db: Db = prisma): Promise<void> {
  await db.knowledgeEmbedding.deleteMany({ where: { knowledgeId } }).catch(() => undefined);
}
