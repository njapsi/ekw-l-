import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'MCP servers · Admin' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive' | 'success'> = {
  CONNECTED: 'success',
  PENDING: 'secondary',
  DEGRADED: 'outline',
  ERROR: 'destructive',
  DISABLED: 'secondary',
};

const TRUST_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive' | 'success'> = {
  INTERNAL: 'success',
  TRUSTED: 'secondary',
  VERIFIED_EXTERNAL: 'outline',
  UNVERIFIED_EXTERNAL: 'destructive',
};

export default async function AdminMcpServersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const trustLevel = typeof sp.trustLevel === 'string' ? sp.trustLevel : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const result = await observability.listMcpServersAdmin(prisma, { status, trustLevel, page });

  return (
    <div className="space-y-4">
      <PageHeader
        title="MCP servers"
        description="Every third-party MCP server connected across all organizations, read-only. Credentials are never read or shown here."
      />
      <form className="flex gap-2" action="/admin/mcp-servers">
        <Input name="status" defaultValue={status} placeholder="status" className="max-w-[10rem]" />
        <Input
          name="trustLevel"
          defaultValue={trustLevel}
          placeholder="trust level"
          className="max-w-[12rem]"
        />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Filter
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No MCP servers match."
        columns={[
          {
            key: 'org',
            header: 'Org',
            cell: (r) => (
              <Link
                href={`/admin/organizations/${r.organizationId}`}
                className="font-mono text-[11px] hover:underline"
              >
                {r.orgSlug ?? r.organizationId.slice(0, 10)}
              </Link>
            ),
          },
          { key: 'name', header: 'Name', cell: (r) => r.name },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => (
              <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                {r.status.toLowerCase()}
              </Badge>
            ),
          },
          {
            key: 'trust',
            header: 'Trust',
            cell: (r) => (
              <Badge variant={TRUST_VARIANT[r.trustLevel] ?? 'outline'}>
                {r.trustLevel.toLowerCase().replace(/_/g, ' ')}
              </Badge>
            ),
          },
          {
            key: 'tools',
            header: 'Tools enabled',
            cell: (r) => `${r.enabledToolCount} / ${r.toolCount}`,
          },
          {
            key: 'checked',
            header: 'Last checked',
            cell: (r) => (r.lastCheckAt ? relDate(r.lastCheckAt) : '—'),
          },
          {
            key: 'err',
            header: 'Last error',
            cell: (r) =>
              r.lastError ? <span className="text-destructive">{r.lastError}</span> : '—',
          },
        ]}
      />
      <Pager
        basePath="/admin/mcp-servers"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ status, trustLevel }}
      />
    </div>
  );
}
