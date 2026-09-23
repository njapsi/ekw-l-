/**
 * Mission task delegation (Phase 10, §13/§14/§15) — dispatches ONE
 * `MissionTask` to the platform agent that already owns its domain. Never
 * reimplements authorization: every dispatch path below terminates in
 * either `executeAgentTool` (Phase 5's Tool Executor — full rate-limit/
 * usage/authorization/timeline stack, reused unchanged) or, for the two SEO
 * operations that are not yet wired into the Tool Executor
 * (`docs/AGENTS.md`'s disclosed gap — SEO remains the one domain still
 * calling its own functions directly, same as `automation/dispatch.ts`
 * already does for `WEBSITE_CRAWL`), the exact same tenant-scoped service
 * functions the automation engine already calls safely.
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { executeAgentTool } from '../agent/tool-executor.js';
import { createTask } from '../agent/tasks.js';
import { listToolMetadata } from '../agent/tool-registry.js';
import { startCrawl } from '../seo/jobs.js';
import { listWebsites } from '../seo/read.js';
import { runSeoAgent } from '../seo/agent.js';
import { enforceAiBudget } from '../usage/ai-budget.js';

export interface DelegationResult {
  /** Whether the underlying call succeeded outright, is now pending human
   *  approval, or failed. A `toolName: null` task always resolves `ok`. */
  outcome: 'ok' | 'requires_approval' | 'failed';
  summary: string;
  detail?: Record<string, unknown>;
  /** Set only when the tool call itself filed a real `IntegrationActionRequest`
   *  (a `*.propose` ACTION tool) — lets the loop link provenance so the
   *  approval queue's decision can notify this task back (`approvals-bridge.ts`). */
  actionRequestId?: string;
}

/** A tool whose own effect is to file a pending approval, never to execute
 *  directly — its "SUCCESS" means "the request was filed", not "the
 *  underlying platform action happened" (Phase 6-9's `*-tools.ts` ACTION
 *  convention). Looked up from the same registry the Tool Executor uses,
 *  never a second classification. */
function isProposeOnlyTool(toolName: string): boolean {
  const meta = listToolMetadata().find((m) => m.name === toolName);
  return meta?.category === 'ACTION' && meta.requiresApproval === true;
}

/** Duck-types an `IntegrationActionRequest` row returned by a propose-only
 *  tool's own `execute()` (e.g. `wordpress.content.update.propose`). */
function asPendingActionRequest(data: unknown): { id: string } | null {
  if (
    data &&
    typeof data === 'object' &&
    'id' in data &&
    'status' in data &&
    'capabilityId' in data &&
    (data as { status: unknown }).status === 'PENDING'
  ) {
    return { id: String((data as { id: unknown }).id) };
  }
  return null;
}

/**
 * Runs one READY task's action. Approval-gated tool calls (WRITE/PUBLISH
 * capability level) are dispatched exactly like any other tool call — the
 * underlying `*-tools.ts` ACTION-kind executor is what files the pending
 * `IntegrationActionRequest`; this function does not special-case that, it
 * just reports `requires_approval` when the envelope says so.
 */
export async function delegateMissionTask(
  input: {
    organizationId: string;
    userId: string;
    missionId: string;
    task: { id: string; title: string; description: string; toolName: string | null; toolInput: unknown };
    agentRunId?: string;
  },
  db: Db = prisma,
): Promise<DelegationResult> {
  const { task } = input;

  if (!task.toolName) {
    // A pure human-decision point: surface it on the Tasks board and count
    // the mission's own job here as done — the human's follow-through is
    // tracked separately, exactly like automation's CONTENT_OPPORTUNITY /
    // SEO_ISSUE_ALERT tasks already do.
    const created = await createTask(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        title: task.title,
        description: task.description,
        instructions: task.description,
        domain: 'GROWTH',
        sourceMissionTaskId: task.id,
      },
      db,
    );
    return { outcome: 'ok', summary: `Opened a task: "${task.title}".`, detail: { taskId: created.id } };
  }

  if (task.toolName === 'seo.crawl.start' || task.toolName === 'seo.agent.analyze') {
    return delegateSeoTask(input, db);
  }

  const envelope = await executeAgentTool(
    { organizationId: input.organizationId, userId: input.userId, agentRunId: input.agentRunId },
    task.toolName,
    task.toolInput ?? {},
  );

  if (envelope.status === 'SUCCESS' || envelope.status === 'PARTIAL') {
    if (isProposeOnlyTool(task.toolName)) {
      const pending = asPendingActionRequest(envelope.data);
      return {
        outcome: 'requires_approval',
        summary: `${task.toolName} filed a pending approval request.`,
        actionRequestId: pending?.id,
      };
    }
    return {
      outcome: 'ok',
      summary: `${task.toolName} completed.`,
      detail: { status: envelope.status, resourceReferences: envelope.resourceReferences },
    };
  }
  if (envelope.status === 'REQUIRES_APPROVAL') {
    return { outcome: 'requires_approval', summary: envelope.error?.message ?? 'Approval required.' };
  }
  return {
    outcome: 'failed',
    summary: envelope.error?.message ?? `${task.toolName} failed.`,
    detail: { code: envelope.error?.code },
  };
}

async function delegateSeoTask(
  input: {
    organizationId: string;
    userId: string;
    task: { toolName: string | null; toolInput: unknown };
  },
  db: Db,
): Promise<DelegationResult> {
  const sites = await listWebsites(input.organizationId, db);
  const configuredWebsiteId =
    input.task.toolInput && typeof input.task.toolInput === 'object'
      ? (input.task.toolInput as Record<string, unknown>).websiteId
      : undefined;
  const site =
    (typeof configuredWebsiteId === 'string' ? sites.find((s) => s.id === configuredWebsiteId) : undefined) ??
    sites.find((s) => s.verified) ??
    sites[0];
  if (!site) return { outcome: 'failed', summary: 'No website is registered.' };

  if (input.task.toolName === 'seo.crawl.start') {
    const { crawlId, result } = await startCrawl(
      { organizationId: input.organizationId, userId: input.userId, websiteId: site.id },
      { db },
    );
    return {
      outcome: 'ok',
      summary: `Crawl ${result.status.toLowerCase()} — ${result.pagesCrawled} page(s), ${result.issuesFound} issue(s).`,
      detail: { crawlId },
    };
  }

  // seo.agent.analyze
  if (!site.latestCrawl) {
    return { outcome: 'failed', summary: 'No completed crawl exists yet to analyze.' };
  }
  try {
    // Part 19/53: a mission task that would spend AI budget checks the
    // org's real, current meter state first — an autonomous mission must
    // stop generating AI cost once the org's plan is exhausted, not only
    // once its own (separate) `maxToolCalls` ceiling is hit.
    await enforceAiBudget({ organizationId: input.organizationId, db });
    const res = await runSeoAgent(
      { db },
      {
        organizationId: input.organizationId,
        crawlId: site.latestCrawl.id,
        question: 'What should be fixed first?',
        goals: [],
        trigger: 'mission',
      },
    );
    return {
      outcome: 'ok',
      summary: res.report.executiveSummary,
      detail: { agentRunId: res.agentRunId, recommendationCount: res.report.recommendations.length },
    };
  } catch (e) {
    return { outcome: 'failed', summary: e instanceof AppError && e.expose ? e.message : 'SEO analysis failed.' };
  }
}
