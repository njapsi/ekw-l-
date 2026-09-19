'use client';

import { useState } from 'react';
import { Button, type ButtonProps } from '@growth-agent/ui';
import type { ActionResult } from '@/server/integration-actions';

/**
 * A button bound to a Server Action that returns `ActionResult`. The outcome
 * is announced in a live region (the Phase 29 convention for just-performed
 * actions) and always states what actually happened.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirm,
  variant = 'outline',
  size = 'sm',
}: {
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel?: string;
  /** When set, the user must confirm before the action runs. */
  confirm?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    setResult(null);
    setResult(await action());
    setPending(false);
  }

  return (
    <div className="space-y-1">
      <Button size={size} variant={variant} disabled={pending} onClick={() => void run()}>
        {pending ? (pendingLabel ?? 'Working…') : label}
      </Button>
      <div role="status" aria-live="polite" className="text-xs">
        {result ? (
          <p className={result.ok ? 'text-muted-foreground' : 'text-destructive'}>
            {result.ok ? result.message : result.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
