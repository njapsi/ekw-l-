/**
 * A small in-memory stand-in for the Prisma client, for unit tests of code
 * whose correctness depends on *real* query semantics (conditional
 * `updateMany` claims, `notIn` deletes, compound unique upserts) rather than
 * on hand-stubbed return values. Test-only; it implements just the operators
 * the integration platform uses:
 *
 *   where:   equality, null, { not, in, notIn, lt, lte, gt, gte }, OR, AND,
 *            compound unique keys (`a_b: { a, b }`); object-valued filters on
 *            a field the row does not hold (relation filters) are ignored.
 *   ops:     findUnique, findFirst, findMany, create, update, updateMany,
 *            upsert, count, delete, deleteMany
 *   options: orderBy (single field), take — `select`/`include` return the row.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const OPS = new Set(['not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matchValue(actual: unknown, filter: unknown): boolean {
  if (isPlainObject(filter) && Object.keys(filter).every((k) => OPS.has(k))) {
    for (const [op, v] of Object.entries(filter)) {
      if (op === 'not' && (isPlainObject(v) ? matchValue(actual, v) : eq(actual, v))) return false;
      if (op === 'in' && !(v as unknown[]).some((x) => eq(actual, x))) return false;
      if (op === 'notIn' && (v as unknown[]).some((x) => eq(actual, x))) return false;
      if (actual === null || actual === undefined) {
        if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') return false;
        continue;
      }
      if (op === 'lt' && !(cmp(actual, v) < 0)) return false;
      if (op === 'lte' && !(cmp(actual, v) <= 0)) return false;
      if (op === 'gt' && !(cmp(actual, v) > 0)) return false;
      if (op === 'gte' && !(cmp(actual, v) >= 0)) return false;
    }
    return true;
  }
  if (filter === null) return actual === null || actual === undefined;
  return eq(actual, filter);
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    if (key === 'OR') {
      if (!(filter as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(filter as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (!(key in row) && isPlainObject(filter)) {
      // Compound unique (`a_b: {a, b}`) or a relation filter.
      const sub = filter;
      if (Object.keys(sub).every((k) => k in row)) {
        if (!matches(row, sub)) return false;
      }
      continue;
    }
    if (!matchValue(row[key], filter)) return false;
  }
  return true;
}

let seq = 0;
function newId(prefix: string) {
  seq += 1;
  return `${prefix}_${seq.toString(36).padStart(4, '0')}`;
}

export interface MemoryModel {
  rows: Row[];
  findUnique(args: { where: Where }): Promise<Row | null>;
  findFirst(args?: {
    where?: Where;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }): Promise<Row | null>;
  findMany(args?: {
    where?: Where;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take?: number;
  }): Promise<Row[]>;
  create(args: { data: Row }): Promise<Row>;
  update(args: { where: Where; data: Row }): Promise<Row>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
  upsert(args: { where: Where; create: Row; update: Row }): Promise<Row>;
  count(args?: { where?: Where }): Promise<number>;
  delete(args: { where: Where }): Promise<Row>;
  deleteMany(args?: { where?: Where }): Promise<{ count: number }>;
}

function model(name: string, defaults: () => Row): MemoryModel {
  const rows: Row[] = [];
  const sorted = (list: Row[], orderBy?: Record<string, 'asc' | 'desc'>) => {
    if (!orderBy) return list;
    const [field, dir] = Object.entries(orderBy)[0] ?? [];
    if (!field) return list;
    return [...list].sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a[field], b[field]));
  };
  // The client API is async; the store is synchronous. `settle` bridges the
  // two so a throwing operation becomes a rejected promise, like Prisma's.
  const settle = <T>(fn: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  const createRow = (data: Row): Row => {
    const now = new Date();
    const row = { id: newId(name), createdAt: now, updatedAt: now, ...defaults(), ...data };
    rows.push(row);
    return row;
  };
  const m: MemoryModel = {
    rows,
    findUnique: ({ where }) => settle(() => rows.find((r) => matches(r, where)) ?? null),
    findFirst: (args = {}) =>
      settle(
        () =>
          sorted(
            rows.filter((r) => matches(r, args.where)),
            args.orderBy,
          )[0] ?? null,
      ),
    findMany: (args = {}) =>
      settle(() => {
        const out = sorted(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        );
        return args.take ? out.slice(0, args.take) : out;
      }),
    create: ({ data }) => settle(() => createRow(data)),
    update: ({ where, data }) =>
      settle(() => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error(`${name}.update: no row matches ${JSON.stringify(where)}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    updateMany: ({ where, data }) =>
      settle(() => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
        return { count: hit.length };
      }),
    upsert: ({ where, create, update }) =>
      settle(() => {
        const row = rows.find((r) => matches(r, where));
        if (!row) return createRow(create);
        Object.assign(row, update, { updatedAt: new Date() });
        return row;
      }),
    count: (args = {}) => settle(() => rows.filter((r) => matches(r, args.where)).length),
    delete: ({ where }) =>
      settle(() => {
        const i = rows.findIndex((r) => matches(r, where));
        if (i < 0) throw new Error(`${name}.delete: no row`);
        return rows.splice(i, 1)[0] as Row;
      }),
    deleteMany: (args = {}) =>
      settle(() => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i] as Row, args.where)) {
            rows.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
  };
  return m;
}

export function createMemoryDb() {
  const db = {
    wordPressSite: model('wps', () => ({
      status: 'ACTIVE',
      detectedCapabilities: [],
      lastError: null,
      lastCheckAt: null,
      lastCheckOk: null,
      siteName: null,
      wpUserId: null,
      createdById: null,
    })),
    wordPressContent: model('wpc', () => ({ syncedAt: new Date() })),
    integrationSyncRun: model('isr', () => ({
      status: 'RUNNING',
      itemsProcessed: 0,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      durationMs: null,
    })),
    integrationActionRequest: model('iar', () => ({
      status: 'PENDING',
      source: 'USER',
      decidedById: null,
      decidedAt: null,
      executedAt: null,
      result: null,
      error: null,
    })),
    oAuthConnection: model('oac', () => ({
      status: 'ACTIVE',
      lastError: null,
      lastRefreshedAt: null,
    })),
    integrationHealth: model('ih', () => ({})),
    website: model('web', () => ({ verified: false, verifiedAt: null })),
    youTubeSyncRun: model('ysr', () => ({})),
    tikTokSyncRun: model('tsr', () => ({})),
    searchConsoleSnapshot: model('gss', () => ({})),
    notification: model('ntf', () => ({ readAt: null })),
    auditLog: model('aud', () => ({})),
  };
  return db;
}

export type MemoryDb = ReturnType<typeof createMemoryDb>;
