import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'API integrations · Admin' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  ACTIVE: 'secondary',
  EXPIRED: 'destructive',
  REVOKED: 'destructive',
  ERROR: 'destructive',
};

export default async function AdminIntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const provider = typeof sp.provider === 'string' ? sp.provider : undefined;
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const result = await observability.listOAuthConnections(prisma, { provider, status, page });

  return (
    <div className="space-y-4">
      <PageHeader
        title="API integrations"
        description="OAuth-connected external accounts and their health. Token material is never read or shown."
      />
      <form className="flex gap-2" action="/admin/integrations">
        <Input
          name="provider"
          defaultValue={provider}
          placeholder="provider"
          className="max-w-[10rem]"
        />
        <Input name="status" defaultValue={status} placeholder="status" className="max-w-[10rem]" />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Filter
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No connections match."
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
          { key: 'provider', header: 'Provider', cell: (r) => r.provider },
          { key: 'name', header: 'Account', cell: (r) => r.displayName ?? '—' },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => (
              <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                {r.status.toLowerCase()}
              </Badge>
            ),
          },
          { key: 'scopes', header: 'Scopes', cell: (r) => r.scopeCount },
          {
            key: 'health',
            header: 'Health',
            cell: (r) =>
              r.health ? (
                <span className={r.health.ok ? '' : 'text-destructive'}>
                  {r.health.ok ? 'ok' : 'error'} · quota {r.health.quotaUnitsUsedToday}
                </span>
              ) : (
                '—'
              ),
          },
          {
            key: 'refreshed',
            header: 'Refreshed',
            cell: (r) => (r.lastRefreshedAt ? relDate(r.lastRefreshedAt) : '—'),
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
        basePath="/admin/integrations"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ provider, status }}
      />
    </div>
  );
}
