import { beforeEach, describe, expect, it } from 'vitest';
import { generateEncryptionKey, keyIdFor, open, seal } from './tokens.js';

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
