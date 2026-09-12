/**
 * Public share links. A link is an opaque 256-bit token; the public view serves
 * a REDACTED snapshot only (`redact.ts`). Links can carry an expiry and can be
 * revoked. Creating / revoking a link is gated by `report:share` (ADMIN+) at
 * the call site because it exposes data outside the org.
 */
import { randomBytes } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreateShareLinkInput {
  organizationId: string;
  userId: string;
  reportId: string;
  /** Days until the link stops working. `null` / omitted ⇒ no expiry. */
  expiresInDays?: number | null;
}

export interface ShareLinkView {
  token: string;
  url: string;
  expiresAt: string | null;
}

export async function createShareLink(
  input: CreateShareLinkInput,
  db: Db = prisma,
): Promise<ShareLinkView> {
  const report = await db.report.findFirst({
    where: { id: input.reportId, organizationId: input.organizationId },
  });
  if (!report) throw AppError.notFound('Report');
  if (report.status !== 'READY') {
    throw AppError.validation('Only a finished report can be shared.');
  }

  const days =
    input.expiresInDays != null && Number.isFinite(input.expiresInDays)
      ? Math.min(365, Math.max(1, Math.round(input.expiresInDays)))
      : null;
  const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : null;
  const token = report.shareToken ?? newToken();

  await db.report.update({
    where: { id: report.id },
    data: {
      shareToken: token,
      shareExpiresAt: expiresAt,
      shareRevokedAt: null,
      shareCreatedById: input.userId,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'report.share.created',
      targetType: 'report',
      targetId: report.id,
      metadata: { expiresAt: expiresAt?.toISOString() ?? null },
    },
    db,
  );

  return { token, url: `/r/${token}`, expiresAt: expiresAt?.toISOString() ?? null };
}

export async function revokeShareLink(
  input: { organizationId: string; userId: string; reportId: string },
  db: Db = prisma,
): Promise<void> {
  const report = await db.report.findFirst({
    where: { id: input.reportId, organizationId: input.organizationId },
  });
  if (!report) throw AppError.notFound('Report');
  if (!report.shareToken) return;

  await db.report.update({
    where: { id: report.id },
    data: { shareRevokedAt: new Date() },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'report.share.revoked',
      targetType: 'report',
      targetId: report.id,
    },
    db,
  );
}

export function shareLinkActive(report: {
  shareToken: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
}): boolean {
  if (!report.shareToken) return false;
  if (report.shareRevokedAt) return false;
  if (report.shareExpiresAt && report.shareExpiresAt.getTime() < Date.now()) return false;
  return true;
}
