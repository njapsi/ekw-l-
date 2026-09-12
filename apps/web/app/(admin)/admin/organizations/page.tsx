import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Organizations · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;
  const result = await observability.listOrganizations(prisma, { q, page });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Organizations"
        description="Tenants. Click through for members, subscription and usage."
      />
      <form className="flex gap-2" action="/admin/organizations">
        <Input name="q" defaultValue={q} placeholder="Search name or slug…" className="max-w-xs" />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Search
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No organizations match."
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (r) => (
              <Link href={`/admin/organizations/${r.id}`} className="font-medium hover:underline">
                {r.name}
                {r.deleted ? <span className="text-destructive"> (deleted)</span> : null}
              </Link>
            ),
          },
          { key: 'slug', header: 'Slug', cell: (r) => <span className="font-mono">{r.slug}</span> },
          { key: 'tier', header: 'Tier', cell: (r) => <Badge variant="outline">{r.tier}</Badge> },
          { key: 'status', header: 'Sub', cell: (r) => r.subscriptionStatus ?? '—' },
          { key: 'members', header: 'Members', cell: (r) => r.members },
          { key: 'created', header: 'Created', cell: (r) => relDate(r.createdAt) },
        ]}
      />
      <Pager
        basePath="/admin/organizations"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ q }}
      />
    </div>
  );
}
