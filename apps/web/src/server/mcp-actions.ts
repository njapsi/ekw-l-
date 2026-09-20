'use server';

/**
 * MCP Server Registry admin actions (Phase 5, Parts 92-93). Mutations go
 * through Server Actions, matching every other integration's admin surface
 * (`integration-actions.ts`) — there is no separate `/api/integrations/mcp`
 * REST surface, since this codebase's convention is that a Server Action
 * handles anything an RSC page can call directly (only OAuth
 * redirect/callback flows need a real API route). `requirePermission
 * ('integration:manage')` gates every mutation, exactly like WordPress/
 * TikTok/YouTube connection management.
 */
import { revalidatePath } from 'next/cache';
import { isAppError, mcp, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

function toError(e: unknown, fallback = 'Something went wrong. Please try again.'): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: fallback };
}

async function limited(
  key: string,
  limit: number,
  windowSec: number,
): Promise<ActionResult | null> {
  const rl = await security.checkRateLimit({ key, limit, windowSec });
  return rl.ok
    ? null
    : { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
}

function refresh() {
  revalidatePath('/app/integrations/mcp');
}

export async function addMcpServerAction(input: {
  name: string;
  endpoint: string;
  transport: 'SSE' | 'STDIO';
  authKind: 'NONE' | 'API_KEY' | 'BEARER_TOKEN';
  credential?: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`mcp-add:${org.id}:${user.id}`, 10, 900);
    if (rl) return rl;
    const server = await mcp.createMcpServer({
      organizationId: org.id,
      name: input.name,
      endpoint: input.endpoint,
      transport: input.transport,
      authKind: input.authKind,
      credential: input.credential,
      createdById: user.id,
    });
    refresh();
    return {
      ok: true,
      message: `Added "${server.name}". It is disconnected and disabled until you test and enable it.`,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function testMcpServerAction(serverId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`mcp-test:${org.id}:${user.id}`, 10, 300);
    if (rl) return rl;
    const result = await mcp.syncMcpServerTools(org.id, serverId);
    refresh();
    return {
      ok: true,
      message: `Connected. Discovered ${result.discovered} tool(s)${
        result.skipped.length ? `, skipped ${result.skipped.length}` : ''
      }. Every tool starts disabled — enable the ones you want the agent to use.`,
    };
  } catch (e) {
    return toError(e, 'Could not connect to that MCP server. Check the endpoint and credential.');
  }
}

export async function setMcpServerEnabledAction(
  serverId: string,
  enabled: boolean,
): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('integration:manage');
    await mcp.setMcpServerEnabled(org.id, serverId, enabled);
    refresh();
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function setMcpServerTrustLevelAction(
  serverId: string,
  trustLevel: 'INTERNAL' | 'TRUSTED' | 'VERIFIED_EXTERNAL' | 'UNVERIFIED_EXTERNAL',
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('integration:manage');
    const rl = await limited(`mcp-trust:${org.id}:${user.id}`, 10, 900);
    if (rl) return rl;
    await mcp.setMcpServerTrustLevel(org.id, serverId, trustLevel);
    refresh();
    return {
      ok: true,
      message:
        'Trust level updated. Re-run "Test connection" to reclassify tool risk under the new level.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function setMcpToolEnabledAction(
  serverId: string,
  toolId: string,
  enabled: boolean,
): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('integration:manage');
    await mcp.setMcpToolEnabled(org.id, serverId, toolId, enabled);
    refresh();
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteMcpServerAction(serverId: string): Promise<ActionResult> {
  try {
    const { org } = await requirePermission('integration:manage');
    await mcp.deleteMcpServer(org.id, serverId);
    refresh();
    return { ok: true, message: 'MCP server removed.' };
  } catch (e) {
    return toError(e);
  }
}
