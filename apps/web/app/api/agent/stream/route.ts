import { agent, isAppError, usage } from '@growth-agent/services';
import { createLogger } from '@growth-agent/observability';
import { requirePermission } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api.agent.stream');

/**
 * Server-Sent Events stream for one Growth Agent turn. Each SSE `data:` frame is
 * one `TurnEvent` JSON object: {type:'status'|'token'|'done'|'error', ...}.
 * The turn is persisted (conversation, messages, AgentRun) as it runs.
 */
export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requirePermission('agent:run');
  } catch (e) {
    if (isAppError(e) && e.code === 'permission_denied') {
      return Response.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  let body: { message?: unknown; conversationId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const conversationId =
    typeof body.conversationId === 'string' && body.conversationId
      ? body.conversationId
      : undefined;
  if (!message) return Response.json({ error: 'A message is required.' }, { status: 400 });
  if (message.length > 8000)
    return Response.json({ error: 'Message is too long.' }, { status: 400 });

  // Per-user abuse throttle in front of the per-org monthly quota (Phase 22,
  // SECURITY-AUDIT.md H-2). Fail-open on a Redis outage.
  const userLimit = await usage.checkAiUserLimit({
    organizationId: ctx.org.id,
    userId: ctx.user.id,
    scope: 'chat',
  });
  if (!userLimit.ok) {
    return Response.json(
      { error: 'You are sending AI requests too quickly. Please slow down.' },
      { status: 429, headers: { 'retry-after': String(userLimit.retryAfterSec) } },
    );
  }

  // Server-side per-org AI budget enforcement (AI_REQUESTS + AI_TOKENS) — never
  // trust the browser (ADR-0025, ADR-0038).
  try {
    await usage.enforceAiBudget({ organizationId: ctx.org.id });
  } catch (e) {
    if (isAppError(e) && e.code === 'usage_limit_exceeded') {
      return Response.json({ error: e.message }, { status: 429 });
    }
    throw e;
  }

  const deps = agent.growthAgentDepsFromEnv();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const ev of agent.streamGrowthAgentTurn(deps, {
          organizationId: ctx.org.id,
          userId: ctx.user.id,
          conversationId,
          message,
          trigger: 'chat',
        })) {
          send(ev);
          if (
            ev &&
            typeof ev === 'object' &&
            (ev as { type?: string }).type === 'done' &&
            typeof (ev as { agentRunId?: unknown }).agentRunId === 'string'
          ) {
            await usage.recordAgentRunUsage({
              organizationId: ctx.org.id,
              agentRunId: (ev as { agentRunId: string }).agentRunId,
              actorId: ctx.user.id,
            });
          }
        }
      } catch (e) {
        log.error({ err: String(e) }, 'agent stream failed');
        send({ type: 'error', message: 'The agent hit an error. Please try again.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
