import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the email+password sign-in provider, alongside the
 * existing magic-link/Google auth. Node's built-in `scrypt` — no new
 * dependency — matching `crypto/tokens.ts`'s existing hand-rolled-crypto
 * convention rather than adding bcrypt/argon2.
 */
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** A fixed, never-matching hash — see `verifyPassword`'s no-such-user path. */
const DUMMY_HASH = hashPassword('not-a-real-password-used-only-for-timing');

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Run a real scrypt computation even when no user was found, so a
 * nonexistent-email login attempt doesn't return measurably faster than a
 * wrong-password one (which would otherwise leak account existence via
 * timing). Always returns false.
 */
export function verifyAgainstDummy(password: string): false {
  verifyPassword(password, DUMMY_HASH);
  return false;
}
