/**
 * Part 9-10: the research execution engine. Runs the lifecycle
 * REQUESTED → PLANNING → SEARCHING → COLLECTING → ANALYZING → VERIFYING →
 * COMPLETED/PARTIALLY_COMPLETED/FAILED. Invoked only from the worker
 * (`jobs.ts::runResearchProjectJob`), never inline from a web request.
 *
 * Honest disclosure baked into the code, not just the docs: `research/search.ts`
 * (Phase 5) has no configured web-search provider in this deployment
 * (`searchProviderFromEnv()` always returns `null` — see that file's own
 * comment). SEARCHING therefore only ever finds something when a real
 * provider is later configured; today, source discovery is driven entirely
 * by the caller's own `config.seedUrls`. This function records that
 * honestly (an empty `queries[].resultCount` when unavailable) rather than
 * pretending it searched the web.
 */
import { type Db, prisma } from '@growth-agent/db';
import { z } from 'zod';
import type { AIProvider } from '@growth-agent/ai';
import { createLogger } from '@growth-agent/observability';
import { recordUsage } from '../usage/index.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { createOrReuseSource } from '../knowledge/sources.js';
import { createKnowledgeItem } from '../knowledge/items.js';
import { researchFetch } from './fetch.js';
import { runSearch } from './search.js';
import { MAX_SOURCES_CEILING } from './schemas.js';

const log = createLogger('research.engine');

export type ResearchModel = Pick<AIProvider, 'generateObject'>;

