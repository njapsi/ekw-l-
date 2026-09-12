'use client';

import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { runMonetizationScanAction } from '@/server/monetization-actions';

export function ScanButton({ lastScanLabel }: { lastScanLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const r = await runMonetizationScanAction();
            setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done') : (r.error ?? 'Failed') });
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? 'Scanning…' : 'Scan opportunities'}
      </Button>
      <span className="text-muted-foreground text-xs">Last scan: {lastScanLabel}</span>
      {msg ? (
        <span
          role={msg.ok ? 'status' : 'alert'}
          className={`text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {msg.text}
        </span>
      ) : null}
    </div>
  );
}
