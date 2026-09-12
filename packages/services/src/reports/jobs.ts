/**
 * Report job entry points. A single report generation runs inline in the
 * Server Action (bounded — a few reads + one optional model call); this wrapper
 * resolves the model from env and is available for a scheduled batch.
 */
import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { type GenerateReportResult, generateReport } from './generate.js';
import type { SummaryModel } from './summary.js';
import type { ReportTypeKey } from './schemas.js';

function modelFromEnv(): SummaryModel | undefined {
  try {
    return createRegistryFromEnv().getForRole('analyst').provider;
  } catch {
    return undefined;
  }
}

export async function generateReportJob(
  input: {
    organizationId: string;
    userId: string;
    type: ReportTypeKey;
    title?: string;
    params?: { websiteId?: string; crawlId?: string };
  },
  db: Db = prisma,
): Promise<GenerateReportResult> {
  return generateReport(input, { db, model: modelFromEnv() });
}
