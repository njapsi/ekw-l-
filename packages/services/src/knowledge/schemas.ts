/**
 * Phase 11 — Memory, Research & Knowledge Intelligence: shared types,
 * validation schemas, and the freshness policy table.
 *
 * `KnowledgeItem` never gets a bare string for `type`/`status`/
 * `classification` from user input without going through these Zod schemas
 * first — every write path in this module validates through here.
 */
import { z } from 'zod';
import type {
  KnowledgeClassification,
  KnowledgeImportance,
  KnowledgeScope,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeType,
} from '@growth-agent/db';

export const KNOWLEDGE_TYPES = [
  'BUSINESS_PROFILE',
  'BRAND_PROFILE',
  'AUDIENCE_PROFILE',
  'PRODUCT',
  'SERVICE',
  'OFFER',
  'WEBSITE',
  'SEO',
  'CONTENT',
  'YOUTUBE',
  'TIKTOK',
  'WORDPRESS',
  'COMPETITOR',
  'MARKET',
  'KEYWORD',
  'TOPIC',
  'CAMPAIGN',
  'MISSION',
  'EXPERIMENT',
  'PERFORMANCE',
  'CUSTOMER_INSIGHT',
  'GROWTH_INSIGHT',
  'USER_PREFERENCE',
  'ORGANIZATION_PREFERENCE',
  'STRATEGY',
  'DECISION',
  'ASSUMPTION',
  'CONSTRAINT',
  'GOAL',
  'RESOURCE',
  'PROCESS',
  'DOCUMENT',
  'RESEARCH',
  'EXTERNAL_FACT',
  'INTERNAL_FACT',
  'LEARNING',
] as const satisfies readonly KnowledgeType[];

export const KNOWLEDGE_CLASSIFICATIONS = [
  'FACT',
  'INFERENCE',
  'HYPOTHESIS',
  'OPINION',
  'USER_PROVIDED',
  'SYSTEM_OBSERVED',
  'EXTERNAL_SOURCE',
] as const satisfies readonly KnowledgeClassification[];

export const KNOWLEDGE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'VERIFIED',
  'UNVERIFIED',
  'STALE',
  'CONFLICTED',
  'ARCHIVED',
  'EXPIRED',
  'REJECTED',
] as const satisfies readonly KnowledgeStatus[];

export const KNOWLEDGE_SCOPES = [
  'USER',
  'ORGANIZATION',
  'MISSION',
] as const satisfies readonly KnowledgeScope[];

export const KNOWLEDGE_IMPORTANCE = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const satisfies readonly KnowledgeImportance[];

export const KNOWLEDGE_SOURCE_TYPES = [
  'YOUTUBE',
  'TIKTOK',
  'GOOGLE_SEARCH_CONSOLE',
  'WEBSITE_CRAWL',
  'WORDPRESS',
  'USER_INPUT',
  'UPLOADED_DOCUMENT',
  'INTERNAL_ANALYTICS',
  'MISSION_RESULT',
  'EXPERIMENT_RESULT',
  'AI_GENERATED',
  'WEB_RESEARCH',
] as const satisfies readonly KnowledgeSourceType[];

