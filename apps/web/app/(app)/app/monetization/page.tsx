import type { Metadata } from 'next';
import { monetization } from '@growth-agent/services';
import { Alert, AlertDescription, AlertTitle, EmptyState, PageHeader } from '@growth-agent/ui';
import {
  BusinessProfileForm,
  type BusinessProfileView,
} from '@/components/app/monetization/business-profile-form';
import { channelLabel } from '@/components/app/monetization/channels';
import {
  OpportunityCard,
  type OpportunityView,
} from '@/components/app/monetization/opportunity-card';
import {
  RevenueTracker,
  type RevenueEntryView,
  type RevenueSummaryView,
} from '@/components/app/monetization/revenue-tracker';
import { ScanButton } from '@/components/app/monetization/scan-button';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Monetization intelligence' };

export default async function MonetizationPage() {
  const { org } = await requireActiveOrg();
  const [dashboard, profileRow] = await Promise.all([
    monetization.getMonetizationDashboard(org.id),
    monetization.getBusinessProfile(org.id),
  ]);

  const profile: BusinessProfileView | null = profileRow
    ? {
        niche: profileRow.niche,
        audienceDescription: profileRow.audienceDescription,
        offerings: profileRow.offerings,
        goals: profileRow.goals,
        emailListSize: profileRow.emailListSize,
        hasWebsite: profileRow.hasWebsite,
        sellsProducts: profileRow.sellsProducts,
        doesSponsorships: profileRow.doesSponsorships,
        doesAffiliates: profileRow.doesAffiliates,
        doesConsulting: profileRow.doesConsulting,
        hasMembership: profileRow.hasMembership,
        hasCourse: profileRow.hasCourse,
        attestations: (profileRow.attestations as BusinessProfileView['attestations']) ?? null,
        notes: profileRow.notes,
      }
    : null;

  const current = dashboard.current as OpportunityView[];
  const potential = dashboard.potential as OpportunityView[];
  const completed = dashboard.completed as OpportunityView[];
  const dismissed = dashboard.dismissed as OpportunityView[];
  const revenueEntries = dashboard.revenue.entries as RevenueEntryView[];
  const revenueSummary = dashboard.revenue.summary as RevenueSummaryView;

  const nothingScanned =
    current.length === 0 &&
    potential.length === 0 &&
    completed.length === 0 &&
    dismissed.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monetization intelligence"
        description="Turns your connected creator data and the business details you provide into a ranked list of monetization channels — platform monetization, sponsorships, affiliates, digital products, services, memberships, subscriptions, lead generation, consulting, courses and brand partnerships. Every difficulty and potential below is a labelled estimate, not a revenue figure."
      />

      <Alert>
        <AlertTitle>How to read this page</AlertTitle>
        <AlertDescription>
          Potential, difficulty, audience fit and confidence are <strong>estimates</strong> derived
          from your audience size and profile — they are relative labels, never dollar amounts.
          Platform-monetization readiness is not a claim that you qualify: eligibility for programs
          like the YouTube Partner Program is decided by the platform when you apply. Revenue
          tracking shows only figures you enter yourself.
        </AlertDescription>
      </Alert>

      <BusinessProfileForm profile={profile} />

      <div className="bg-card rounded-lg border p-4">
        <ScanButton
          lastScanLabel={dashboard.lastScanAt ? relDate(dashboard.lastScanAt) : 'never'}
        />
        {dashboard.lastScanOverview ? (
          <p className="text-muted-foreground mt-3 text-sm">{dashboard.lastScanOverview}</p>
        ) : null}
      </div>

      {nothingScanned ? (
        <EmptyState
          title="No opportunities yet."
          description="Fill in your business profile and/or connect a platform, then run a scan."
        />
      ) : (
        <>
          {dashboard.recommendedActions.length ? (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Recommended actions</h2>
              <ol className="space-y-2">
                {dashboard.recommendedActions.map((a) => (
                  <li key={a.opportunityId} className="bg-card rounded-lg border p-3 text-sm">
                    <span className="text-muted-foreground text-xs">
                      {channelLabel(a.channel)}
                      {a.priorityScore != null ? ` · priority ${a.priorityScore}/100` : ''}
                    </span>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-muted-foreground">{a.action}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Current opportunities ({current.length})</h2>
            {current.length ? (
              current.map((o) => <OpportunityCard key={o.id} opp={o} />)
            ) : (
              <p className="text-muted-foreground text-sm">
                Nothing active or in progress. Start one from the potential list below.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Potential opportunities ({potential.length})</h2>
            {potential.length ? (
              potential.map((o) => <OpportunityCard key={o.id} opp={o} />)
            ) : (
              <p className="text-muted-foreground text-sm">No suggested opportunities right now.</p>
            )}
          </section>

          {completed.length ? (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Completed ({completed.length})</h2>
              {completed.map((o) => (
                <OpportunityCard key={o.id} opp={o} />
              ))}
            </section>
          ) : null}

          {dismissed.length ? (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Dismissed ({dismissed.length})</h2>
              {dismissed.map((o) => (
                <OpportunityCard key={o.id} opp={o} />
              ))}
            </section>
          ) : null}
        </>
      )}

      <RevenueTracker entries={revenueEntries} summary={revenueSummary} />
    </div>
  );
}
