/**
 * Content hashing for WordPress version safety (Phase 9, §30). A pure
 * sha256 over the fields that matter for a content change, matching the
 * hand-rolled-crypto convention `tiktok/publish.ts`'s `contentHash` already
 * established for dedupe — reused here to detect a concurrent edit rather
 * than a duplicate submission.
 */
import { createHash } from 'node:crypto';

export interface HashableContent {
  title?: string | null;
  excerpt?: string | null;
  content?: string | null;
}

export function contentHash(input: HashableContent): string {
  return createHash('sha256')
    .update(`${input.title ?? ''}|${input.excerpt ?? ''}|${input.content ?? ''}`)
    .digest('hex');
}
