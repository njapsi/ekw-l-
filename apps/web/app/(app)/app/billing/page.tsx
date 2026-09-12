import type { Metadata } from 'next';
import { billing, can } from '@growth-agent/services';
import { Alert, AlertDescription, AlertTitle, PageHeader } from '@growth-agent/ui';
import { BillingPanels } from '@/components/app/billing/billing-panels';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Billing' };

export default async function BillingPage() {
  const { org } = await requireActiveOrg();
  const summary = await billing.getBillingSummary(org.id);
  const configured = billing.isBillingConfigured();
  const canManage = can(org.role, 'billing:manage');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing & usage"
        description="Your plan, what you've used this period, and your invoices. Prices and limits come from the plan catalog; payments are handled by Stripe — we never see or store card details."
      />

      {!configured ? (
        <Alert>
          <AlertTitle>Billing is not set up on this deployment</AlertTitle>
          <AlertDescription>
            Everyone runs on the <strong>Free</strong> plan and its limits are still enforced. Set
            the Stripe environment variables to enable checkout, upgrades and invoices.
          </AlertDescription>
        </Alert>
      ) : null}

      {!canManage ? (
        <Alert>
          <AlertTitle>View only</AlertTitle>
          <AlertDescription>
            You can see the plan and usage, but only an organization <strong>owner</strong> can
            change the subscription.
          </AlertDescription>
        </Alert>
      ) : null}

      <BillingPanels summary={summary} configured={configured} canManage={canManage} />
    </div>
  );
}
