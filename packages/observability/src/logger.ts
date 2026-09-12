import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging (master instruction H). One JSON line per request/job with
 * correlation ids. Secrets and auth material are redacted before they can be
 * written (see `SECURITY.md` §4).
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.accessTokenCipher',
  '*.refreshTokenCipher',
  // Provider error objects can carry a token-bearing response body two levels
  // deep (SECURITY-AUDIT.md M-3); catch the common shapes.
  '*.body.access_token',
  '*.body.refresh_token',
  '*.*.access_token',
  '*.*.refresh_token',
  'err.body',
  'error.body',
  '*.secret',
  '*.clientSecret',
  '*.client_secret',
  '*.webhookSecret',
  '*.sessionToken',
  '*.session_token',
  '*.privateKey',
  '*.private_key',
  '*.apiKey',
  '*.encryptionKey',
  '*.metricsToken',
  'password',
  'token',
  'secret',
];

export type { Logger };

let root: Logger | undefined;

export function baseLoggerOptions(): LoggerOptions {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
  const isDev = process.env.NODE_ENV === 'development';
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: process.env.OTEL_SERVICE_NAME ?? 'growth-agent' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      isDev && !process.env.NO_PRETTY_LOGS
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  };
}

/** Process-wide root logger. Prefer `createLogger(name)` for a named child. */
export function rootLogger(): Logger {
  if (!root) root = pino(baseLoggerOptions());
  return root;
}

/** A named child logger, e.g. `createLogger('auth')`. */
export function createLogger(name: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child({ name, ...bindings });
}

/** Attach a request/job correlation id to a logger. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
