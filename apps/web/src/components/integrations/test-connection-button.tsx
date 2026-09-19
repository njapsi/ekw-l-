'use client';

import { useState } from 'react';
import { Button } from '@growth-agent/ui';
import { testConnectionAction, type TestConnectionResult } from '@/server/integration-actions';

/**
 * Runs a real provider probe. The result is announced to screen readers
 * (Phase 29's convention: every just-performed-action result gets a live
 * region) and states the concrete outcome rather than a generic toast.
 */
export function TestConnectionButton({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [result, setResult] = useState<TestConnectionResult | null>(null);

  async function run() {
    setState('running');
    setResult(null);
    setResult(await testConnectionAction(connectionId));
    setState('idle');
  }

  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="outline" disabled={state === 'running'} onClick={() => void run()}>
        {state === 'running' ? 'Testing…' : 'Test connection'}
      </Button>
      <div role="status" aria-live="polite" className="text-xs">
        {result ? (
          result.error ? (
            <p className="text-destructive">{result.error}</p>
          ) : (
            <>
              <p
                className={
                  result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'
                }
              >
                {result.title}
              </p>
              {!result.ok ? (
                <p className="text-muted-foreground">{result.recommendedAction}</p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
