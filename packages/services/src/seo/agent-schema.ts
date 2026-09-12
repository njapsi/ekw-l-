/**
 * Schemas for the AI SEO Agent.
 *
 * `SeoAgentModelOutput` is the ONLY thing the model produces — narrative prose
 * plus (optionally) an answer to the user's question. Every number and every
 * recommendation ranking is computed deterministically elsewhere; the model
 * refines wording only, and its free text is grounding-checked before use.
 */
import { z } from 'zod';

export const SeoAgentModelOutput = z.object({
  /** Present only when the caller asked a question; else an empty string. */
  answer: z.string().default(''),
  answerEvidenceFactIds: z.array(z.string()).default([]),
  /** A grounded, plain-language read of the crawl + priorities. */
  executiveSummary: z.string().min(1),
  executiveSummaryEvidenceFactIds: z.array(z.string()).min(1),
  /** Optional per-recommendation wording refinements, keyed by issue code. */
  recommendationNotes: z
    .array(
      z.object({
        code: z.string(),
        whyItMatters: z.string().min(1),
        evidenceFactIds: z.array(z.string()).min(1),
      }),
    )
    .default([]),
  aiReadabilityNote: z.string().default(''),
  aiReadabilityEvidenceFactIds: z.array(z.string()).default([]),
  /**
   * Optional interpretation that combines crawler + Search Console evidence.
   * Must label each claim as "Crawler evidence", "Search Console evidence" or
   * "AI interpretation" and cite fact ids. Empty when no property is connected.
   */
  searchConsoleNote: z.string().default(''),
  searchConsoleEvidenceFactIds: z.array(z.string()).default([]),
  disclaimers: z.array(z.string()).default([]),
});
export type SeoAgentModelOutput = z.infer<typeof SeoAgentModelOutput>;

export const SEO_AGENT_EXAMPLE_QUESTIONS = [
  "Why isn't Google finding these pages?",
  'Which pages are blocked from crawling?',
  'Which pages are probably not indexable?',
  'Where are my canonical conflicts?',
  'Which pages are orphaned?',
  'Which pages should receive internal links?',
  'Why does my sitemap contain problematic URLs?',
  'Which technical SEO problems should I fix first?',
  'How should I structure this website for better machine understanding?',
  'Which structured data opportunities exist?',
  'How can I make my website easier for AI agents to understand?',
] as const;
