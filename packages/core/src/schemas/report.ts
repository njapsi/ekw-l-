import { z } from 'zod';
import { EffortLevel, Priority } from './recommendation.js';

/**
 * The shared contract for a **report snapshot** (operator's "Phase 11"). A
 * snapshot is a self-contained, immutable rendering of one analysis at one point
 * in time — the durable artifact behind the dashboard view and every export
 * (PDF / CSV / JSON). Once a report is `READY` its snapshot never changes;
 * regenerating produces a new report that links back to the previous one for the
 * "Historical Changes" section.
 *
 * Every report — YouTube, TikTok, SEO, Website Health, AI Recommendations,
 * Growth, Monetization — carries the same seven sections.
 */

export const ReportType = z.enum([
  'YOUTUBE',
  'TIKTOK',
  'SEO',
  'WEBSITE_HEALTH',
  'AI_RECOMMENDATIONS',
  'GROWTH',
  'MONETIZATION',
]);
export type ReportType = z.infer<typeof ReportType>;

export const ReportSeverity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type ReportSeverity = z.infer<typeof ReportSeverity>;

export const MetricDirection = z.enum(['up', 'down', 'flat', 'unknown']);
export type MetricDirection = z.infer<typeof MetricDirection>;

export const ReportMeta = z.object({
  type: ReportType,
  title: z.string().min(1),
  /** Human label for the analysis subject — a channel name, a hostname, "your
   *  organization". Redacted to a generic label in public snapshots. */
  subjectLabel: z.string().min(1),
  orgName: z.string().min(1),
  generatedAt: z.string().datetime(),
  periodStart: z.string().datetime().nullable().default(null),
  periodEnd: z.string().datetime().nullable().default(null),
  /** The latest timestamp of the underlying data (sync / crawl time). */
  dataThrough: z.string().datetime().nullable().default(null),
  /** True when this snapshot has been through `redactSnapshotForPublic`. */
  isPublic: z.boolean().default(false),
});
export type ReportMeta = z.infer<typeof ReportMeta>;

export const ExecutiveSummary = z.object({
  headline: z.string().min(1),
  paragraphs: z.array(z.string().min(1)).min(1),
  /** True when a grounded model pass produced the prose; false ⇒ deterministic
   *  assembly (the always-available fallback). */
  grounded: z.boolean().default(false),
});
export type ExecutiveSummary = z.infer<typeof ExecutiveSummary>;

export const MetricDelta = z.object({
  previous: z.string().min(1),
  changePct: z.number().nullable().default(null),
  direction: MetricDirection.default('unknown'),
});

export const KeyMetric = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  /** The raw numeric value when the metric is numeric (used by CSV export). */
  raw: z.number().nullable().default(null),
  unit: z.string().optional(),
  delta: MetricDelta.nullable().default(null),
  note: z.string().optional(),
});
export type KeyMetric = z.infer<typeof KeyMetric>;

export const ReportProblem = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: ReportSeverity,
  /** Free-text evidence lines (already redaction-safe). */
  evidence: z.array(z.string()).default([]),
});
export type ReportProblem = z.infer<typeof ReportProblem>;

export const ReportOpportunity = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  /** Labelled estimate, never a promised figure. */
  potential: z.string().optional(),
  effort: z.string().optional(),
});
export type ReportOpportunity = z.infer<typeof ReportOpportunity>;

export const ReportRecommendation = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  why: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
  priority: Priority,
  effort: EffortLevel,
  confidence: z.number().min(0).max(1),
  expectedImpact: z.string().min(1),
});
export type ReportRecommendation = z.infer<typeof ReportRecommendation>;

export const PriorityAction = z.object({
  rank: z.number().int().positive(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  effort: z.string().optional(),
});
export type PriorityAction = z.infer<typeof PriorityAction>;

export const HistoricalChange = z.object({
  label: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  changePct: z.number().nullable().default(null),
  direction: MetricDirection.default('unknown'),
});
export type HistoricalChange = z.infer<typeof HistoricalChange>;

export const HistoricalChanges = z.object({
  comparedTo: z
    .object({ reportId: z.string(), generatedAt: z.string().datetime() })
    .nullable()
    .default(null),
  changes: z.array(HistoricalChange).default([]),
  notes: z.array(z.string()).default([]),
});
export type HistoricalChanges = z.infer<typeof HistoricalChanges>;

export const ReportSnapshot = z.object({
  /** Schema version — bump on a breaking change to the snapshot shape. */
  version: z.literal(1).default(1),
  meta: ReportMeta,
  executiveSummary: ExecutiveSummary,
  keyMetrics: z.array(KeyMetric).default([]),
  problems: z.array(ReportProblem).default([]),
  opportunities: z.array(ReportOpportunity).default([]),
  recommendations: z.array(ReportRecommendation).default([]),
  priorityActions: z.array(PriorityAction).default([]),
  historicalChanges: HistoricalChanges,
  /** Never guarantee outcomes; state estimates as estimates. */
  disclaimers: z.array(z.string()).default([]),
  /** What data was missing / not connected, stated plainly (never invented). */
  dataGaps: z.array(z.string()).default([]),
});
export type ReportSnapshot = z.infer<typeof ReportSnapshot>;

export const REPORT_SECTIONS = [
  'executiveSummary',
  'keyMetrics',
  'problems',
  'opportunities',
  'recommendations',
  'priorityActions',
  'historicalChanges',
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number];
