import { z } from 'zod';

/**
 * Structured output contract for the TikTok Analyst Agent. Same grounding
 * discipline as the YouTube analyst: every analytical item cites
 * `evidenceFactIds` from the fact sheet; a grounding check runs before
 * persistence (docs/AI-ARCHITECTURE.md §6).
 */
const confidence = z.number().min(0).max(1);
const factIds = z.array(z.string().min(1)).min(1);

export const TtObservation = z.object({
  id: z.string().min(1),
  kind: z.enum(['opportunity', 'warning', 'observation']),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidenceFactIds: factIds,
  confidence,
});

export const TtRecommendation = z.object({
  id: z.string().min(1),
  category: z.enum(['themes', 'captions', 'hashtags', 'posting', 'repurposing', 'engagement']),
  title: z.string().min(1),
  reasoning: z.string().min(1),
  suggestedAction: z.string().min(1),
  expectedImpact: z.string().min(1),
  confidence,
  effort: z.enum(['trivial', 'small', 'medium', 'large']),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  evidenceFactIds: factIds,
});

export const TtCaptionIdea = z.object({
  caption: z.string().min(1),
  rationale: z.string().min(1),
  evidenceFactIds: factIds,
});

export const TtHashtagSuggestion = z.object({
  hashtags: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  evidenceFactIds: factIds,
});

export const TtContentIdea = z.object({
  title: z.string().min(1),
  format: z.enum(['short', 'series', 'trend-response', 'repurpose']),
  rationale: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  evidenceFactIds: factIds,
});

export const TikTokAnalysis = z.object({
  accountName: z.string().min(1),
  dataCoverage: z.string().min(1),
  observations: z.array(TtObservation).default([]),
  recommendations: z.array(TtRecommendation).default([]),
  contentIdeas: z.array(TtContentIdea).default([]),
  captionIdeas: z.array(TtCaptionIdea).default([]),
  hashtagSuggestions: z.array(TtHashtagSuggestion).default([]),
  contentThemes: z
    .array(
      z.object({
        theme: z.string().min(1),
        rationale: z.string().min(1),
        evidenceFactIds: factIds,
      }),
    )
    .default([]),
  postingRecommendations: z
    .array(
      TtCaptionIdea.pick({ rationale: true }).extend({
        suggestion: z.string().min(1),
        evidenceFactIds: factIds,
      }),
    )
    .default([]),
  repurposingRecommendations: z
    .array(
      z.object({
        suggestion: z.string().min(1),
        rationale: z.string().min(1),
        evidenceFactIds: factIds,
      }),
    )
    .default([]),
  disclaimers: z.array(z.string()).default([]),
});

export type TikTokAnalysis = z.infer<typeof TikTokAnalysis>;
