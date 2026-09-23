import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { EmptyState, PageHeader } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { knowledge } from '@growth-agent/services';
import { ConflictRow } from '@/components/app/knowledge/conflict-row';

export const metadata: Metadata = { title: 'Knowledge Conflicts' };

export default async function ConflictsPage() {
  const { org } = await requireActiveOrg();
  const conflicts = await knowledge.listConflicts(org.id, 'OPEN');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge conflicts"
        description="Two stored items disagree. Growth Agent never picks a side silently — resolve which is correct, or confirm both hold in their own context."
      />
      {conflicts.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title="No open conflicts" description="Nothing needs your attention right now." />
      ) : (
        <div className="max-w-3xl space-y-4">
          {conflicts.map((c) => (
            <ConflictRow key={c.id} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}
