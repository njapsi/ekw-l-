/**
 * Typed application errors. Services return `Result` (from `@growth-agent/core`)
 * or throw an `AppError`; the HTTP layer maps `AppError.code` to the standard
 * envelope + status (docs/API.md §6). Nothing is silently swallowed.
 */
export type AppErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'permission_denied'
  | 'automation_disabled'
  | 'resource_not_found'
  | 'conflict'
  | 'already_exists'
  | 'rate_limited'
  | 'usage_limit_exceeded'
  | 'provider_unavailable'
  | 'internal_error';

const STATUS: Record<AppErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  permission_denied: 403,
  automation_disabled: 403,
  resource_not_found: 404,
  conflict: 409,
  already_exists: 409,
  rate_limited: 429,
  usage_limit_exceeded: 429,
  provider_unavailable: 503,
  internal_error: 500,
};

export interface AppErrorDetail {
  path?: string;
  issue: string;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: AppErrorDetail[];
  /** When true the message is safe to show an end user. */
  readonly expose: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    opts: { details?: AppErrorDetail[]; cause?: unknown; expose?: boolean } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = opts.details;
    this.expose = opts.expose ?? code !== 'internal_error';
  }

  static notFound(what = 'Resource') {
    return new AppError('resource_not_found', `${what} not found.`);
  }
  static unauthenticated(message = 'You must be signed in.') {
    return new AppError('unauthenticated', message);
  }
  static forbidden(message = 'You do not have permission to do that.') {
    return new AppError('permission_denied', message);
  }
  static conflict(message: string) {
    return new AppError('conflict', message);
  }
  static validation(message: string, details?: AppErrorDetail[]) {
    return new AppError('validation_failed', message, { details });
  }
}

export function statusForCode(code: AppErrorCode): number {
  return STATUS[code];
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
