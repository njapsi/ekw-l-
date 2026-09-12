import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  createConversation,
  deleteConversation,
  exportConversation,
  getConversation,
  renameConversation,
  searchConversations,
} from './conversations.js';

interface Convo {
  id: string;
  organizationId: string;
  userId: string;
  title: string;
  deletedAt: Date | null;
  archivedAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
  messages: Array<{ id: string; role: string; content: string; blocks: unknown; createdAt: Date }>;
}

function fakeDb(convos: Convo[]) {
  return {
    convos,
    aIConversation: {
      create: vi.fn(async ({ data }: any) => {
        const c: Convo = {
          id: `c${convos.length}`,
          deletedAt: null,
          archivedAt: null,
          lastMessageAt: new Date(),
          createdAt: new Date(),
          messages: [],
          ...data,
        };
        convos.push(c);
        return c;
      }),
      findFirst: vi.fn(async ({ where, include }: any) => {
        const c = convos.find(
          (x) =>
            x.id === where.id &&
            x.organizationId === where.organizationId &&
            x.userId === where.userId &&
            x.deletedAt === null,
        );
        if (!c) return null;
        return include?.messages ? c : { ...c, messages: undefined };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let list = convos.filter(
          (c) =>
            c.organizationId === where.organizationId &&
            c.userId === where.userId &&
            c.deletedAt === null,
        );
        if (where.OR) {
          const q = where.OR[0].title.contains.toLowerCase();
          list = list.filter(
            (c) =>
              c.title.toLowerCase().includes(q) ||
              c.messages.some((m) => m.content.toLowerCase().includes(q)),
          );
        }
        return list.map((c) => {
          const anyWhere = (where.OR?.[1]?.messages?.some?.content?.contains ?? '').toLowerCase();
          return {
            ...c,
            messages: anyWhere
              ? c.messages.filter((m) => m.content.toLowerCase().includes(anyWhere)).slice(0, 1)
              : c.messages,
          };
        });
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const c = convos.find((x) => x.id === where.id);
        Object.assign(c!, data);
        return c;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

function convo(over: Partial<Convo> = {}): Convo {
  return {
    id: 'c0',
    organizationId: 'o1',
    userId: 'u1',
    title: 'YouTube momentum',
    deletedAt: null,
    archivedAt: null,
    lastMessageAt: new Date(),
    createdAt: new Date(),
    messages: [
      {
        id: 'm1',
        role: 'USER',
        content: 'Why is my channel losing momentum?',
        blocks: null,
        createdAt: new Date(),
      },
      {
        id: 'm2',
        role: 'ASSISTANT',
        content: 'Your uploads slowed and CTR dropped on browse.',
        blocks: {
          recommendations: [{ title: 'Publish weekly', howToFix: 'Ship one video every week.' }],
        },
        createdAt: new Date(),
      },
    ],
    ...over,
  };
}

describe('conversations', () => {
  it('creates and renames within the tenant', async () => {
    const db = fakeDb([]);
    const c = await createConversation(
      { organizationId: 'o1', userId: 'u1', title: 'x' },
      db as never,
    );
    const r = await renameConversation(
      {
        organizationId: 'o1',
        userId: 'u1',
        conversationId: c.id,
        title: '   A much longer title   ',
      },
      db as never,
    );
    expect(r.title).toBe('A much longer title');
    await expect(
      renameConversation(
        { organizationId: 'o2', userId: 'u1', conversationId: c.id, title: 'z' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('soft-deletes and then hides the conversation', async () => {
    const db = fakeDb([convo()]);
    await deleteConversation(
      { organizationId: 'o1', userId: 'u1', conversationId: 'c0' },
      db as never,
    );
    await expect(
      getConversation({ organizationId: 'o1', userId: 'u1', conversationId: 'c0' }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('searches title and message content and returns an excerpt', async () => {
    const db = fakeDb([
      convo(),
      convo({
        id: 'c1',
        title: 'SEO audit',
        messages: [
          {
            id: 'm3',
            role: 'USER',
            content: 'canonical conflicts everywhere',
            blocks: null,
            createdAt: new Date(),
          },
        ],
      }),
    ]);
    const byContent = await searchConversations(
      { organizationId: 'o1', userId: 'u1', query: 'canonical' },
      db as never,
    );
    expect(byContent.map((r) => r.id)).toEqual(['c1']);
    expect(byContent[0]?.snippet).toMatch(/canonical/i);
    const byTitle = await searchConversations(
      { organizationId: 'o1', userId: 'u1', query: 'momentum' },
      db as never,
    );
    expect(byTitle.map((r) => r.id)).toContain('c0');
  });

  it('exports markdown and json', async () => {
    const db = fakeDb([convo()]);
    const md = await exportConversation(
      { organizationId: 'o1', userId: 'u1', conversationId: 'c0' },
      db as never,
    );
    expect(md.filename).toMatch(/\.md$/);
    expect(md.content).toMatch(/# YouTube momentum/);
    expect(md.content).toMatch(/Publish weekly/);
    const json = await exportConversation(
      { organizationId: 'o1', userId: 'u1', conversationId: 'c0', format: 'json' },
      db as never,
    );
    const parsed = JSON.parse(json.content) as { messages: unknown[] };
    expect(parsed.messages).toHaveLength(2);
  });
});
