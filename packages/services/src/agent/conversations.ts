/**
 * Conversation store for the Growth Agent (master instruction: "CONVERSATION"
 * — history, titles, search, delete, export). Streaming lives in the
 * orchestrator + the web Route Handler.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

export async function createConversation(
  input: { organizationId: string; userId: string; title?: string },
  db: Db = prisma,
) {
  return db.aIConversation.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      title: (input.title ?? 'New conversation').slice(0, 120),
    },
  });
}

export async function listConversations(
  input: { organizationId: string; userId: string; includeArchived?: boolean },
  db: Db = prisma,
) {
  return db.aIConversation.findMany({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      deletedAt: null,
      ...(input.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    select: { id: true, title: true, lastMessageAt: true, createdAt: true, archivedAt: true },
  });
}

export async function getConversation(
  input: { organizationId: string; userId: string; conversationId: string },
  db: Db = prisma,
) {
  const convo = await db.aIConversation.findFirst({
    where: {
      id: input.conversationId,
      organizationId: input.organizationId,
      userId: input.userId,
      deletedAt: null,
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, take: 200 },
    },
  });
  if (!convo) throw AppError.notFound('Conversation');
  return convo;
}

export async function renameConversation(
  input: { organizationId: string; userId: string; conversationId: string; title: string },
  db: Db = prisma,
) {
  const convo = await db.aIConversation.findFirst({
    where: {
      id: input.conversationId,
      organizationId: input.organizationId,
      userId: input.userId,
      deletedAt: null,
    },
  });
  if (!convo) throw AppError.notFound('Conversation');
  return db.aIConversation.update({
    where: { id: convo.id },
    data: { title: input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled' },
  });
}

export async function deleteConversation(
  input: { organizationId: string; userId: string; conversationId: string },
  db: Db = prisma,
) {
  const convo = await db.aIConversation.findFirst({
    where: {
      id: input.conversationId,
      organizationId: input.organizationId,
      userId: input.userId,
      deletedAt: null,
    },
  });
  if (!convo) throw AppError.notFound('Conversation');
  await db.aIConversation.update({ where: { id: convo.id }, data: { deletedAt: new Date() } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'agent.conversation.deleted',
      targetType: 'ai_conversation',
      targetId: convo.id,
    },
    db,
  );
}

/** Title + message-content search within the user's own conversations. */
export async function searchConversations(
  input: { organizationId: string; userId: string; query: string; limit?: number },
  db: Db = prisma,
) {
  const q = input.query.trim();
  if (q.length < 2) return [];
  const limit = Math.min(50, input.limit ?? 25);

  const matches = await db.aIConversation.findMany({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      deletedAt: null,
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { messages: { some: { content: { contains: q, mode: 'insensitive' } } } },
      ],
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      lastMessageAt: true,
      messages: {
        where: { content: { contains: q, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { role: true, content: true, createdAt: true },
      },
    },
  });

  return matches.map((m) => ({
    id: m.id,
    title: m.title,
    lastMessageAt: m.lastMessageAt,
    snippet: m.messages[0] ? excerpt(m.messages[0].content, q) : excerpt(m.title, q),
  }));
}

function excerpt(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text.slice(0, 160);
  const start = Math.max(0, i - 60);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + 200).replace(/\s+/g, ' ') +
    (text.length > start + 200 ? '…' : '')
  );
}

export interface ConversationExport {
  format: 'markdown' | 'json';
  filename: string;
  content: string;
}

export async function exportConversation(
  input: {
    organizationId: string;
    userId: string;
    conversationId: string;
    format?: 'markdown' | 'json';
  },
  db: Db = prisma,
): Promise<ConversationExport> {
  const convo = await getConversation(input, db);
  const format = input.format ?? 'markdown';
  const slug =
    convo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'conversation';

  if (format === 'json') {
    return {
      format,
      filename: `${slug}.json`,
      content: JSON.stringify(
        {
          title: convo.title,
          createdAt: convo.createdAt,
          messages: convo.messages.map((m) => ({
            role: m.role,
            content: m.content,
            blocks: m.blocks ?? null,
            createdAt: m.createdAt,
          })),
        },
        null,
        2,
      ),
    };
  }

  const lines = [`# ${convo.title}`, '', `_Exported ${new Date().toISOString()}_`, ''];
  for (const m of convo.messages) {
    lines.push(
      `## ${m.role === 'USER' ? 'You' : m.role === 'ASSISTANT' ? 'Growth Agent' : 'System'} — ${m.createdAt.toISOString()}`,
    );
    lines.push('');
    lines.push(m.content);
    lines.push('');
    const blocks = m.blocks as {
      recommendations?: Array<{ title: string; howToFix: string }>;
      proposedActions?: Array<{ label: string }>;
    } | null;
    if (blocks?.recommendations?.length) {
      lines.push('### Recommendations');
      for (const r of blocks.recommendations) lines.push(`- **${r.title}** — ${r.howToFix}`);
      lines.push('');
    }
  }
  return { format, filename: `${slug}.md`, content: lines.join('\n') };
}

/** Touch `lastMessageAt` after a turn. */
export async function touchConversation(conversationId: string, db: Db = prisma): Promise<void> {
  await db.aIConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
}
