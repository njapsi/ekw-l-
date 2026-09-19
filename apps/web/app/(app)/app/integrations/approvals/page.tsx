import type { Metadata } from 'next';
import Link from 'next/link';
import { approvals, can } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { ShieldCheck } from 'lucide-react';
import { requireActiveOrg } from '@/lib/auth';
import { ActionButton } from '@/components/integrations/action-button';
import { cancelApprovalAction, decideApprovalAction } from '@/server/integration-actions';

export const metadata: Metadata = { title: 'Approvals' };

const LEVEL_VARIANT: Record<string, 'warning' | 'destructive' | 'outline'> = {
  WRITE: 'warning',
  PUBLISH: 'warning',
  DANGEROUS: 'destructive',
};

function when(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
}

export default async function ApprovalsPage() {
  const { org, user } = await requireActiveOrg();
  const canDecide = can(org.role, 'publish:external');
  const rows = await approvals.listActionRequests(org.id, { status: 'ALL', limit: 100 });
  const now = new Date();
  const pending = rows.filter((r) => r.status === 'PENDING' && r.expiresAt > now);
  const history = rows.filter((r) => !(r.status === 'PENDING' && r.expiresAt > now));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Every change Growth Agent would make to a connected account waits here until an admin approves it. Nothing is changed before that."
      />
      <p className="text-sm">
        <Link href="/app/integrations" className="underline">
          ← All connections
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waiting for approval ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pending.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="Nothing waiting"
              description="Requests to update or publish content appear here."
            />
          ) : (
            pending.map((r) => (
              <div key={r.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={LEVEL_VARIANT[r.level] ?? 'outline'}>{r.level}</Badge>
                  <span className="text-sm font-medium">{r.summary}</span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {r.capabilityId} · requested {when(r.createdAt)} by{' '}
                  {r.source === 'AGENT'
                    ? 'the AI agent'
                    : r.requestedById === user.id
                      ? 'you'
                      : 'a teammate'}{' '}
                  · expires {when(r.expiresAt)}
                </p>
                <details className="text-xs">
                  <summary className="cursor-pointer">Exact change</summary>
                  <pre className="bg-muted/40 mt-1 overflow-x-auto rounded p-2 font-mono text-[11px]">
                    {JSON.stringify(r.payload, null, 2)}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-3">
                  {canDecide ? (
                    <>
                      <ActionButton
                        label="Approve and apply"
                        pendingLabel="Applying…"
                        variant="default"
                        confirm={`Apply this change to the live site now?\n\n${r.summary}`}
                        action={decideApprovalAction.bind(null, r.id, 'approve')}
                      />
                      <ActionButton
                        label="Reject"
                        pendingLabel="Rejecting…"
                        action={decideApprovalAction.bind(null, r.id, 'reject')}
                      />
                    </>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      An admin or owner must approve this.
                    </p>
                  )}
                  {r.requestedById === user.id || canDecide ? (
                    <ActionButton
                      label="Cancel request"
                      pendingLabel="Cancelling…"
                      variant="ghost"
                      action={cancelApprovalAction.bind(null, r.id)}
                    />
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">No decisions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th scope="col" className="py-2 pr-3">
                      Request
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      Outcome
                    </th>
                    <th scope="col" className="py-2">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="py-2 pr-3">{r.summary}</td>
                      <td className="py-2 pr-3">
                        {r.status === 'PENDING' ? 'EXPIRED' : r.status}
                        {r.error ? (
                          <span className="text-destructive block text-xs">{r.error}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap py-2">
                        {when(r.executedAt ?? r.decidedAt ?? r.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
