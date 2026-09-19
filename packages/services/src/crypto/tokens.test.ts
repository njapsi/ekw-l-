import { beforeEach, describe, expect, it } from 'vitest';
import { generateEncryptionKey, isStaleKeyId, keyIdFor, open, seal } from './tokens.js';

const KEY = generateEncryptionKey();
const OTHER = generateEncryptionKey();

describe('token envelope encryption', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });

  it('round-trips a token', () => {
    const sealed = seal('ya29.super-secret-access-token');
    expect(sealed.cipher).not.toContain('ya29');
    expect(open(sealed)).toBe('ya29.super-secret-access-token');
  });

  it('produces a distinct IV each time', () => {
    expect(seal('x').iv).not.toBe(seal('x').iv);
  });

  it('fails to open with a different key', () => {
    const sealed = seal('secret');
    expect(() => open(sealed, OTHER)).toThrow(/keyId mismatch/);
  });

  it('fails on a tampered ciphertext', () => {
    const sealed = seal('secret');
    const tampered = { ...sealed, cipher: Buffer.from('tampered').toString('base64') };
    expect(() => open(tampered)).toThrow();
  });

  it('rejects a malformed key', () => {
    expect(() => seal('x', 'too-short')).toThrow(/32 bytes/);
  });

  it('keyId is stable and short', () => {
    expect(keyIdFor(KEY)).toHaveLength(12);
    expect(keyIdFor(KEY)).toBe(keyIdFor(KEY));
    expect(keyIdFor(KEY)).not.toBe(keyIdFor(OTHER));
  });
});

describe('key rotation', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it('opens a row sealed with ENCRYPTION_KEY_PREVIOUS during a rotation window', () => {
    const sealedWithOld = seal('refresh-token', OTHER);
    process.env.ENCRYPTION_KEY_PREVIOUS = OTHER;
    expect(open(sealedWithOld)).toBe('refresh-token');
    expect(isStaleKeyId(sealedWithOld.keyId)).toBe(true);
  });

  it('still refuses an unknown key once the previous key is removed', () => {
    const sealedWithOld = seal('refresh-token', OTHER);
    expect(() => open(sealedWithOld)).toThrow(/keyId mismatch/);
  });

  it('does not treat a current-key row as stale', () => {
    expect(isStaleKeyId(seal('x').keyId)).toBe(false);
  });
});
