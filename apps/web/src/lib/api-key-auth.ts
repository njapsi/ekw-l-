import 'server-only';
import { apiKeys, isAppError, security } from '@growth-agent/services';

type Handler = (req: Request, principal: apiKeys.ApiPrincipal) => Promise<Response>;

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
};

function problem(status: number, error: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

/**
 * Wrap a `/api/v1` route with API-key authentication (Phase 2, Part 18/19).
 *
 * This is deliberately separate from browser sessions: `/api/v1` never reads
 * the session cookie, and an API key never works on `/app` pages or Server
 * Actions. The organization comes from the key, never from the request.
 * `scope: null` accepts any valid key (e.g. identity introspection).
 */
export function withApiKey(scope: apiKeys.ApiScope | null, handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const auth = req.headers.get('authorization') ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    let principal: apiKeys.ApiPrincipal;
    try {
      principal = await apiKeys.authenticateApiKey(presented);
    } catch {
      // One generic answer: no oracle for unknown / revoked / expired keys.
      return problem(401, 'Invalid or expired API key.', { 'www-authenticate': 'Bearer' });
    }
    const rl = await security.checkRateLimit({
      key: `api-key:${principal.keyId}`,
      limit: 120,
      windowSec: 60,
    });
    if (!rl.ok)
      return problem(429, 'Rate limit exceeded.', { 'retry-after': String(rl.retryAfterSec) });
    try {
      if (scope) apiKeys.requireScope(principal, scope);
      return await handler(req, principal);
    } catch (e) {
      if (isAppError(e) && e.expose) return problem(e.status, e.message);
      return problem(500, 'Internal error.');
    }
  };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
