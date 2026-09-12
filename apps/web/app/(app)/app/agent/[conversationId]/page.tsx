import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { agent, isAppError } from '@growth-agent/services';
import { AgentChat } from '@/components/app/agent/agent-chat';
import type { AgentBlocks } from '@/components/app/agent/message-blocks';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'AI Growth Agent' };

export default async function AgentConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const { user, org } = await requireActiveOrg();

  let convo;
  try {
    convo = await agent.getConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId,
    });
  } catch (e) {
    if (isAppError(e) && e.code === 'resource_not_found') notFound();
    throw e;
  }

  return (
    <div className="bg-card h-full rounded-lg border p-4">
      <AgentChat
        conversationId={convo.id}
        initialMessages={convo.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          blocks: (m.blocks as AgentBlocks | null) ?? null,
        }))}
      />
    </div>
  );
}
