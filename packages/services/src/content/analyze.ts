/**
 * CONTENT ANALYSIS → KEY IDEAS → CONTENT ANGLES.
 *
 * One `generateObject` call produces a `ContentAnalysis` from a fact sheet built
 * from the source. Grounding is light (creative stage): guarantee phrasing is
 * rejected, and any `sourceQuote` that does not actually appear in the source is
 * dropped rather than failing the run. Without a model, a deterministic analysis
 * is derived from the title / tags / first sentences.
 */
import type { AIProvider } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { ContentAnalysis } from './schemas.js';

const log = createLogger('content.analyze');

export type AnalyzeModel = Pick<AIProvider, 'generateObject'>;

export interface AnalyzeDeps {
  db?: Db;
  model?: AnalyzeModel;
}

export interface AnalyzeResult {
  projectId: string;
  analysis: ContentAnalysis;
  agentRunId: string | null;
  grounded: boolean;
  usedModel: boolean;
}

const GUARANTEE_RE =
  /\b(guarantee[ds]?|will (?:definitely|certainly) (?:go viral|rank|make money)|guaranteed (?:views|revenue|virality|ranking))\b/i;

interface ProjectSource {
  id: string;
  sourceTitle: string | null;
  sourceDescription: string | null;
  sourceTranscript: string | null;
  sourceBody: string | null;
  sourceTags: string[];
  sourceDurationSec: number | null;
}

export function sourceText(p: ProjectSource): string {
  return [p.sourceTitle, p.sourceDescription, p.sourceTranscript, p.sourceBody]
    .filter(Boolean)
    .join('\n\n');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstSentences(text: string, n: number): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25)
    .slice(0, n);
}

function buildFactSheet(p: ProjectSource): string {
  const lines: string[] = [];
  if (p.sourceTitle) lines.push(`TITLE: ${p.sourceTitle}`);
  if (p.sourceDurationSec) lines.push(`DURATION: ~${Math.round(p.sourceDurationSec / 60)} min`);
  if (p.sourceTags.length) lines.push(`TAGS: ${p.sourceTags.slice(0, 25).join(', ')}`);
  if (p.sourceDescription) lines.push(`DESCRIPTION:\n${p.sourceDescription.slice(0, 4000)}`);
  if (p.sourceTranscript)
    lines.push(`TRANSCRIPT (excerpt):\n${p.sourceTranscript.slice(0, 12000)}`);
  if (p.sourceBody) lines.push(`SOURCE CONTENT:\n${p.sourceBody.slice(0, 12000)}`);
  return lines.join('\n\n');
}

