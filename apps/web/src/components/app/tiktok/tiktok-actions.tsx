'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  disconnectTikTokAction,
  refreshTikTokStatusAction,
  runTikTokAnalystAction,
  syncTikTokAction,
} from '@/server/tiktok-actions';

type Result = { ok: boolean; error?: string; message?: string };

function useServerAction(fn: () => Promise<Result>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = () =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });
  return { pending, result, run };
}

function Status({ result }: { result: Result | null }) {
  if (!result) return null;
  return (
    <span
      role={result.ok ? 'status' : 'alert'}
      className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
    >
      {result.ok ? result.message : result.error}
    </span>
  );
}

export function TikTokSyncButton({
  facet = 'all',
  children = 'Sync now',
}: {
  facet?: 'all' | 'account' | 'videos';
  children?: React.ReactNode;
}) {
  const { pending, result, run } = useServerAction(() => syncTikTokAction(facet));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? 'Syncing…' : children}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function RunTikTokAnalystButton({ disabled }: { disabled?: boolean }) {
  const { pending, result, run } = useServerAction(runTikTokAnalystAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending || disabled}>
        {pending ? 'Analyzing…' : 'Run analysis'}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function DisconnectTikTokButton() {
  const { pending, result, run } = useServerAction(disconnectTikTokAction);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={run}
        disabled={pending}
      >
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </Button>
      {result && !result.ok ? (
        <span role="alert" className="text-destructive text-xs">
          {result.error}
        </span>
      ) : null}
    </span>
  );
}

export function RefreshStatusButton({ publishRowId }: { publishRowId: string }) {
  const { pending, result, run } = useServerAction(() => refreshTikTokStatusAction(publishRowId));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={run} disabled={pending}>
        {pending ? 'Checking…' : 'Check status'}
      </Button>
      <Status result={result} />
    </span>
  );
}