const Synthesis = z.object({
  conclusion: z.string().max(2000),
  confidence: z.number().min(0).max(1),
  findings: z.array(
    z.object({
      finding: z.string().max(600),
      citationIndex: z.number().int().min(0),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

async function transition(researchProjectId: string, status: string, db: Db, extra: Record<string, unknown> = {}) {
  await db.researchProject.update({ where: { id: researchProjectId }, data: { status: status as never, ...extra } });
}

export interface RunResearchDeps {
  model?: ResearchModel;
  db?: Db;
}

export async function runResearchProject(
  organizationId: string,
  researchProjectId: string,
  deps: RunResearchDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const project = await db.researchProject.findFirst({ where: { id: researchProjectId, organizationId } });
  if (!project || project.status !== 'REQUESTED') return;

  // Phase 12 hardening: claim the project with a conditional `updateMany`
  // instead of the plain `findFirst`-then-`update` this used to be. Without
  // this, an overlapping `research-dispatch-sweep` tick (no per-project
  // lock) or a manual `runResearchProjectJob` racing the sweep could both
  // pass the `status !== 'REQUESTED'` check above before either wrote
  // `PLANNING`, running the whole fetch/citation/usage-recording pipeline
  // twice for the same project.
  const claim = await db.researchProject.updateMany({
    where: { id: researchProjectId, organizationId, status: 'REQUESTED' },
    data: { status: 'PLANNING', startedAt: new Date() },
  });
  if (claim.count === 0) return;
  const config = (project.config as { seedUrls?: string[]; maxSources?: number } | null) ?? {};
  const maxSources = Math.min(config.maxSources ?? 5, MAX_SOURCES_CEILING);
  const seedUrls = (config.seedUrls ?? []).slice(0, maxSources);

  // --- SEARCHING: only ever produces results once a real provider exists.
  await transition(researchProjectId, 'SEARCHING', db);
  const searchResult = await runSearch(project.question, maxSources);
  await db.researchQuery.create({
    data: {
      researchProjectId,
      organizationId,
      query: project.question,
      executedAt: new Date(),
      resultCount: 0,
    },
  });
  if (!searchResult.available) {
    log.info({ organizationId, researchProjectId, reason: searchResult.reason }, 'no web search provider configured');
  }

  // --- COLLECTING: fetch every seed URL (SSRF-safe, bounded).
  await transition(researchProjectId, 'COLLECTING', db);
  let succeeded = 0;
  let failed = 0;
  const citations: Array<{ url: string; title: string | null; excerpt: string; sourceId: string }> = [];
  for (const url of seedUrls) {
    const fetched = await researchFetch(url);
    await recordUsage(
      {
        organizationId,
        meter: 'RESEARCH_CALLS',
        quantity: 1,
        idempotencyKey: `research-fetch:${researchProjectId}:${url}`,
        subjectType: 'research_project',
        subjectId: researchProjectId,
      },
      db,
    ).catch(() => undefined);

    if (!fetched.ok) {
      failed++;
      continue;
    }
    succeeded++;
    const source = await createOrReuseSource(
      {
        organizationId,
        type: 'WEB_RESEARCH',
        url: fetched.citation.sourceUrl,
        title: fetched.citation.title ?? undefined,
        content: fetched.citation.excerpt,
      },
      db,
    );
    citations.push({
      url: fetched.citation.sourceUrl,
      title: fetched.citation.title,
      excerpt: fetched.citation.excerpt,
      sourceId: source.id,
    });
    await db.researchCitation.create({
      data: {
        researchProjectId,
        organizationId,
        sourceId: source.id,
        url: fetched.citation.sourceUrl,
        retrievedAt: new Date(fetched.citation.retrievedAt),
      },
    });
  }

  if (seedUrls.length === 0) {
    await transition(researchProjectId, 'FAILED', db, {
      failureReason: 'No sources to research: no seed URLs were provided and no web search provider is configured for this deployment.',
      completedAt: new Date(),
    });
    return;
  }
  if (succeeded === 0) {
    await transition(researchProjectId, 'FAILED', db, {
      failureReason: `All ${seedUrls.length} source(s) failed to fetch.`,
      completedAt: new Date(),
    });
    return;
  }

  // --- ANALYZING + VERIFYING: one finding per source, plus an optional
  // grounded synthesis. Never fabricates a conclusion when no model is
  // configured — the findings themselves are the result.
  await transition(researchProjectId, 'ANALYZING', db);
  for (const [index, c] of citations.entries()) {
    await db.researchFinding.create({
      data: {
        researchProjectId,
        organizationId,
        finding: c.excerpt.slice(0, 1500),
        sourceId: c.sourceId,
        confidence: 0.5,
      },
    });
    void index;
  }

  await transition(researchProjectId, 'VERIFYING', db);
  let conclusion: string | null = null;
  let confidence: number | null = null;
  if (deps.model && citations.length > 0) {
    try {
      const evidenceBlock = citations
        .map((c, i) => `[${i}] (${c.url}) ${c.title ?? ''}\n${c.excerpt.slice(0, 1200)}`)
        .join('\n\n');
      const res = await deps.model.generateObject({
        schema: Synthesis,
        system: `You are a research analyst. Synthesize ONLY from the sources given. Never invent a fact not present in the sources. Cite each finding's citationIndex from the SOURCES list. If sources disagree, say so in the conclusion rather than picking one silently.\n\n${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`,
        prompt: `${wrapUntrusted('USER_QUESTION', project.question)}\n\n${wrapUntrusted('SOURCES', evidenceBlock)}\n\nProduce the synthesis now.`,
      });
      conclusion = res.object.conclusion;
      confidence = res.object.confidence;
      for (const f of res.object.findings) {
        const citation = citations[f.citationIndex];
        if (!citation) continue;
        await db.researchFinding.create({
          data: {
            researchProjectId,
            organizationId,
            finding: f.finding.slice(0, 1500),
            sourceId: citation.sourceId,
            confidence: f.confidence,
          },
        });
      }
    } catch (e) {
      log.warn({ organizationId, researchProjectId, err: String(e) }, 'research synthesis failed; keeping raw findings only');
    }
  }

  const status = failed > 0 ? 'PARTIALLY_COMPLETED' : 'COMPLETED';
  await transition(researchProjectId, status, db, {
    conclusion,
    confidence,
    completedAt: new Date(),
  });

  if (conclusion) {
    await createKnowledgeItem(
      {
        type: 'RESEARCH',
        scope: project.missionId ? 'MISSION' : 'ORGANIZATION',
        missionId: project.missionId ?? undefined,
        title: `Research: ${project.question.slice(0, 150)}`,
        content: conclusion,
        classification: 'EXTERNAL_SOURCE',
        confidence: confidence ?? 0.5,
        importance: 'MEDIUM',
        status: 'UNVERIFIED',
      },
      { organizationId, createdById: project.createdById },
      db,
    ).catch((e) => log.warn({ organizationId, researchProjectId, err: String(e) }, 'failed to store research as knowledge'));
  }
}
