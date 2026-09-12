import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { HealthPill, Stat, StatGrid } from '@/components/admin/stat';
import { bytes, ms, ratioPct, usd } from '@/lib/admin-format';
import { compactNumber, fullNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'System health · Admin' };
export const dynamic = 'force-dynamic';

const DAY = 24 * 60 * 60 * 1000;

function counterTotal(counters: { name: string; value: number }[], prefix: string): number {
  return counters.filter((c) => c.name.startsWith(prefix)).reduce((n, c) => n + c.value, 0);
}

export default async function AdminSystemHealthPage() {
  const [health, ai, crawler, jobs, db, workers, snap] = await Promise.all([
    observability.runHealthChecks(prisma),
    observability.aiUsageSummary(prisma, { sinceMs: DAY }),
    observability.crawlerSummary(prisma, { sinceMs: DAY }),
    observability.jobDurationSummary(prisma, { sinceMs: 7 * DAY }),
    observability.dbPerformance(prisma),
    observability.listWorkerHeartbeats(prisma),
    Promise.resolve(observability.snapshot()),
  ]);

  const httpReqs = counterTotal(snap.counters, 'http_requests_total');
  const httpErrs = counterTotal(snap.counters, 'http_errors_total');
  const extCalls = counterTotal(snap.counters, 'external_api_calls_total');
  const extFails = counterTotal(snap.counters, 'external_api_failures_total');
  const latencyHistos = snap.histograms.filter((h) =>
    h.name.startsWith('http_request_duration_ms'),
  );
  const jobHistos = snap.histograms.filter((h) => h.name.startsWith('job_duration_ms'));

  return (
    <div className="space-y-6">
      <PageHeader
        title="System health"
        description="Dependency checks and the operational metrics. Counters marked “this instance” are in-memory and reset on deploy."
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Dependencies</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={health.checks}
            rowKey={(c) => c.name}
            columns={[
              { key: 'name', header: 'Check', cell: (c) => c.name.replace(/_/g, ' ') },
              { key: 'state', header: 'State', cell: (c) => <HealthPill state={c.state} /> },
              {
                key: 'lat',
                header: 'Latency',
                cell: (c) => (c.latencyMs != null ? ms(c.latencyMs) : '—'),
              },
              { key: 'detail', header: 'Detail', cell: (c) => c.detail ?? '—' },
            ]}
          />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Requests & errors — this instance</h2>
        <StatGrid>
          <Stat label="HTTP requests" value={fullNumber(httpReqs)} />
          <Stat
            label="Error rate (5xx)"
            value={ratioPct(httpReqs ? httpErrs / httpReqs : 0)}
            hint={`${httpErrs} of ${httpReqs}`}
          />
          <Stat
            label="Errors captured"
            value={fullNumber(counterTotal(snap.counters, 'errors_captured_total'))}
          />
          <Stat
            label="External API failures"
            value={ratioPct(extCalls ? extFails / extCalls : 0)}
            hint={`${extFails} of ${extCalls}`}
          />
        </StatGrid>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Request latency by route</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={latencyHistos}
              rowKey={(h) => h.name}
              empty="No requests recorded on this instance yet."
              columns={[
                {
                  key: 'route',
                  header: 'Route',
                  cell: (h) => <span className="font-mono text-[11px]">{h.name}</span>,
                },
                { key: 'n', header: 'Count', cell: (h) => h.count },
                { key: 'p50', header: 'p50', cell: (h) => ms(h.p50) },
                { key: 'p90', header: 'p90', cell: (h) => ms(h.p90) },
                { key: 'p99', header: 'p99', cell: (h) => ms(h.p99) },
              ]}
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">AI — last 24h</h2>
        <StatGrid>
          <Stat
            label="Runs"
            value={compactNumber(ai.runs)}
            hint={`${ratioPct(ai.failureRate)} failed`}
          />
          <Stat
            label="Latency p50 / p95"
            value={`${ms(ai.latencyMs.p50)} / ${ms(ai.latencyMs.p95)}`}
          />
          <Stat
            label="Tokens"
            value={compactNumber(ai.promptTokens + ai.completionTokens)}
            hint={`${compactNumber(ai.promptTokens)} in · ${compactNumber(ai.completionTokens)} out`}
          />
          <Stat label="Est. cost" value={usd(ai.costUsd)} />
        </StatGrid>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Crawler — last 24h</h2>
        <StatGrid>
          <Stat label="Crawls" value={compactNumber(crawler.total)} />
          <Stat
            label="Failures"
            value={compactNumber(crawler.failed)}
            hint={ratioPct(crawler.failureRate)}
          />
          <Stat
            label="Duration p50 / p95"
            value={`${ms(crawler.durationMs.p50)} / ${ms(crawler.durationMs.p95)}`}
          />
          <Stat label="Pages" value={compactNumber(crawler.pagesCrawled)} />
        </StatGrid>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Background jobs</h2>
        <StatGrid>
          <Stat label="Queue depth (total)" value={fullNumber(jobs.totalDepth)} />
          <Stat label="Failed (in queues)" value={fullNumber(jobs.totalFailed)} />
          <Stat
            label="Automation run p50 / p95"
            value={`${ms(jobs.automationRuns.durationMs.p50)} / ${ms(jobs.automationRuns.durationMs.p95)}`}
          />
        </StatGrid>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Queue depth</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={jobs.queues}
              rowKey={(q) => q.name}
              columns={[
                { key: 'q', header: 'Queue', cell: (q) => q.name },
                { key: 'w', header: 'Waiting', cell: (q) => q.waiting },
                { key: 'a', header: 'Active', cell: (q) => q.active },
                { key: 'd', header: 'Delayed', cell: (q) => q.delayed },
                {
                  key: 'f',
                  header: 'Failed',
                  cell: (q) =>
                    q.failed > 0 ? <span className="text-destructive">{q.failed}</span> : '0',
                },
                {
                  key: 'e',
                  header: '',
                  cell: (q) =>
                    q.error ? (
                      <span className="text-destructive">unreachable</span>
                    ) : q.isPaused ? (
                      'paused'
                    ) : (
                      ''
                    ),
                },
              ]}
            />
          </CardContent>
        </Card>
        {jobHistos.length > 0 ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Job duration by queue — this instance</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={jobHistos}
                rowKey={(h) => h.name}
                columns={[
                  {
                    key: 'q',
                    header: 'Queue',
                    cell: (h) => <span className="font-mono text-[11px]">{h.name}</span>,
                  },
                  { key: 'n', header: 'Count', cell: (h) => h.count },
                  { key: 'p50', header: 'p50', cell: (h) => ms(h.p50) },
                  { key: 'p99', header: 'p99', cell: (h) => ms(h.p99) },
                ]}
              />
            </CardContent>
          </Card>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Database performance</h2>
        <StatGrid>
          <Stat label="Cache hit ratio" value={ratioPct(db.cacheHitRatio)} />
          <Stat
            label="Connections"
            value={db.connections.total}
            hint={`${db.connections.active} active · ${db.connections.idleInTransaction} idle-in-txn · ${db.connections.waiting} waiting`}
          />
          <Stat
            label="Rollback ratio"
            value={ratioPct(db.rollbackRatio)}
            hint={`${db.deadlocks} deadlocks`}
          />
          <Stat label="DB size" value={bytes(db.databaseSizeBytes)} />
        </StatGrid>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Slowest statements</CardTitle>
          </CardHeader>
          <CardContent>
            {db.pgStatStatements ? (
              <DataTable
                rows={db.slowQueries}
                rowKey={(q) => q.query}
                empty="pg_stat_statements returned no rows."
                columns={[
                  {
                    key: 'q',
                    header: 'Query',
                    cell: (q) => <span className="font-mono text-[11px]">{q.query}</span>,
                  },
                  { key: 'calls', header: 'Calls', cell: (q) => fullNumber(q.calls) },
                  { key: 'mean', header: 'Mean', cell: (q) => ms(q.meanExecMs) },
                  { key: 'total', header: 'Total', cell: (q) => ms(q.totalExecMs) },
                ]}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                The <span className="font-mono">pg_stat_statements</span> extension is not installed
                — per-statement timings are unavailable.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Worker fleet</h2>
        <Card>
          <CardContent className="pt-4">
            <DataTable
              rows={workers}
              rowKey={(w) => w.workerId}
              empty="No worker has ever checked in."
              columns={[
                {
                  key: 'id',
                  header: 'Worker',
                  cell: (w) => <span className="font-mono text-[11px]">{w.workerId}</span>,
                },
                { key: 'health', header: 'Health', cell: (w) => <HealthPill state={w.health} /> },
                { key: 'beat', header: 'Last beat', cell: (w) => relDate(w.lastBeatAt) },
                { key: 'boot', header: 'Booted', cell: (w) => relDate(w.bootAt) },
                { key: 'redis', header: 'Redis', cell: (w) => (w.redisOk ? 'ok' : 'down') },
                {
                  key: 'jobs',
                  header: 'Jobs (proc / fail)',
                  cell: (w) => `${fullNumber(w.jobsProcessed)} / ${fullNumber(w.jobsFailed)}`,
                },
              ]}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
