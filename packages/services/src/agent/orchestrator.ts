/**
 * The Unified AI Growth Agent orchestrator (master instruction "PHASE 7").
 *
 * Pipeline per turn: load context + memory + history → PLAN (tool selection) →
 * EXECUTE capabilities → COLLECT evidence → SYNTHESIZE a grounded structured
 * answer → GENERATE the response text (streamed) → PERSIST + update memory.
 *
 * Private chain-of-thought is never surfaced. The user sees only: analysis
 * summary · evidence · decisions · recommendations · actions. External-system
 * actions are proposed with `requiresConfirmation`, never executed here.
 */
import type { AIProvider } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { checkGroundingFields, type GroundingField } from '../agents/grounding.js';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { recordAgentRunEvent } from './events.js';
import {
  CAPABILITY_BY_ID,
  type AgentModel,
  type Capability,
  type CapabilityContext,
  type CapabilityRecommendation,
  type CapabilityResult,
  describeCapabilities,
} from './capabilities.js';
import {
  type ActionClass,
  decide as decideGovernance,
  getGovernancePolicy,
} from '../governance/index.js';
import type { IntegrationKey } from '../integrations/contract.js';
import { loadOrgContext, summarizeOrgContext, type OrgContext } from './context.js';
import { createConversation, touchConversation } from './conversations.js';
import { loadMemory, rememberFromTurn, summarizeMemory } from './memory.js';
import { planTurn } from './planner.js';
import {
  type CapabilityId,
  type GrowthAgentResponse as GrowthAgentResponseT,
  GrowthAgentResponse,
  type TurnPlan,
} from './schemas.js';

/** Which integration + action class each capability exercises (governance). */
const CAPABILITY_GOVERNANCE: Partial<
  Record<CapabilityId, { integration: IntegrationKey; cls: ActionClass }>
> = {
  'youtube-analyst': { integration: 'YOUTUBE', cls: 'analyze' },
  'youtube-monetization': { integration: 'YOUTUBE', cls: 'analyze' },
  'tiktok-analyst': { integration: 'TIKTOK', cls: 'analyze' },
  'seo-agent': { integration: 'WEBSITE', cls: 'analyze' },
};

const log = createLogger('agent.orchestrator');

export type SynthModel = Pick<AIProvider, 'generateObject'>;
export type ResponseModel = Pick<AIProvider, 'streamText'>;

export interface GrowthAgentDeps {
  db?: Db;
  /** Used for planning, capability agents, synthesis and memory extraction. */
  model?: AgentModel & Partial<SynthModel>;
  /** Used for streaming the final natural-language reply. */
  responseModel?: ResponseModel;
  /** Override the capability registry (tests / a restricted set). */
  capabilities?: Map<string, Capability>;
}

export interface RunTurnOptions {
  organizationId: string;
  userId: string;
  /** Omit to start a new conversation. */
  conversationId?: string;
  message: string;
  trigger?: string;
  /**
   * Aborts the orchestrator's own direct model calls (synthesis, response
   * writing) immediately — the SDK's real abort mechanism, not a poll.
   * Capability sub-agent calls (youtube-analyst, etc.) are not threaded with
   * this signal; a run cancelled mid-capability finishes that capability
   * and stops at the next checkpoint instead (see `checkCancelled`) — this
   * keeps cancellation from interrupting a capability mid-write.
   */
  signal?: AbortSignal;
}

export type TurnEvent =
  | { type: 'run_created'; agentRunId: string; conversationId: string }
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      conversationId: string;
      messageId: string;
      agentRunId: string;
      title: string;
      blocks: GrowthAgentResponseT;
    }
  | { type: 'error'; message: string }
  | { type: 'cancelled'; agentRunId: string };

export interface RunTurnResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  agentRunId: string;
  title: string;
  responseText: string;
  blocks: GrowthAgentResponseT;
  plan: TurnPlan;
  capabilityResults: CapabilityResult[];
}

