'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  disconnectYouTubeAction,
  runAnalystAction,
  syncYouTubeAction,
} from '@/server/youtube-actions';

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

export function SyncButton({
  facet = 'all',
  children = 'Sync now',
}: {
  facet?: 'all' | 'channel' | 'videos' | 'analytics';
  children?: React.ReactNode;
}) {
  const { pending, result, run } = useServerAction(() => syncYouTubeAction(facet));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? 'Syncing…' : children}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </span>
  );
}

export function RunAnalystButton({ disabled }: { disabled?: boolean }) {
  const { pending, result, run } = useServerAction(runAnalystAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending || disabled}>
        {pending ? 'Analyzing…' : 'Run analysis'}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </span>
  );
}

export function DisconnectButton() {
  const { pending, result, run } = useServerAction(disconnectYouTubeAction);
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
