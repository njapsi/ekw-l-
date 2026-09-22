'use client';

import { useState } from 'react';
import { Button } from '@growth-agent/ui';
import { type ActionResult, proposeWordPressSeoFixAction } from '@/server/wordpress-actions';

export function ProposeFixButton({ siteId, issueId }: { siteId: string; issueId: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function submit() {
    setPending(true);
    setResult(null);
    setResult(await proposeWordPressSeoFixAction({ siteId, issueId }));
    setPending(false);
  }

  if (result) {
    return (
      <p role="status" className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
        {result.ok ? result.message : result.error}
      </p>
    );
  }

  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => void submit()}>
      {pending ? 'Proposing…' : 'Propose fix'}
    </Button>
  );
}
