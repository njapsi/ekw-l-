import { describe, expect, it } from 'vitest';
import { diffChangeRatio, diffText } from './diff.js';

describe('diffText', () => {
  it('returns a single equal token for identical text', () => {
    const tokens = diffText('hello world', 'hello world');
    expect(tokens.every((t) => t.op === 'equal')).toBe(true);
  });

  it('detects an inserted word', () => {
    const tokens = diffText('the cat sat', 'the big cat sat');
    expect(tokens.some((t) => t.op === 'insert' && t.text.includes('big'))).toBe(true);
  });

  it('detects a deleted word', () => {
    const tokens = diffText('the big cat sat', 'the cat sat');
    expect(tokens.some((t) => t.op === 'delete' && t.text.includes('big'))).toBe(true);
  });

  it('detects a replacement as a delete + insert pair', () => {
    const tokens = diffText('the cat sat', 'the dog sat');
    expect(tokens.some((t) => t.op === 'delete' && t.text.includes('cat'))).toBe(true);
    expect(tokens.some((t) => t.op === 'insert' && t.text.includes('dog'))).toBe(true);
  });

  it('handles an empty original (pure insertion)', () => {
    const tokens = diffText('', 'new text');
    expect(tokens.every((t) => t.op === 'insert')).toBe(true);
  });

  it('handles an empty proposed (pure deletion)', () => {
    const tokens = diffText('old text', '');
    expect(tokens.every((t) => t.op === 'delete')).toBe(true);
  });

  it('never hangs on a huge single-line input (falls back past word-level tiering)', () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => `w${i}`).join(' ');
    const start = Date.now();
    diffText(huge, huge);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('never hangs on a long multi-paragraph article with a small real edit', () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} has some ordinary prose in it.`);
    const original = paragraphs.join('\n\n');
    const proposed = [...paragraphs.slice(0, 150), 'A changed paragraph.', ...paragraphs.slice(151)].join('\n\n');
    const start = Date.now();
    const tokens = diffText(original, proposed);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(tokens.some((t) => t.op !== 'equal')).toBe(true);
  });

  it('never attempts an unbounded diff when both word- and paragraph-level tiers are too large', () => {
    // Thousands of one-line "paragraphs" that also differ — both tiers
    // exceed WORD_LEVEL_MAX_TOKENS, so this must hit the final fallback.
    const original = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');
    const proposed = Array.from({ length: 5_000 }, (_, i) => `line ${i}-changed`).join('\n');
    const start = Date.now();
    const tokens = diffText(original, proposed);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(tokens).toEqual([
      { op: 'delete', text: original },
      { op: 'insert', text: proposed },
    ]);
  });
});

describe('diffChangeRatio', () => {
  it('is 0 for identical text', () => {
    expect(diffChangeRatio('hello world', 'hello world')).toBe(0);
  });

  it('is greater than 0 for changed text', () => {
    expect(diffChangeRatio('hello world', 'goodbye world')).toBeGreaterThan(0);
  });

  it('never exceeds 1', () => {
    expect(diffChangeRatio('a', 'a completely different and much longer sentence')).toBeLessThanOrEqual(1);
  });
});
