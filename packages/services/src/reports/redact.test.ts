import { describe, expect, it } from 'vitest';
import { redactSnapshotForPublic, scrubText } from './redact.js';
import { sampleSnapshot } from './sample.js';

describe('scrubText', () => {
  it('removes emails, URLs, @handles and long ids', () => {
    const out = scrubText(
      'Reach me at ops@acme.com or https://studio.youtube.com/abc via @acmecreator id AKfycbx0Longtokenvaluehere123',
    );
    expect(out).not.toContain('ops@acme.com');
    expect(out).not.toContain('https://');
    expect(out).not.toContain('@acmecreator');
    expect(out).not.toContain('AKfycbx0Longtokenvaluehere123');
    expect(out).toContain('[redacted]');
    expect(out).toContain('a page');
  });
});

describe('redactSnapshotForPublic', () => {
  const pub = redactSnapshotForPublic(sampleSnapshot());

  it('replaces the subject label and org name with generic text and marks it public', () => {
    expect(pub.meta.isPublic).toBe(true);
    expect(pub.meta.subjectLabel).toBe('a YouTube channel');
    expect(pub.meta.orgName).toBe('Shared report');
    expect(JSON.stringify(pub)).not.toContain('Acme Channel');
    expect(JSON.stringify(pub)).not.toContain('Acme Inc');
  });

  it('scrubs emails / URLs / handles from every free-text field', () => {
    const blob = JSON.stringify(pub);
    expect(blob).not.toContain('ops@acme.com');
    expect(blob).not.toContain('studio.youtube.com');
    expect(blob).not.toContain('search.google.com');
    expect(blob).not.toMatch(/@acme/i);
  });

  it('hides raw monetary amounts but keeps other metrics', () => {
    const revenue = pub.keyMetrics.find((m) => m.label === 'Recorded revenue')!;
    expect(revenue.value).toMatch(/hidden/i);
    expect(revenue.raw).toBeNull();
    expect(revenue.delta?.previous).toBe('hidden');
    const subs = pub.keyMetrics.find((m) => m.label === 'Subscribers')!;
    expect(subs.value).toBe('12.3K');
    expect(subs.delta?.changePct).toBe(3.4);
  });

  it('hides revenue values in historical changes but keeps the rows', () => {
    const rev = pub.historicalChanges.changes.find((c) => c.label === 'Recorded revenue')!;
    expect(rev.from).toBe('hidden');
    expect(rev.to).toBe('hidden');
    const subs = pub.historicalChanges.changes.find((c) => c.label === 'Subscribers')!;
    expect(subs.from).toBe('11.9K');
  });

  it('is idempotent', () => {
    expect(JSON.stringify(redactSnapshotForPublic(pub))).toEqual(JSON.stringify(pub));
  });
});
