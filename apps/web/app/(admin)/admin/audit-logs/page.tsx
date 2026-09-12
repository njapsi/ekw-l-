import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Input, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Audit logs · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const action = typeof sp.action === 'string' ? sp.action : undefined;
  const organizationId = typeof sp.org === 'string' ? sp.org : undefined;
  const actorId = typeof sp.actor === 'string' ? sp.actor : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const result = await observability.listAuditLogs(prisma, {
    action,
    organizationId,
    actorId,
    page,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit logs"
        description="Append-only record of consequential actions, all tenants."
      />
      <form className="flex flex-wrap gap-2" action="/admin/audit-logs">
        <Input
          name="action"
          defaultValue={action}
          placeholder="action contains…"
          className="max-w-[14rem]"
        />
        <Input
          name="org"
          defaultValue={organizationId}
          placeholder="org id"
          className="max-w-[14rem]"
        />
        <Input
          name="actor"
          defaultValue={actorId}
          placeholder="actor id"
          className="max-w-[14rem]"
        />
        <button type="submit" className="border-border rounded border px-3 text-sm">
          Filter
        </button>
      </form>
      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No audit events match."
        columns={[
          {
            key: 'action',
            header: 'Action',
            cell: (r) => <span className="font-mono">{r.action}</span>,
          },
          { key: 'actor', header: 'Actor', cell: (r) => r.actorEmail ?? r.actorType.toLowerCase() },
          { key: 'org', header: 'Org', cell: (r) => r.orgSlug ?? '—' },
          {
            key: 'target',
            header: 'Target',
            cell: (r) => (r.targetType ? `${r.targetType}:${r.targetId ?? ''}` : '—'),
          },
          { key: 'ip', header: 'IP', cell: (r) => r.ip ?? '—' },
          { key: 'when', header: 'When', cell: (r) => relDate(r.createdAt) },
        ]}
      />
      <Pager
        basePath="/admin/audit-logs"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ action, org: organizationId, actor: actorId }}
      />
    </div>
  );
}
