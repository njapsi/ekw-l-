import { describe, expect, it } from 'vitest';
import { scrubContext, scrubSecrets } from './scrub.js';

describe('scrubSecrets', () => {
  it('redacts vendor key shapes', () => {
    expect(scrubSecrets('key sk-ant-api03-abcdefgh12345678 more')).not.toContain('sk-ant-api03');
    expect(scrubSecrets('AIzaSyA1234567890abcdefghij')).toBe('[redacted]');
    expect(scrubSecrets('whsec_abcdefgh12345678')).toBe('[redacted]');
  });

  it('redacts Authorization header values but keeps the scheme', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOi.payloadpart.sigpart')).toMatch(
      /Bearer \[redacted\]/,
    );
  });

  it('redacts credentials in a connection string', () => {
    expect(scrubSecrets('postgres://user:s3cr3tpw@db:5432/app')).toBe(
      'postgres://user:[redacted]@db:5432/app',
    );
  });

  it('redacts the value of a NAME=secret assignment, keeping the name', () => {
    const out = scrubSecrets('STRIPE_SECRET_KEY=sk_live_deadbeefcafe123 rest');
    expect(out).toContain('STRIPE_SECRET_KEY=');
    expect(out).not.toContain('deadbeefcafe123');
  });

  it('leaves ordinary text and short ids alone', () => {
    const text = 'crawl 42 finished with 3 issues on example.com';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('is safe on empty / null input', () => {
    expect(scrubSecrets('')).toBe('');
    expect(scrubSecrets(null)).toBe('');
  });
});

describe('scrubContext', () => {
  it('drops values under sensitive keys and scrubs string values', () => {
    const out = scrubContext({
      apiKey: 'sk-ant-abc',
      note: 'token=sk_live_abcdef123456',
      count: 3,
      nested: { a: 1 },
    });
    expect(out.apiKey).toBe('[redacted]');
    expect(out.note).not.toContain('sk_live');
    expect(out.count).toBe(3);
    expect(out.nested).toBe('[object]');
  });
});