const SYNTH_SYSTEM = `You are the Unified AI Growth Agent. Capability agents have already run and produced evidence. Your job is to combine their results into ONE concise, structured answer for the user.

Rules you must follow exactly:
- Work ONLY from the EVIDENCE list and capability summaries provided.
- Every free-text field must cite evidenceRefs that are ids from the EVIDENCE list. If you cannot cite evidence, do not make the claim.
- Do NOT state any number that is not in the evidence (small counts, years and 0-100 scores are fine).
- NEVER reveal step-by-step reasoning. "decisions" is a short list of WHAT you did and why (one line each), not how you thought.
- NEVER promise or guarantee rankings, revenue, views, subscribers or traffic. Describe likely direction only.
- Keep recommendations concrete: Problem, Why it matters, How to fix it, Expected benefit.
- If a capability reported a missing prerequisite, put that in "decisions" and reflect it in the summary.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

// --- public: non-streaming full turn ---------------------------------

export async function runGrowthAgentTurn(
  deps: GrowthAgentDeps,
  opts: RunTurnOptions,
): Promise<RunTurnResult> {
  const events: TurnEvent[] = [];
  let result: RunTurnResult | null = null;
  for await (const ev of streamGrowthAgentTurn(deps, opts)) {
    events.push(ev);
    if (ev.type === 'error') throw new AppError('internal_error', ev.message);
  }
  // Rebuild the result from the persisted rows.
  const done = events.find((e): e is Extract<TurnEvent, { type: 'done' }> => e.type === 'done');
  if (!done) throw new AppError('internal_error', 'agent turn did not complete');
  result = internalResults.get(done.agentRunId) ?? null;
  internalResults.delete(done.agentRunId);
  if (!result) throw new AppError('internal_error', 'agent turn result missing');
  return result;
}

// Bridge so the non-streaming wrapper can recover the full result object.
const internalResults = new Map<string, RunTurnResult>();

/**
 * Checkpoint-based cancellation (Part 20): cheap enough to call between every
 * stage. `cancelAgentRun` (cancellation.ts) is the only other writer of
 * `CANCELLED` for a chat-triggered run, via a conditional `updateMany` that
 * only succeeds from QUEUED/RUNNING — so once this observes CANCELLED, the
 * turn is authoritatively over and must not overwrite that state.
 */
async function checkCancelled(runId: string, db: Db): Promise<boolean> {
  const row = await db.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
  return row?.status === 'CANCELLED';
}

// --- public: streaming turn -----------------------------------------

export async function* streamGrowthAgentTurn(
  deps: GrowthAgentDeps,
  opts: RunTurnOptions,
): AsyncGenerator<TurnEvent, void, unknown> {
  const db = deps.db ?? prisma;
  const message = opts.message.trim();
  if (!message) {
    yield { type: 'error', message: 'Empty message.' };
    return;
  }

  // 1. conversation + history
  let conversation = opts.conversationId
    ? await db.aIConversation.findFirst({
        where: {
          id: opts.conversationId,
          organizationId: opts.organizationId,
          userId: opts.userId,
          deletedAt: null,
        },
        select: {
          id: true,
          title: true,
          // `blocks` (the full GrowthAgentResponse JSON on assistant turns)
          // isn't needed to build the plain-text `history` prompt below.
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 20,
            select: { role: true, content: true },
          },
        },
      })
    : null;
  if (opts.conversationId && !conversation) {
    yield { type: 'error', message: 'Conversation not found.' };
    return;
  }
  const isNew = !conversation;
  if (!conversation) {
    const created = await createConversation(
      { organizationId: opts.organizationId, userId: opts.userId, title: deriveTitle(message) },
      db,
    );
    conversation = { ...created, messages: [] };
  }
  const history = conversation.messages.map(
    (m) => `${m.role === 'USER' ? 'User' : 'Agent'}: ${m.content.slice(0, 300)}`,
  );

  // persist the user message immediately
  const userMessage = await db.aIMessage.create({
    data: {
      conversationId: conversation.id,
      organizationId: opts.organizationId,
      role: 'USER',
      content: message,
    },
  });

  const run = await db.agentRun.create({
    data: {
      organizationId: opts.organizationId,
      userId: opts.userId,
      conversationId: conversation.id,
      agent: 'growth-agent',
      status: 'RUNNING',
      trigger: opts.trigger ?? 'chat',
      input: { conversationId: conversation.id, message },
      currentStep: 'gathering',
      startedAt: new Date(),
    },
  });
  await recordAgentRunEvent(
    { agentRunId: run.id, organizationId: opts.organizationId, type: 'RUN_CREATED' },
    db,
  );
  await recordAgentRunEvent(
    { agentRunId: run.id, organizationId: opts.organizationId, type: 'RUN_STARTED' },
    db,
  );
  // Yielded before any stage work so the client can enable a "Stop" button
  // immediately, well before the run otherwise finishes and reveals its id
  // via the 'done' event.
  yield { type: 'run_created', agentRunId: run.id, conversationId: conversation.id };

  try {
    // 2. context + memory
    yield { type: 'status', stage: 'gathering', detail: 'Reading your connected data and goals' };
    const [orgContext, memory] = await Promise.all([
      loadOrgContext(opts.organizationId, db),
      loadMemory(opts.organizationId, opts.userId, db),
    ]);
    const goals = [...memory.userGoals, ...memory.orgGoals];
    await recordAgentRunEvent(
      { agentRunId: run.id, organizationId: opts.organizationId, type: 'CONTEXT_LOADED' },
      db,
    );

    // 3. plan
    yield { type: 'status', stage: 'planning', detail: 'Deciding which specialists to use' };
    const plan = await planTurn({ model: deps.model }, { message, context: orgContext, history });
    yield { type: 'status', stage: 'planned', detail: plan.rationale };
    await recordAgentRunEvent(
      {
        agentRunId: run.id,
        organizationId: opts.organizationId,
        type: 'PLAN_CREATED',
        metadata: { capabilities: plan.capabilities, rationale: plan.rationale },
      },
      db,
    );

    if (await checkCancelled(run.id, db)) {
      yield { type: 'cancelled', agentRunId: run.id };
      return;
    }

    // 4. execute capabilities (org-context always first)
    const orgFirst: CapabilityId = 'org-context';
    const capIds: CapabilityId[] = [
      orgFirst,
      ...plan.capabilities.filter((c) => c !== 'org-context'),
    ].slice(0, 5);
    const capCtx: CapabilityContext = {
      organizationId: opts.organizationId,
      userId: opts.userId,
      db,
      model: deps.model,
      message,
      orgContext,
      goals,
    };
    const registry = deps.capabilities ?? CAPABILITY_BY_ID;
    const activeCaps = capIds
      .map((id) => registry.get(id))
      .filter((c): c is NonNullable<ReturnType<typeof registry.get>> => Boolean(c));
    for (const cap of activeCaps) {
      if (cap.id !== 'org-context')
        yield { type: 'status', stage: 'running', detail: `Running ${cap.title}` };
    }
    // Each capability only reads the shared capCtx — none depends on another's
    // result this turn — so they run concurrently instead of one at a time,
    // which otherwise serializes up to 5 AI calls (worst case ~5x latency).
    // AI governance (ADR-0052): the org can forbid the agent from analysing
    // a given integration at all. A blocked capability is skipped with the
    // reason, never run.
    const governance = await getGovernancePolicy(opts.organizationId, db);
    await db.agentRun.update({ where: { id: run.id }, data: { currentStep: 'running' } });
    const capabilityResults: CapabilityResult[] = await Promise.all(
      activeCaps.map(async (cap): Promise<CapabilityResult> => {
        await recordAgentRunEvent(
          {
            agentRunId: run.id,
            organizationId: opts.organizationId,
            type: 'TOOL_SELECTED',
            metadata: { capabilityId: cap.id },
          },
          db,
        );
        const gate = CAPABILITY_GOVERNANCE[cap.id];
        if (gate) {
          await recordAgentRunEvent(
            {
              agentRunId: run.id,
              organizationId: opts.organizationId,
              type: 'TOOL_AUTHORIZATION_CHECK',
              metadata: { capabilityId: cap.id, integration: gate.integration, class: gate.cls },
            },
            db,
          );
          const d = decideGovernance(governance, gate.integration, gate.cls, { viaAgent: true });
          if (!d.allowed) {
            return {
              capabilityId: cap.id,
              status: 'skipped',
              summary: `${cap.title} was not run.`,
              evidence: [],
              recommendations: [],
              note: d.reason,
            };
          }
        }
        await recordAgentRunEvent(
          {
            agentRunId: run.id,
            organizationId: opts.organizationId,
            type: 'TOOL_STARTED',
            metadata: { capabilityId: cap.id },
          },
          db,
        );
        try {
          const result = await cap.run(capCtx);
          await recordAgentRunEvent(
            {
              agentRunId: run.id,
              organizationId: opts.organizationId,
              type: 'TOOL_COMPLETED',
              metadata: { capabilityId: cap.id, status: result.status },
            },
            db,
          );
          return result;
        } catch (e) {
          log.warn({ capability: cap.id, err: String(e) }, 'capability failed');
          await recordAgentRunEvent(
            {
              agentRunId: run.id,
              organizationId: opts.organizationId,
              type: 'TOOL_FAILED',
              metadata: { capabilityId: cap.id, error: e instanceof Error ? e.message : 'error' },
            },
            db,
          );
          return {
            capabilityId: cap.id,
            status: 'error',
            summary: `${cap.title} could not run this time.`,
            evidence: [],
            recommendations: [],
            note: e instanceof Error ? e.message : 'error',
          };
        }
      }),
    );
    await db.agentRun.update({
      where: { id: run.id },
      data: { toolCallCount: activeCaps.length, iterationCount: { increment: 1 } },
    });

    if (await checkCancelled(run.id, db)) {
      yield { type: 'cancelled', agentRunId: run.id };
      return;
    }

    // 5. synthesize
    yield { type: 'status', stage: 'synthesizing', detail: 'Combining the results' };
    await db.agentRun.update({ where: { id: run.id }, data: { currentStep: 'synthesizing' } });
    const { blocks, grounded, usedModel, usage } = await synthesize(deps, {
      message,
      orgContext,
      memorySummary: summarizeMemory(memory),
      plan,
      capabilityResults,
      signal: opts.signal,
    });

    // 6. response text (streamed)
    yield { type: 'status', stage: 'writing', detail: 'Writing the answer' };
    await db.agentRun.update({ where: { id: run.id }, data: { currentStep: 'writing' } });
    let responseText = '';
    if (deps.responseModel) {
      try {
        const stream = await deps.responseModel.streamText({
          system:
            'Write a concise, friendly reply to the user from the structured analysis below. Lead with the answer. Do NOT reveal step-by-step reasoning. Do NOT invent numbers. Never guarantee rankings, revenue or traffic. 2-5 short paragraphs or a short list.\n\n' +
            UNTRUSTED_CONTENT_SYSTEM_CLAUSE,
          prompt: responsePrompt(message, blocks),
          signal: opts.signal,
        });
        for await (const chunk of stream.textStream) {
          responseText += chunk;
          yield { type: 'token', text: chunk };
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'response streaming failed; using deterministic text');
        responseText = '';
      }
    }
    if (!responseText.trim()) {
      responseText = deterministicText(blocks);
      for (const chunk of chunkText(responseText)) yield { type: 'token', text: chunk };
    }

    // 7. persist
    const assistantMessage = await db.aIMessage.create({
      data: {
        conversationId: conversation.id,
        organizationId: opts.organizationId,
        role: 'ASSISTANT',
        content: responseText,
        blocks: blocks as never,
        agentRunId: run.id,
      },
    });
    await touchConversation(conversation.id, db);
    if (isNew) {
      await db.aIConversation.update({
        where: { id: conversation.id },
        data: { title: deriveTitle(message) },
      });
    }
    // Conditional: a concurrent cancel request may have already flipped this
    // row to CANCELLED between the last checkpoint and here — never let a
    // completing turn overwrite that authoritative state.
    const completed = await db.agentRun.updateMany({
      where: { id: run.id, status: { not: 'CANCELLED' } },
      data: {
        status: 'COMPLETED',
        currentStep: 'done',
        output: {
          blocks,
          plan,
          grounded,
          capabilityStatuses: capabilityResults.map((c) => ({
            id: c.capabilityId,
            status: c.status,
          })),
          toolCalls: capabilityResults.map((c) => c.capabilityId),
        } as never,
        finishedAt: new Date(),
        tokensPrompt: usage?.promptTokens ?? 0,
        tokensCompletion: usage?.completionTokens ?? 0,
        costUsd: usage?.estimatedCostUsd ?? 0,
        model: usage?.model,
        provider: usage?.provider,
      },
    });
    if (completed.count === 0) {
      yield { type: 'cancelled', agentRunId: run.id };
      return;
    }
    await recordAgentRunEvent(
      { agentRunId: run.id, organizationId: opts.organizationId, type: 'RUN_COMPLETED' },
      db,
    );
    await rememberFromTurn(
      { db, model: deps.model },
      {
        organizationId: opts.organizationId,
        userId: opts.userId,
        message,
        conversationId: conversation.id,
      },
    );
    await recordAudit(
      {
        organizationId: opts.organizationId,
        actorId: opts.userId,
        action: 'agent.turn.completed',
        targetType: 'ai_conversation',
        targetId: conversation.id,
        metadata: {
          capabilities: capabilityResults.map((c) => c.capabilityId),
          recommendations: blocks.recommendations.length,
          grounded,
          usedModel: usedModel || Boolean(deps.responseModel),
        },
      },
      db,
    );

    const title = isNew ? deriveTitle(message) : conversation.title;
    internalResults.set(run.id, {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      agentRunId: run.id,
      title,
      responseText,
      blocks,
      plan,
      capabilityResults,
    });
    yield {
      type: 'done',
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      agentRunId: run.id,
      title,
      blocks,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    await db.agentRun
      .updateMany({
        where: { id: run.id, status: { not: 'CANCELLED' } },
        data: {
          status: aborted ? 'CANCELLED' : 'FAILED',
          currentStep: 'done',
          error: aborted ? undefined : e instanceof Error ? e.message : 'error',
          errorCode: aborted ? undefined : 'AI_PROVIDER_ERROR',
          cancelledAt: aborted ? new Date() : undefined,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    await recordAgentRunEvent(
      {
        agentRunId: run.id,
        organizationId: opts.organizationId,
        type: aborted ? 'RUN_CANCELLED' : 'RUN_FAILED',
        metadata: aborted ? undefined : { error: e instanceof Error ? e.message : 'error' },
      },
      db,
    );
    if (aborted) {
      log.info({ agentRunId: run.id }, 'growth agent turn aborted (client disconnect)');
      yield { type: 'cancelled', agentRunId: run.id };
      return;
    }
    log.error({ err: String(e) }, 'growth agent turn failed');
    yield { type: 'error', message: 'The agent hit an error. Please try again.' };
  }
}

// --- synthesis -----------------------------------------------------

interface SynthInput {
  message: string;
  orgContext: OrgContext;
  memorySummary: string;
  plan: TurnPlan;
  capabilityResults: CapabilityResult[];
  signal?: AbortSignal;
}

async function synthesize(
  deps: GrowthAgentDeps,
  input: SynthInput,
): Promise<{
  blocks: GrowthAgentResponseT;
  grounded: boolean;
  usedModel: boolean;
  usage: Awaited<ReturnType<SynthModel['generateObject']>>['usage'] | null;
}> {
  // Build the evidence catalogue (ids the model must cite).
  const evidence: Array<{ id: string; source: string; statement: string; kind: string }> = [];
  input.capabilityResults.forEach((cr) => {
    cr.evidence.forEach((e) => {
      evidence.push({
        id: `e${evidence.length + 1}`,
        source: cr.capabilityId,
        statement: e.statement,
        kind: e.kind,
      });
    });
  });
  const knownIds = new Set(evidence.map((e) => e.id));
  const factNumbers = evidence
    .flatMap((e) => e.statement.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

  const deterministic = finalizeBlocks(assembleResponse(input, evidence));

  const canModel = typeof deps.model?.generateObject === 'function' && evidence.length > 0;
  if (!canModel) return { blocks: deterministic, grounded: true, usedModel: false, usage: null };

  const evidenceBlock = evidence
    .map((e) => `[${e.id}] (${e.source}, ${e.kind}) ${e.statement}`)
    .join('\n');
  const summaryBlock = input.capabilityResults
    .map((c) => `- ${c.capabilityId} [${c.status}]: ${c.summary}${c.note ? ` (${c.note})` : ''}`)
    .join('\n');

  let prompt = `${wrapUntrusted('USER_MESSAGE', input.message)}

