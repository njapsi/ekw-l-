import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { Stat, StatGrid } from '@/components/admin/stat';
import { ms, ratioPct, usd } from '@/lib/admin-format';
import { compactNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'AI usage · Admin' };
export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

export default async function AdminAiUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const win = WINDOWS.find((w) => w.key === sp.window) ?? WINDOWS[0]!;

  const [summary, expensive] = await Promise.all([
    observability.aiUsageSummary(prisma, { sinceMs: win.ms }),
    observability.recentExpensiveAgentRuns(prisma, 20),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI usage"
        description="Token consumption, cost estimates and latency from AgentRun. Cost is estimated from the internal price table — not billed."
      />

      <div className="flex gap-2 text-sm">
        {WINDOWS.map((w) => (
          <Link
            key={w.key}
            href={`/admin/ai-usage?window=${w.key}`}
            className={`rounded border px-2 py-0.5 ${w.key === win.key ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            {w.key}
          </Link>
        ))}
      </div>

      <StatGrid>
        <Stat label="Runs" value={compactNumber(summary.runs)} hint={`${summary.failed} failed`} />
        <Stat label="Failure rate" value={ratioPct(summary.failureRate)} />
        <Stat
          label="Tokens"
          value={compactNumber(summary.promptTokens + summary.completionTokens)}
          hint={`${compactNumber(summary.promptTokens)} in · ${compactNumber(summary.completionTokens)} out`}
        />
        <Stat label="Est. cost" value={usd(summary.costUsd)} />
        <Stat
          label="Latency p50 / p95"
          value={`${ms(summary.latencyMs.p50)} / ${ms(summary.latencyMs.p95)}`}
          hint={`${summary.latencyMs.samples} samples`}
        />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">By provider</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={summary.byProvider}
              rowKey={(r) => r.provider}
              empty="No data."
              columns={[
                { key: 'p', header: 'Provider', cell: (r) => r.provider },
                { key: 'runs', header: 'Runs', cell: (r) => r.runs },
                { key: 'cost', header: 'Cost', cell: (r) => usd(r.costUsd) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">By model</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={summary.byModel}
              rowKey={(r) => r.model}
              empty="No data."
              columns={[
                { key: 'm', header: 'Model', cell: (r) => r.model },
                { key: 'runs', header: 'Runs', cell: (r) => r.runs },
                {
                  key: 'tok',
                  header: 'Tokens',
                  cell: (r) => compactNumber(r.promptTokens + r.completionTokens),
                },
                { key: 'cost', header: 'Cost', cell: (r) => usd(r.costUsd) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">By agent</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={summary.byAgent}
              rowKey={(r) => r.agent}
              empty="No data."
              columns={[
                { key: 'a', header: 'Agent', cell: (r) => r.agent },
                { key: 'runs', header: 'Runs', cell: (r) => r.runs },
                { key: 'cost', header: 'Cost', cell: (r) => usd(r.costUsd) },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Most expensive runs (all time)</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={expensive}
            rowKey={(r) => r.id}
            empty="No agent runs."
            columns={[
              {
                key: 'org',
                header: 'Org',
                cell: (r) => (
                  <Link
                    href={`/admin/organizations/${r.organizationId}`}
                    className="font-mono text-[11px] hover:underline"
                  >
                    {r.organizationId.slice(0, 10)}
                  </Link>
                ),
              },
              { key: 'agent', header: 'Agent', cell: (r) => r.agent },
              { key: 'model', header: 'Model', cell: (r) => r.model ?? '—' },
              { key: 'status', header: 'Status', cell: (r) => r.status },
              {
                key: 'tok',
                header: 'Tokens',
                cell: (r) => compactNumber(r.promptTokens + r.completionTokens),
              },
              { key: 'cost', header: 'Cost', cell: (r) => usd(r.costUsd) },
              { key: 'dur', header: 'Duration', cell: (r) => ms(r.durationMs) },
              { key: 'when', header: 'When', cell: (r) => relDate(r.createdAt) },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
