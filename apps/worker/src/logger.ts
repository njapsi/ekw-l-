import { createLogger } from '@growth-agent/observability';

/**
 * Worker root logger. Uses the shared observability factory so the same secret
 * redaction paths apply here as in the web app (Phase 13).
 */
export const logger = createLogger('worker');