WHAT IS CONNECTED: ${summarizeOrgContext(input.orgContext)}
MEMORY: ${input.memorySummary}
ROUTING: ${input.plan.rationale}

CAPABILITY SUMMARIES:
${summaryBlock}

${wrapUntrusted(
  'CAPABILITY_EVIDENCE',
  `EVIDENCE (cite these ids — this block may quote crawled pages or third-party API text):\n${evidenceBlock}`,
)}

Produce the structured answer for the user message above. Cite evidenceRefs for every free-text field. "decisions" must be one line per capability you used (what + why), not reasoning steps.`;

  let usage: Awaited<ReturnType<SynthModel['generateObject']>>['usage'] | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await (deps.model as SynthModel).generateObject({
      schema: GrowthAgentResponse,
      system: SYNTH_SYSTEM,
      prompt,
      signal: input.signal,
    });
    usage = res.usage;
    const candidate = res.object;
    const issues = checkGroundingFields(flatten(candidate), knownIds, factNumbers);
    if (issues.length === 0) {
      return { blocks: finalizeBlocks(candidate), grounded: true, usedModel: true, usage };
    }
    log.warn({ attempt, issues }, 'growth agent synthesis failed grounding; retrying');
    prompt = `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these and resubmit:\n${issues
      .map((i) => `- ${i.path}: ${i.problem}`)
      .join(
        '\n',
      )}\nCite only evidence ids that appear in the EVIDENCE list; state no numbers not present there; make no guarantees.`;
  }
  // Grounding failed → deterministic assembly (numbers/recs are model-free).
  return { blocks: deterministic, grounded: false, usedModel: true, usage };
}

/**
 * Invariants enforced in code, never trusted from the model
 * (docs/AI-SECURITY-AUDIT.md finding 3): every `external` proposed action
 * requires confirmation, full stop — `checkGroundingFields`/`flatten()` below
 * never examines `proposedActions`, so a successful injection convincing the
 * model to emit `requiresConfirmation: false` on an external action would
 * otherwise pass grounding untouched. Also scrubs (finding 2) before the
 * response is ever persisted or shown, on both the model path and the
 * deterministic fallback.
 */
function finalizeBlocks(blocks: GrowthAgentResponseT): GrowthAgentResponseT {
  const scrubbed = scrubModelOutput(blocks);
  return {
    ...scrubbed,
    proposedActions: scrubbed.proposedActions.map((a) =>
      a.kind === 'external' ? { ...a, requiresConfirmation: true } : a,
    ),
  };
}

function flatten(r: GrowthAgentResponseT): GroundingField[] {
  const fields: GroundingField[] = [
    { path: 'analysisSummary', text: r.analysisSummary, factIds: r.analysisSummaryEvidenceRefs },
  ];
  r.decisions.forEach((d, i) => fields.push({ path: `decisions[${i}]`, text: d }));
  r.recommendations.forEach((rec, i) =>
    fields.push({
      path: `recommendations[${i}]`,
      text: `${rec.title} ${rec.problem} ${rec.whyItMatters} ${rec.howToFix} ${rec.expectedBenefit}`,
      factIds: rec.evidenceRefs,
    }),
  );
  r.evidence.forEach((e, i) => fields.push({ path: `evidence[${i}]`, text: e.statement }));
  r.disclaimers.forEach((d, i) => fields.push({ path: `disclaimers[${i}]`, text: d }));
  return fields;
}

function dedupeRecommendations(list: CapabilityRecommendation[]): CapabilityRecommendation[] {
  const seen = new Set<string>();
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return list
    .filter((r) => {
      const k = r.title.toLowerCase().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => order[a.priority] - order[b.priority])
    .slice(0, 8);
}

function assembleResponse(
  input: SynthInput,
  evidence: Array<{ id: string; source: string; statement: string; kind: string }>,
): GrowthAgentResponseT {
  const ran = input.capabilityResults.filter((c) => c.status === 'ok').map((c) => c.capabilityId);
  const blocked = input.capabilityResults.filter((c) => c.status === 'needs_prerequisite');
  const recs = dedupeRecommendations(input.capabilityResults.flatMap((c) => c.recommendations));

  const summaryParts = input.capabilityResults
    .filter((c) => c.status === 'ok' && c.capabilityId !== 'org-context')
    .map((c) => c.summary);
  const analysisSummary =
    (summaryParts.length
      ? summaryParts.join(' ')
      : `Ran: ${ran.join(', ') || 'org context only'}.`) +
    (blocked.length
      ? ` Some analysis is unavailable: ${blocked.map((b) => b.note).join(' ')}`
      : '');

  const decisions = [
    ...ran
      .filter((id) => id !== 'org-context')
      .map(
        (id) =>
          `Used ${CAPABILITY_BY_ID.get(id)?.title ?? id} because the question is in its area.`,
      ),
    ...blocked.map(
      (b) => `Skipped ${CAPABILITY_BY_ID.get(b.capabilityId)?.title ?? b.capabilityId}: ${b.note}`,
    ),
  ];

  const proposedActions: GrowthAgentResponseT['proposedActions'] = recs.slice(0, 5).map((r, i) => ({
    kind: 'create_task',
    label: `Create task: ${r.title}`,
    recommendationIndex: i,
    requiresConfirmation: false,
    note: 'Adds an internal, trackable task. No external system is touched.',
  }));
  const external = recs.find(
    (r) =>
      (r.domain === 'TIKTOK' || r.domain === 'YOUTUBE' || r.domain === 'CONTENT') &&
      /publish|post natively|metadata|upload/i.test(r.howToFix),
  );
  if (external) {
    proposedActions.push({
      kind: 'external',
      label: 'Publishing / metadata changes need confirmation',
      externalActionKind: `${external.domain.toLowerCase()}.publish_or_metadata`,
      requiresConfirmation: true,
      note: 'The agent never publishes or edits an external account. Do this from the platform’s own approval screen (e.g. /app/tiktok/publishing).',
    });
  }

  return GrowthAgentResponse.parse({
    analysisSummary,
    analysisSummaryEvidenceRefs: evidence.length ? [evidence[0]!.id] : ['e0'],
    evidence: evidence.map((e) => ({
      source: e.source,
      statement: e.statement,
      kind: e.kind as never,
    })),
    decisions,
    recommendations: recs.map((r) => ({
      title: r.title,
      problem: r.problem,
      whyItMatters: r.whyItMatters,
      howToFix: r.howToFix,
      expectedBenefit: r.expectedBenefit,
      priority: r.priority,
      difficulty: r.difficulty,
      confidence: r.confidence,
      domain: r.domain,
      affectedUrls: r.affectedUrls,
      affectedRefs: r.affectedRefs,
      evidenceRefs: evidence.length ? [evidence[0]!.id] : ['e0'],
    })),
    proposedActions,
    disclaimers: [
      'This is analysis of your connected data. It does not predict or guarantee rankings, revenue, views or traffic.',
      'The agent reasons over stored data and never changes an external account; publishing and metadata changes go through their own approval screens.',
    ],
  });
}

// --- response text ------------------------------------------------

function responsePrompt(message: string, blocks: GrowthAgentResponseT): string {
  return `${wrapUntrusted('USER_MESSAGE', message)}

