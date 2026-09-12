import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import {
  createNotification,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from './index.js';

// Keep email out of it — with no transport configured, fan-out is a no-op.
vi.mock('./email.js', () => ({
  emailDeliveryConfigured: () => false,
  sendTransactionalEmail: vi.fn(async () => false),
}));

interface Row {
  id: string;
  organizationId: string;
  userId: string | null;
  kind: string;
  level: string;
  title: string;
  body: string;
  linkPath: string | null;
  dedupeKey: string | null;
  sourceType: string | null;
  sourceId: string | null;
  readAt: Date | null;
  emailedAt: Date | null;
  createdAt: Date;
}

function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const match = (r: Row, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR' && Array.isArray(v)) {
        if (!v.some((clause) => match(r, clause as Record<string, unknown>))) return false;
      } else if (k === 'id' && v && typeof v === 'object' && 'in' in v) {
        if (!(v as { in: string[] }).in.includes(r.id)) return false;
      } else if (k === 'readAt' && v === null) {
        if (r.readAt !== null) return false;
      } else if ((r as unknown as Record<string, unknown>)[k] !== v) {
        return false;
      }
    }
    return true;
  };
  const db = {
    notification: {
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        const row: Row = {
          id: `n${++seq}`,
          organizationId: data.organizationId!,
          userId: data.userId ?? null,
          kind: data.kind!,
          level: (data.level as string) ?? 'INFO',
          title: data.title!,
          body: data.body!,
          linkPath: data.linkPath ?? null,
          dedupeKey: data.dedupeKey ?? null,
          sourceType: data.sourceType ?? null,
          sourceId: data.sourceId ?? null,
          readAt: null,
          emailedAt: null,
          createdAt: new Date(Date.now() + seq),
        };
        rows.push(row);
        return row;
      }),
      upsert: vi.fn(
        async ({ where, create }: { where: { dedupeKey: string }; create: Partial<Row> }) => {
          const existing = rows.find((r) => r.dedupeKey === where.dedupeKey);
          if (existing) return existing;
          return db.notification.create({ data: create });
        },
      ),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        rows
          .filter((r) => match(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take ?? 1000),
      ),
      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((r) => match(r, where)).length,
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: { readAt: Date } }) => {
          let count = 0;
          for (const r of rows) {
            if (match(r, where)) {
              r.readAt = data.readAt;
              count++;
            }
          }
          return { count };
        },
      ),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ email: 'x@y.z', deletedAt: null })) },
  };
  return { db: db as unknown as Db, rows };
}

describe('notifications', () => {
  let ctx: ReturnType<typeof fakeDb>;
  beforeEach(() => {
    ctx = fakeDb();
  });

  it('creates a row and is idempotent on dedupeKey', async () => {
    const a = await createNotification(
      { organizationId: 'o1', userId: 'u1', kind: 'x', title: 't', body: 'b', dedupeKey: 'k1' },
      ctx.db,
    );
    const b = await createNotification(
      { organizationId: 'o1', userId: 'u1', kind: 'x', title: 't2', body: 'b2', dedupeKey: 'k1' },
      ctx.db,
    );
    expect(a).toBe(b);
    expect(ctx.rows).toHaveLength(1);
  });

  it('never throws — a broken db call returns null', async () => {
    const broken = { notification: {} } as unknown as Db;
    await expect(
      createNotification({ organizationId: 'o1', kind: 'x', title: 't', body: 'b' }, broken),
    ).resolves.toBeNull();
  });

  it('scopes list/unread/markRead to the org + (user or org-wide)', async () => {
    await createNotification(
      { organizationId: 'o1', userId: 'u1', kind: 'k', title: 'mine', body: 'b' },
      ctx.db,
    );
    await createNotification(
      { organizationId: 'o1', userId: null, kind: 'k', title: 'orgwide', body: 'b' },
      ctx.db,
    );
    await createNotification(
      { organizationId: 'o1', userId: 'u2', kind: 'k', title: 'theirs', body: 'b' },
      ctx.db,
    );
    await createNotification(
      { organizationId: 'o2', userId: 'u1', kind: 'k', title: 'otherorg', body: 'b' },
      ctx.db,
    );

    const list = await listNotifications({ organizationId: 'o1', userId: 'u1' }, ctx.db);
    expect(list.map((r) => r.title).sort()).toEqual(['mine', 'orgwide']);

    expect(await unreadCount('o1', 'u1', ctx.db)).toBe(2);

    await markAllRead({ organizationId: 'o1', userId: 'u1' }, ctx.db);
    expect(await unreadCount('o1', 'u1', ctx.db)).toBe(0);
    // u2 still has "theirs" unread. (The org-wide row shares a single readAt —
    // acceptable for broadcast system notices; targeted rows are per-user.)
    expect(await unreadCount('o1', 'u2', ctx.db)).toBe(1);
  });

  it('markRead only affects the caller-visible ids', async () => {
    const id = await createNotification(
      { organizationId: 'o1', userId: 'u1', kind: 'k', title: 'a', body: 'b' },
      ctx.db,
    );
    const updated = await markRead(
      [id!, 'nonexistent'],
      { organizationId: 'o1', userId: 'u1' },
      ctx.db,
    );
    expect(updated).toBe(1);
  });
});
