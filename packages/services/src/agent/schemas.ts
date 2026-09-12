/**
 * Schemas for the Unified AI Growth Agent (master instruction "PHASE 7").
 *
 * The agent never exposes private chain-of-thought. The model produces only:
 *   - a `TurnPlan` (which capabilities to run + a one-line, non-CoT rationale)
 *   - a `GrowthAgentResponse` with the concise, user-facing blocks:
 *     analysis summary · evidence · decisions · recommendations · actions
 */
import { z } from 'zod';

/** Ids of the specialized capabilities the orchestrator can invoke. */
export const CAPABILITY_IDS = [
  'org-context',
  'youtube-analyst',
  'youtube-monetization',
  'tiktok-analyst',
  'seo-agent',
  'content-repurpose',
  'growth-plan',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const TurnPlan = z.object({
  /** A short label for what the user is asking. Not chain-of-thought. */
  intent: z.string().min(1).max(200),
  /** Capabilities to run, in order. `org-context` is always run first by the
   * orchestrator regardless of what the model returns. */
  capabilities: z.array(z.enum(CAPABILITY_IDS)).max(5).default([]),
  /** One sentence on the routing decision — a summary, never step-by-step
   * reasoning. */
  rationale: z.string().min(1).max(400),
  /** Prerequisites the user must satisfy first (e.g. "connect YouTube"). */
  missingPrerequisites: z.array(z.string().max(200)).default([]),
});
export type TurnPlan = z.infer<typeof TurnPlan>;

export const EvidenceItem = z.object({
  source: z.string().min(1), // capability id or "org-context"
  statement: z.string().min(1),
  kind: z.enum(['fact', 'calculated_metric', 'assumption', 'prediction', 'recommendation']),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const AgentRecommendation = z.object({
  title: z.string().min(1),
  problem: z.string().min(1),
  whyItMatters: z.string().min(1),
  howToFix: z.string().min(1),
  expectedBenefit: z.string().min(1),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  difficulty: z.enum(['trivial', 'small', 'medium', 'large']),
  confidence: z.number().min(0).max(1),
  domain: z.enum(['SEO', 'YOUTUBE', 'TIKTOK', 'CONTENT', 'GROWTH']),
  affectedUrls: z.array(z.string()).default([]),
  affectedRefs: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).min(1),
});
export type AgentRecommendation = z.infer<typeof AgentRecommendation>;

export const ProposedAction = z.object({
  kind: z.enum(['create_task', 'external']),
  label: z.string().min(1),
  /** For create_task: which recommendation index it materialises. */
  recommendationIndex: z.number().int().nonnegative().optional(),
  /** For external: the owning feature + why it needs confirmation. */
  externalActionKind: z.string().optional(),
  requiresConfirmation: z.boolean().default(true),
  note: z.string().optional(),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

/** The user-facing structured answer. No `thinking` / `reasoningSteps` field —
 * chain-of-thought is never surfaced. */
export const GrowthAgentResponse = z.object({
  analysisSummary: z.string().min(1),
  analysisSummaryEvidenceRefs: z.array(z.string()).min(1),
  evidence: z.array(EvidenceItem).default([]),
  /** What the agent chose to do and why — concise, decision-level only. */
  decisions: z.array(z.string().min(1)).default([]),
  recommendations: z.array(AgentRecommendation).default([]),
  proposedActions: z.array(ProposedAction).default([]),
  disclaimers: z.array(z.string()).default([]),
});
export type GrowthAgentResponse = z.infer<typeof GrowthAgentResponse>;

/** Strict schema for what the memory extractor may persist. */
export const MemoryExtraction = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['USER_GOAL', 'ORG_GOAL', 'PREFERENCE', 'ACTIVE_PROJECT']),
        label: z.string().min(1).max(60),
        value: z.string().min(1).max(300),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
    )
    .max(6)
    .default([]),
});
export type MemoryExtraction = z.infer<typeof MemoryExtraction>;

export const EXAMPLE_PROMPTS = [
  'Why is my YouTube channel losing momentum?',
  'What should I post this week?',
  'Which of my videos should I remake?',
  'How can I make more money from my existing audience?',
  'Analyze my website.',
  'What are the five biggest SEO problems?',
  'Which pages should I fix first?',
  'Give me a 30-day growth plan.',
  'Turn my YouTube video into TikTok content.',
  'Give me a plan to improve my technical SEO.',
] as const;
