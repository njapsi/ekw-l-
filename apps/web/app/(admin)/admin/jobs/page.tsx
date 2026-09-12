import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { HealthPill } from '@/components/admin/stat';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Background jobs · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminJobsPage() {
  const [depths, failed, ticks, workers] = await Promise.all([
    observability.getQueueDepths(),
    observability.getAllRecentFailedJobs(8),
    observability.getRepeatableTicks(),
    observability.listWorkerHeartbeats(prisma),
  ]);

  const anyUnreachable = depths.some((d) => d.error);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Background jobs"
        description="BullMQ queues on Redis. Job payloads are not shown — only ids and failure reasons."
      />

      {anyUnreachable ? (
        <p className="text-destructive text-sm">
          One or more queues could not be read from Redis — depths below may be stale.
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Queues</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={depths}
            rowKey={(q) => q.name}
            columns={[
              {
                key: 'q',
                header: 'Queue',
                cell: (q) => <span className="font-medium">{q.name}</span>,
              },
              { key: 'w', header: 'Waiting', cell: (q) => q.waiting },
              { key: 'a', header: 'Active', cell: (q) => q.active },
              { key: 'd', header: 'Delayed', cell: (q) => q.delayed },
              {
                key: 'f',
                header: 'Failed',
                cell: (q) =>
                  q.failed > 0 ? <span className="text-destructive">{q.failed}</span> : '0',
              },
              { key: 'c', header: 'Completed', cell: (q) => q.completed },
              {
                key: 's',
                header: 'State',
                cell: (q) =>
                  q.error ? (
                    <span className="text-destructive">unreachable</span>
                  ) : q.isPaused ? (
                    <Badge variant="outline">paused</Badge>
                  ) : (
                    'running'
                  ),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Repeatable ticks</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={ticks}
            rowKey={(t) => `${t.name}:${t.pattern ?? t.every ?? ''}`}
            empty="No repeatable jobs registered (worker not running?)."
            columns={[
              { key: 'n', header: 'Name', cell: (t) => t.name },
              {
                key: 'sched',
                header: 'Schedule',
                cell: (t) =>
                  t.every ? `every ${Math.round(t.every / 1000)}s` : (t.pattern ?? '—'),
              },
              { key: 'next', header: 'Next', cell: (t) => (t.next ? relDate(t.next) : '—') },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent failed jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={failed}
            rowKey={(j) => `${j.queue}:${j.id}`}
            empty="No failed jobs on record."
            columns={[
              { key: 'q', header: 'Queue', cell: (j) => j.queue },
              { key: 'name', header: 'Job', cell: (j) => j.name },
              {
                key: 'id',
                header: 'Id',
                cell: (j) => <span className="font-mono text-[11px]">{j.id}</span>,
              },
              { key: 'att', header: 'Attempts', cell: (j) => j.attemptsMade },
              {
                key: 'reason',
                header: 'Reason',
                cell: (j) => <span className="text-destructive">{j.failedReason || '—'}</span>,
              },
              {
                key: 'when',
                header: 'When',
                cell: (j) => relDate(j.finishedOn ?? j.timestamp),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Workers</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={workers}
            rowKey={(w) => w.workerId}
            empty="No worker heartbeat on record."
            columns={[
              {
                key: 'id',
                header: 'Worker',
                cell: (w) => <span className="font-mono text-[11px]">{w.workerId}</span>,
              },
              { key: 'health', header: 'Health', cell: (w) => <HealthPill state={w.health} /> },
              { key: 'v', header: 'Version', cell: (w) => w.version ?? '—' },
              { key: 'beat', header: 'Last beat', cell: (w) => relDate(w.lastBeatAt) },
              { key: 'redis', header: 'Redis', cell: (w) => (w.redisOk ? 'ok' : 'down') },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
