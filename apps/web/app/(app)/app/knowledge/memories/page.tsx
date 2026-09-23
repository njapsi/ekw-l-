import type { Metadata } from 'next';
import { Inbox } from 'lucide-react';
import { EmptyState, PageHeader } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { knowledge } from '@growth-agent/services';
import { MemoryCandidateRow } from '@/components/app/knowledge/memory-candidate-row';

export const metadata: Metadata = { title: 'Memories to review' };

export default async function MemoriesPage() {
  const { org } = await requireActiveOrg();
  const candidates = await knowledge.listMemoryCandidates(org.id, 'PENDING');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memories to review"
        description="Statements the AI noticed while chatting with you that might be worth remembering. Nothing here is stored as real knowledge until you accept it."
      />
      {candidates.length === 0 ? (
        <EmptyState icon={<Inbox />} title="Nothing to review" description="Nothing is waiting for your review right now." />
      ) : (
        <div className="max-w-2xl space-y-4">
          {candidates.map((c) => (
            <MemoryCandidateRow key={c.id} candidate={c} />
          ))}
        </div>
      )}
    </div>
  );
}
