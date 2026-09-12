/**
 * PLATFORM-SPECIFIC CONTENT stage. For each requested `ContentAssetType`, one
 * `generateObject` call produces that type's payload (a set for the "idea"/
 * "post" types), which becomes a `ContentAsset` + its first
 * `ContentAssetVersion` (status DRAFT). The engine never publishes.
 *
 * Light grounding: guarantee phrasing → fall back to a deterministic template
 * for that type. Without a model every type has a template.
 */
import type { AIProvider } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { z } from 'zod';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { analyzeProject, type AnalyzeModel } from './analyze.js';
import { renderAsset } from './render.js';
import {
  ALL_ASSET_TYPES,
  type ContentAnalysis,
  type ContentAssetTypeKey,
  GEN_SCHEMAS,
  MULTI_COUNT,
} from './schemas.js';

const log = createLogger('content.generate');

export type GenerateModel = Pick<AIProvider, 'generateObject'>;

export interface GenerateDeps {
  db?: Db;
  model?: GenerateModel & AnalyzeModel;
}

export interface GenerateResult {
  projectId: string;
  agentRunId: string | null;
  assetIds: string[];
  usedModel: boolean;
  byType: Record<string, number>;
}

const GUARANTEE_RE =
  /\b(guarantee[ds]?|will (?:definitely|certainly) (?:go viral|rank|make money)|guaranteed (?:views|revenue|virality|ranking))\b/i;

async function createAssetWithVersion(
  db: Db,
  input: {
    projectId: string;
    organizationId: string;
    type: ContentAssetTypeKey;
    platform: string;
    title: string;
    body: string;
    structured: Record<string, unknown>;
    sourceAngle: string | null;
    agentRunId: string | null;
  },
): Promise<string> {
  const asset = await db.contentAsset.create({
    data: {
      repurposeProjectId: input.projectId,
      organizationId: input.organizationId,
      type: input.type,
      platform: input.platform,
      title: input.title.slice(0, 200),
      status: 'DRAFT',
      sourceAngle: input.sourceAngle,
      createdByAgentRunId: input.agentRunId,
    },
  });
  const version = await db.contentAssetVersion.create({
    data: {
      contentAssetId: asset.id,
      organizationId: input.organizationId,
      versionNumber: 1,
      body: input.body,
      structured: input.structured as never,
      editedById: null,
      editSummary: 'AI-generated',
    },
  });
  await db.contentAsset.update({ where: { id: asset.id }, data: { currentVersionId: version.id } });
  return asset.id;
}

function angleFor(analysis: ContentAnalysis, keyIdeaIds: string[] | undefined): string | null {
  if (!keyIdeaIds?.length) return null;
  const set = new Set(keyIdeaIds);
  const hit = analysis.contentAngles.find((a) => a.keyIdeaIds.some((id) => set.has(id)));
  return hit?.angle ?? null;
}

// --- deterministic templates (one per type) -----------------------

