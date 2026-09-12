/**
 * Assemble a full `ReportSnapshot`: gather deterministic facts → assemble the
 * six data sections + the diff against the previous snapshot → build the
 * executive summary (deterministic, or a grounded model pass). Pure with
 * respect to the database beyond the read functions the gatherers call.
 */
import type { ReportSnapshot } from '@growth-agent/core';
import { type Db, prisma } from '@growth-agent/db';
import { type GatherOptions, gatherFacts } from './facts.js';
import { REPORT_TYPE_LABEL, type ReportTypeKey } from './schemas.js';
import { assembleSections } from './sections.js';
import { type SummaryModel, buildExecutiveSummary } from './summary.js';

export interface PreviousReport {
  reportId: string;
  generatedAt: string;
  snapshot: ReportSnapshot;
}

export interface BuildSnapshotInput {
  organizationId: string;
  orgName: string;
  type: ReportTypeKey;
  params?: GatherOptions;
  previous?: PreviousReport | null;
}

export interface BuildSnapshotDeps {
  db?: Db;
  model?: SummaryModel;
}

export interface BuildSnapshotResult {
  snapshot: ReportSnapshot;
  subjectRef: string | null;
  dataThrough: Date | null;
  connected: boolean;
}

export async function buildReportSnapshot(
  input: BuildSnapshotInput,
  deps: BuildSnapshotDeps = {},
): Promise<BuildSnapshotResult> {
  const db = deps.db ?? prisma;
  const gathered = await gatherFacts(input.type, input.organizationId, input.params ?? {}, db);

  const previous = input.previous ?? null;
  const sections = assembleSections(
    gathered,
    previous?.snapshot ?? null,
    previous ? { reportId: previous.reportId, generatedAt: previous.generatedAt } : null,
  );

  const executiveSummary = await buildExecutiveSummary(
    {
      type: input.type,
      subjectLabel: gathered.subjectLabel,
      gathered,
      sections,
    },
    { model: deps.model },
  );

  const now = new Date();
  const snapshot: ReportSnapshot = {
    version: 1,
    meta: {
      type: input.type,
      title: `${REPORT_TYPE_LABEL[input.type]} — ${gathered.subjectLabel}`,
      subjectLabel: gathered.subjectLabel,
      orgName: input.orgName,
      generatedAt: now.toISOString(),
      periodStart: gathered.periodStart?.toISOString() ?? null,
      periodEnd: gathered.periodEnd?.toISOString() ?? null,
      dataThrough: gathered.dataThrough?.toISOString() ?? null,
      isPublic: false,
    },
    executiveSummary,
    keyMetrics: sections.keyMetrics,
    problems: sections.problems,
    opportunities: sections.opportunities,
    recommendations: sections.recommendations,
    priorityActions: sections.priorityActions,
    historicalChanges: sections.historicalChanges,
    disclaimers: dedupe([
      'This report never guarantees outcomes (rankings, revenue, monetization approval).',
      ...gathered.disclaimers,
    ]),
    dataGaps: dedupe(gathered.dataGaps),
  };

  return {
    snapshot,
    subjectRef: gathered.subjectRef,
    dataThrough: gathered.dataThrough,
    connected: gathered.connected,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}
