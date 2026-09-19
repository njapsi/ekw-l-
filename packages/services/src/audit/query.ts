/**
 * Reading the audit log (Phase 2, Part 17). Tenant-scoped, permission-gated,
 * secret-free: metadata is scrubbed at write time, and export re-scrubs.
 */
import { type Db, type Prisma, prisma, requireMembership } from '@growth-agent/db';
import { z } from 'zod';
import { scrubContext } from '../observability/scrub.js';
import { authorize } from '../rbac/authorize.js';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  actionPrefixesFor,
  auditCategory,
  auditEventType,
  auditLabel,
} from './catalog.js';

export const auditFilterInput = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  actorId: z.string().max(64).optional(),
  resourceType: z.string().max(64).optional(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditFilter = z.input<typeof auditFilterInput>;

function whereFor(
  organizationId: string,
  f: z.infer<typeof auditFilterInput>,
): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [{ organizationId }];
  if (f.category) {
    and.push({ OR: actionPrefixesFor(f.category).map((p) => ({ action: { startsWith: p } })) });
  }
  if (f.actorId) and.push({ actorId: f.actorId });
  if (f.resourceType) and.push({ targetType: f.resourceType });
  if (f.result) and.push({ result: f.result });
  if (f.from) and.push({ createdAt: { gte: f.from } });
  if (f.to) and.push({ createdAt: { lte: f.to } });
  if (f.q) {
    and.push({
      OR: [
        { action: { contains: f.q, mode: 'insensitive' } },
        { targetId: { contains: f.q } },
        { targetType: { contains: f.q, mode: 'insensitive' } },
        { actor: { email: { contains: f.q, mode: 'insensitive' } } },
        { actor: { name: { contains: f.q, mode: 'insensitive' } } },
      ],
    });
  }
  return { AND: and };
}

const SELECT = {
  id: true,
  action: true,
  actorType: true,
  targetType: true,
  targetId: true,
  result: true,
  requestId: true,
  agentRunId: true,
  metadata: true,
  createdAt: true,
  actor: { select: { id: true, name: true, email: true } },
} as const;

export interface AuditEventView {
  id: string;
  type: string;
  label: string;
  category: AuditCategory;
  action: string;
  actorType: string;
  actor: { id: string; name: string | null; email: string } | null;
  resourceType: string | null;
  resourceId: string | null;
  result: string;
  requestId: string | null;
  agentRunId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function toView(r: {
  id: string;
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  result: string | null;
  requestId: string | null;
  agentRunId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; name: string | null; email: string } | null;
}): AuditEventView {
  const meta =
    r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
      ? (r.metadata as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    type: auditEventType(r.action),
    label: auditLabel(r.action),
    category: auditCategory(r.action),
    action: r.action,
    actorType: r.actorType,
    actor: r.actor,
    resourceType: r.targetType,
    resourceId: r.targetId,
    // Rows written before Phase 2 predate the result column; they recorded
    // completed operations only.
    result: r.result ?? 'SUCCESS',
    requestId: r.requestId,
    agentRunId: r.agentRunId,
    metadata: scrubContext(meta),
    createdAt: r.createdAt,
  };
}

async function assertAudit(
  actorUserId: string,
  organizationId: string,
  permission: 'audit.view' | 'audit.export',
  db: Db,
) {
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, permission);
}

export async function listAuditEvents(
  actorUserId: string,
  organizationId: string,
  raw: AuditFilter = {},
  db: Db = prisma,
): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
  await assertAudit(actorUserId, organizationId, 'audit.view', db);
  const f = auditFilterInput.parse(raw);
  const rows = await db.auditLog.findMany({
    where: whereFor(organizationId, f),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    select: SELECT,
  });
  const page = rows.slice(0, f.limit);
  return {
    events: page.map(toView),
    nextCursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Distinct actors who appear in this org's log (for the actor filter). */
export async function listAuditActors(
  actorUserId: string,
  organizationId: string,
  db: Db = prisma,
) {
  await assertAudit(actorUserId, organizationId, 'audit.view', db);
  const members = await db.membership.findMany({
    where: { organizationId },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  return members.map((m) => m.user);
}

export const AUDIT_EXPORT_MAX_ROWS = 10_000;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection (CSV injection / OWASP).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function exportAuditCsv(
  actorUserId: string,
  organizationId: string,
  raw: AuditFilter = {},
  db: Db = prisma,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  await assertAudit(actorUserId, organizationId, 'audit.export', db);
  const f = auditFilterInput.parse({ ...raw, cursor: undefined, limit: 200 });
  const rows = await db.auditLog.findMany({
    where: whereFor(organizationId, f),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AUDIT_EXPORT_MAX_ROWS + 1,
    select: SELECT,
  });
  const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
  const header = [
    'timestamp',
    'event_type',
    'action',
    'category',
    'result',
    'actor_type',
    'actor_email',
    'resource_type',
    'resource_id',
    'request_id',
    'agent_run_id',
    'metadata',
  ];
  const lines = rows
    .slice(0, AUDIT_EXPORT_MAX_ROWS)
    .map(toView)
    .map((e) =>
      [
        e.createdAt.toISOString(),
        e.type,
        e.action,
        e.category,
        e.result,
        e.actorType,
        e.actor?.email ?? '',
        e.resourceType ?? '',
        e.resourceId ?? '',
        e.requestId ?? '',
        e.agentRunId ?? '',
        e.metadata,
      ]
        .map(csvCell)
        .join(','),
    );
  return { csv: [header.join(','), ...lines].join('\n'), rows: lines.length, truncated };
}
