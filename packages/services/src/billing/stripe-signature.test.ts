import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StripeSignatureError,
  signStripePayload,
  verifyStripeSignature,
} from './stripe-signature.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed, fresh payload and returns the timestamp', () => {
    const now = 1_800_000_000_000;
    const header = signStripePayload(BODY, SECRET, Math.floor(now / 1000));
    const ts = verifyStripeSignature(BODY, header, SECRET, { now: () => now });
    expect(ts).toBe(Math.floor(now / 1000));
  });

  it('rejects a tampered body', () => {
    const now = 1_800_000_000_000;
    const header = signStripePayload(BODY, SECRET, Math.floor(now / 1000));
    expect(() => verifyStripeSignature(`${BODY} `, header, SECRET, { now: () => now })).toThrow(
      StripeSignatureError,
    );
  });

  it('rejects a wrong secret', () => {
    const header = signStripePayload(BODY, SECRET);
    expect(() => verifyStripeSignature(BODY, header, 'whsec_other')).toThrow(StripeSignatureError);
  });

  it('rejects a timestamp outside the tolerance window (replay protection)', () => {
    const signedAt = 1_000;
    const header = signStripePayload(BODY, SECRET, signedAt);
    expect(() =>
      verifyStripeSignature(BODY, header, SECRET, {
        now: () => (signedAt + 10_000) * 1000,
        toleranceSec: 300,
      }),
    ).toThrow(/tolerance/i);
  });

  it('rejects a missing header, a header with no v1, and an empty secret', () => {
    expect(() => verifyStripeSignature(BODY, null, SECRET)).toThrow(/missing/i);
    expect(() => verifyStripeSignature(BODY, 't=123', SECRET)).toThrow(/no v1/i);
    expect(() => verifyStripeSignature(BODY, 't=1,v1=abc', '')).toThrow(/signing secret/i);
  });

  it('accepts when any one of multiple v1 signatures matches', () => {
    const now = 1_800_000_000_000;
    const t = Math.floor(now / 1000);
    const good = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex');
    const header = `t=${t},v1=deadbeef,v1=${good}`;
    expect(verifyStripeSignature(BODY, header, SECRET, { now: () => now })).toBe(t);
  });
});
