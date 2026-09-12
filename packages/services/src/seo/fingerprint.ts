/**
 * Content fingerprints for near-duplicate detection (docs/SEO-ENGINE.md
 * "Duplication" rules). `contentHash` is an exact digest of the visible text;
 * `simhash` is a 64-bit locality-sensitive hash so pages that differ only in
 * boilerplate still cluster together.
 */
import { createHash } from 'node:crypto';

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

/** 3-word shingles of the normalized text. */
export function shingles(text: string, size = 3): string[] {
  const words = normalizeText(text).split(' ').filter(Boolean);
  if (words.length < size) return words.length ? [words.join(' ')] : [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(' '));
  return out;
}

function hash64(s: string): bigint {
  // FNV-1a 64-bit — cheap and good enough as the per-feature hash for simhash.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

/** 64-bit simhash of the text's shingles, returned as a 16-char hex string. */
export function simhash(text: string): string {
  const feats = shingles(text);
  if (feats.length === 0) return '0'.repeat(16);
  const bits = new Array<number>(64).fill(0);
  for (const f of feats) {
    const h = hash64(f);
    for (let b = 0; b < 64; b++) {
      bits[b] = (bits[b] ?? 0) + (((h >> BigInt(b)) & 1n) === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if ((bits[b] ?? 0) > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

/** Hamming distance between two hex simhashes (0 = identical). */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Pages within this Hamming distance are treated as near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 6;
