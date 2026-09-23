import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunking.js';

describe('chunkDocument', () => {
  it('returns nothing for empty input', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   ')).toEqual([]);
  });

  it('starts a new chunk at each markdown heading and carries it as metadata', () => {
    const text = '# Pricing\n\nWe charge $10/mo.\n\n## Refunds\n\nFull refund within 30 days.';
    const chunks = chunkDocument(text);
    expect(chunks.map((c) => c.heading)).toEqual(['Pricing', 'Refunds']);
    expect(chunks[0]?.text).toContain('$10/mo');
    expect(chunks[1]?.text).toContain('30 days');
  });

  it('groups consecutive short paragraphs into one chunk under the char budget', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunkDocument(text, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Paragraph one.\n\nParagraph two.\n\nParagraph three.');
  });

  it('splits once the running buffer would exceed maxChars, never producing one oversized chunk', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`;
    const chunks = chunkDocument(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(60);
  });

  it('hard-splits a single paragraph that alone exceeds maxChars, rather than producing an unbounded chunk', () => {
    const text = 'x'.repeat(250);
    const chunks = chunkDocument(text, 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100);
  });

  it('assigns sequential zero-based indices', () => {
    const chunks = chunkDocument('a\n\nb\n\nc', 1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });
});
