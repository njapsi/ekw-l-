import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for OAuth tokens at rest (docs/SECURITY.md §5).
 * AES-256-GCM. The key comes from `ENCRYPTION_KEY` (base64 or hex, 32 bytes).
 * A short `keyId` (derived from the key) is stored alongside each ciphertext so
 * the key can be rotated and old rows re-encrypted incrementally.
 */
const ALGO = 'aes-256-gcm';

export interface SealedToken {
  cipher: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyId: string;
}

function loadKey(raw = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error('ENCRYPTION_KEY is not set — cannot handle OAuth tokens.');
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}).`);
  }
  return key;
}

export function keyIdFor(raw = process.env.ENCRYPTION_KEY): string {
  return createHash('sha256').update(loadKey(raw)).digest('hex').slice(0, 12);
}

export function seal(plaintext: string, raw = process.env.ENCRYPTION_KEY): SealedToken {
  const key = loadKey(raw);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    cipher: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId: keyIdFor(raw),
  };
}

export function open(sealed: SealedToken, raw = process.env.ENCRYPTION_KEY): string {
  const key = loadKey(raw);
  if (sealed.keyId !== keyIdFor(raw)) {
    throw new Error('Ciphertext was sealed with a different ENCRYPTION_KEY (keyId mismatch).');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Generate a fresh 32-byte key, base64 — for `ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}
