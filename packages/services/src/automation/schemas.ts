/**
 * Automation task-type registry (operator's "Phase 12").
 *
 * Every task type maps to ONE `requiredAction` — the RBAC action the owner must
 * still hold at execution time. **No task type performs an external publish**
 * (`externalPublish` is `false` for all of them by construction); publishing
 * stays behind its owning feature's explicit approval flow (ADR-0022, ADR-0027).
 */
import { z } from 'zod';
import type { Action } from '../rbac/actions.js';
import { isValidCron } from './cron.js';

export const AUTOMATION_TASK_TYPES = [
  'YOUTUBE_ANALYSIS',
  'TIKTOK_ANALYSIS',
  'WEBSITE_CRAWL',
  'SEO_ISSUE_ALERT',
  'MONETIZATION_SCAN',
  'GROWTH_REPORT',
  'CONTENT_OPPORTUNITY',
] as const;
export type AutomationTaskTypeKey = (typeof AUTOMATION_TASK_TYPES)[number];

export const AUTOMATION_CADENCES = ['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export type AutomationCadenceKey = (typeof AUTOMATION_CADENCES)[number];

const emptyConfig = z.object({}).strict().default({});

const websiteConfig = z
  .object({ websiteId: z.string().min(1).optional() })
  .strict()
  .default({});

const seoAlertConfig = z
  .object({
    websiteId: z.string().min(1).optional(),
    /** Minimum severity that raises an alert task. */
    severity: z.enum(['critical', 'high']).default('critical'),
  })
  .strict()
  .default({ severity: 'critical' });

const growthReportConfig = z
  .object({
    reportType: z
      .enum([
        'YOUTUBE',
        'TIKTOK',
        'SEO',
        'WEBSITE_HEALTH',
        'AI_RECOMMENDATIONS',
        'GROWTH',
        'MONETIZATION',
      ])
      .default('GROWTH'),
    websiteId: z.string().min(1).optional(),
  })
  .strict()
  .default({ reportType: 'GROWTH' });

export interface TaskTypeMeta {
  key: AutomationTaskTypeKey;
  label: string;
  description: string;
  /** The RBAC action the owner must hold for a run to proceed. */
  requiredAction: Action;
  /** Always false — automations never publish externally. */
  externalPublish: false;
  configSchema: z.ZodTypeAny;
  /** An example phrasing, for the UI. */
  example: string;
}

export const TASK_TYPE_META: Record<AutomationTaskTypeKey, TaskTypeMeta> = {
  YOUTUBE_ANALYSIS: {
    key: 'YOUTUBE_ANALYSIS',
    label: 'Analyze my YouTube channel',
    description: 'Runs the YouTube Analyst over your primary connected channel.',
    requiredAction: 'agent:run',
    externalPublish: false,
    configSchema: emptyConfig,
    example: 'Analyze my YouTube channel every Monday.',
  },
  TIKTOK_ANALYSIS: {
    key: 'TIKTOK_ANALYSIS',
    label: 'Analyze my TikTok account',
    description: 'Runs the TikTok Analyst over your primary connected account.',
    requiredAction: 'agent:run',
    externalPublish: false,
    configSchema: emptyConfig,
    example: 'Check my TikTok performance every week.',
  },
  WEBSITE_CRAWL: {
    key: 'WEBSITE_CRAWL',
    label: 'Crawl my website',
    description: 'Starts a technical SEO crawl of a verified website.',
    requiredAction: 'crawl:run',
    externalPublish: false,
    configSchema: websiteConfig,
    example: 'Crawl my website every week.',
  },
  SEO_ISSUE_ALERT: {
    key: 'SEO_ISSUE_ALERT',
    label: 'Alert me to critical SEO issues',
    description:
      'Checks the latest crawl and opens a task when a new critical (or high) issue appears.',
    requiredAction: 'crawl:run',
    externalPublish: false,
    configSchema: seoAlertConfig,
    example: 'Tell me when a critical SEO issue appears.',
  },
  MONETIZATION_SCAN: {
    key: 'MONETIZATION_SCAN',
    label: 'Re-scan monetization opportunities',
    description: 'Re-runs the monetization opportunity scan.',
    requiredAction: 'monetization:manage',
    externalPublish: false,
    configSchema: emptyConfig,
    example: 'Refresh my monetization opportunities every month.',
  },
  GROWTH_REPORT: {
    key: 'GROWTH_REPORT',
    label: 'Generate a report',
    description: 'Generates a snapshot report (Growth by default) you can view or export.',
    requiredAction: 'report:generate',
    externalPublish: false,
    configSchema: growthReportConfig,
    example: 'Send me my weekly growth report.',
  },
  CONTENT_OPPORTUNITY: {
    key: 'CONTENT_OPPORTUNITY',
    label: 'Find my biggest content opportunity',
    description:
      'Asks the Growth Agent for the single biggest content opportunity and opens it as a task.',
    requiredAction: 'agent:run',
    externalPublish: false,
    configSchema: emptyConfig,
    example: 'Find my biggest content opportunity every Friday.',
  },
};

/** Runtime invariant: no automation task type may require an external publish. */
export function assertNoExternalPublish(): void {
  for (const meta of Object.values(TASK_TYPE_META)) {
    if (meta.requiredAction === 'publish:external' || meta.externalPublish) {
      throw new Error(`automation task type ${meta.key} must never publish externally`);
    }
  }
}

export function parseTaskConfig(taskType: AutomationTaskTypeKey, raw: unknown): unknown {
  return TASK_TYPE_META[taskType].configSchema.parse(raw ?? {});
}

export const CustomCron = z
  .string()
  .trim()
  .refine((v) => isValidCron(v), { message: 'Not a valid 5-field cron expression.' });

export interface AutomationInput {
  name: string;
  taskType: AutomationTaskTypeKey;
  cadence: AutomationCadenceKey;
  /** Required when cadence = CUSTOM. */
  cronExpression?: string;
  /** Cadence knobs for DAILY/WEEKLY/MONTHLY. */
  hour?: number;
  minute?: number;
  weekday?: number;
  monthday?: number;
  config?: unknown;
  maxRetries?: number;
}
