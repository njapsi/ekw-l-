import { randomUUID } from 'node:crypto';

const PREFIX = 'req';

/** Generate a sortable-ish correlation id for a request or job. */
export function newCorrelationId(kind: string = PREFIX): string {
  return `${kind}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Pull an inbound correlation id from request headers if a trusted upstream set
 * one, otherwise mint a fresh id. Only accepts a conservative shape so a client
 * cannot inject arbitrary log content.
 */
export function resolveCorrelationId(headerValue: string | null | undefined): string {
  if (headerValue && /^[A-Za-z0-9_-]{8,64}$/.test(headerValue)) return headerValue;
  return newCorrelationId();
}
