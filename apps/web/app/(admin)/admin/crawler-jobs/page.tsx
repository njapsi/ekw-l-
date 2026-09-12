import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { Stat, StatGrid } from '@/components/admin/stat';
import { ms, ratioPct } from '@/lib/admin-format';
import { compactNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Crawler jobs · Admin' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  COMPLETED: 'secondary',
  RUNNING: 'outline',
  QUEUED: 'outline',
  PAUSED: 'outline',
  FAILED: 'destructive',
  BLOCKED: 'destructive',
  CANCELLED: 'outline',
};

export default async function AdminCrawlerJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const [summary, result] = await Promise.all([
    observability.crawlerSummary(prisma, { sinceMs: 7 * 24 * 60 * 60 * 1000 }),
    observability.listCrawls(prisma, { status, page }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Crawler jobs"
        description="SEO crawls across all tenants. Errors are scrubbed."
      />

      <StatGrid>
        <Stat label="Crawls · 7d" value={compactNumber(summary.total)} />
        <Stat
          label="Failures · 7d"
          value={compactNumber(summary.failed)}
          hint={ratioPct(summary.failureRate)}
        />
        <Stat label="Pages crawled · 7d" value={compactNumber(summary.pagesCrawled)} />
        <Stat
          label="Duration p50 / p95"
          value={`${ms(summary.durationMs.p50)} / ${ms(summary.durationMs.p95)}`}
        />
      </StatGrid>

      <form className="flex gap-2" action="/admin/crawler-jobs">
        <Input name="status" defaultValue={status} placeholder="status" className="max-w-[10rem]" />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Filter
        </button>
      </form>

      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No crawls match."
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
          { key: 'host', header: 'Site', cell: (r) => r.hostname },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => (
              <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                {r.status.toLowerCase()}
              </Badge>
            ),
          },
          { key: 'mode', header: 'Render', cell: (r) => r.renderMode },
          { key: 'pages', header: 'Pages', cell: (r) => r.pagesCrawled },
          { key: 'issues', header: 'Issues', cell: (r) => r.issuesFound },
          { key: 'dur', header: 'Duration', cell: (r) => ms(r.durationMs) },
          {
            key: 'err',
            header: 'Error',
            cell: (r) =>
              r.error || r.blockedReason ? (
                <span className="text-destructive">{r.error ?? r.blockedReason}</span>
              ) : (
                '—'
              ),
          },
          { key: 'when', header: 'When', cell: (r) => relDate(r.createdAt) },
        ]}
      />
      <Pager
        basePath="/admin/crawler-jobs"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ status }}
      />
    </div>
  );
}
