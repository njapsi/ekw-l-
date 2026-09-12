import type { Metadata } from 'next';
import Link from 'next/link';
import { automation, can, seo } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import {
  NewAutomationForm,
  type TaskTypeOption,
} from '@/components/app/automations/new-automation-form';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Automations' };

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  ACTIVE: 'secondary',
  PAUSED: 'outline',
  FAILING: 'destructive',
  DISABLED: 'destructive',
};

const RUN_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  SUCCEEDED: 'secondary',
  RUNNING: 'outline',
  PENDING: 'outline',
  RETRY_SCHEDULED: 'outline',
  SKIPPED: 'destructive',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

export default async function AutomationsPage() {
  const { org } = await requireActiveOrg();
  const canManage = can(org.role, 'automation:manage');

  const [rules, websites] = await Promise.all([
    automation.listAutomations(org.id),
    seo.listWebsites(org.id).catch(() => [] as Awaited<ReturnType<typeof seo.listWebsites>>),
  ]);

  const taskTypes: TaskTypeOption[] = automation.AUTOMATION_TASK_TYPES.map((key) => {
    const meta = automation.TASK_TYPE_META[key];
    return {
      key,
      label: meta.label,
      description: meta.description,
      example: meta.example,
      requiredAction: meta.requiredAction,
      needsWebsite: key === 'WEBSITE_CRAWL' || key === 'SEO_ISSUE_ALERT',
      isAlert: key === 'SEO_ISSUE_ALERT',
      isReport: key === 'GROWTH_REPORT',
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description="Schedule the analyses and reports you want to run automatically — daily, weekly, monthly, or on a custom cron. Every run uses your permissions and is logged; nothing is ever published externally."
      />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New automation</CardTitle>
            <CardDescription>
              Runs in the background on the schedule you pick (UTC). Retries with exponential
              backoff on failure.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewAutomationForm
              taskTypes={taskTypes}
              websites={websites.map((w) => ({ id: w.id, hostname: w.hostname }))}
            />
          </CardContent>
        </Card>
      ) : (
        <Alert>
          <AlertDescription>
            You can view automations, but a member or admin configures them.
          </AlertDescription>
        </Alert>
      )}

      {rules.length === 0 ? (
        <EmptyState
          title="No automations yet."
          description={canManage ? 'Create one above.' : 'Nothing scheduled for this organization.'}
        />
      ) : (
        <div className="grid gap-3">
          {rules.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <Link href={`/app/automations/${r.id}`} className="hover:underline">
                      {r.name}
                    </Link>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{r.taskLabel}</Badge>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                      {r.status.toLowerCase()}
                    </Badge>
                    {r.lastRun ? (
                      <Badge variant={RUN_VARIANT[r.lastRun.status] ?? 'outline'}>
                        last: {r.lastRun.status.toLowerCase()}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <CardDescription>
                  {r.scheduleLabel} · next {r.nextRunAt ? relDate(r.nextRunAt) : '—'} ·{' '}
                  {r.totalRuns} run(s)
                  {r.failureCount > 0 ? ` · ${r.failureCount} consecutive failure(s)` : ''}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
