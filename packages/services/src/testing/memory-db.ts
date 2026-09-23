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
  const av = a instanceof Date ? a.getTime() : (a as number | string | bigint);
  const bv = b instanceof Date ? b.getTime() : (b as number | string | bigint);
  if (av === bv) return 0;
  // `===` never considers a Number and a BigInt of the same magnitude equal
  // (`4 === 4n` is `false`), even though `<`/`>` compare them correctly by
  // value. Falling straight to `av < bv ? -1 : 1` after a failed `===`
  // therefore misreports an exactly-equal Number/BigInt pair as "greater
  // than" — a real, previously-latent bug this harness's own `used:
  // {increment}` (which silently converts a BigInt counter to a plain
  // Number, see `applyOps` below) turns into a live off-by-one: a `{lte:
  // 5n}` boundary check on a counter that is legitimately at exactly 5
  // (stored as the Number `5`) wrongly rejects instead of matching. Check
  // ordering explicitly instead of assuming not-less-than means greater.
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Prisma's string filter shape (`{ contains | equals | startsWith | endsWith,
 *  mode?: 'insensitive' }`) — a real operator real code uses (knowledge
 *  search, memory-candidate dedupe) that the original OPS set above never
 *  covered, silently matching nothing instead of erroring. */
function matchStringFilter(actual: unknown, filter: Record<string, unknown>): boolean | null {
  const stringOps = ['contains', 'equals', 'startsWith', 'endsWith'] as const;
  const op = stringOps.find((k) => k in filter);
  if (!op) return null;
  if (typeof actual !== 'string' && actual !== null && actual !== undefined) return null;
  if (typeof filter[op] !== 'string') return null;
  const insensitive = filter.mode === 'insensitive';
  const hay = actual ?? '';
  const needle = filter[op];
  const a = insensitive ? hay.toLowerCase() : hay;
  const b = insensitive ? needle.toLowerCase() : needle;
  if (op === 'contains') return a.includes(b);
  if (op === 'equals') return a === b;
  if (op === 'startsWith') return a.startsWith(b);
  return a.endsWith(b);
}

function matchValue(actual: unknown, filter: unknown): boolean {
  if (isPlainObject(filter)) {
    const stringMatch = matchStringFilter(actual, filter);
    if (stringMatch !== null) return stringMatch;
  }
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
  // A nested object filter against a stored nested object (a denormalised
  // relation in a test fixture, e.g. `user: { email }`) matches field-wise.
  if (isPlainObject(filter) && isPlainObject(actual)) return matches(actual, filter);
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

/** Resolve Prisma atomic number ops (`{ increment: 1 }`) against the row. */
function applyOps(row: Row, data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) {
    const current = row[k];
    // A real Prisma `BigInt` column stays a `bigint` through an
    // increment/decrement; silently widening it to a `Number` here (the
    // previous behavior) let a later `{lte: 5n}`-style filter compare a
    // Number against a BigInt, which `cmp()` above can get wrong at an
    // exact-equality boundary. Preserve the field's own type instead of
    // always producing a `Number`.
    if (isPlainObject(v) && typeof v.increment === 'number') {
      out[k] = typeof current === 'bigint' ? current + BigInt(v.increment) : Number(current ?? 0) + v.increment;
    } else if (isPlainObject(v) && typeof v.decrement === 'number') {
      out[k] = typeof current === 'bigint' ? current - BigInt(v.decrement) : Number(current ?? 0) - v.decrement;
    } else {
      out[k] = v;
    }
  }
  return out;
}

let seq = 0;
function newId(prefix: string) {
  seq += 1;
  return `${prefix}_${seq.toString(36).padStart(4, '0')}`;
}

/** A single-field spec (`{field: 'desc'}`) or, matching real Prisma, an
 *  array of them for multi-field tie-breaking (`[{a: 'desc'}, {b: 'desc'}]`). */
export type OrderBy = Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;

export interface MemoryModel {
  rows: Row[];
  findUnique(args: { where: Where }): Promise<Row | null>;
  findFirst(args?: { where?: Where; orderBy?: OrderBy }): Promise<Row | null>;
  findMany(args?: { where?: Where; orderBy?: OrderBy; take?: number }): Promise<Row[]>;
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
  const sorted = (list: Row[], orderBy?: OrderBy) => {
    if (!orderBy) return list;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    const fields = specs
      .map((o) => Object.entries(o)[0])
      .filter((e): e is [string, 'asc' | 'desc'] => Boolean(e));
    if (fields.length === 0) return list;
    return [...list].sort((a, b) => {
      for (const [field, dir] of fields) {
        const c = (dir === 'desc' ? -1 : 1) * cmp(a[field], b[field]);
        if (c !== 0) return c;
      }
      return 0;
    });
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
  // Prisma returns fresh objects; so must we, or a later update would mutate
  // a value the code under test already read (hiding real bugs).
  const copy = (r: Row | undefined): Row | null => (r ? { ...r } : null);
  const m: MemoryModel = {
    rows,
    findUnique: ({ where }) => settle(() => copy(rows.find((r) => matches(r, where)))),
    findFirst: (args = {}) =>
      settle(() =>
        copy(
          sorted(
            rows.filter((r) => matches(r, args.where)),
            args.orderBy,
          )[0],
        ),
      ),
    findMany: (args = {}) =>
      settle(() => {
        const out = sorted(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        );
        return (args.take ? out.slice(0, args.take) : out).map((r) => ({ ...r }));
      }),
    create: ({ data }) => settle(() => ({ ...createRow(data) })),
    update: ({ where, data }) =>
      settle(() => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error(`${name}.update: no row matches ${JSON.stringify(where)}`);
        Object.assign(row, applyOps(row, data), { updatedAt: new Date() });
        return { ...row };
      }),
    updateMany: ({ where, data }) =>
      settle(() => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, applyOps(r, data), { updatedAt: new Date() });
        return { count: hit.length };
      }),
    upsert: ({ where, create, update }) =>
      settle(() => {
        const row = rows.find((r) => matches(r, where));
        if (!row) return { ...createRow(create) };
        Object.assign(row, applyOps(row, update), { updatedAt: new Date() });
        return { ...row };
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

/**
 * `model()` doesn't know a schema's `@unique` constraints, so by default two
 * rows with the same value for a supposedly-unique field can both be
 * created — unlike real Prisma, which throws `P2002`. Most tests either
 * don't hit that path or use their own hand-rolled fixture that checks it
 * explicitly; this wraps a shared-harness model's `create` to enforce one
 * real unique field, throwing the same `{code:'P2002'}` shape production
 * code's own `isUniqueViolation`-style checks already look for.
 */
function withUniqueField(m: MemoryModel, field: string): MemoryModel {
  return withUniqueFields(m, [field]);
}

/** Same as `withUniqueField`, for a compound unique key (`@@unique([a, b])`). */
function withUniqueFields(m: MemoryModel, fields: string[]): MemoryModel {
  return {
    ...m,
    create: async (args: { data: Row }) => {
      if (m.rows.some((r) => fields.every((f) => eq(r[f], args.data[f])))) {
        const err = new Error(`Unique constraint failed on the fields: (\`${fields.join('`, `')}\`)`) as Error & {
          code: string;
        };
        err.code = 'P2002';
        throw err;
      }
      return m.create(args);
    },
  };
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
    // loadOrgContext's connected-platform snapshot (agent/context.ts) — bare
    // stubs so callers that go through the full org-context read (missions,
    // the growth-agent orchestrator) don't hit "undefined.findFirst" against
    // an org with nothing connected yet.
    youTubeChannel: model('ytc', () => ({})),
    tikTokAccount: model('tta', () => ({})),
    crawl: model('crl', () => ({})),
    task: model('tsk', () => ({ status: 'PENDING' })),
    recommendation: model('rec', () => ({})),
    orgMemory: model('omm', () => ({
      userId: null,
      label: null,
      sourceType: 'manual',
      sourceId: null,
      confidence: 1,
      expiresAt: null,
    })),
    // Phase 2 identity models.
    aiGovernancePolicy: model('gov', () => ({})),
    user: model('usr', () => ({
      sessionVersion: 0,
      deletedAt: null,
      deactivatedAt: null,
      passwordHash: null,
      lastLoginAt: null,
      lastActiveAt: null,
    })),
    organization: model('org', () => ({ deletedAt: null, deletionScheduledAt: null })),
    membership: model('mbr', () => ({ status: 'ACTIVE', invitedById: null })),
    invitation: model('inv', () => ({
      acceptedAt: null,
      acceptedById: null,
      revokedAt: null,
      lastSentAt: null,
      sendCount: 1,
    })),
    userSession: model('ses', () => ({ revokedAt: null, revokedReason: null })),
    securityEvent: model('sev', () => ({ severity: 'INFO' })),
    userMfaFactor: model('mfa', () => ({
      label: null,
      secretCipher: null,
      secretIv: null,
      secretAuthTag: null,
      keyId: null,
      credentialId: null,
      publicKey: null,
      signCount: null,
      lastUsedAt: null,
    })),
    apiKey: model('key', () => ({
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      revokedById: null,
    })),
    automationRule: model('atr', () => ({})),
    // Phase 13 — Billing.
    subscription: model('sub', () => ({
      tier: 'FREE',
      status: 'ACTIVE',
      interval: 'MONTH',
      seats: 1,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEndsAt: null,
    })),
    entitlement: model('ent', () => ({
      limitValue: null,
      boolValue: null,
      source: 'PLAN',
      note: null,
      createdById: null,
      expiresAt: null,
    })),
    usageRecord: withUniqueField(
      model('usr', () => ({
        actorId: null,
        subjectType: null,
        subjectId: null,
        costUsd: null,
        metadata: null,
        occurredAt: new Date(),
      })),
      'idempotencyKey',
    ),
    usageCounter: withUniqueFields(
      model('usc', () => ({ used: BigInt(0), limitValue: null })),
      ['organizationId', 'meter', 'periodStart'],
    ),
    invoice: model('inv2', () => ({
      number: null,
      amountDue: 0,
      amountPaid: 0,
      amountRemaining: 0,
      currency: 'usd',
      hostedInvoiceUrl: null,
      invoicePdfUrl: null,
      periodStart: null,
      periodEnd: null,
      issuedAt: null,
    })),
    billingEvent: model('bev', () => ({ status: 'RECEIVED', error: null, processedAt: null })),
    creditTransaction: model('crt', () => ({ source: null, referenceId: null, actorId: null })),
    enterpriseContract: model('ent2', () => ({
      status: 'ACTIVE',
      contractEnd: null,
      seatLimit: null,
      billingTerms: null,
      supportLevel: null,
      createdById: null,
    })),
    // Phase 10 — Growth Missions.
    growthMission: model('gmi', () => ({
      status: 'DRAFT',
      priority: 'medium',
      autonomyLevel: 'ASSISTED',
      allowedPlatforms: [],
      allowedActions: [],
      budget: null,
      constraints: null,
      approvalPolicy: null,
      currentStrategy: null,
      currentProgress: null,
      toolCallCount: 0,
      taskCount: 0,
      loopFailureCount: 0,
      lastLoopAt: null,
      nextLoopAt: null,
      startDate: null,
      targetDate: null,
      activatedAt: null,
      pausedAt: null,
      completedAt: null,
      cancelledAt: null,
    })),
    missionMilestone: model('mms', () => ({
      status: 'PENDING',
      targetDate: null,
      startedAt: null,
      completedAt: null,
    })),
    missionTask: model('mts', () => ({
      milestoneId: null,
      toolName: null,
      toolInput: null,
      dependsOnTaskIds: [],
      risk: 'LOW',
      approvalRequired: false,
      status: 'PENDING',
      priority: 'medium',
      expectedResult: null,
      actualResult: null,
      resourceKey: null,
      attempt: 0,
      maxRetries: 2,
      startedAt: null,
      finishedAt: null,
    })),
    missionMetric: model('mmt', () => ({
      unit: null,
      currentValue: null,
      previousValue: null,
      targetValue: null,
      trend: null,
      measuredAt: new Date(),
    })),
    missionLearning: model('mln', () => ({
      evidence: [],
      confidence: 0.5,
      relatedTaskId: null,
    })),
    missionEvent: model('mev', () => ({ metadata: null })),
    // Phase 11 — Memory, Research & Knowledge Intelligence.
    knowledgeSource: model('ksr', () => ({
      url: null,
      title: null,
      publisher: null,
      author: null,
      publishedAt: null,
      lastVerifiedAt: null,
      contentHash: null,
      trustLevel: 'UNKNOWN',
      metadata: null,
    })),
    knowledgeItem: model('kit', () => ({
      createdById: null,
      missionId: null,
      scope: 'ORGANIZATION',
      summary: null,
      classification: 'SYSTEM_OBSERVED',
      confidence: 0.5,
      importance: 'MEDIUM',
      status: 'DRAFT',
      primarySourceId: null,
      freshnessPolicy: 'medium',
      expiresAt: null,
      lastVerifiedAt: null,
      lastUsedAt: null,
      metadata: null,
    })),
    knowledgeEvidence: model('kev', () => ({ location: null, confidence: 0.5 })),
    knowledgeEmbedding: model('kem', () => ({
      chunkIndex: 0,
      chunkMetadata: null,
      embeddingModel: null,
      embeddingVersion: null,
    })),
    knowledgeRelation: model('krl', () => ({})),
    knowledgeConflict: model('kcf', () => ({
      status: 'OPEN',
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      detectedAt: new Date(),
    })),
    memoryCandidate: model('mcd', () => ({
      userId: null,
      conversationId: null,
      classification: 'USER_PROVIDED',
      scope: 'ORGANIZATION',
      importance: 'MEDIUM',
      confidence: 0.6,
      status: 'PENDING',
      resolvedKnowledgeId: null,
      resolvedById: null,
      resolvedAt: null,
    })),
    researchProject: model('rsp', () => ({
      missionId: null,
      objective: null,
      scope: null,
      status: 'REQUESTED',
      config: null,
      conclusion: null,
      confidence: null,
      failureReason: null,
      startedAt: null,
      completedAt: null,
    })),
    researchQuery: model('rsq', () => ({ executedAt: null, resultCount: 0 })),
    researchFinding: model('rsf', () => ({ sourceId: null, confidence: 0.5, conflictsWithFindingId: null })),
    researchCitation: model('rsc', () => ({ findingId: null, quote: null })),
  };

  /**
   * Real rollback-on-throw, matching Prisma's interactive `$transaction`
   * (`db-tx.ts::runInTransaction` calls this when it's present). Added for
   * Phase 13's atomic usage-reservation logic, whose correctness depends on
   * "a rejected claim leaves no trace" — a real, permanent, reusable
   * capability for any future test that needs to prove a `try { ... } catch
   * { rollback }` code path, not a one-off.
   *
   * This must undo only the rows *this* transaction itself touched, each
   * restored to its value from just before this transaction first touched
   * it — never a wholesale "restore every model to how it looked when this
   * transaction started" snapshot. Two callers can have transactions
   * in-flight at once (interleaved across `await` points, exactly like two
   * concurrent requests hitting real Postgres), and a wholesale snapshot
   * taken when transaction A started would predate transaction B's
   * meanwhile-committed writes — rolling A back would then silently erase
   * B's legitimate, already-committed changes. A first version of this had
   * exactly that bug: it corrupted a concurrent-reservation test (10
   * requests racing 5 units of capacity landed 4, not 5, because a
   * rejected 6th reservation's rollback wiped out a 5th one that had
   * already succeeded in the interim).
   */
  (db as unknown as { $transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T> }).$transaction = async <
    T,
  >(
    fn: (tx: typeof db) => Promise<T>,
  ): Promise<T> => {
    // For each model, the first-seen pre-transaction value of every row this
    // transaction mutates, or `undefined` for a row this transaction itself
    // created (⇒ rollback deletes it). Recorded lazily, once per row, before
    // the real mutation runs.
    const journal = new Map<MemoryModel, Map<string, Row | undefined>>();
    const journalFor = (m: MemoryModel) => {
      let j = journal.get(m);
      if (!j) {
        j = new Map();
        journal.set(m, j);
      }
      return j;
    };
    const remember = (m: MemoryModel, id: string) => {
      const j = journalFor(m);
      if (j.has(id)) return; // keep the oldest (genuinely pre-transaction) snapshot
      const row = m.rows.find((r) => r.id === id);
      j.set(id, row ? { ...row } : undefined);
    };

    const tx: typeof db = { ...db };
    for (const [key, m] of Object.entries(db)) {
      if (!m || typeof m !== 'object' || !Array.isArray(m.rows)) continue;
      const real = m;
      const wrapped: MemoryModel = {
        rows: real.rows,
        findUnique: (args) => real.findUnique(args),
        findFirst: (args) => real.findFirst(args),
        findMany: (args) => real.findMany(args),
        count: (args) => real.count(args),
        create: async (args) => {
          const row = await real.create(args);
          // Didn't exist before this transaction touched it ⇒ delete on
          // rollback. Must set this directly rather than via `remember` —
          // by now the row already exists in `real.rows`, so `remember`'s
          // own lookup would (wrongly) capture the new row as if it were
          // the pre-transaction state instead of recording "no prior row".
          const j = journalFor(real);
          if (!j.has(row.id as string)) j.set(row.id as string, undefined);
          return row;
        },
        update: async (args) => {
          const before = real.rows.find((r) => matches(r, args.where));
          if (before) remember(real, before.id as string);
          return real.update(args);
        },
        updateMany: async (args) => {
          for (const r of real.rows.filter((r) => matches(r, args.where))) remember(real, r.id as string);
          return real.updateMany(args);
        },
        upsert: async (args) => {
          const before = real.rows.find((r) => matches(r, args.where));
          if (before) remember(real, before.id as string);
          const row = await real.upsert(args);
          if (!before) journalFor(real).set(row.id as string, undefined);
          return row;
        },
        delete: async (args) => {
          const before = real.rows.find((r) => matches(r, args.where));
          if (before) remember(real, before.id as string);
          return real.delete(args);
        },
        deleteMany: async (args = {}) => {
          for (const r of real.rows.filter((r) => matches(r, args.where))) remember(real, r.id as string);
          return real.deleteMany(args);
        },
      };
      (tx as unknown as Record<string, unknown>)[key] = wrapped;
    }

    try {
      return await fn(tx);
    } catch (err) {
      for (const [m, rowsById] of journal) {
        for (const [id, before] of rowsById) {
          const i = m.rows.findIndex((r) => r.id === id);
          if (before === undefined) {
            if (i >= 0) m.rows.splice(i, 1); // this transaction created it — remove it
          } else if (i >= 0) {
            m.rows[i] = before; // restore this row's pre-transaction value
          } else {
            m.rows.push(before); // this transaction deleted it — bring it back
          }
        }
      }
      throw err;
    }
  };

  return db;
}

export type MemoryDb = ReturnType<typeof createMemoryDb>;
