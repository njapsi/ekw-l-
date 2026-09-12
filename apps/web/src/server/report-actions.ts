'use server';

import { revalidatePath } from 'next/cache';
import { isAppError, reports } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ReportActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  reportId?: string;
  shareUrl?: string;
}

function toError(e: unknown): ReportActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

const TYPES = new Set(reports.REPORT_TYPES as readonly string[]);

export async function generateReportAction(input: {
  type: string;
  websiteId?: string;
  title?: string;
}): Promise<ReportActionResult> {
  try {
    const { org, user } = await requirePermission('report:generate');
    if (!TYPES.has(input.type)) return { ok: false, error: 'Unknown report type.' };
    const res = await reports.generateReportJob({
      organizationId: org.id,
      userId: user.id,
      type: input.type as never,
      title: input.title?.trim() || undefined,
      params: input.websiteId ? { websiteId: input.websiteId } : undefined,
    });
    revalidatePath('/app/reports');
    if (res.status === 'FAILED') {
      return {
        ok: false,
        reportId: res.reportId,
        error: res.error ?? 'The report could not be generated.',
      };
    }
    return { ok: true, reportId: res.reportId, message: 'Report generated.' };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteReportAction(reportId: string): Promise<ReportActionResult> {
  try {
    const { org, user } = await requirePermission('report:generate');
    await reports.deleteReport({ organizationId: org.id, userId: user.id, reportId });
    revalidatePath('/app/reports');
    return { ok: true, message: 'Report deleted.' };
  } catch (e) {
    return toError(e);
  }
}

export async function createShareLinkAction(
  reportId: string,
  expiresInDays?: number | null,
): Promise<ReportActionResult> {
  try {
    const { org, user } = await requirePermission('report:share');
    const link = await reports.createShareLink({
      organizationId: org.id,
      userId: user.id,
      reportId,
      expiresInDays: expiresInDays ?? null,
    });
    revalidatePath(`/app/reports/${reportId}`);
    return {
      ok: true,
      shareUrl: link.url,
      message: link.expiresAt
        ? `Share link created; expires ${new Date(link.expiresAt).toLocaleDateString()}.`
        : 'Share link created (no expiry).',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function revokeShareLinkAction(reportId: string): Promise<ReportActionResult> {
  try {
    const { org, user } = await requirePermission('report:share');
    await reports.revokeShareLink({ organizationId: org.id, userId: user.id, reportId });
    revalidatePath(`/app/reports/${reportId}`);
    return { ok: true, message: 'Share link revoked.' };
  } catch (e) {
    return toError(e);
  }
}
