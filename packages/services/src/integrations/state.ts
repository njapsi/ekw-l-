import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, short-lived OAuth `state`. Carries the acting user + organization so
 * the callback can (a) resist CSRF and (b) attribute the new connection to the
 * right tenant without trusting a query param. HMAC-SHA256 with `AUTH_SECRET`.
 */
export interface OAuthState {
  organizationId: string;
  userId: string;
  provider: string;
  /** epoch ms */
  iat: number;
  nonce: string;
}

const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error('AUTH_SECRET is required to sign OAuth state.');
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signState(input: Omit<OAuthState, 'iat' | 'nonce'>): string {
  const state: OAuthState = {
    ...input,
    iat: Date.now(),
    nonce: b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(12)))),
  };
  const payload = b64url(Buffer.from(JSON.stringify(state), 'utf8'));
  const sig = b64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyState(token: string): OAuthState {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Malformed OAuth state.');
  const [payload, sig] = parts as [string, string];
  const expected = b64url(createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('OAuth state signature is invalid.');
  }
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  if (typeof state.iat !== 'number' || Date.now() - state.iat > TTL_MS) {
    throw new Error('OAuth state has expired.');
  }
  if (!state.organizationId || !state.userId || !state.provider) {
    throw new Error('OAuth state is missing required fields.');
  }
  return state;
}