ANALYSIS SUMMARY: ${blocks.analysisSummary}

DECISIONS:
${blocks.decisions.map((d) => `- ${d}`).join('\n') || '- (none)'}

TOP RECOMMENDATIONS:
${
  blocks.recommendations
    .slice(0, 6)
    .map((r, i) => `${i + 1}. ${r.title} — ${r.howToFix} (priority ${r.priority}, ${r.difficulty})`)
    .join('\n') || '- (none)'
}

DISCLAIMERS:
${blocks.disclaimers.map((d) => `- ${d}`).join('\n')}

Write the reply now.`;
}

function deterministicText(blocks: GrowthAgentResponseT): string {
  const lines: string[] = [blocks.analysisSummary, ''];
  if (blocks.decisions.length) {
    lines.push('**What I did**');
    for (const d of blocks.decisions) lines.push(`- ${d}`);
    lines.push('');
  }
  if (blocks.recommendations.length) {
    lines.push('**Recommendations**');
    blocks.recommendations.slice(0, 6).forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}** _(priority ${r.priority}, ${r.difficulty})_`);
      lines.push(`   - Why it matters: ${r.whyItMatters}`);
      lines.push(`   - How to fix: ${r.howToFix}`);
      lines.push(`   - Expected benefit: ${r.expectedBenefit}`);
    });
    lines.push('');
  }
  if (blocks.proposedActions.length) {
    lines.push('**Suggested actions**');
    for (const a of blocks.proposedActions)
      lines.push(`- ${a.label}${a.requiresConfirmation ? ' _(needs your confirmation)_' : ''}`);
    lines.push('');
  }
  for (const d of blocks.disclaimers) lines.push(`_${d}_`);
  return lines.join('\n').trim();
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 240) chunks.push(text.slice(i, i + 240));
  return chunks;
}

function deriveTitle(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim().split(' ').slice(0, 9).join(' ');
  const t = words.length < message.trim().length ? `${words}…` : words;
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 120) || 'New conversation';
}

export { describeCapabilities };
