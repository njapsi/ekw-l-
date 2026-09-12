import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { automation, can } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { AutomationActionsBar } from '@/components/app/automations/automation-actions-bar';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Automation' };

const RUN_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  SUCCEEDED: 'secondary',
  RUNNING: 'outline',
  PENDING: 'outline',
  RETRY_SCHEDULED: 'outline',
  SKIPPED: 'destructive',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  ACTIVE: 'secondary',
  PAUSED: 'outline',
  FAILING: 'destructive',
  DISABLED: 'destructive',
};

function summaryOf(output: unknown): string {
  if (output && typeof output === 'object' && 'summary' in output) {
    const s = (output as { summary?: unknown }).summary;
    if (typeof s === 'string') return s;
  }
  return '';
}

export default async function AutomationDetailPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const { automationId } = await params;
  const { org } = await requireActiveOrg();
  const rule = await automation.getAutomation(org.id, automationId);
  if (!rule) notFound();
  const canManage = can(org.role, 'automation:manage');

  return (
    <div className="space-y-6">
      <PageHeader title={rule.name} description={rule.taskLabel} />
      <div className="-mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{rule.taskLabel}</Badge>
        <Badge variant={STATUS_VARIANT[rule.status] ?? 'outline'}>
          {rule.status.toLowerCase()}
        </Badge>
        <Link href="/app/automations" className="text-muted-foreground text-xs underline">
          All automations
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">Schedule:</span> {rule.scheduleLabel}{' '}
            <span className="text-muted-foreground">({rule.cronExpression} UTC)</span>
          </p>
          <p>
            <span className="text-muted-foreground">Next run:</span>{' '}
            {rule.nextRunAt
              ? `${relDate(rule.nextRunAt)} (${new Date(rule.nextRunAt).toISOString()})`
              : '—'}
          </p>
          <p>
            <span className="text-muted-foreground">Last run:</span>{' '}
            {rule.lastRunAt ? `${relDate(rule.lastRunAt)} — ${rule.lastRunStatus ?? '—'}` : 'never'}
          </p>
          <p>
            <span className="text-muted-foreground">Retries per run:</span> {rule.maxRetries} ·{' '}
            <span className="text-muted-foreground">total runs:</span> {rule.totalRuns} ·{' '}
            <span className="text-muted-foreground">consecutive failures:</span> {rule.failureCount}
          </p>
          {rule.lastError ? <p className="text-destructive">Last error: {rule.lastError}</p> : null}
          {Object.keys((rule.config as Record<string, unknown>) ?? {}).length > 0 ? (
            <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-xs">
              {JSON.stringify(rule.config, null, 2)}
            </pre>
          ) : null}
          <p className="text-muted-foreground mt-2 text-xs">
            Runs use the owner&apos;s permissions and never publish externally.
          </p>
        </CardContent>
      </Card>

      {canManage ? <AutomationActionsBar automationId={rule.id} status={rule.status} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Execution log ({rule.runs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {rule.runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3">When</th>
                    <th className="py-1 pr-3">Status</th>
                    <th className="py-1 pr-3">Attempt</th>
                    <th className="py-1 pr-3">Duration</th>
                    <th className="py-1 pr-3">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rule.runs.map((run) => (
                    <tr key={run.id} className="border-border border-t align-top">
                      <td className="whitespace-nowrap py-1 pr-3">
                        {relDate(run.createdAt)}
                        <span className="text-muted-foreground block">{run.triggeredBy}</span>
                      </td>
                      <td className="py-1 pr-3">
                        <Badge variant={RUN_VARIANT[run.status] ?? 'outline'}>
                          {run.status.toLowerCase()}
                        </Badge>
                        {run.status === 'RETRY_SCHEDULED' && run.nextAttemptAt ? (
                          <span className="text-muted-foreground block">
                            retry {relDate(run.nextAttemptAt)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3">{run.attempt}</td>
                      <td className="py-1 pr-3">
                        {run.durationMs != null ? `${Math.round(run.durationMs / 100) / 10}s` : '—'}
                      </td>
                      <td className="py-1 pr-3">
                        {run.error ? (
                          <span className="text-destructive">{run.error}</span>
                        ) : (
                          summaryOf(run.output) || '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
