/**
 * Stripe webhook signature verification, implemented directly (no SDK).
 *
 * Stripe signs each webhook with a header of the form
 *   `t=<unix ts>,v1=<hex hmac>,v1=<hex hmac>,...`
 * where each `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`. We recompute it
 * and compare in constant time, and reject signatures whose timestamp is
 * outside a tolerance window (replay protection).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureVerifyOptions {
  /** Seconds of clock skew tolerated. Default 300 (Stripe's own default). */
  toleranceSec?: number;
  /** Injectable for tests. */
  now?: () => number;
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedHeader {
  const parts = header.split(',').map((p) => p.trim());
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  return { timestamp, signatures };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a raw webhook body against the `Stripe-Signature` header. Throws
 * `StripeSignatureError` on any failure; returns the signed timestamp on
 * success.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: SignatureVerifyOptions = {},
): number {
  if (!secret) throw new StripeSignatureError('No webhook signing secret configured.');
  if (!signatureHeader) throw new StripeSignatureError('Missing Stripe-Signature header.');

  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!Number.isFinite(timestamp)) {
    throw new StripeSignatureError('Signature header has no valid timestamp.');
  }
  if (signatures.length === 0) {
    throw new StripeSignatureError('Signature header has no v1 signatures.');
  }

  const toleranceSec = opts.toleranceSec ?? 300;
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new StripeSignatureError('Signature timestamp is outside the tolerance window.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  if (!signatures.some((sig) => safeEqualHex(sig, expected))) {
    throw new StripeSignatureError('No signature in the header matched.');
  }
  return timestamp;
}

/** Test / tooling helper: produce a header that {@link verifyStripeSignature} accepts. */
export function signStripePayload(rawBody: string, secret: string, timestampSec?: number): string {
  const t = timestampSec ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}
