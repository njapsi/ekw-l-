import type { ReactNode } from 'react';
import { agent } from '@growth-agent/services';
import { PageHeader } from '@growth-agent/ui';
import { ConversationSidebar } from '@/components/app/agent/conversation-sidebar';
import { requireActiveOrg } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AgentLayout({ children }: { children: ReactNode }) {
  const { user, org } = await requireActiveOrg();
  const conversations = await agent.listConversations({ organizationId: org.id, userId: user.id });

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Growth Agent"
        description="One agent that plans across your YouTube, TikTok and SEO data, gathers evidence from the specialized agents, and returns prioritized, explainable actions. It never changes an external account."
      />
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="h-[70vh] lg:sticky lg:top-4">
          <ConversationSidebar
            conversations={conversations.map((c) => ({
              id: c.id,
              title: c.title,
              lastMessageAt: c.lastMessageAt,
            }))}
          />
        </aside>
        <div className="h-[70vh] min-w-0">{children}</div>
      </div>
    </div>
  );
}
