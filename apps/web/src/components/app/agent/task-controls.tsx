'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { updateTaskStatusAction } from '@/server/agent-actions';

type Status = 'PENDING' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';

const NEXT: Record<Status, Status[]> = {
  PENDING: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'BLOCKED', 'PENDING'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  DONE: ['IN_PROGRESS'],
  CANCELLED: ['PENDING'],
};

const LABEL: Record<Status, string> = {
  PENDING: 'To do',
  IN_PROGRESS: 'Start',
  BLOCKED: 'Block',
  DONE: 'Mark done',
  CANCELLED: 'Cancel',
};

export function TaskControls({ taskId, status }: { taskId: string; status: Status }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {NEXT[status].map((s) => (
        <Button
          key={s}
          size="sm"
          variant={s === 'DONE' ? 'default' : 'outline'}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await updateTaskStatusAction(taskId, s);
              if (!r.ok) setErr(r.error ?? 'Failed');
              else router.refresh();
            })
          }
        >
          {LABEL[s]}
        </Button>
      ))}
      {err ? (
        <span role="alert" className="text-destructive text-xs">
          {err}
        </span>
      ) : null}
    </span>
  );
}
