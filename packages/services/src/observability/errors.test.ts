import { describe, expect, it, vi } from 'vitest';
import { captureError, listErrorEvents } from './errors.js';

interface Row {
  id: string;
  fingerprint: string;
  [k: string]: unknown;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function makeDb() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const db = {
    rows,
    errorEvent: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.fingerprint);
        if (existing) {
          existing.count += update.count?.increment ?? 0;
          existing.lastSeenAt = update.lastSeenAt;
          existing.message = update.message;
          return existing;
        }
        const row: Row = {
          id: `err_${++seq}`,
          count: 1,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          ...create,
        };
        rows.set(where.fingerprint, row);
        return row;
      }),
      findMany: vi.fn(async () =>
        [...rows.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()),
      ),
    },
  };
  return db as any;
}

describe('captureError', () => {
  it('creates a row, then folds a repeat into the same fingerprint', async () => {
    const db = makeDb();
    const err = new Error('kaboom');
    err.stack = 'Error: kaboom\n    at doThing (src/thing.ts:10:5)';

    await captureError(err, { source: 'WEB', route: '/api/x' }, db);
    await captureError(err, { source: 'WEB', route: '/api/x' }, db);

    expect(db.errorEvent.upsert).toHaveBeenCalledTimes(2);
    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0].count).toBe(2);
  });

  it('gives a different fingerprint for a different route', async () => {
    const db = makeDb();
    const err = new Error('same message');
    err.stack = 'Error: same message\n    at h (src/a.ts:1:1)';
    await captureError(err, { source: 'WEB', route: '/api/a' }, db);
    await captureError(err, { source: 'WEB', route: '/api/b' }, db);
    expect(db.rows.size).toBe(2);
  });

  it('scrubs secrets and caps the message length', async () => {
    const db = makeDb();
    await captureError(
      new Error(`boom token=sk_live_abcdef1234567 ${'x'.repeat(5000)}`),
      {
        source: 'WORKER',
      },
      db,
    );
    const row = [...db.rows.values()][0];
    expect(row.message).not.toContain('sk_live_abcdef');
    expect((row.message as string).length).toBeLessThanOrEqual(1000);
  });

  it('never throws when the database write fails', async () => {
    const db = makeDb();
    db.errorEvent.upsert = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(captureError(new Error('x'), { source: 'WEB' }, db)).resolves.toBeUndefined();
  });
});

describe('listErrorEvents', () => {
  it('shapes rows for the admin table', async () => {
    const db = makeDb();
    await captureError(new Error('hello'), { source: 'WEB', route: '/r', statusCode: 500 }, db);
    const rows = await listErrorEvents(db, { limit: 10 });
    expect(rows[0]).toMatchObject({ source: 'WEB', name: 'Error', message: 'hello', count: 1 });
    expect(typeof rows[0]!.lastSeenAt).toBe('string');
  });
});
