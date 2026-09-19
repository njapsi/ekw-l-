import type { NextRequest } from 'next/server';
import { handlers, runWithRequestContext } from '@growth-agent/services/auth';

/**
 * Auth.js endpoints. Each request runs inside a request-context scope so the
 * sign-in callbacks can record the device and network of the new session
 * (Settings → Security → Active sessions). No behaviour of Auth.js changes.
 */
export function GET(req: NextRequest) {
  return runWithRequestContext(req, () => handlers.GET(req));
}

export function POST(req: NextRequest) {
  return runWithRequestContext(req, () => handlers.POST(req));
}
