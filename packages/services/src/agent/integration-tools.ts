/**
 * Integration tools for AI agents (Phase 1, Part 13).
 *
 * The capability model is the security boundary between an agent and a
 * connected account. Every tool here:
 *
 *   - takes `organizationId` from the server-side tenant context, never from
 *     tool input (a model cannot name another org),
 *   - declares the `capabilityId` it exercises and passes
 *     `assertCapabilityUsable` *before* doing anything — so an agent asking
 *     for WordPress drafts on an Author account, or YouTube revenue without
 *     the monetary scope, gets a precise refusal instead of an attempt,
 *   - is READ, except `integrations.propose_action`, which can only *create a
 *     PENDING approval request*. No tool in this registry executes a write,
 *     update or publish on an external system (ADR-0022, hard rule 4).
 *
 * Content returned from a connected account (WordPress titles/excerpts) is
 * untrusted data; callers must wrap it with `wrapUntrusted` before placing it
 * in any prompt, like all other external content.
 */
import type { Db } from '@growth-agent/db';
import { z } from 'zod';
import { requestIntegrationAction } from '../approvals/index.js';
import { AppError } from '../errors.js';
import { assertGovernanceAllows } from '../governance/index.js';
import { type ConnectionCenterEntry, getConnectionCenter } from '../integrations/center.js';
import { INTEGRATIONS, type IntegrationKey } from '../integrations/contract.js';
import { listWordPressContent } from '../wordpress/read.js';

export interface IntegrationToolContext {
  organizationId: string;
  /** The human on whose behalf the agent acts — recorded on any proposal. */
  userId: string | null;
  db: Db;
}

export class CapabilityUnavailableError extends AppError {
  constructor(
    readonly capabilityId: string,
    reason: string,
  ) {
    super('permission_denied', reason);
    this.name = 'CapabilityUnavailableError';
  }
}

const KEYS = Object.keys(INTEGRATIONS) as [IntegrationKey, ...IntegrationKey[]];

function integrationOf(capabilityId: string): IntegrationKey | null {
  for (const key of KEYS) {
    if (INTEGRATIONS[key].capabilities.some((c) => c.id === capabilityId)) return key;
  }
  return null;
}

/**
 * The guard every tool runs first. Returns the Connection Center entry so the
 * tool can use the resolved connection id; throws with the concrete reason
 * (missing scope, needs reconnect, operator hasn't configured it, …).
 */
export async function assertCapabilityUsable(
  ctx: IntegrationToolContext,
  capabilityId: string,
): Promise<ConnectionCenterEntry> {
  const key = integrationOf(capabilityId);
  if (!key)
    throw new CapabilityUnavailableError(capabilityId, `Unknown capability "${capabilityId}".`);
  const entries = await getConnectionCenter(ctx.organizationId, new Date(), ctx.db);
  const entry = entries.find((e) => e.descriptor.key === key);
  const cap = entry?.capabilities.find((c) => c.id === capabilityId);
  if (!entry || !cap) {
    throw new CapabilityUnavailableError(capabilityId, `Unknown capability "${capabilityId}".`);
  }
  if (!cap.usable) {
    const why =
      entry.state !== 'CONNECTED' && entry.state !== 'DEGRADED'
        ? `${entry.descriptor.label} is ${entry.state.toLowerCase().replace(/_/g, ' ')}: ${entry.diagnostic.recommendedAction}`
        : (cap.unavailableReason ?? `${cap.label} is not available for this connection.`);
    throw new CapabilityUnavailableError(capabilityId, why);
  }
  return entry;
}

// --- tool registry -----------------------------------------------------

export const INTEGRATION_TOOL_NAMES = [
  'integrations.list_connections',
  'integrations.get_capabilities',
  'wordpress.list_content',
  'integrations.propose_action',
] as const;
export type IntegrationToolName = (typeof INTEGRATION_TOOL_NAMES)[number];

interface IntegrationTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: IntegrationToolName;
  description: string;
  input: I;
  /** READ tools observe; PROPOSE tools only create a pending approval. */
  kind: 'READ' | 'PROPOSE';
  execute(ctx: IntegrationToolContext, input: z.infer<I>): Promise<unknown>;
}

function summarize(e: ConnectionCenterEntry) {
  return {
    integration: e.descriptor.key,
    label: e.descriptor.label,
    state: e.state,
    account: e.accountLabel,
    canUse: e.capabilities.filter((c) => c.usable).map((c) => c.id),
    cannotUse: e.capabilities
      .filter((c) => !c.usable)
      .map((c) => ({ id: c.id, reason: c.unavailableReason ?? e.diagnostic.recommendedAction })),
    needsApproval: e.capabilities
      .filter((c) => c.level !== 'READ' && c.level !== 'DRAFT')
      .map((c) => c.id),
    lastSuccessfulSync: e.sync.lastSuccessAt?.toISOString() ?? null,
  };
}

