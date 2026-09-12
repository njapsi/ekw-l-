'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  deleteAutomationAction,
  runAutomationNowAction,
  setAutomationStatusAction,
} from '@/server/automation-actions';

export function AutomationActionsBar({
  automationId,
  status,
}: {
  automationId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done.') : (r.error ?? 'Failed.') });
      if (r.ok) router.refresh();
    });

  const paused = status === 'PAUSED';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => runAutomationNowAction(automationId))}
        >
          Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(() => setAutomationStatusAction(automationId, paused ? 'ACTIVE' : 'PAUSED'))
          }
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={pending}
          onClick={() => {
            if (confirm('Delete this automation? Its run history is removed too.')) {
              run(async () => {
                const r = await deleteAutomationAction(automationId);
                if (r.ok) router.push('/app/automations');
                return r;
              });
            }
          }}
        >
          Delete
        </Button>
      </div>
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
