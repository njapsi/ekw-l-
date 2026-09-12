import { z } from 'zod';

/**
 * Structured output contract for the YouTube Analyst Agent. Every analytical
 * item must cite `evidenceFactIds` that resolve to facts in the fact sheet the
 * agent was given — this is the primary anti-hallucination guard
 * (docs/AI-ARCHITECTURE.md §7). Free-text numbers are additionally checked
 * against the fact sheet.
 */
const confidence = z.number().min(0).max(1);
const factIds = z.array(z.string().min(1)).min(1);

export const YtFinding = z.object({
  id: z.string().min(1),
  kind: z.enum(['opportunity', 'warning', 'observation']),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidenceFactIds: factIds,
  confidence,
});

export const YtRecommendation = z.object({
  id: z.string().min(1),
  category: z.enum([
    'titles',
    'descriptions',
    'topics',
    'publishing',
    'engagement',
    'catalogue',
    'monetization',
  ]),
  title: z.string().min(1),
  reasoning: z.string().min(1),
  suggestedAction: z.string().min(1),
  expectedImpact: z.string().min(1),
  confidence,
  effort: z.enum(['trivial', 'small', 'medium', 'large']),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  evidenceFactIds: factIds,
});

export const YtSuggestion = z.object({
  forVideoId: z.string().optional(),
  suggestion: z.string().min(1),
  rationale: z.string().min(1),
  evidenceFactIds: factIds,
});

export const YtTopicSuggestion = z.object({
  topic: z.string().min(1),
  rationale: z.string().min(1),
  evidenceFactIds: factIds,
});

export const YtContentIdea = z.object({
  title: z.string().min(1),
  format: z.enum(['long-form', 'short', 'series', 'livestream']),
  rationale: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  evidenceFactIds: factIds,
});

export const YouTubeAnalysis = z.object({
  channelTitle: z.string().min(1),
  dataCoverage: z.string().min(1),
  findings: z.array(YtFinding).default([]),
  recommendations: z.array(YtRecommendation).default([]),
  titleSuggestions: z.array(YtSuggestion).default([]),
  descriptionSuggestions: z.array(YtSuggestion).default([]),
  topicSuggestions: z.array(YtTopicSuggestion).default([]),
  publishingRecommendations: z.array(YtSuggestion).default([]),
  contentIdeas: z.array(YtContentIdea).default([]),
  disclaimers: z.array(z.string()).default([]),
});

export type YouTubeAnalysis = z.infer<typeof YouTubeAnalysis>;
export type YtRecommendation = z.infer<typeof YtRecommendation>;
