import { describe, expect, it, vi } from 'vitest';
import { looksSensitive, rememberFromTurn, rememberItem } from './memory.js';

function fakeMemoryDb() {
  const rows: any[] = [];
  return {
    rows,
    orgMemory: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.organizationId === where.organizationId &&
              r.userId === where.userId &&
              r.kind === where.kind &&
              r.label === where.label,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `m${rows.length}`, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      findMany: vi.fn(async () => rows),
    },
  };
}

describe('looksSensitive', () => {
  it('flags emails, phone numbers, tokens, hex secrets and credential URLs', () => {
    for (const s of [
      'contact me at jane@example.com',
      'call +1 415 555 0132 today',
      'the key is sk_live_ABCDEFGHIJKLMNOP',
      'AKIA1234567890ABCDEF',
      'deadbeefdeadbeefdeadbeefdeadbeef00',
      'https://user:pass@host/path',
      'my password is hunter2',
    ]) {
      expect(looksSensitive(s), s).toBe(true);
    }
  });
  it('does not flag ordinary goals', () => {
    expect(looksSensitive('grow the channel to 10k subscribers this year')).toBe(false);
    expect(looksSensitive('I prefer short, punchy titles')).toBe(false);
  });
});

describe('rememberItem', () => {
  it('stores a clean goal and dedupes on (org,user,kind,label)', async () => {
    const db = fakeMemoryDb();
    expect(
      await rememberItem(
        {
          organizationId: 'o1',
          userId: 'u1',
          kind: 'USER_GOAL',
          label: 'primary-goal',
          value: 'reach 10k subs',
        },
        db as never,
      ),
    ).toBe(true);
    expect(
      await rememberItem(
        {
          organizationId: 'o1',
          userId: 'u1',
          kind: 'USER_GOAL',
          label: 'primary-goal',
          value: 'reach 20k subs',
        },
        db as never,
      ),
    ).toBe(true);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].value).toBe('reach 20k subs');
  });

  it('refuses to store anything sensitive', async () => {
    const db = fakeMemoryDb();
    const ok = await rememberItem(
      {
        organizationId: 'o1',
        userId: 'u1',
        kind: 'PREFERENCE',
        label: 'contact',
        value: 'email me at a@b.com',
      },
      db as never,
    );
    expect(ok).toBe(false);
    expect(db.rows).toHaveLength(0);
  });

  it('caps value length', async () => {
    const db = fakeMemoryDb();
    await rememberItem(
      {
        organizationId: 'o1',
        userId: 'u1',
        kind: 'USER_GOAL',
        label: 'goal',
        value: 'grow '.repeat(200),
      },
      db as never,
    );
    expect(db.rows[0].value.length).toBeLessThanOrEqual(300);
  });
});

describe('rememberFromTurn', () => {
  it('extracts a goal and a preference via the deterministic path (no model)', async () => {
    const db = fakeMemoryDb();
    const n = await rememberFromTurn(
      { db: db as never },
      {
        organizationId: 'o1',
        userId: 'u1',
        conversationId: 'c1',
        message: 'My goal is to hit 50000 subscribers by December. I prefer weekly uploads.',
      },
    );
    expect(n).toBeGreaterThanOrEqual(1);
    const kinds = db.rows.map((r) => r.kind);
    expect(kinds).toContain('USER_GOAL');
  });

  it('constrains the model extractor and drops sensitive output', async () => {
    const db = fakeMemoryDb();
    const model = {
      generateObject: vi.fn(async () => ({
        object: {
          items: [
            {
              kind: 'USER_GOAL',
              label: 'reach',
              value: 'grow to 100k subscribers',
              confidence: 0.8,
            },
            {
              kind: 'PREFERENCE',
              label: 'contact',
              value: 'reach me at jane@example.com',
              confidence: 0.9,
            },
          ],
        },
        usage: {
          provider: 'anthropic' as const,
          model: 'x',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
        },
      })),
    };
    await rememberFromTurn(
      { db: db as never, model },
      { organizationId: 'o1', userId: 'u1', conversationId: 'c1', message: 'hi' },
    );
    expect(db.rows.map((r) => r.value)).toEqual(['grow to 100k subscribers']); // the email one was dropped
  });
});
