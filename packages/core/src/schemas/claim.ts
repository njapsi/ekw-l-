import { z } from 'zod';

/**
 * The AI must always distinguish the epistemic status of every statement it
 * emits (master instruction, section D):
 *   fact | calculated metric | assumption | prediction | recommendation
 * Nothing the agent outputs may be untagged.
 */
export const ClaimKind = z.enum([
  'fact',
  'calculated_metric',
  'assumption',
  'prediction',
  'recommendation',
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const EvidenceSource = z.object({
  /** e.g. "youtube.analytics.v2", "crawl:https://example.com/", "user_input" */
  origin: z.string().min(1),
  /** Optional URL or record id the claim can be traced back to. */
  reference: z.string().optional(),
  retrievedAt: z.string().datetime().optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const Claim = z.object({
  kind: ClaimKind,
  statement: z.string().min(1),
  /** 0..1 — required for assumptions and predictions. */
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(EvidenceSource).default([]),
});
export type Claim = z.infer<typeof Claim>;
