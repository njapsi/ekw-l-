import { describe, expect, it } from 'vitest';
import { contentHash, hammingDistance, shingles, simhash } from './fingerprint.js';

describe('contentHash', () => {
  it('is stable under whitespace/case differences', () => {
    expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
  });
  it('differs for different content', () => {
    expect(contentHash('one two three')).not.toBe(contentHash('four five six'));
  });
});

describe('shingles', () => {
  it('produces 3-word windows', () => {
    expect(shingles('a b c d')).toEqual(['a b c', 'b c d']);
  });
});

describe('simhash + hamming', () => {
  it('near-identical text is much closer than unrelated text', () => {
    const base =
      'The quick brown fox jumps over the lazy dog near the river bank in the morning light every single day';
    const near = simhash(`${base} today`);
    const same = simhash(base);
    const unrelated = simhash(
      'the botanical garden opened a new orchid pavilion for spring visitors this weekend near downtown',
    );
    const nearDist = hammingDistance(near, same);
    const farDist = hammingDistance(unrelated, same);
    expect(nearDist).toBeLessThan(farDist);
    expect(nearDist).toBeLessThan(12);
  });

  it('unrelated text has a large Hamming distance', () => {
    const a = simhash(
      'financial markets rallied sharply after the central bank decision this week again',
    );
    const b = simhash(
      'the botanical garden opened a new orchid pavilion for spring visitors nearby',
    );
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
  });

  it('identical text has distance 0', () => {
    const t = 'exactly the same sentence repeated for the fingerprint test here';
    expect(hammingDistance(simhash(t), simhash(t))).toBe(0);
  });
});
