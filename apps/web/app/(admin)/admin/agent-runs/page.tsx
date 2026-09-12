import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { ms, usd } from '@/lib/admin-format';
import { compactNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Agent runs · Admin' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  SUCCEEDED: 'secondary',
  COMPLETED: 'secondary',
  RUNNING: 'outline',
  QUEUED: 'outline',
  FAILED: 'destructive',
};

export default async function AdminAgentRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const agent = typeof sp.agent === 'string' ? sp.agent : undefined;
  const organizationId = typeof sp.org === 'string' ? sp.org : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const result = await observability.listAgentRuns(prisma, { status, agent, organizationId, page });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent runs"
        description="Every AI agent execution — status, model, tokens, estimated cost, latency."
      />
      <form className="flex flex-wrap gap-2" action="/admin/agent-runs">
        <Input
          name="agent"
          defaultValue={agent}
          placeholder="agent name"
          className="max-w-[12rem]"
        />
        <Input name="status" defaultValue={status} placeholder="status" className="max-w-[10rem]" />
        <Input
          name="org"
          defaultValue={organizationId}
          placeholder="org id"
          className="max-w-[14rem]"
        />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Filter
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No agent runs match."
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
          {
            key: 'status',
            header: 'Status',
            cell: (r) => (
              <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                {r.status.toLowerCase()}
              </Badge>
            ),
          },
          { key: 'trigger', header: 'Trigger', cell: (r) => r.trigger ?? '—' },
          { key: 'model', header: 'Model', cell: (r) => r.model ?? '—' },
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
      <Pager
        basePath="/admin/agent-runs"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ status, agent, org: organizationId }}
      />
    </div>
  );
}
