import type { Metadata } from 'next';
import { can, governance } from '@growth-agent/services';
import { GovernanceForm } from '@/components/app/settings/governance-form';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'AI governance · Settings' };

export default async function GovernanceSettingsPage() {
  const { org } = await requireActiveOrg();
  const policy = await governance.getGovernancePolicy(org.id);
  return (
    <GovernanceForm
      initial={policy}
      allTaskTypes={[...governance.AUTOMATION_TASK_TYPES]}
      canEdit={can(org.role, 'agent.configure')}
    />
  );
}
