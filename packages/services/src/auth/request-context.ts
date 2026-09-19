import { AsyncLocalStorage } from 'node:async_hooks';
import { clientIpFrom } from '../security/rate-limit.js';
import type { SessionContext } from './sessions.js';

/**
 * Request-scoped device/network context for Auth.js callbacks.
 *
 * Auth.js's `jwt` callback receives no request object, and this package does
 * not depend on Next.js. The web app's `/api/auth/[...nextauth]` route runs
 * each request inside `runWithRequestContext`, and the callbacks read it back
 * here. Outside that scope (tests, the worker) the context is simply empty:
 * the session is still recorded, just without device / network detail.
 */
const storage = new AsyncLocalStorage<SessionContext>();

export function runWithRequestContext<T>(req: Request, fn: () => T): T {
  return storage.run(contextFromRequest(req), fn);
}

export function currentRequestContext(): SessionContext {
  return storage.getStore() ?? {};
}

export function contextFromRequest(req: Request | undefined): SessionContext {
  if (!req) return {};
  return { userAgent: req.headers.get('user-agent'), ip: clientIpFrom(req.headers) };
}
