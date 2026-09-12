/**
 * Monetization Intelligence — types + schemas (master instruction, Phase 9).
 *
 * The opportunity engine is deterministic; the model may only refine prose,
 * grounded against the signals fact sheet. Every `potential` / `difficulty` /
 * `audienceFit` is a **labelled estimate** — never a currency figure. Revenue is
 * only ever user-entered (`RevenueEntry`).
 */
import { z } from 'zod';

export const MONETIZATION_CHANNELS = [
  'PLATFORM_MONETIZATION',
  'SPONSORSHIP',
  'AFFILIATE',
  'DIGITAL_PRODUCT',
  'SERVICE',
  'MEMBERSHIP',
  'SUBSCRIPTION',
  'LEAD_GENERATION',
  'CONSULTING',
  'COURSE',
  'BRAND_PARTNERSHIP',
] as const;
export type MonetizationChannelKey = (typeof MONETIZATION_CHANNELS)[number];

export const CHANNEL_LABEL: Record<MonetizationChannelKey, string> = {
  PLATFORM_MONETIZATION: 'Platform monetization',
  SPONSORSHIP: 'Sponsorships',
  AFFILIATE: 'Affiliate marketing',
  DIGITAL_PRODUCT: 'Digital products',
  SERVICE: 'Services',
  MEMBERSHIP: 'Memberships',
  SUBSCRIPTION: 'Subscriptions',
  LEAD_GENERATION: 'Lead generation',
  CONSULTING: 'Consulting',
  COURSE: 'Courses',
  BRAND_PARTNERSHIP: 'Brand partnerships',
};

export type EvidenceKind = 'fact' | 'calculated_metric' | 'assumption';
export type AudienceFit = 'strong' | 'moderate' | 'weak' | 'unknown';
export type Difficulty = 'low' | 'medium' | 'high';
/** A labelled estimate — never a number. */
export type PotentialLabel = 'Low' | 'Moderate' | 'High';

export interface OpportunityDraft {
  channel: MonetizationChannelKey;
  title: string;
  description: string;
  /** "current" ⇒ evidence shows it is available/active now; "potential" ⇒ a
   * step is needed first. */
  readiness: 'current' | 'potential';
  evidence: Array<{ statement: string; kind: EvidenceKind }>;
  audienceFit: AudienceFit;
  difficulty: Difficulty;
  potential: PotentialLabel;
  potentialBasis: string;
  requiredActions: string[];
  confidence: number;
  priorityScore: number;
}

/** Optional model layer: prose only, keyed by channel. */
export const MonetizationAnalysis = z.object({
  overview: z.string().min(1),
  overviewEvidenceRefs: z.array(z.string()).min(1),
  channelNotes: z
    .array(
      z.object({
        channel: z.enum(MONETIZATION_CHANNELS),
        description: z.string().min(1),
        requiredActions: z.array(z.string().min(1)).min(1),
        evidenceRefs: z.array(z.string()).min(1),
      }),
    )
    .default([]),
  disclaimers: z.array(z.string()).default([]),
});
export type MonetizationAnalysis = z.infer<typeof MonetizationAnalysis>;

export const AUDIENCE_BANDS = [
  { min: 0, label: 'nascent' },
  { min: 1_000, label: 'small' },
  { min: 10_000, label: 'mid' },
  { min: 100_000, label: 'large' },
  { min: 1_000_000, label: 'major' },
] as const;

export function audienceBand(
  size: number | null,
): (typeof AUDIENCE_BANDS)[number]['label'] | 'unknown' {
  if (size == null) return 'unknown';
  let band: (typeof AUDIENCE_BANDS)[number]['label'] = 'nascent';
  for (const b of AUDIENCE_BANDS) if (size >= b.min) band = b.label;
  return band;
}
