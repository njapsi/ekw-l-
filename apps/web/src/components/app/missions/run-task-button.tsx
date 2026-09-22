'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { runMissionTaskNowAction } from '@/server/mission-actions';

export function RunTaskButton({ missionId, taskId }: { missionId: string; taskId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const res = await runMissionTaskNowAction(missionId, taskId);
    if (!res.ok) setError(res.error ?? 'Could not run this task.');
    setPending(false);
    router.refresh();
  }

  return (
    <div className="text-right">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void run()}>
        {pending ? 'Running…' : 'Run now'}
      </Button>
      {error ? <p className="text-destructive mt-1 text-xs">{error}</p> : null}
    </div>
  );
}
