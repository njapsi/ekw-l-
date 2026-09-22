'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  activateMissionAction,
  cancelMissionAction,
  pauseMissionAction,
  planMissionAction,
  resumeMissionAction,
} from '@/server/mission-actions';

export function MissionActionsBar({ missionId, status }: { missionId: string; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setPending(true);
    setMessage(null);
    const res = await action();
    setMessage(res.ok ? (res.message ?? null) : (res.error ?? 'Something went wrong.'));
    setPending(false);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === 'DRAFT' || status === 'AWAITING_APPROVAL' ? (
          <Button disabled={pending} onClick={() => void run(() => planMissionAction(missionId))}>
            {status === 'AWAITING_APPROVAL' ? 'Regenerate plan' : 'Generate plan'}
          </Button>
        ) : null}
        {status === 'AWAITING_APPROVAL' ? (
          <Button disabled={pending} onClick={() => void run(() => activateMissionAction(missionId))}>
            Activate mission
          </Button>
        ) : null}
        {status === 'ACTIVE' ? (
          <Button variant="outline" disabled={pending} onClick={() => void run(() => pauseMissionAction(missionId))}>
            Pause
          </Button>
        ) : null}
        {status === 'PAUSED' ? (
          <Button disabled={pending} onClick={() => void run(() => resumeMissionAction(missionId))}>
            Resume
          </Button>
        ) : null}
        {['DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'ACTIVE', 'PAUSED', 'BLOCKED'].includes(status) ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                if (!window.confirm('Cancel this mission? Its history is preserved but no further work will happen.')) {
                  return { ok: true };
                }
                return cancelMissionAction(missionId);
              })
            }
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
