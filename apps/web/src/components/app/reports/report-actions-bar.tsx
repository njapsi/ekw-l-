'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  createShareLinkAction,
  deleteReportAction,
  revokeShareLinkAction,
} from '@/server/report-actions';

export interface ShareState {
  hasLink: boolean;
  active: boolean;
  url: string | null;
  expiresAt: string | null;
}

export function ReportActionsBar({
  reportId,
  canGenerate,
  canShare,
  share,
}: {
  reportId: string;
  canGenerate: boolean;
  canShare: boolean;
  share: ShareState;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expiresDays, setExpiresDays] = useState('30');

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const fullShareUrl = share.url ? `${origin}${share.url}` : null;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done.') : (r.error ?? 'Failed.') });
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href={`/app/reports/${reportId}/export?format=pdf`}>Export PDF</a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={`/app/reports/${reportId}/export?format=csv`}>Export CSV</a>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={`/app/reports/${reportId}/export?format=json`}>JSON</a>
        </Button>
        {canGenerate ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={pending}
            onClick={() => {
              if (confirm('Delete this report? Exports and any share link stop working.')) {
                run(async () => {
                  const r = await deleteReportAction(reportId);
                  if (r.ok) router.push('/app/reports');
                  return r;
                });
              }
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>

      {canShare ? (
        <div className="bg-card rounded-lg border p-3">
          <p className="text-sm font-medium">Shareable link</p>
          <p className="text-muted-foreground text-xs">
            Anyone with the link sees a read-only, redacted copy — no account identifiers or private
            figures.
          </p>
          {share.active && fullShareUrl ? (
            <div className="mt-2 space-y-2">
              <code className="bg-muted block break-all rounded p-2 text-xs">{fullShareUrl}</code>
              <p className="text-muted-foreground text-xs">
                {share.expiresAt
                  ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}.`
                  : 'No expiry.'}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={pending}
                onClick={() => run(() => revokeShareLinkAction(reportId))}
              >
                Revoke link
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-xs">
                Expires in{' '}
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={expiresDays}
                  onChange={(e) => setExpiresDays(e.target.value)}
                  className="border-input bg-background h-8 w-16 rounded border px-2 text-xs"
                />{' '}
                days
              </label>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    createShareLinkAction(
                      reportId,
                      expiresDays.trim() ? Number(expiresDays) : null,
                    ),
                  )
                }
              >
                Create link
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {msg ? (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
