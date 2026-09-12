/**
 * Output schema for the SEO Auditor Agent's crawl summary. Same discipline as
 * the YouTube/TikTok analysts (docs/AI-ARCHITECTURE.md): every analytical item
 * cites `evidenceFactIds` from the deterministic fact sheet, and the model may
 * not invent numbers or promise ranking outcomes.
 */
import { z } from 'zod';

const Cited = z.object({
  text: z.string().min(1),
  evidenceFactIds: z.array(z.string()).min(1),
});

export const CrawlAuditAnalysis = z.object({
  headline: z.string().min(1),
  /** Plain-language read of the crawl's state. */
  overview: z.string().min(1),
  dataCoverage: z.string().min(1),
  keyObservations: z.array(Cited).default([]),
  prioritizedActions: z
    .array(
      z.object({
        title: z.string().min(1),
        rationale: z.string().min(1),
        priority: z.enum(['critical', 'high', 'medium', 'low']),
        effort: z.enum(['low', 'medium', 'high']),
        expectedImpact: z.string().min(1),
        recommendedActions: z.array(z.string().min(1)).min(1),
        evidenceFactIds: z.array(z.string()).min(1),
      }),
    )
    .default([]),
  disclaimers: z.array(z.string()).default([]),
});
export type CrawlAuditAnalysis = z.infer<typeof CrawlAuditAnalysis>;