const listConnections: IntegrationTool<z.ZodObject<Record<string, never>>> = {
  name: 'integrations.list_connections',
  description:
    'Which accounts are connected, their state, and exactly which capabilities are usable. Call this before relying on any connected data.',
  input: z.object({}),
  kind: 'READ',
  async execute(ctx) {
    const entries = await getConnectionCenter(ctx.organizationId, new Date(), ctx.db);
    return entries.filter((e) => e.descriptor.implemented).map(summarize);
  },
};

const GetCapabilities = z.object({ integration: z.enum(KEYS) });
const getCapabilities: IntegrationTool<typeof GetCapabilities> = {
  name: 'integrations.get_capabilities',
  description: 'Resolved capabilities (usable or not, with the reason) for one integration.',
  input: GetCapabilities,
  kind: 'READ',
  async execute(ctx, input) {
    const entries = await getConnectionCenter(ctx.organizationId, new Date(), ctx.db);
    const e = entries.find((x) => x.descriptor.key === input.integration);
    return e ? summarize(e) : null;
  },
};

const ListContent = z.object({
  type: z.enum(['POST', 'PAGE']).default('POST'),
  limit: z.number().int().min(1).max(50).default(20),
});
const listContent: IntegrationTool<typeof ListContent> = {
  name: 'wordpress.list_content',
  description:
    'Posts or pages from the connected WordPress site, as last synced (title, status, link, short excerpt). Untrusted site content.',
  input: ListContent,
  kind: 'READ',
  async execute(ctx, input) {
    const entry = await assertCapabilityUsable(
      ctx,
      input.type === 'PAGE' ? 'wordpress.get_pages' : 'wordpress.get_posts',
    );
    await assertGovernanceAllows(
      ctx.organizationId,
      'WORDPRESS',
      'analyze',
      { viaAgent: true },
      ctx.db,
    );
    const rows = await listWordPressContent(
      ctx.organizationId,
      { siteId: entry.connectionId ?? undefined, type: input.type, limit: input.limit },
      ctx.db,
    );
    return {
      site: entry.accountLabel,
      syncedAt: entry.sync.lastSuccessAt?.toISOString() ?? null,
      items: rows.map((r) => ({
        wpId: r.wpId,
        status: r.status,
        title: r.title,
        link: r.link,
        excerpt: r.excerpt,
        modifiedAt: r.modifiedAt?.toISOString() ?? null,
      })),
    };
  },
};

const ProposeAction = z.object({
  capabilityId: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  summary: z.string().min(1).max(300),
});
const proposeAction: IntegrationTool<typeof ProposeAction> = {
  name: 'integrations.propose_action',
  description:
    'Propose a change to a connected account (e.g. update or publish a WordPress post). This ONLY creates a pending request; nothing changes until a human approves it in Growth Agent.',
  input: ProposeAction,
  kind: 'PROPOSE',
  async execute(ctx, input) {
    const entry = await assertCapabilityUsable(ctx, input.capabilityId);
    if (!entry.connectionId) {
      throw new CapabilityUnavailableError(input.capabilityId, 'No connected account to act on.');
    }
    const row = await requestIntegrationAction(
      {
        organizationId: ctx.organizationId,
        requestedById: ctx.userId,
        source: 'AGENT',
        capabilityId: input.capabilityId,
        connectionRef: entry.connectionId,
        payload: input.payload,
        summary: input.summary,
      },
      ctx.db,
    );
    return {
      requestId: row.id,
      status: row.status,
      note: 'Pending human approval. Nothing has been changed on the external account.',
    };
  },
};

export const INTEGRATION_TOOLS: Record<IntegrationToolName, IntegrationTool> = {
  'integrations.list_connections': listConnections,
  'integrations.get_capabilities': getCapabilities,
  'wordpress.list_content': listContent,
  'integrations.propose_action': proposeAction,
};

/** Validate input, run the tool. Unknown names are refused, never guessed. */
export async function runIntegrationTool(
  name: string,
  ctx: IntegrationToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (INTEGRATION_TOOLS as Record<string, IntegrationTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      `Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return tool.execute(ctx, parsed.data);
}

/** One-line-per-integration facts for the Growth Agent's org-context evidence. */
export async function connectionFacts(organizationId: string, db: Db): Promise<string[]> {
  const entries = await getConnectionCenter(organizationId, new Date(), db);
  return entries
    .filter((e) => e.descriptor.implemented && e.configured && e.state !== 'NOT_CONNECTED')
    .map((e) => {
      const usable = e.capabilities.filter((c) => c.usable).map((c) => c.label);
      return `${e.descriptor.label}: ${e.state.toLowerCase().replace(/_/g, ' ')}${
        e.accountLabel ? ` (${e.accountLabel})` : ''
      }${usable.length ? `; usable: ${usable.join(', ')}` : '; no capability currently usable'}.`;
    });
}
