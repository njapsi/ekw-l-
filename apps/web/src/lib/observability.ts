import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { observability } from '@growth-agent/services';
import { createLogger, resolveCorrelationId } from '@growth-agent/observability';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * The correlation id for the current request: a well-formed `x-correlation-id`
 * from a trusted proxy, otherwise a freshly minted one. `cache()` keeps it
 * stable across a single server render.
 */
export const getCorrelationId = cache(async (): Promise<string> => {
  const h = await headers();
  return resolveCorrelationId(h.get(CORRELATION_HEADER));
});

/**
 * Wrap a Route Handler so every call emits one structured log line, feeds the
 * in-process metrics histogram (request latency + error rate), and routes an
 * unhandled throw through `captureError` before re-throwing.
 */
export function withRouteObservability(
  routeName: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  const log = createLogger(`route.${routeName}`);
  return async (req: Request) => {
    const started = Date.now();
    const correlationId = resolveCorrelationId(req.headers.get(CORRELATION_HEADER));
    const method = req.method;
    try {
      const res = await handler(req);
      const durationMs = Date.now() - started;
      observability.recordHttpRequest({ route: routeName, method, status: res.status, durationMs });
      log.info({ correlationId, method, status: res.status, durationMs }, 'request');
      return res;
    } catch (err) {
      const durationMs = Date.now() - started;
      observability.recordHttpRequest({ route: routeName, method, status: 500, durationMs });
      await observability.captureError(err, {
        source: 'WEB',
        route: routeName,
        method,
        statusCode: 500,
        correlationId,
      });
      log.error(
        {
          correlationId,
          method,
          durationMs,
          err: err instanceof Error ? err.message : String(err),
        },
        'request failed',
      );
      throw err;
    }
  };
}
