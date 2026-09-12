'use client';

import { useState, useTransition } from 'react';
import { Button } from '@growth-agent/ui';
import {
  disconnectSearchConsoleAction,
  syncPropertiesAction,
} from '@/server/search-console-actions';

export function SearchConsoleActions() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.message ?? 'Done.') : (r.error ?? 'Failed.'));
    });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" disabled={pending} onClick={() => run(() => syncPropertiesAction())}>
        {pending ? 'Working…' : 'Refresh property list'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run(() => disconnectSearchConsoleAction())}
      >
        Disconnect
      </Button>
      {msg ? <span className="text-muted-foreground text-xs">{msg}</span> : null}
    </div>
  );
}
