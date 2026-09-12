import { describe, expect, it } from 'vitest';
import { slugify, uniqueSlug } from './slug.js';

describe('slugify', () => {
  it('lowercases, trims and hyphenates', () => {
    expect(slugify('  Acme Media Co. ')).toBe('acme-media-co');
  });
  it('collapses separators and strips leading/trailing hyphens', () => {
    expect(slugify('--Hello___World!!--')).toBe('hello-world');
  });
  it('strips accents', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });
  it('caps length at 40', () => {
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when free', async () => {
    expect(await uniqueSlug('My Org', () => Promise.resolve(false))).toBe('my-org');
  });
  it('appends a counter until free', async () => {
    const taken = new Set(['my-org', 'my-org-2', 'my-org-3']);
    expect(await uniqueSlug('My Org', (s) => Promise.resolve(taken.has(s)))).toBe('my-org-4');
  });
});
