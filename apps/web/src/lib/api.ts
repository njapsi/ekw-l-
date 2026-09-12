import { AppError, isAppError } from '@growth-agent/services';
import { createLogger, newCorrelationId } from '@growth-agent/observability';
import { NextResponse } from 'next/server';

const log = createLogger('api');

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function requestIdFrom(req: Request): string {
  const inbound = req.headers.get('x-request-id');
  if (inbound && /^[A-Za-z0-9_-]{8,64}$/.test(inbound)) return inbound;
  return newCorrelationId();
}

/** Success envelope. */
export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** Error envelope with the standard shape (docs/API.md §6). */
export function jsonError(err: unknown, req?: Request, fallbackRequestId?: string): NextResponse {
  const requestId = req ? requestIdFrom(req) : (fallbackRequestId ?? newCorrelationId());

  if (isAppError(err)) {
    if (!err.expose || err.status >= 500) {
      log.error({ err, requestId, code: err.code }, 'request failed');
    }
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Something went wrong.',
          details: err.details,
          requestId,
        },
      },
      { status: err.status, headers: { 'x-request-id': requestId } },
    );
  }

  log.error({ err, requestId }, 'unhandled error in request');
  const internal = new AppError('internal_error', 'Something went wrong.');
  return NextResponse.json(
    { error: { code: internal.code, message: internal.message, requestId } },
    { status: 500, headers: { 'x-request-id': requestId } },
  );
}

/** Wrap a route handler so thrown `AppError`s become the standard envelope. */
export function route(
  handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return jsonError(err, req);
    }
  };
}
