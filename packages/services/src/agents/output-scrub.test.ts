import { describe, expect, it } from 'vitest';
import { scrubModelOutput } from './output-scrub.js';

describe('scrubModelOutput', () => {
  it('redacts an API-key-shaped string in a plain string leaf', () => {
    expect(scrubModelOutput('here is a key sk-ant-abcdefgh12345678')).toContain('[redacted]');
  });

  it('redacts a JWT and a connection-string credential nested in an object', () => {
    const out = scrubModelOutput({
      summary: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ',
      nested: { conn: 'postgres://user:hunter2@db.internal:5432/app' },
    });
    expect(out.summary).toContain('[redacted]');
    expect(out.nested.conn).not.toContain('hunter2');
    expect(out.nested.conn).toContain('[redacted]');
  });

  it('walks arrays and preserves shape/order', () => {
    const out = scrubModelOutput([
      { title: 'clean text', value: 1 },
      { title: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', value: 2 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'clean text', value: 1 });
    expect(out[1]!.title).toContain('[redacted]');
    expect(out[1]!.value).toBe(2);
  });

  it('leaves non-secret text, numbers, booleans, and null untouched', () => {
    const out = scrubModelOutput({ a: 'ordinary text', b: 42, c: true, d: null });
    expect(out).toEqual({ a: 'ordinary text', b: 42, c: true, d: null });
  });

  it('passes a Date through unchanged rather than walking its internals', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const out = scrubModelOutput({ createdAt: d });
    expect(out.createdAt).toBe(d);
  });
});
