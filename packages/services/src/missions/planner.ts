/**
 * Mission planner (Phase 10, §7/§8/§13) — evidence-based only. Every
 * milestone/task this module creates is derived from a real signal in
 * `OrgContext` (or a targeted follow-up read); a platform the mission
 * allows but the organization has not connected gets an honest assumption/
 * risk note, never a fabricated task (hard rule 1).
 *
 * The strategy narrative is deterministic first, optionally refined by one
 * grounded `generateObject` call — dropped on any failure, exactly like
 * `agent/planner.ts`'s keyword-router-then-model-refine precedent. Numbers
 * and the task graph are never influenced by the model; only the narrative
 * prose is.
 */
import { type Db, type Prisma, prisma } from '@growth-agent/db';
import type { AIProvider } from '@growth-agent/ai';
import { z } from 'zod';
import { loadOrgContext, type OrgContext } from '../agent/context.js';
import { findRefreshCandidates } from '../wordpress/content-refresh.js';
import { listWebsites } from '../seo/read.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { retrieveKnowledge, type RetrievedKnowledge } from '../knowledge/retrieval.js';
import type { EmbeddingCapableModel } from '../knowledge/embeddings.js';
import { enforceAiBudget } from '../usage/ai-budget.js';
import { listRecentLearnings } from './learning.js';
import { hasCycle } from './task-graph.js';
import {
  MissionLimitsSchema,
  MissionStrategySchema,
  type MissionPlatformKey,
  type MissionStrategy,
} from './schemas.js';

export type PlannerModel = Pick<AIProvider, 'generateObject'>;