export const CreateKnowledgeItemInput = z.object({
  type: z.enum(KNOWLEDGE_TYPES),
  scope: z.enum(KNOWLEDGE_SCOPES).default('ORGANIZATION'),
  missionId: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  summary: z.string().max(600).optional(),
  classification: z.enum(KNOWLEDGE_CLASSIFICATIONS).default('SYSTEM_OBSERVED'),
  confidence: z.number().min(0).max(1).default(0.5),
  importance: z.enum(KNOWLEDGE_IMPORTANCE).default('MEDIUM'),
  status: z.enum(KNOWLEDGE_STATUSES).default('DRAFT'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: z
    .object({
      type: z.enum(KNOWLEDGE_SOURCE_TYPES),
      url: z.string().url().max(2000).optional(),
      title: z.string().max(300).optional(),
      publisher: z.string().max(200).optional(),
      author: z.string().max(200).optional(),
      publishedAt: z.coerce.date().optional(),
    })
    .optional(),
});
/** The pre-`.parse()` shape (defaulted fields stay optional) — every writer
 * of a `CreateKnowledgeItemInputT` passes a partial object and lets
 * `createKnowledgeItem` apply Zod's defaults, exactly like a real caller
 * (a tool, a Server Action) would. */
export type CreateKnowledgeItemInputT = z.input<typeof CreateKnowledgeItemInput>;

export const UpdateKnowledgeItemInput = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20_000).optional(),
  summary: z.string().max(600).optional(),
  classification: z.enum(KNOWLEDGE_CLASSIFICATIONS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.enum(KNOWLEDGE_IMPORTANCE).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateKnowledgeItemInputT = z.infer<typeof UpdateKnowledgeItemInput>;

/**
 * Part 36: freshness windows differ by kind of knowledge and must be
 * configurable, not hard-coded assumptions scattered through the app — this
 * table is the one place that decision lives. `ttlDays: null` means the
 * knowledge is a permanent historical record and never auto-expires (an
 * experiment result, a decision log entry) — it can still be manually
 * archived.
 */
export const FRESHNESS_POLICIES = {
  permanent: { label: 'Permanent historical record', ttlDays: null as number | null },
  long: { label: 'Long-lived', ttlDays: 365 },
  medium: { label: 'Medium', ttlDays: 90 },
  short: { label: 'Short', ttlDays: 14 },
  very_short: { label: 'Very short (trends, live metrics)', ttlDays: 3 },
} satisfies Record<string, { label: string; ttlDays: number | null }>;
export type FreshnessPolicyKey = keyof typeof FRESHNESS_POLICIES;

/** Part 3's types mapped to a default freshness policy (Part 36's examples,
 * applied to the full type list). Callers may still set a different policy
 * explicitly per item. */
export const DEFAULT_FRESHNESS_BY_TYPE: Record<KnowledgeType, FreshnessPolicyKey> = {
  BUSINESS_PROFILE: 'long',
  BRAND_PROFILE: 'long',
  AUDIENCE_PROFILE: 'long',
  PRODUCT: 'long',
  SERVICE: 'long',
  OFFER: 'long',
  WEBSITE: 'medium',
  SEO: 'short',
  CONTENT: 'medium',
  YOUTUBE: 'short',
  TIKTOK: 'short',
  WORDPRESS: 'medium',
  COMPETITOR: 'medium',
  MARKET: 'very_short',
  KEYWORD: 'medium',
  TOPIC: 'medium',
  CAMPAIGN: 'medium',
  MISSION: 'permanent',
  EXPERIMENT: 'permanent',
  PERFORMANCE: 'short',
  CUSTOMER_INSIGHT: 'medium',
  GROWTH_INSIGHT: 'medium',
  USER_PREFERENCE: 'long',
  ORGANIZATION_PREFERENCE: 'long',
  STRATEGY: 'medium',
  DECISION: 'permanent',
  ASSUMPTION: 'medium',
  CONSTRAINT: 'long',
  GOAL: 'medium',
  RESOURCE: 'long',
  PROCESS: 'long',
  DOCUMENT: 'long',
  RESEARCH: 'medium',
  EXTERNAL_FACT: 'medium',
  INTERNAL_FACT: 'medium',
  LEARNING: 'permanent',
};

/**
 * Part 5: the AI must never present a hypothesis/inference/opinion as an
 * established fact. This maps our finer 7-value `KnowledgeClassification`
 * onto the pre-existing `EvidenceItem.kind` vocabulary from
 * `agent/schemas.ts` (`fact | calculated_metric | assumption | prediction |
 * recommendation` — the master instruction's own hard rule 1 tagging), so
 * knowledge injected into the orchestrator's evidence catalogue is graded by
 * the SAME grounding machinery that already refuses ungrounded claims,
 * rather than a second, parallel tagging system.
 */
export function evidenceKindFor(
  classification: KnowledgeClassification,
): 'fact' | 'calculated_metric' | 'assumption' | 'prediction' {
  switch (classification) {
    case 'FACT':
    case 'USER_PROVIDED':
    case 'SYSTEM_OBSERVED':
    case 'EXTERNAL_SOURCE':
      return 'fact';
    case 'INFERENCE':
      return 'calculated_metric';
    case 'HYPOTHESIS':
    case 'OPINION':
    default:
      return 'assumption';
  }
}

/** Part 6: source trust is a transparent rule keyed on source type, never an
 * arbitrary "AI score". First-party synced platform data and the org's own
 * analytics are the most trustworthy; unauthenticated web research is the
 * least (still usable, just labelled accordingly). */
export function trustLevelFor(
  type: KnowledgeSourceType,
): 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  switch (type) {
    case 'INTERNAL_ANALYTICS':
    case 'MISSION_RESULT':
    case 'EXPERIMENT_RESULT':
      return 'VERY_HIGH';
    case 'YOUTUBE':
    case 'TIKTOK':
    case 'GOOGLE_SEARCH_CONSOLE':
    case 'WORDPRESS':
      return 'HIGH';
    case 'USER_INPUT':
    case 'UPLOADED_DOCUMENT':
      return 'MEDIUM';
    case 'WEBSITE_CRAWL':
    case 'WEB_RESEARCH':
      return 'LOW';
    case 'AI_GENERATED':
    default:
      return 'UNKNOWN';
  }
}
