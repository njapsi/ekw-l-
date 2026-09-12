/**
 * In-app notifications (Phase 19 — FORENSIC-AUDIT M-1).
 *
 * `createNotification` is modelled on `recordAudit`: it NEVER throws into the
 * caller, so a notification-write failure can never break the operation that
 * triggered it (a finished crawl, a ready report, a failing automation). Email
 * fan-out is best-effort and only happens when a real transport (Resend / SMTP)
 * is configured — weekly digests are not implemented (externally-dependent).
 */
import { type Db, type NotificationLevel, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { emailDeliveryConfigured, sendTransactionalEmail } from './email.js';

export { emailDeliveryConfigured } from './email.js';

const log = createLogger('notifications');

export interface CreateNotificationInput {
  organizationId: string;
  /** Target member; omit for an org-wide notice shown to every member. */
  userId?: string | null;
  kind: string;
  level?: NotificationLevel;
  title: string;
  body: string;
  linkPath?: string;
  /** Idempotency key — a retried job with the same key is a no-op. */
  dedupeKey?: string;
  sourceType?: string;
  sourceId?: string;
  /** Set false to force in-app only even when an email transport exists. */
  email?: boolean;
}

/**
 * Persist a notification (idempotent on `dedupeKey`) and, when a real email
 * transport is configured and the notification targets a specific user, send a
 * best-effort email. Returns the row id, or null if nothing was written.
 */
export async function createNotification(
  input: CreateNotificationInput,
  db: Db = prisma,
): Promise<string | null> {
  try {
    const data = {
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      kind: input.kind,
      level: input.level ?? 'INFO',
      title: input.title.slice(0, 300),
      body: input.body.slice(0, 4000),
      linkPath: input.linkPath,
      dedupeKey: input.dedupeKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    };

    const row = input.dedupeKey
      ? await db.notification.upsert({
          where: { dedupeKey: input.dedupeKey },
          create: data,
          update: {}, // already delivered — do not resurface
        })
      : await db.notification.create({ data });

    // Fan out to email only for a targeted user, only with a real transport,
    // and only for a freshly-created row (upsert "update: {}" keeps createdAt).
    if (
      input.email !== false &&
      input.userId &&
      emailDeliveryConfigured() &&
      row.emailedAt === null
    ) {
      void fanOutEmail(row.id, input, db).catch((err) => {
        log.warn({ err: String(err), id: row.id }, 'notification email fan-out failed');
      });
    }

    return row.id;
  } catch (err) {
    log.error({ err, kind: input.kind }, 'failed to write notification');
    return null;
  }
}

async function fanOutEmail(id: string, input: CreateNotificationInput, db: Db): Promise<void> {
  if (!input.userId) return;
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true, deletedAt: true },
  });
  if (!user?.email || user.deletedAt) return;

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const link = input.linkPath ? `${base}${input.linkPath}` : base;
  const sent = await sendTransactionalEmail({
    to: user.email,
    subject: `[Growth Agent] ${input.title}`,
    text: `${input.body}\n\n${link}`,
    html: `<p>${escapeHtml(input.body)}</p><p><a href="${link}">Open Growth Agent</a></p>`,
  });
  if (sent) {
    await db.notification
      .update({ where: { id }, data: { emailedAt: new Date() } })
      .catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// --- reads / mutations (always scoped to org + the requesting user) --------

export interface ListArgs {
  organizationId: string;
  userId: string;
  unreadOnly?: boolean;
  limit?: number;
}

/** A member sees notifications addressed to them plus org-wide ones. */
export async function listNotifications(args: ListArgs, db: Db = prisma) {
  return db.notification.findMany({
    where: {
      organizationId: args.organizationId,
      OR: [{ userId: args.userId }, { userId: null }],
      ...(args.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(args.limit ?? 30, 100),
  });
}

export async function unreadCount(
  organizationId: string,
  userId: string,
  db: Db = prisma,
): Promise<number> {
  return db.notification.count({
    where: {
      organizationId,
      readAt: null,
      OR: [{ userId }, { userId: null }],
    },
  });
}

export async function markRead(
  ids: string[],
  scope: { organizationId: string; userId: string },
  db: Db = prisma,
): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await db.notification.updateMany({
    where: {
      id: { in: ids.slice(0, 200) },
      organizationId: scope.organizationId,
      OR: [{ userId: scope.userId }, { userId: null }],
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return res.count;
}

export async function markAllRead(
  scope: { organizationId: string; userId: string },
  db: Db = prisma,
): Promise<number> {
  const res = await db.notification.updateMany({
    where: {
      organizationId: scope.organizationId,
      OR: [{ userId: scope.userId }, { userId: null }],
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return res.count;
}