const SYSTEM = `You analyze a piece of source content so it can be repurposed. Produce a neutral CONTENT ANALYSIS, the reusable KEY IDEAS, and distinct CONTENT ANGLES.

Rules:
- Work only from the SOURCE provided. Do not invent facts, statistics, names, or quotes.
- A "sourceQuote" MUST be a verbatim span copied from the SOURCE. If you cannot copy one, omit it.
- Never guarantee views, revenue, virality, or rankings.
- Key ideas are the substance a creator could reuse; content angles are different ways to frame that substance for other formats/audiences. Each angle lists the keyIdeaIds it draws on.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

function deterministicAnalysis(p: ProjectSource): ContentAnalysis {
  const text = sourceText(p);
  const sentences = firstSentences(text, 6);
  const keyIdeas =
    sentences.length > 0
      ? sentences.slice(0, 5).map((s, i) => ({ id: `k${i + 1}`, idea: s }))
      : [{ id: 'k1', idea: p.sourceTitle ?? 'The main point of the source content.' }];
  const topics = [
    ...new Set(
      [
        ...(p.sourceTags ?? []),
        ...(p.sourceTitle ?? '')
          .split(/[^a-zA-Z0-9]+/)
          .filter((w) => w.length > 4)
          .slice(0, 5),
      ].map((t) => t.toLowerCase()),
    ),
  ].slice(0, 8);
  const allIds = keyIdeas.map((k) => k.id);
  return ContentAnalysis.parse({
    summary: sentences[0] ?? p.sourceTitle ?? 'Source content for repurposing.',
    contentType: 'unknown',
    tone: 'neutral',
    topics: topics.length ? topics : ['general'],
    keyIdeas,
    audienceTakeaways: sentences.slice(0, 3),
    contentAngles: [
      {
        id: 'a1',
        angle: 'A concise version for short-form video and social',
        rationale: 'Reaches viewers who will not watch the full piece.',
        keyIdeaIds: allIds.slice(0, 2).length ? allIds.slice(0, 2) : allIds,
      },
      {
        id: 'a2',
        angle: 'A written explainer / blog treatment',
        rationale: 'Captures search traffic and gives a durable reference.',
        keyIdeaIds: allIds,
      },
      {
        id: 'a3',
        angle: 'A beginner-friendly framing',
        rationale: 'Broadens the audience beyond people already familiar with the topic.',
        keyIdeaIds: allIds.slice(0, 3).length ? allIds.slice(0, 3) : allIds,
      },
    ],
    keywords: topics,
    disclaimers: [
      'Generated without an AI model — analysis is a mechanical summary of the source.',
    ],
  });
}

export async function analyzeProject(
  deps: AnalyzeDeps,
  opts: { organizationId: string; projectId: string; trigger?: string },
): Promise<AnalyzeResult> {
  const db = deps.db ?? prisma;
  const project = await db.repurposeProject.findFirst({
    where: { id: opts.projectId, organizationId: opts.organizationId, deletedAt: null },
  });
  if (!project) throw AppError.notFound('Project');

  const text = sourceText(project);
  if (text.trim().length < 40) {
    throw AppError.validation('The source has too little text to analyze.');
  }

  await db.repurposeProject.update({ where: { id: project.id }, data: { status: 'ANALYZING' } });

  // Thin source or no model → deterministic analysis.
  if (!deps.model || text.length < 200) {
    const analysis = scrubModelOutput(deterministicAnalysis(project));
    await db.repurposeProject.update({
      where: { id: project.id },
      data: { status: 'ANALYZED', analysis: analysis as never, analysisGrounded: true },
    });
    await recordAudit(
      {
        organizationId: opts.organizationId,
        action: 'content.project.analyzed',
        actorType: 'SYSTEM',
        targetType: 'repurpose_project',
        targetId: project.id,
        metadata: { model: false },
      },
      db,
    );
    return { projectId: project.id, analysis, agentRunId: null, grounded: true, usedModel: false };
  }

  const run = await db.agentRun.create({
    data: {
      organizationId: opts.organizationId,
      agent: 'content-analyst',
      status: 'RUNNING',
      trigger: opts.trigger ?? 'manual',
      input: { projectId: project.id, sourceType: project.sourceType },
      startedAt: new Date(),
    },
  });

  let analysis: ContentAnalysis | null = null;
  let grounded = true;
  let usage: Awaited<ReturnType<AnalyzeModel['generateObject']>>['usage'] | null = null;
  try {
    const res = await deps.model.generateObject({
      schema: ContentAnalysis,
      system: SYSTEM,
      prompt: `${wrapUntrusted('SOURCE_CONTENT', buildFactSheet(project))}\n\nProduce the analysis.`,
    });
    usage = res.usage;
    analysis = res.object;

    // Light grounding: drop non-verbatim quotes; reject guarantee phrasing.
    const haystack = normalize(text);
    const flat = [
      analysis.summary,
      ...analysis.keyIdeas.map((k) => k.idea),
      ...analysis.contentAngles.map((a) => `${a.angle} ${a.rationale}`),
    ].join(' ');
    if (GUARANTEE_RE.test(flat)) {
      grounded = false;
      log.warn(
        { agentRunId: run.id },
        'content analysis contained guarantee phrasing; using deterministic',
      );
      analysis = deterministicAnalysis(project);
    } else {
      analysis = {
        ...analysis,
        keyIdeas: analysis.keyIdeas.map((k) =>
          k.sourceQuote && !haystack.includes(normalize(k.sourceQuote))
            ? { id: k.id, idea: k.idea }
            : k,
        ),
      };
    }
  } catch (e) {
    log.warn(
      { agentRunId: run.id, err: String(e) },
      'content analysis model call failed; using deterministic',
    );
    grounded = false;
    analysis = deterministicAnalysis(project);
  }

  // Scrub before anything is persisted or returned (docs/AI-SECURITY-AUDIT.md
  // finding 2), on every path — model-grounded, guarantee-dropped, or the
  // model-call-failed fallback.
  analysis = scrubModelOutput(analysis);

  await db.repurposeProject.update({
    where: { id: project.id },
    data: {
      status: 'ANALYZED',
      analysis: analysis as never,
      analysisAgentRunId: run.id,
      analysisGrounded: grounded,
    },
  });
  await db.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      output: analysis as never,
      finishedAt: new Date(),
      tokensPrompt: usage?.promptTokens ?? 0,
      tokensCompletion: usage?.completionTokens ?? 0,
      costUsd: usage?.estimatedCostUsd ?? 0,
      model: usage?.model,
      provider: usage?.provider,
    },
  });
  await recordAudit(
    {
      organizationId: opts.organizationId,
      action: 'content.project.analyzed',
      actorType: 'AGENT',
      targetType: 'repurpose_project',
      targetId: project.id,
      metadata: { model: true, grounded },
    },
    db,
  );

  return { projectId: project.id, analysis, agentRunId: run.id, grounded, usedModel: true };
}
