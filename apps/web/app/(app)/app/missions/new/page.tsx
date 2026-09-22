import type { Metadata } from 'next';
import { PageHeader } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { MissionWizard } from '@/components/app/missions/mission-wizard';

export const metadata: Metadata = { title: 'New mission' };

export default async function NewMissionPage() {
  await requireActiveOrg();
  return (
    <div className="space-y-6">
      <PageHeader
        title="New Growth Mission"
        description="Describe your goal in plain language. The AI will gather evidence from what you've connected and propose a plan for you to review before anything runs."
      />
      <MissionWizard />
    </div>
  );
}