function template(
  type: ContentAssetTypeKey,
  analysis: ContentAnalysis,
  sourceTitle: string,
): Array<Record<string, unknown>> {
  const ideas = analysis.keyIdeas.map((k) => k.idea);
  const allIds = analysis.keyIdeas.map((k) => k.id);
  const kw = analysis.keywords[0] ?? analysis.topics[0] ?? 'this topic';
  const base = sourceTitle || analysis.summary;
  switch (type) {
    case 'YT_TITLE_ALTERNATIVES':
      return [
        {
          options: [
            base,
            `${base} (what I learned)`,
            `The truth about ${kw}`,
            `${kw}: a practical walkthrough`,
            `How to think about ${kw}`,
          ],
          keyIdeaIds: allIds,
        },
      ];
    case 'YT_DESCRIPTION':
      return [
        {
          body: `${analysis.summary}\n\nIn this video:\n${ideas
            .slice(0, 5)
            .map((i) => `- ${i}`)
            .join('\n')}\n\nTopics: ${analysis.topics.join(', ')}`,
          keyIdeaIds: allIds,
        },
      ];
    case 'YT_CHAPTERS':
      return [
        {
          chapters: [
            { timestamp: '0:00', title: 'Intro' },
            ...ideas.slice(0, 6).map((i) => ({ title: i.slice(0, 60) })),
          ],
          keyIdeaIds: allIds,
        },
      ];
    case 'HOOK':
      return [
        {
          options: [
            `Here's what nobody tells you about ${kw}.`,
            `I was wrong about ${kw} — here's why.`,
            `${ideas[0] ?? base}`,
            `Stop doing ${kw} the hard way.`,
          ],
          format: 'spoken',
          keyIdeaIds: allIds,
        },
      ];
    case 'FAQ':
      return [
        {
          items: ideas.slice(0, 4).map((i) => ({
            question: `What about ${i.split(' ').slice(0, 6).join(' ')}?`,
            answer: i,
          })),
          keyIdeaIds: allIds,
        },
      ];
    case 'SHORTS_IDEA':
    case 'TIKTOK_IDEA':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        title: a.angle.slice(0, 80),
        ...(type === 'TIKTOK_IDEA' ? { concept: a.rationale } : {}),
        hook: `${ideas[0] ?? base}`.slice(0, 120),
        beats: ideas.slice(0, 3).length >= 2 ? ideas.slice(0, 3) : [...ideas, base].slice(0, 2),
        onScreenText: [],
        keyIdeaIds: a.keyIdeaIds,
      }));
    case 'TIKTOK_CAPTION':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        caption: `${a.angle}. ${ideas[0] ?? ''}`.slice(0, 150),
        hashtags: analysis.keywords.slice(0, 4),
        keyIdeaIds: a.keyIdeaIds,
      }));
    case 'SCRIPT':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        format: 'short-form',
        hook: `${ideas[0] ?? base}`.slice(0, 120),
        script: `${a.angle}.\n\n${ideas.slice(0, 4).join(' ')}\n\nThat's the core of it.`,
        callToAction: 'Follow for more.',
        keyIdeaIds: a.keyIdeaIds,
      }));
    case 'SOCIAL_POST':
      return (['x', 'linkedin', 'generic'] as const).slice(0, MULTI_COUNT).map((platform) => ({
        platform,
        body: `${analysis.summary}\n\n${ideas
          .slice(0, 3)
          .map((i) => `• ${i}`)
          .join('\n')}`,
        hashtags: analysis.keywords.slice(0, 3),
        keyIdeaIds: allIds,
      }));
    case 'BLOG_IDEA':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        workingTitle: `${a.angle}: ${base}`.slice(0, 90),
        angle: a.angle,
        targetReader: 'Someone researching ' + kw,
        keyPoints: ideas.slice(0, 4).length >= 2 ? ideas.slice(0, 4) : [...ideas, base].slice(0, 2),
        keyIdeaIds: a.keyIdeaIds,
      }));
    case 'SEO_ARTICLE_OUTLINE':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        workingTitle: `${base}: a complete guide`.slice(0, 90),
        targetQuery: kw,
        searchIntent: 'informational',
        sections: [
          { heading: 'Overview', bullets: [analysis.summary] },
          ...ideas
            .slice(0, 4)
            .map((i) => ({ heading: i.split(' ').slice(0, 6).join(' '), bullets: [i] })),
          {
            heading: 'Key takeaways',
            bullets: analysis.audienceTakeaways.length
              ? analysis.audienceTakeaways
              : ideas.slice(0, 3),
          },
        ],
        internalLinkIdeas: [],
        keyIdeaIds: a.keyIdeaIds,
      }));
    case 'NEWSLETTER_IDEA':
      return analysis.contentAngles.slice(0, MULTI_COUNT).map((a) => ({
        subjectLines: [`${base}`, `What I learned about ${kw}`, `${a.angle}`],
        angle: a.angle,
        outline: ideas.slice(0, 4).length >= 2 ? ideas.slice(0, 4) : [...ideas, base].slice(0, 2),
        keyIdeaIds: a.keyIdeaIds,
      }));
    default: {
      const _x: never = type;
      return [{ note: String(_x) }];
    }
  }
}

function requestSchema(type: ContentAssetTypeKey) {
  const { schema, multi } = GEN_SCHEMAS[type];
  return multi ? z.object({ items: z.array(schema).min(1).max(MULTI_COUNT) }) : schema;
}

