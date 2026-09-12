import { observability, security } from '@growth-agent/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8_000;

/**
 * Sink for browser-side and edge-runtime errors (FORENSIC-AUDIT M-4 / D-4).
 * The App Router's `onRequestError` only fires for the nodejs runtime, so
 * client error boundaries + `window.onerror` POST here and it funnels into the
 * same de-duplicated `ErrorEvent` table the server uses. Unauthenticated (an
 * error can happen before/around auth) but per-IP rate-limited and size-capped.
 */
export async function POST(req: Request) {
  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({ key: `client-error:${ip}`, limit: 30, windowSec: 60 });
  if (!rl.ok) return new Response(null, { status: 429 });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (raw.length > MAX_BYTES) raw = raw.slice(0, MAX_BYTES);

  let payload: {
    message?: unknown;
    stack?: unknown;
    name?: unknown;
    source?: unknown;
    url?: unknown;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return new Response(null, { status: 400 });
  }

  const message =
    typeof payload.message === 'string' ? payload.message.slice(0, 1000) : 'client error';
  const err = new Error(message);
  err.name = typeof payload.name === 'string' ? payload.name.slice(0, 120) : 'ClientError';
  if (typeof payload.stack === 'string') err.stack = payload.stack.slice(0, 6000);

  await observability.captureError(err, {
    source: 'WEB',
    route: typeof payload.url === 'string' ? payload.url.slice(0, 300) : undefined,
    context: {
      client: true,
      origin: typeof payload.source === 'string' ? payload.source.slice(0, 60) : 'window',
      ua: req.headers.get('user-agent')?.slice(0, 200) ?? undefined,
    },
  });

  return new Response(null, { status: 204 });
}
