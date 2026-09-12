import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Users · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;
  const result = await observability.listUsers(prisma, { q, page });

  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Every registered account. No credentials or tokens." />
      <form className="flex gap-2" action="/admin/users">
        <Input name="q" defaultValue={q} placeholder="Search email or name…" className="max-w-xs" />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Search
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No users match."
        columns={[
          {
            key: 'email',
            header: 'Email',
            cell: (r) => (
              <span className="font-medium">
                {r.email}
                {r.deleted ? <span className="text-destructive"> (deleted)</span> : null}
              </span>
            ),
          },
          { key: 'name', header: 'Name', cell: (r) => r.name ?? '—' },
          {
            key: 'verified',
            header: 'Verified',
            cell: (r) => (r.emailVerified ? 'yes' : 'no'),
          },
          {
            key: 'staff',
            header: 'Staff',
            cell: (r) => (r.staffLevel ? <Badge variant="outline">{r.staffLevel}</Badge> : '—'),
          },
          { key: 'orgs', header: 'Orgs', cell: (r) => r.memberships },
          { key: 'created', header: 'Joined', cell: (r) => relDate(r.createdAt) },
        ]}
      />
      <Pager
        basePath="/admin/users"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ q }}
      />
    </div>
  );
}
