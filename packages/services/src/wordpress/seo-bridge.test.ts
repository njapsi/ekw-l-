import { describe, expect, it } from 'vitest';
import { buildFixProposal } from './seo-bridge.js';

describe('buildFixProposal', () => {
  it('returns null for an issue code with no writable field mapping', () => {
    expect(buildFixProposal('MISSING_IMAGE_ALT', { title: 'T', excerpt: 'E', content: 'C' })).toBeNull();
    expect(buildFixProposal('ORPHAN_PAGE', { title: 'T', excerpt: 'E', content: 'C' })).toBeNull();
  });

  it('proposes a title derived from existing content for MISSING_TITLE', () => {
    const proposal = buildFixProposal('MISSING_TITLE', {
      title: '',
      excerpt: '',
      content: 'This article explains how to configure a reverse proxy for a Node.js application.',
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.field).toBe('title');
    expect(proposal!.proposedValue.length).toBeGreaterThan(0);
    expect(proposal!.derivedFromExistingContent).toBe(true);
  });

  it('returns null for MISSING_TITLE when there is no source text at all', () => {
    expect(buildFixProposal('MISSING_TITLE', { title: '', excerpt: '', content: '' })).toBeNull();
  });

  it('truncates an over-length title for TITLE_LENGTH', () => {
    const longTitle = 'A'.repeat(120);
    const proposal = buildFixProposal('TITLE_LENGTH', { title: longTitle, excerpt: '', content: '' });
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedValue.length).toBeLessThanOrEqual(60);
  });

  it('proposes an excerpt derived from existing content for MISSING_META_DESCRIPTION', () => {
    const proposal = buildFixProposal('MISSING_META_DESCRIPTION', {
      title: 'T',
      excerpt: '',
      content:
        'This guide walks through setting up continuous integration for a monorepo using GitHub Actions and pnpm workspaces, with caching strategies for faster builds.',
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.field).toBe('excerpt');
    expect(proposal!.rationale).toMatch(/approximation/);
  });

  it('truncates an over-length excerpt for META_DESCRIPTION_LENGTH', () => {
    const longExcerpt = 'B'.repeat(300);
    const proposal = buildFixProposal('META_DESCRIPTION_LENGTH', {
      title: '',
      excerpt: longExcerpt,
      content: '',
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedValue.length).toBeLessThanOrEqual(160);
  });

  it('returns null when the derived proposal is identical to the current value', () => {
    // A short excerpt within the target range and no content to expand from
    // is left as-is — do not propose a no-op change.
    expect(
      buildFixProposal('META_DESCRIPTION_LENGTH', { title: '', excerpt: '', content: '' }),
    ).toBeNull();
  });

  it('never fabricates a claim not present in the source text', () => {
    const source = 'Our return policy allows returns within 30 days of purchase.';
    const proposal = buildFixProposal('MISSING_META_DESCRIPTION', {
      title: '',
      excerpt: '',
      content: source,
    });
    expect(proposal).not.toBeNull();
    // The proposed text must be a substring/truncation of the real source —
    // never new invented content.
    expect(source.startsWith(proposal!.proposedValue.replace(/…$/, ''))).toBe(true);
  });
});
