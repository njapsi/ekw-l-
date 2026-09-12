/**
 * Next.js instrumentation. `onRequestError` is the one global hook the App
 * Router gives us for unhandled faults in server components / route handlers.
 *
 * - nodejs runtime: funnel straight into `observability.captureError` (Phase 13).
 *   The `@growth-agent/services` import is nested inside the runtime check so
 *   webpack drops `bullmq` / `ioredis` from the edge bundle.
 * - edge runtime: `@growth-agent/services` (Node-only) can't load here, so POST
 *   the fault to the internal `/api/client-error` sink, which records it into
 *   the same de-duplicated `ErrorEvent` table (FORENSIC-AUDIT M-4 / D-4).
 */
import type { Instrumentation } from 'next';

export function register(): void {
  // Reserved for a future OTel SDK init (ADR-0028 defers it).
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const corrRaw = headers['x-correlation-id'];
  const correlationId = Array.isArray(corrRaw) ? corrRaw[0] : corrRaw;
  const e = err instanceof Error ? err : new Error(String(err));

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { observability } = await import('@growth-agent/services');
      await observability.captureError(e, {
        source: 'WEB',
        route: context.routePath || request.path,
        method: request.method,
        correlationId,
        context: { routerKind: context.routerKind, routeType: context.routeType },
      });
    } catch {
      // Error reporting must never throw out of the hook.
    }
    return;
  }

  // Edge runtime.
  try {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
    await fetch(`${base}/api/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: e.message,
        stack: e.stack,
        name: e.name,
        source: 'edge',
        url: context.routePath || request.path,
      }),
      keepalive: true,
    });
  } catch {
    // best effort
  }
};
