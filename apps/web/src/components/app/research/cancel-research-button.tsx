'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { cancelResearchProjectAction } from '@/server/research-actions';

export function CancelResearchButton({ researchId }: { researchId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function cancel() {
    setPending(true);
    await cancelResearchProjectAction(researchId);
    setPending(false);
    router.refresh();
  }

  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => void cancel()}>
      {pending ? 'Cancelling…' : 'Cancel'}
    </Button>
  );
}
