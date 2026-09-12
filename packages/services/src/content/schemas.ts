/**
 * Schemas for the content repurposing engine (master instruction, Phase 8).
 *
 * The pipeline: SOURCE → CONTENT ANALYSIS → KEY IDEAS → CONTENT ANGLES →
 * PLATFORM-SPECIFIC CONTENT. `ContentAnalysis` is the analysis stage; the 13
 * `GEN_SCHEMAS` are the platform-specific generation stage.
 *
 * Generation is creative, so grounding is lighter than the analytics agents:
 * no fabricated statistics or quotes, no guarantee phrasing — but the model may
 * paraphrase and invent hooks. Every generated item cites the key-idea ids it
 * builds on.
 */
import { z } from 'zod';

// --- Analysis stage -------------------------------------------------

export const ContentAnalysis = z.object({
  /** CONTENT ANALYSIS — a neutral read of the source. */
  summary: z.string().min(1),
  contentType: z.string().min(1), // e.g. "tutorial", "interview", "vlog", "essay"
  tone: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1),
  /** KEY IDEAS — the reusable substance. */
  keyIdeas: z
    .array(
      z.object({
        id: z.string().min(1),
        idea: z.string().min(1),
        /** A verbatim snippet from the source, when one supports the idea. */
        sourceQuote: z.string().optional(),
      }),
    )
    .min(1),
  audienceTakeaways: z.array(z.string().min(1)).default([]),
  /** CONTENT ANGLES — distinct framings for repurposed pieces. */
  contentAngles: z
    .array(
      z.object({
        id: z.string().min(1),
        angle: z.string().min(1),
        rationale: z.string().min(1),
        keyIdeaIds: z.array(z.string()).min(1),
      }),
    )
    .min(1),
  keywords: z.array(z.string().min(1)).default([]),
  disclaimers: z.array(z.string()).default([]),
});
export type ContentAnalysis = z.infer<typeof ContentAnalysis>;

// --- Generation stage: one schema per ContentAssetType ------------

const cited = z.array(z.string()).min(1); // key-idea ids

export const TitleAlternatives = z.object({
  options: z.array(z.string().min(1)).min(3).max(8),
  keyIdeaIds: cited,
});

export const YouTubeDescription = z.object({
  body: z.string().min(1),
  keyIdeaIds: cited,
});

export const YouTubeChapters = z.object({
  chapters: z
    .array(
      z.object({
        timestamp: z.string().optional(), // "0:00" style; optional when no transcript timings
        title: z.string().min(1),
      }),
    )
    .min(2),
  keyIdeaIds: cited,
});

export const ShortsIdea = z.object({
  title: z.string().min(1),
  hook: z.string().min(1),
  beats: z.array(z.string().min(1)).min(2),
  onScreenText: z.array(z.string()).default([]),
  keyIdeaIds: cited,
});

export const TikTokIdea = z.object({
  title: z.string().min(1),
  concept: z.string().min(1),
  hook: z.string().min(1),
  beats: z.array(z.string().min(1)).min(2),
  keyIdeaIds: cited,
});

export const TikTokCaption = z.object({
  caption: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  keyIdeaIds: cited,
});

export const Hook = z.object({
  options: z.array(z.string().min(1)).min(3).max(10),
  format: z.enum(['spoken', 'on-screen', 'thumbnail-text', 'first-line']).default('spoken'),
  keyIdeaIds: cited,
});

export const Script = z.object({
  format: z.enum(['short-form', 'long-form-segment']),
  hook: z.string().min(1),
  script: z.string().min(1), // the spoken/read script text
  callToAction: z.string().optional(),
  approxDurationSec: z.number().int().positive().optional(),
  keyIdeaIds: cited,
});

export const SocialPost = z.object({
  platform: z.enum(['x', 'linkedin', 'instagram', 'threads', 'facebook', 'generic']),
  body: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  keyIdeaIds: cited,
});

export const BlogIdea = z.object({
  workingTitle: z.string().min(1),
  angle: z.string().min(1),
  targetReader: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(2),
  keyIdeaIds: cited,
});

export const SeoArticleOutline = z.object({
  workingTitle: z.string().min(1),
  targetQuery: z.string().min(1),
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        bullets: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(3),
  internalLinkIdeas: z.array(z.string()).default([]),
  keyIdeaIds: cited,
});

export const Faq = z.object({
  items: z
    .array(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
      }),
    )
    .min(3),
  keyIdeaIds: cited,
});

export const NewsletterIdea = z.object({
  subjectLines: z.array(z.string().min(1)).min(2).max(6),
  angle: z.string().min(1),
  outline: z.array(z.string().min(1)).min(2),
  keyIdeaIds: cited,
});

/** The 13 asset types → their generation schema + platform + whether the
 * generator produces one asset or a set. */
export const GEN_SCHEMAS = {
  YT_TITLE_ALTERNATIVES: {
    schema: TitleAlternatives,
    platform: 'youtube',
    multi: false,
    label: 'YouTube title alternatives',
  },
  YT_DESCRIPTION: {
    schema: YouTubeDescription,
    platform: 'youtube',
    multi: false,
    label: 'YouTube description',
  },
  YT_CHAPTERS: {
    schema: YouTubeChapters,
    platform: 'youtube',
    multi: false,
    label: 'YouTube chapters',
  },
  SHORTS_IDEA: { schema: ShortsIdea, platform: 'youtube', multi: true, label: 'Shorts idea' },
  TIKTOK_IDEA: { schema: TikTokIdea, platform: 'tiktok', multi: true, label: 'TikTok idea' },
  TIKTOK_CAPTION: {
    schema: TikTokCaption,
    platform: 'tiktok',
    multi: true,
    label: 'TikTok caption',
  },
  HOOK: { schema: Hook, platform: 'generic', multi: false, label: 'Hooks' },
  SCRIPT: { schema: Script, platform: 'generic', multi: true, label: 'Script' },
  SOCIAL_POST: { schema: SocialPost, platform: 'social', multi: true, label: 'Social post' },
  BLOG_IDEA: { schema: BlogIdea, platform: 'blog', multi: true, label: 'Blog idea' },
  SEO_ARTICLE_OUTLINE: {
    schema: SeoArticleOutline,
    platform: 'blog',
    multi: true,
    label: 'SEO article outline',
  },
  FAQ: { schema: Faq, platform: 'blog', multi: false, label: 'FAQ' },
  NEWSLETTER_IDEA: {
    schema: NewsletterIdea,
    platform: 'newsletter',
    multi: true,
    label: 'Newsletter idea',
  },
} as const;

export type ContentAssetTypeKey = keyof typeof GEN_SCHEMAS;
export const ALL_ASSET_TYPES = Object.keys(GEN_SCHEMAS) as ContentAssetTypeKey[];

/** How many items to ask the model for when `multi` is true. */
export const MULTI_COUNT = 3;
