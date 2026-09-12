import type { Metadata } from 'next';
import { AgentChat } from '@/components/app/agent/agent-chat';

export const metadata: Metadata = { title: 'AI Growth Agent' };

export default function AgentIndexPage() {
  return (
    <div className="bg-card h-full rounded-lg border p-4">
      <AgentChat initialMessages={[]} />
    </div>
  );
}
