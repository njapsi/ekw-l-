import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError, isAppError, missions } from '@growth-agent/services';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { MissionActionsBar } from '@/components/app/missions/mission-actions-bar';
import { RunTaskButton } from '@/components/app/missions/run-task-button';

export const metadata: Metadata = { title: 'Mission' };

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  ACTIVE: 'success',
  DRAFT: 'outline',
  PLANNING: 'secondary',
  AWAITING_APPROVAL: 'warning',
  PAUSED: 'warning',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

const TASK_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  PENDING: 'outline',
  READY: 'secondary',
  RUNNING: 'warning',
  WAITING_APPROVAL: 'warning',
  BLOCKED: 'destructive',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'outline',
  SKIPPED: 'outline',
};

const APPROVAL_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'destructive'> = {
  PENDING: 'warning',
  APPROVED: 'outline',
  REJECTED: 'destructive',
  EXECUTED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'outline',
  EXPIRED: 'outline',
};

export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  const { org } = await requireActiveOrg();

  let detail;
  try {
    detail = await missions.getMissionDetail(org.id, missionId);
  } catch (e) {
    if (isAppError(e) && e.code === 'resource_not_found') notFound();
    throw e as AppError;
  }
  const { mission, milestones, tasks } = detail;

  const [metrics, learnings, events, approvals] = await Promise.all([
    missions.getMissionMetricProgress(org.id, missionId),
    missions.listMissionLearnings(org.id, missionId),
    missions.listMissionEvents(org.id, missionId),
    missions.listMissionApprovals(org.id, missionId),
  ]);

  const strategy = mission.currentStrategy as
    | { narrative: string; currentState: string; targetState: string; assumptions: string[]; risks: string[]; grounded: boolean }
    | null;
  const tasksByMilestone = new Map<string | null, typeof tasks>();
  for (const t of tasks) {
    const key = t.milestoneId ?? null;
    tasksByMilestone.set(key, [...(tasksByMilestone.get(key) ?? []), t]);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={mission.name}
        description={mission.objective}
        actions={<Badge variant={STATUS_VARIANT[mission.status] ?? 'outline'}>{mission.status.replace(/_/g, ' ').toLowerCase()}</Badge>}
      />

      <MissionActionsBar missionId={mission.id} status={mission.status} />

      {strategy ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Strategy</CardTitle>
            <CardDescription>
              {strategy.grounded ? 'AI-refined narrative, grounded in the evidence below.' : 'Deterministic summary (no AI narrative was available).'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{strategy.narrative}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground text-xs font-medium">Current state</p>
                <p>{strategy.currentState}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs font-medium">Target state</p>
                <p>{strategy.targetState}</p>
              </div>
            </div>
            {strategy.assumptions.length > 0 ? (
              <div>
                <p className="text-muted-foreground text-xs font-medium">Assumptions</p>
                <ul className="list-disc pl-4">
                  {strategy.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {strategy.risks.length > 0 ? (
              <div>
                <p className="text-muted-foreground text-xs font-medium">Risks</p>
                <ul className="list-disc pl-4">
                  {strategy.risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {metrics.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metrics</CardTitle>
            <CardDescription>Current / previous / target / trend — real measurements only.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {metrics.map((m) => (
                <div key={m.key} className="border-border rounded-md border p-3">
                  <p className="text-xs font-medium">{m.label}</p>
                  <p className="text-lg font-semibold">{m.current ?? '—'}</p>
                  <p className="text-muted-foreground text-xs">
                    {m.trend ? `Trend: ${m.trend}` : 'Not enough data yet'}
                    {m.target != null ? ` · Target: ${m.target}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {approvals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approvals</CardTitle>
            <CardDescription>
              Nothing this mission proposes runs until a human approves it. Review and decide from{' '}
              <Link href="/app/integrations/approvals" className="underline">
                the approvals queue
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {approvals.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{a.summary}</span>
                <Badge variant={APPROVAL_STATUS_VARIANT[a.status] ?? 'outline'}>{a.status.toLowerCase()}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Milestones &amp; tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {milestones.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No plan yet.{' '}
              {mission.status === 'DRAFT' ? 'Click "Generate plan" above to build one from your connected data.' : ''}
            </p>
          ) : (
            milestones.map((milestone) => (
              <div key={milestone.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{milestone.title}</p>
                  <Badge variant="outline">{milestone.status.toLowerCase()}</Badge>
                </div>
                <p className="text-muted-foreground text-xs">{milestone.description}</p>
                <div className="space-y-1.5">
                  {(tasksByMilestone.get(milestone.id) ?? []).map((task) => (
                    <div key={task.id} className="border-border flex items-center justify-between gap-3 rounded-md border p-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate">{task.title}</p>
                        <p className="text-muted-foreground text-xs">
                          {task.platform.toLowerCase()} · {task.risk.toLowerCase()} risk
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant={TASK_STATUS_VARIANT[task.status] ?? 'outline'}>{task.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                        {task.status === 'READY' && mission.status === 'ACTIVE' ? (
                          <RunTaskButton missionId={mission.id} taskId={task.id} />
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
          {(tasksByMilestone.get(null) ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {(tasksByMilestone.get(null) ?? []).map((task) => (
                <div key={task.id} className="border-border flex items-center justify-between gap-3 rounded-md border p-2.5 text-sm">
                  <span className="truncate">{task.title}</span>
                  <Badge variant={TASK_STATUS_VARIANT[task.status] ?? 'outline'}>{task.status.toLowerCase()}</Badge>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {learnings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Learnings</CardTitle>
            <CardDescription>Observation / Hypothesis / Learning / Decision — never presented as more certain than they are.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {learnings.slice(0, 10).map((l) => (
              <div key={l.id} className="text-sm">
                <Badge variant="outline">{l.type.toLowerCase()}</Badge>{' '}
                <span className="font-medium">{l.title}:</span> <span className="text-muted-foreground">{l.detail}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
          <CardDescription>Why the mission took each action, and what happened — auditable, never hidden chain-of-thought.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {events.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing has happened yet.</p>
          ) : (
            events
              .slice()
              .reverse()
              .slice(0, 30)
              .map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 text-xs">
                  <span>{e.type.replace(/_/g, ' ').toLowerCase()}</span>
                  <span className="text-muted-foreground">{relDate(e.createdAt)}</span>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
