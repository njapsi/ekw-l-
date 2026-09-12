import { describe, expect, it } from 'vitest';
import { newCorrelationId, resolveCorrelationId } from './correlation.js';

describe('correlation ids', () => {
  it('mints prefixed ids', () => {
    expect(newCorrelationId()).toMatch(/^req_[a-f0-9]{24}$/);
    expect(newCorrelationId('job')).toMatch(/^job_[a-f0-9]{24}$/);
  });

  it('accepts a well-formed inbound id', () => {
    expect(resolveCorrelationId('abc123-DEF_456')).toBe('abc123-DEF_456');
  });

  it('rejects a malformed inbound id and mints a fresh one', () => {
    expect(resolveCorrelationId('nope!')).toMatch(/^req_/);
    expect(resolveCorrelationId('')).toMatch(/^req_/);
    expect(resolveCorrelationId(null)).toMatch(/^req_/);
    expect(resolveCorrelationId('x'.repeat(200))).toMatch(/^req_/);
  });
});
