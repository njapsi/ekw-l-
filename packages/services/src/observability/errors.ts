/**
 * `captureError` — the one place an unexpected fault is recorded. It logs a
 * structured line AND folds the fault into a de-duplicated `ErrorEvent` row so
 * `/admin/errors` shows "this bug, 412 times since Tuesday" rather than 412
 * rows. It never throws: a broken error path must not break the caller.
 */
import { createHash } from 'node:crypto';
import { type Db, type ErrorSource, type Prisma, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { incr } from './metrics.js';
import { scrubContext, scrubSecrets } from './scrub.js';

const log = createLogger('error');

const MESSAGE_CAP = 1_000;
const STACK_CAP = 4_000;

export interface CaptureContext {
  source?: ErrorSource;
  route?: string;
  method?: string;
  statusCode?: number;
  correlationId?: string;
  organizationId?: string;
  actorId?: string;
  /** Small, non-sensitive extras — scrubbed before persistence. */
  context?: Record<string, unknown>;
}

interface NormalizedError {
  name: string;
  message: string;
  stack: string | null;
}

function normalize(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || String(err),
      stack: err.stack ?? null,
    };
  }
  if (typeof err === 'string') return { name: 'Error', message: err, stack: null };
  try {
    return { name: 'Error', message: JSON.stringify(err), stack: null };
  } catch {
    return { name: 'Error', message: String(err), stack: null };
  }
}

/** First stack frame that is our code, used to keep the fingerprint stable. */
function keyFrame(stack: string | null): string {
  if (!stack) return '';
  const lines = stack.split('\n').slice(1);
  const own = lines.find((l) => /\bat\b/.test(l) && !l.includes('node_modules')) ?? lines[0] ?? '';
  return own
    .trim()
    .replace(/:\d+:\d+\)?$/, '')
    .slice(0, 200);
}

function fingerprintOf(source: string, n: NormalizedError, route?: string): string {
  const basis = `${source}|${n.name}|${keyFrame(n.stack) || n.message.slice(0, 120)}|${route ?? ''}`;
  return createHash('sha1').update(basis).digest('hex');
}

export async function captureError(
  err: unknown,
  ctx: CaptureContext = {},
  db: Db = prisma,
): Promise<void> {
  const source: ErrorSource = ctx.source ?? 'WEB';
  const n = normalize(err);
  const message = scrubSecrets(n.message).slice(0, MESSAGE_CAP);
  const stack = n.stack ? scrubSecrets(n.stack).slice(0, STACK_CAP) : null;
  const fingerprint = fingerprintOf(source, n, ctx.route);

  log.error(
    {
      err: message,
      errName: n.name,
      source,
      route: ctx.route,
      method: ctx.method,
      statusCode: ctx.statusCode,
      correlationId: ctx.correlationId,
      orgId: ctx.organizationId,
      fingerprint,
    },
    'captured error',
  );

  try {
    incr('errors_captured_total', 1, { source });
    const contextJson = ctx.context ? scrubContext(ctx.context) : undefined;
    await db.errorEvent.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        source,
        name: n.name.slice(0, 200),
        message,
        stack,
        route: ctx.route?.slice(0, 300),
        method: ctx.method?.slice(0, 12),
        statusCode: ctx.statusCode,
        correlationId: ctx.correlationId?.slice(0, 80),
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        context: (contextJson ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {
        count: { increment: 1 },
        lastSeenAt: new Date(),
        message,
        stack,
        statusCode: ctx.statusCode,
        correlationId: ctx.correlationId?.slice(0, 80),
      },
    });
  } catch (persistErr) {
    log.warn(
      { err: persistErr instanceof Error ? persistErr.message : String(persistErr) },
      'failed to persist ErrorEvent',
    );
  }
}

// --- reads for /admin -----------------------------------------------------

export interface ErrorEventRow {
  id: string;
  fingerprint: string;
  source: ErrorSource;
  name: string;
  message: string;
  route: string | null;
  statusCode: number | null;
  correlationId: string | null;
  organizationId: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

function shapeRow(r: {
  id: string;
  fingerprint: string;
  source: ErrorSource;
  name: string;
  message: string;
  route: string | null;
  statusCode: number | null;
  correlationId: string | null;
  organizationId: string | null;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}): ErrorEventRow {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    source: r.source,
    name: r.name,
    message: r.message,
    route: r.route,
    statusCode: r.statusCode,
    correlationId: r.correlationId,
    organizationId: r.organizationId,
    count: r.count,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

export async function listErrorEvents(
  db: Db = prisma,
  opts: { limit?: number; source?: ErrorSource; sinceMs?: number } = {},
): Promise<ErrorEventRow[]> {
  const where: Prisma.ErrorEventWhereInput = {};
  if (opts.source) where.source = opts.source;
  if (opts.sinceMs) where.lastSeenAt = { gte: new Date(Date.now() - opts.sinceMs) };
  const rows = await db.errorEvent.findMany({
    where,
    orderBy: { lastSeenAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 500),
  });
  return rows.map(shapeRow);
}

export async function getErrorEvent(db: Db, id: string) {
  const row = await db.errorEvent.findUnique({ where: { id } });
  if (!row) return null;
  return {
    ...shapeRow(row),
    method: row.method,
    actorId: row.actorId,
    stack: row.stack,
    context: row.context,
  };
}

export async function errorStats(db: Db = prisma, opts: { sinceMs?: number } = {}) {
  const since = new Date(Date.now() - (opts.sinceMs ?? 24 * 60 * 60 * 1000));
  const [web, worker, distinct] = await Promise.all([
    db.errorEvent.aggregate({
      _sum: { count: true },
      where: { source: 'WEB', lastSeenAt: { gte: since } },
    }),
    db.errorEvent.aggregate({
      _sum: { count: true },
      where: { source: 'WORKER', lastSeenAt: { gte: since } },
    }),
    db.errorEvent.count({ where: { lastSeenAt: { gte: since } } }),
  ]);
  const webCount = Number(web._sum.count ?? 0);
  const workerCount = Number(worker._sum.count ?? 0);
  return {
    sinceMs: opts.sinceMs ?? 24 * 60 * 60 * 1000,
    total: webCount + workerCount,
    bySource: { WEB: webCount, WORKER: workerCount },
    distinctFingerprints: distinct,
  };
}
