import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from './result.js';

describe('Result', () => {
  it('constructs ok values', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toBe(42);
  });

  it('constructs err values', () => {
    const r = err(new Error('boom'));
    expect(isErr(r)).toBe(true);
    expect(() => unwrap(r)).toThrow('boom');
  });
});
