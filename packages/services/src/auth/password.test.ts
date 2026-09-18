import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';

describe('password', () => {
  it('round-trips a correct password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('salts each hash differently for the same password', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });

  it('verifyAgainstDummy always returns false (timing-parity path)', () => {
    expect(verifyAgainstDummy('whatever-someone-typed')).toBe(false);
  });
});