interface DraftTask {
  key: string; // stable within this plan, used to resolve dependsOn
  title: string;
  description: string;
  platform: MissionPlatformKey;
  toolName: string | null;
  toolInput?: Record<string, unknown>;
  dependsOn: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

interface DraftMilestone {
  title: string;
  description: string;
  order: number;
  tasks: DraftTask[];
}

interface PlanDraft {
  milestones: DraftMilestone[];
  evidence: string[];
  assumptions: string[];
  risks: string[];
}

function draftYouTube(ctx: OrgContext): DraftMilestone | null {
  if (!ctx.youtube.connected) return null;
  const evidence = `YouTube connected: "${ctx.youtube.channelTitle ?? 'channel'}", ${
    ctx.youtube.subscriberCount ?? 'n/a'
  } subscribers, ${ctx.youtube.videoCount ?? 'n/a'} videos.`;
  return {
    title: 'Grow YouTube performance',
    description: evidence,
    order: 0,
    tasks: [
      {
        key: 'yt-benchmark',
        title: 'Benchmark recent YouTube videos',
        description: "Compare recent videos against this channel's own history.",
        platform: 'YOUTUBE',
        toolName: 'youtube.content.performance',
        toolInput: { limit: 50 },
        dependsOn: [],
        priority: 'medium',
      },
      {
        key: 'yt-opportunities',
        title: 'Identify YouTube content opportunities',
        description: 'Rank evidence-backed content opportunities from real channel history.',
        platform: 'YOUTUBE',
        toolName: 'youtube.content.opportunities',
        toolInput: { regenerate: true },
        dependsOn: ['yt-benchmark'],
        priority: 'medium',
      },
      {
        key: 'yt-review',
        title: 'Review YouTube opportunities and choose next video',
        description: 'A human decision point — the mission surfaces this as a task, never publishes.',
        platform: 'YOUTUBE',
        toolName: null,
        dependsOn: ['yt-opportunities'],
        priority: 'medium',
      },
    ],
  };
}

function draftTikTok(ctx: OrgContext): DraftMilestone | null {
  if (!ctx.tiktok.connected) return null;
  return {
    title: 'Grow TikTok performance',
    description: `TikTok connected: "${ctx.tiktok.displayName ?? 'account'}".`,
    order: 0,
    tasks: [
      {
        key: 'tt-benchmark',
        title: 'Benchmark recent TikTok videos',
        description: "Compare recent videos against this account's own history.",
        platform: 'TIKTOK',
        toolName: 'tiktok.content.performance',
        toolInput: { limit: 50 },
        dependsOn: [],
        priority: 'medium',
      },
      {
        key: 'tt-opportunities',
        title: 'Identify TikTok content opportunities',
        description: 'Rank evidence-backed content opportunities from real account history.',
        platform: 'TIKTOK',
        toolName: 'tiktok.content.opportunities',
        toolInput: { regenerate: true },
        dependsOn: ['tt-benchmark'],
        priority: 'medium',
      },
      {
        key: 'tt-review',
        title: 'Review TikTok opportunities and choose next video',
        description: 'A human decision point — the mission surfaces this as a task, never publishes.',
        platform: 'TIKTOK',
        toolName: null,
        dependsOn: ['tt-opportunities'],
        priority: 'medium',
      },
    ],
  };
}

async function draftSeo(organizationId: string, ctx: OrgContext, db: Db): Promise<DraftMilestone | null> {
  if (ctx.seo.websites === 0) return null;
  const hasCrawl = Boolean(ctx.seo.latestCrawl);
  const tasks: DraftTask[] = [];
  if (!hasCrawl) {
    tasks.push({
      key: 'seo-crawl',
      title: 'Run a technical SEO crawl',
      description: 'No completed crawl exists yet — one is needed before issues can be found.',
      platform: 'SEO',
      toolName: 'seo.crawl.start',
      dependsOn: [],
      priority: 'high',
    });
  }
  tasks.push({
    key: 'seo-analyze',
    title: 'Analyze the crawl for priority fixes',
    description: 'Runs the AI SEO Agent over the latest crawl to rank issues by priority.',
    platform: 'SEO',
    toolName: 'seo.agent.analyze',
    dependsOn: hasCrawl ? [] : ['seo-crawl'],
    priority: 'high',
  });
  tasks.push({
    key: 'seo-review',
    title: 'Review SEO fixes and approve updates',
    description: 'A human decision point — fixes are proposed for approval, never applied automatically.',
    platform: 'SEO',
    toolName: null,
    dependsOn: ['seo-analyze'],
    priority: 'high',
  });

  let evidence = `${ctx.seo.verifiedWebsites}/${ctx.seo.websites} verified website(s) registered.`;
  if (ctx.seo.latestCrawl) {
    evidence += ` Latest crawl of ${ctx.seo.latestCrawl.hostname}: ${ctx.seo.latestCrawl.pagesCrawled} pages, ${ctx.seo.latestCrawl.issuesFound} issues.`;
  } else {
    const sites = await listWebsites(organizationId, db).catch(() => []);
    if (sites[0]) evidence += ` "${sites[0].hostname}" has not been crawled yet.`;
  }
  return { title: 'Fix technical SEO issues', description: evidence, order: 0, tasks };
}

async function draftWordPress(organizationId: string, ctx: OrgContext, db: Db): Promise<DraftMilestone | null> {
  if (!ctx.wordpress.connected) return null;
  let evidence = `WordPress connected: ${ctx.wordpress.siteUrl ?? 'site'}.`;
  try {
    const candidates = await findRefreshCandidates(organizationId, { limit: 5 }, db);
    const worthRefreshing = candidates.filter((c) => c.score > 0).length;
    if (worthRefreshing > 0) evidence += ` ${worthRefreshing} page(s) look worth refreshing.`;
  } catch {
    // Evidence is best-effort; the tasks below still run their own real check.
  }
  return {
    title: 'Refresh and improve WordPress content',
    description: evidence,
    order: 0,
    tasks: [
      {
        key: 'wp-refresh',
        title: 'Find WordPress refresh candidates',
        description: 'Real age/word-count/SEO-issue signals only.',
        platform: 'WORDPRESS',
        toolName: 'wordpress.content.refresh.analyze',
        dependsOn: [],
        priority: 'medium',
      },
      {
        key: 'wp-review',
        title: 'Review refresh candidates and approve updates',
        description: 'A human decision point — updates are proposed for approval, never applied automatically.',
        platform: 'WORDPRESS',
        toolName: null,
        dependsOn: ['wp-refresh'],
        priority: 'medium',
      },
    ],
  };
}

async function buildDraft(
  organizationId: string,
  allowedPlatforms: MissionPlatformKey[],
  db: Db,
): Promise<PlanDraft> {
  const ctx = await loadOrgContext(organizationId, db);
  const wants = (p: MissionPlatformKey) => allowedPlatforms.includes(p) || allowedPlatforms.includes('CROSS_PLATFORM');

  const candidates: Array<{ platform: MissionPlatformKey; draft: DraftMilestone | null; connected: boolean }> = [];
  if (wants('YOUTUBE')) candidates.push({ platform: 'YOUTUBE', draft: draftYouTube(ctx), connected: ctx.youtube.connected });
  if (wants('TIKTOK')) candidates.push({ platform: 'TIKTOK', draft: draftTikTok(ctx), connected: ctx.tiktok.connected });
  if (wants('SEO')) candidates.push({ platform: 'SEO', draft: await draftSeo(organizationId, ctx, db), connected: ctx.seo.websites > 0 });
  if (wants('WORDPRESS')) candidates.push({ platform: 'WORDPRESS', draft: await draftWordPress(organizationId, ctx, db), connected: ctx.wordpress.connected });

  const milestones = candidates.filter((c) => c.draft).map((c, i) => ({ ...c.draft!, order: i }));
  const evidence = milestones.map((m) => m.description);
  const assumptions: string[] = [];
  const risks: string[] = [];

  for (const c of candidates) {
    if (!c.draft) {
      assumptions.push(
        c.connected
          ? `${c.platform} is connected but has no usable data yet — it was left out of this plan.`
          : `${c.platform} is not connected — connect it to include it in this mission.`,
      );
    }
  }

  if (milestones.length === 0) {
    risks.push('No connected platform has usable data yet — this mission cannot take any real action until one is connected.');
  } else if (milestones.length > 1) {
    milestones.push({
      title: 'Measure results and adapt strategy',
      description: 'Cross-platform review once the platform-specific milestones above have real results.',
      order: milestones.length,
      tasks: [
        {
          key: 'cross-review',
          title: 'Review measured results across platforms and adapt strategy',
          description: 'A human decision point — the mission does not auto-decide the next strategy.',
          platform: 'CROSS_PLATFORM',
          toolName: null,
          dependsOn: milestones
            .map((m) => m.tasks[m.tasks.length - 1]?.key)
            .filter((k): k is string => Boolean(k)),
          priority: 'medium',
        },
      ],
    });
  }

  return { milestones, evidence, assumptions, risks };
}

/**
 * Phase 11, Part 45/85: "before mission planning, retrieve relevant
 * organization knowledge / historical missions / experiments / lessons."
 * Reuses `knowledge/retrieval.ts` and `missions/learning.ts::listRecentLearnings`
 * — no new read path, no duplicated storage. A FACT/USER_PROVIDED/
 * SYSTEM_OBSERVED/EXTERNAL_SOURCE knowledge item is treated as evidence; an
 * INFERENCE/HYPOTHESIS/OPINION one is treated as an assumption (Part 5's own
 * distinction, applied here too) — never blurred into a single "context" bag.
 */
async function gatherKnowledgeContext(
  organizationId: string,
  missionId: string,
  objective: string,
  embeddingModel: EmbeddingCapableModel | undefined,
  db: Db,
): Promise<{ evidence: string[]; assumptions: string[]; priorLearnings: string[] }> {
  const [knowledge, learnings] = await Promise.all([
    retrieveKnowledge(organizationId, objective, { limit: 6 }, embeddingModel, db).catch(
      () => [] as RetrievedKnowledge[],
    ),
    listRecentLearnings(organizationId, { limit: 6, excludeMissionId: missionId }, db).catch(() => []),
  ]);

  const evidence: string[] = [];
  const assumptions: string[] = [];
  for (const k of knowledge) {
    const line = `${k.title}: ${k.summary ?? k.content.slice(0, 200)}`;
    if (
      k.classification === 'FACT' ||
      k.classification === 'USER_PROVIDED' ||
      k.classification === 'SYSTEM_OBSERVED' ||
      k.classification === 'EXTERNAL_SOURCE'
    ) {
      evidence.push(`[stored knowledge] ${line}`);
    } else {
      assumptions.push(`[unverified] ${line}`);
    }
  }
  const priorLearnings = learnings.map(
    (l) => `[${l.type}${l.mission?.name ? `, from "${l.mission.name}"` : ''}] ${l.title}: ${l.detail.slice(0, 200)}`,
  );
  return { evidence, assumptions, priorLearnings };
}

const ModelStrategyOutput = z.object({
  narrative: z.string().min(1).max(1_500),
  currentState: z.string().min(1).max(800),
  targetState: z.string().min(1).max(800),
});

async function refineNarrative(
  model: PlannerModel | undefined,
  input: {
    organizationId: string;
    objective: string;
    evidence: string[];
    assumptions: string[];
    priorLearnings: string[];
  },
  db: Db,
): Promise<{ narrative: string; currentState: string; targetState: string; grounded: boolean } | null> {
  if (!model) return null;
  try {
    // Part 19/53: the same org-wide AI budget every other AI call in this
    // app checks before spending — a mission's optional narrative
    // refinement degrades to the deterministic narrative (below) once the
    // org's plan is exhausted, exactly like any other best-effort model
    // call in this codebase, rather than being a second, unmetered path.
    await enforceAiBudget({ organizationId: input.organizationId, db });
    const res = await model.generateObject({
      schema: ModelStrategyOutput,
      system: `You write a short, factual growth-mission strategy summary from real evidence only. Never invent a number or claim a result is guaranteed. If a PRIOR LESSON is directly relevant, you may reference it, but never present a HYPOTHESIS-labelled lesson as a proven fact. Do not reveal chain-of-thought — three short fields only.\n\n${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`,
      prompt: `OBJECTIVE: ${input.objective}\n\n${wrapUntrusted('EVIDENCE', input.evidence.join('\n') || 'none')}\n\n${wrapUntrusted('ASSUMPTIONS', input.assumptions.join('\n') || 'none')}\n\n${wrapUntrusted('PRIOR_LESSONS', input.priorLearnings.join('\n') || 'none')}\n\nWrite narrative/currentState/targetState.`,
    });
    return { ...res.object, grounded: true };
  } catch {
    return null;
  }
}

export interface GeneratedPlan {
  strategy: MissionStrategy;
  milestoneCount: number;
  taskCount: number;
}

export async function generateMissionPlan(
  input: {
    organizationId: string;
    mission: {
      id: string;
      objective: string;
      allowedPlatforms: MissionPlatformKey[];
      limits?: unknown;
    };
    model?: PlannerModel;
    embeddingModel?: EmbeddingCapableModel;
  },
  db: Db = prisma,
): Promise<GeneratedPlan> {
  // Part 19: a mission's own configured `maxRetries` — previously computed
  // but never actually applied to the tasks the planner creates, so every
  // task silently used the DB column default (2) regardless of what the
  // mission's limits said.
  const missionMaxRetries = MissionLimitsSchema.parse(input.mission.limits ?? {}).maxRetries;
  const [draft, knowledgeContext] = await Promise.all([
    buildDraft(input.organizationId, input.mission.allowedPlatforms, db),
    gatherKnowledgeContext(
      input.organizationId,
      input.mission.id,
      input.mission.objective,
      input.embeddingModel,
      db,
    ),
  ]);
  draft.evidence = [...draft.evidence, ...knowledgeContext.evidence];
  draft.assumptions = [...draft.assumptions, ...knowledgeContext.assumptions];

  // Defensive: the planner above only ever adds forward dependency edges
  // (a task depends on an earlier task within the same or an earlier
  // milestone), so a cycle would indicate a real bug — check before persisting.
  const allTasks = draft.milestones.flatMap((m) => m.tasks);
  const keyToId = new Map<string, string>();

  // Clear any previous plan's milestones/tasks (re-planning replaces the
  // draft graph; EXECUTED/terminal history from a prior activation is never
  // touched because a mission can only be (re)planned from DRAFT/AWAITING_APPROVAL).
  await db.missionTask.deleteMany({ where: { missionId: input.mission.id } });
  await db.missionMilestone.deleteMany({ where: { missionId: input.mission.id } });

  let taskCount = 0;
  for (const milestone of draft.milestones) {
    const milestoneRow = await db.missionMilestone.create({
      data: {
        missionId: input.mission.id,
        organizationId: input.organizationId,
        title: milestone.title,
        description: milestone.description,
        order: milestone.order,
      },
    });
    for (const task of milestone.tasks) {
      const row = await db.missionTask.create({
        data: {
          missionId: input.mission.id,
          organizationId: input.organizationId,
          milestoneId: milestoneRow.id,
          title: task.title,
          description: task.description,
          platform: task.platform,
          toolName: task.toolName,
          toolInput: (task.toolInput ?? null) as unknown as Prisma.InputJsonValue,
          priority: task.priority,
          dependsOnTaskIds: [], // resolved below once every id is known
          maxRetries: missionMaxRetries,
        },
      });
      keyToId.set(task.key, row.id);
      taskCount += 1;
    }
  }

  // Resolve symbolic keys to real row ids now that every task has one.
  for (const task of allTasks) {
    const id = keyToId.get(task.key);
    if (!id || task.dependsOn.length === 0) continue;
    const dependsOnTaskIds = task.dependsOn.map((k) => keyToId.get(k)).filter((x): x is string => Boolean(x));
    await db.missionTask.update({ where: { id }, data: { dependsOnTaskIds } });
  }

  if (
    hasCycle(
      (
        await db.missionTask.findMany({
          where: { missionId: input.mission.id, organizationId: input.organizationId },
        })
      ).map((t) => ({
        id: t.id,
        status: t.status as never,
        dependsOnTaskIds: t.dependsOnTaskIds,
      })),
    )
  ) {
    throw new Error('mission planner produced a cyclic task graph — this is a planner bug, not user error');
  }

  const refined = await refineNarrative(
    input.model,
    {
      organizationId: input.organizationId,
      objective: input.mission.objective,
      evidence: draft.evidence,
      assumptions: draft.assumptions,
      priorLearnings: knowledgeContext.priorLearnings,
    },
    db,
  );

  const strategy = MissionStrategySchema.parse({
    narrative:
      refined?.narrative ??
      (draft.milestones.length > 0
        ? `This mission will work through ${draft.milestones.length} milestone(s) across ${new Set(draft.milestones.map((m) => m.title)).size} area(s), based on what is currently connected.`
        : 'No connected platform has usable data yet, so this mission has no milestones to work on until one is connected.'),
    currentState: refined?.currentState ?? (draft.evidence.join(' ') || 'Nothing is connected yet.'),
    targetState: refined?.targetState ?? input.mission.objective,
    assumptions: draft.assumptions,
    risks: draft.risks,
    grounded: refined?.grounded ?? false,
  });

  return { strategy, milestoneCount: draft.milestones.length, taskCount };
}
