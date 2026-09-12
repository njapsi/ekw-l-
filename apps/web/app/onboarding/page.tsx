import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { listOrganizationsForUser } from '@growth-agent/db';
import { requireUser } from '@/lib/auth';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'Create your organization' };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const orgs = await listOrganizationsForUser(user.id);

  // If the user already has an organization and did not explicitly ask for a
  // new one, send them into the app.
  if (orgs.length > 0 && params.new !== '1') {
    redirect('/app/dashboard');
  }

  return (
    <div className="container flex min-h-screen items-center justify-center py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">Create your organization</h1>
          <p className="text-muted-foreground text-sm">
            An organization holds your connected accounts, SEO projects, and team.
          </p>
        </div>
        <OnboardingForm />
      </div>
    </div>
  );
}
