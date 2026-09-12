/**
 * Reporting module types (operator's "Phase 11"). The wire contract for a
 * finished report — `ReportSnapshot` and its sections — lives in
 * `@growth-agent/core` so it is shared with the app. This file adds the
 * service-side helpers: the report-type catalogue and the intermediate
 * `GatheredReport` a per-type builder produces before section assembly.
 */
import type {
  KeyMetric,
  MetricDirection,
  ReportOpportunity,
  ReportProblem,
  ReportRecommendation,
  ReportSnapshot,
  ReportType,
} from '@growth-agent/core';

export type { ReportSnapshot, ReportType };

export const REPORT_TYPES = [
  'YOUTUBE',
  'TIKTOK',
  'SEO',
  'WEBSITE_HEALTH',
  'AI_RECOMMENDATIONS',
  'GROWTH',
  'MONETIZATION',
] as const satisfies readonly ReportType[];

export type ReportTypeKey = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABEL: Record<ReportTypeKey, string> = {
  YOUTUBE: 'YouTube performance',
  TIKTOK: 'TikTok performance',
  SEO: 'SEO analysis',
  WEBSITE_HEALTH: 'Website health',
  AI_RECOMMENDATIONS: 'AI recommendations',
  GROWTH: 'Growth summary',
  MONETIZATION: 'Monetization',
};

export const REPORT_TYPE_BLURB: Record<ReportTypeKey, string> = {
  YOUTUBE: 'Channel and video performance, cadence, and open recommendations.',
  TIKTOK: 'Account performance, posting cadence, themes, and recommendations.',
  SEO: 'The AI SEO Agent view — ranked fixes, action plans, machine readability.',
  WEBSITE_HEALTH: 'Technical-SEO crawl health: scores, issues by severity, architecture.',
  AI_RECOMMENDATIONS: 'Every open recommendation across all surfaces, prioritized.',
  GROWTH: 'A cross-surface summary of where you are and what to do next.',
  MONETIZATION: 'Monetization opportunities, readiness, and user-entered revenue.',
};

/** A metric before deltas are computed against a previous snapshot. */
export interface MetricInput {
  key: string;
  label: string;
  value: string;
  raw: number | null;
  unit?: string;
  note?: string;
}

/** What a per-type builder returns; `sections.ts` turns it into a snapshot. */
export interface GatheredReport {
  /** True when the underlying data source is connected / has data. */
  connected: boolean;
  subjectLabel: string;
  subjectRef: string | null;
  dataThrough: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  metrics: MetricInput[];
  problems: ReportProblem[];
  opportunities: ReportOpportunity[];
  recommendations: ReportRecommendation[];
  /** id-tagged facts for the grounded executive-summary pass. */
  facts: Array<{ id: string; text: string }>;
  dataGaps: string[];
  disclaimers: string[];
}

export function emptyGathered(subjectLabel: string): GatheredReport {
  return {
    connected: false,
    subjectLabel,
    subjectRef: null,
    dataThrough: null,
    periodStart: null,
    periodEnd: null,
    metrics: [],
    problems: [],
    opportunities: [],
    recommendations: [],
    facts: [],
    dataGaps: [],
    disclaimers: [],
  };
}

export type { KeyMetric, MetricDirection };