const GEN_SYSTEM = `You repurpose already-created content. You are given a CONTENT ANALYSIS with KEY IDEAS and CONTENT ANGLES. Generate the requested deliverable.

Rules:
- Build only on the KEY IDEAS provided. Do not invent statistics, quotes, names, dates, or claims that are not supported by the analysis.
- Every item lists the keyIdeaIds it draws on.
- Never guarantee or promise views, revenue, virality, or search rankings.
- Match the platform's norms (length, tone). Keep it ready-to-edit, not final.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

export async function generateAssets(
  deps: GenerateDeps,
  opts: {
    organizationId: string;
    userId: string;
    projectId: string;
    types?: ContentAssetTypeKey[];
    trigger?: string;
  },
): Promise<GenerateResult> {
  const db = deps.db ?? prisma;
  let project = await db.repurposeProject.findFirst({
    where: { id: opts.projectId, organizationId: opts.organizationId, deletedAt: null },
  });
  if (!project) throw AppError.notFound('Project');

  if (!project.analysis) {
    await analyzeProject(
      { db, model: deps.model },
      { organizationId: opts.organizationId, projectId: project.id },
    );
    project = await db.repurposeProject.findFirst({ where: { id: project.id } });
  }
  const analysis = project!.analysis as ContentAnalysis | null;
  if (!analysis) throw AppError.validation('The project could not be analyzed.');

  const types = (opts.types && opts.types.length ? opts.types : ALL_ASSET_TYPES).filter((t) =>
    ALL_ASSET_TYPES.includes(t),
  );
  await db.repurposeProject.update({ where: { id: project!.id }, data: { status: 'GENERATING' } });

  const run = deps.model
    ? await db.agentRun.create({
        data: {
          organizationId: opts.organizationId,
          agent: 'content-generator',
          status: 'RUNNING',
          trigger: opts.trigger ?? 'manual',
          input: { projectId: project!.id, types },
          startedAt: new Date(),
        },
      })
    : null;

  const sourceTitle = project!.sourceTitle ?? analysis.summary;
  const assetIds: string[] = [];
  const byType: Record<string, number> = {};
  const totalUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  let model: string | undefined;
  let provider: string | undefined;

  // Each type's generation is an independent model call with its own template
  // fallback on failure — run them concurrently instead of one at a time,
  // which otherwise serializes up to 13 AI calls. DB writes below stay
  // sequential (cheap, and keeps assetIds/byType in the original `types`
  // order), only the AI round-trips are parallelized.
  const generationResults = await Promise.all(
    types.map(async (type) => {
      const { multi, platform } = GEN_SCHEMAS[type];
      let items: Array<Record<string, unknown>> = [];
      let usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
      let usedModel: string | undefined;
      let usedProvider: string | undefined;

      if (deps.model) {
        try {
          const res = await deps.model.generateObject({
            schema: requestSchema(type),
            system: GEN_SYSTEM,
            prompt: `${wrapUntrusted(
              'CONTENT_ANALYSIS',
              `ANALYSIS:\n${JSON.stringify(
                {
                  summary: analysis.summary,
                  tone: analysis.tone,
                  keyIdeas: analysis.keyIdeas,
                  contentAngles: analysis.contentAngles,
                  keywords: analysis.keywords,
                },
                null,
                1,
              ).slice(0, 9000)}\n\nSOURCE TITLE: ${sourceTitle}`,
            )}\n\nGenerate: ${GEN_SCHEMAS[type].label}${
              multi ? ` (up to ${MULTI_COUNT} distinct items)` : ''
            }.`,
          });
          usage = {
            promptTokens: res.usage.promptTokens,
            completionTokens: res.usage.completionTokens,
            costUsd: res.usage.estimatedCostUsd,
          };
          usedModel = res.usage.model;
          usedProvider = res.usage.provider;
          const obj = res.object as Record<string, unknown>;
          items = multi ? (obj.items as Array<Record<string, unknown>>) : [obj];
          const flat = JSON.stringify(items);
          if (GUARANTEE_RE.test(flat)) {
            log.warn({ type }, 'generated content contained guarantee phrasing; using template');
            items = template(type, analysis, sourceTitle);
          }
        } catch (e) {
          log.warn({ type, err: String(e) }, 'generation failed for type; using template');
          items = template(type, analysis, sourceTitle);
        }
      } else {
        items = template(type, analysis, sourceTitle);
      }

      // Scrub before anything is rendered/persisted (docs/AI-SECURITY-AUDIT.md
      // finding 2), regardless of which branch above produced `items`.
      items = scrubModelOutput(items);

      return { type, platform, multi, items, usage, usedModel, usedProvider };
    }),
  );

  for (const {
    type,
    platform,
    multi,
    items,
    usage,
    usedModel,
    usedProvider,
  } of generationResults) {
    totalUsage.promptTokens += usage.promptTokens;
    totalUsage.completionTokens += usage.completionTokens;
    totalUsage.costUsd += usage.costUsd;
    if (usedModel) model = usedModel;
    if (usedProvider) provider = usedProvider;

    for (const data of items.slice(0, multi ? MULTI_COUNT : 1)) {
      const rendered = renderAsset(type, data);
      const id = await createAssetWithVersion(db, {
        projectId: project!.id,
        organizationId: opts.organizationId,
        type,
        platform,
        title: rendered.title,
        body: rendered.body,
        structured: rendered.structured,
        sourceAngle: angleFor(analysis, data.keyIdeaIds as string[] | undefined),
        agentRunId: run?.id ?? null,
      });
      assetIds.push(id);
      byType[type] = (byType[type] ?? 0) + 1;
    }
  }

  await db.repurposeProject.update({ where: { id: project!.id }, data: { status: 'READY' } });
  if (run) {
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        output: { assetIds: assetIds.length, byType } as never,
        finishedAt: new Date(),
        tokensPrompt: totalUsage.promptTokens,
        tokensCompletion: totalUsage.completionTokens,
        costUsd: totalUsage.costUsd,
        model,
        provider,
      },
    });
  }
  await recordAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.userId,
      action: 'content.assets.generated',
      actorType: run ? 'AGENT' : 'SYSTEM',
      targetType: 'repurpose_project',
      targetId: project!.id,
      metadata: { count: assetIds.length, types: types.length, model: Boolean(deps.model) },
    },
    db,
  );

  return {
    projectId: project!.id,
    agentRunId: run?.id ?? null,
    assetIds,
    usedModel: Boolean(deps.model),
    byType,
  };
}
