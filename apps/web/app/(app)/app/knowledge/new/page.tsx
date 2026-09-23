import type { Metadata } from 'next';
import { PageHeader } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { AddKnowledgeForm } from '@/components/app/knowledge/add-knowledge-form';

export const metadata: Metadata = { title: 'Add Knowledge' };

export default async function AddKnowledgePage() {
  await requireActiveOrg();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Add knowledge"
        description="Tell Growth Agent something durable about your business, or import a page. It's tagged as directly user-provided and starts active immediately."
      />
      <AddKnowledgeForm />
    </div>
  );
}
