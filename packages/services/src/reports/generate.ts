/**
 * The report lifecycle: enforce the plan limit, create a `Report` row
 * (BUILDING), assemble an immutable snapshot, and store it (READY) — or record
 * the failure (FAILED). A regenerate creates a NEW row that links to the
 * previous READY report of the same type for the "Historical Changes" diff;
 * existing snapshots are never mutated (ADR-0026).
 */
import type { ReportSnapshot } from '@growth-agent/core';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import { AppError } from '../errors.js';
import { enforceUsage } from '../usage/enforce.js';
import { recordUsage } from '../usage/record.js';
import { type PreviousReport, buildReportSnapshot } from './build.js';
import type { SummaryModel } from './summary.js';
import { REPORT_TYPE_LABEL, type ReportTypeKey } from './schemas.js';

const log = createLogger('reports.generate');

export interface GenerateReportInput {
  organizationId: string;
  userId: string;
  type: ReportTypeKey;
  title?: string;
  params?: { websiteId?: string; crawlId?: string };
}

export interface GenerateReportDeps {
  db?: Db;
  model?: SummaryModel;
}

export interface GenerateReportResult {
  reportId: string;
  status: 'READY' | 'FAILED';
  error?: string;
}

export async function generateReport(
  input: GenerateReportInput,
  deps: GenerateReportDeps = {},
): Promise<GenerateReportResult> {
  const db = deps.db ?? prisma;

  // Plan limit — server-side (ADR-0025).
  await enforceUsage({ organizationId: input.organizationId, meter: 'REPORTS', amount: 1 }, db);

  const org = await db.organization.findUnique({
    where: { id: input.organizationId },
    select: { name: true },
  });
  if (!org) throw AppError.notFound('Organization');

  const previousRow = await db.report.findFirst({
    where: { organizationId: input.organizationId, type: input.type, status: 'READY' },
    orderBy: { createdAt: 'desc' },
  });
  const previous: PreviousReport | null =
    previousRow && previousRow.snapshot
      ? {
          reportId: previousRow.id,
          generatedAt: previousRow.createdAt.toISOString(),
          snapshot: previousRow.snapshot as unknown as ReportSnapshot,
        }
      : null;

  const report = await db.report.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      title: input.title?.trim() || REPORT_TYPE_LABEL[input.type],
      status: 'BUILDING',
      params: (input.params ?? {}) as never,
      previousReportId: previous?.reportId ?? null,
      requestedById: input.userId,
    },
  });

  try {
    const built = await buildReportSnapshot(
      {
        organizationId: input.organizationId,
        orgName: org.name,
        type: input.type,
        params: input.params ?? {},
        previous,
      },
      { db, model: deps.model },
    );

    const finished = await db.report.update({
      where: { id: report.id },
      data: {
        status: 'READY',
        snapshot: built.snapshot as never,
        title: built.snapshot.meta.title,
        subjectRef: built.subjectRef,
        periodStart: built.snapshot.meta.periodStart
          ? new Date(built.snapshot.meta.periodStart)
          : null,
        periodEnd: built.snapshot.meta.periodEnd ? new Date(built.snapshot.meta.periodEnd) : null,
        dataThrough: built.dataThrough,
        finishedAt: new Date(),
        error: null,
      },
    });

    await recordUsage(
      {
        organizationId: input.organizationId,
        meter: 'REPORTS',
        quantity: 1,
        idempotencyKey: `report:${finished.id}`,
        actorId: input.userId,
        subjectType: 'report',
        subjectId: finished.id,
      },
      db,
    );
    await recordAudit(
      {
        organizationId: input.organizationId,
        actorId: input.userId,
        action: 'report.generated',
        targetType: 'report',
        targetId: finished.id,
        metadata: {
          type: input.type,
          connected: built.connected,
          grounded: built.snapshot.executiveSummary.grounded,
          previousReportId: previous?.reportId ?? null,
        },
      },
      db,
    );
    await createNotification(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        kind: 'report.ready',
        level: 'SUCCESS',
        title: `Report ready: ${finished.title}`,
        body: `Your ${REPORT_TYPE_LABEL[input.type]} report has finished generating and is ready to view.`,
        linkPath: `/app/reports/${finished.id}`,
        dedupeKey: `report:${finished.id}:ready`,
        sourceType: 'report',
        sourceId: finished.id,
      },
      db,
    );
    return { reportId: finished.id, status: 'READY' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, reportId: report.id, type: input.type }, 'report generation failed');
    await db.report.update({
      where: { id: report.id },
      data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() },
    });
    await recordAudit(
      {
        organizationId: input.organizationId,
        actorId: input.userId,
        action: 'report.failed',
        targetType: 'report',
        targetId: report.id,
        metadata: { type: input.type },
      },
      db,
    );
    await createNotification(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        kind: 'report.failed',
        level: 'WARNING',
        title: `Report failed: ${REPORT_TYPE_LABEL[input.type]}`,
        body: `Report generation did not complete. You can try again from the Reports page.`,
        linkPath: `/app/reports`,
        dedupeKey: `report:${report.id}:failed`,
        sourceType: 'report',
        sourceId: report.id,
      },
      db,
    );
    return { reportId: report.id, status: 'FAILED', error: message };
  }
}

export async function deleteReport(
  input: { organizationId: string; userId: string; reportId: string },
  db: Db = prisma,
): Promise<void> {
  const report = await db.report.findFirst({
    where: { id: input.reportId, organizationId: input.organizationId },
  });
  if (!report) throw AppError.notFound('Report');
  await db.report.delete({ where: { id: report.id } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'report.deleted',
      targetType: 'report',
      targetId: report.id,
      metadata: { type: report.type },
    },
    db,
  );
}
