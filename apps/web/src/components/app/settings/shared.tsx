'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Alert, AlertDescription, Button } from '@growth-agent/ui';
import { type ActionResult, sendReauthLinkAction } from '@/server/settings-actions';

export function useAction<I, R extends ActionResult>(fn: (input: I) => Promise<R>) {
  const [state, setState] = useState<{ pending: boolean; result: R | null }>({
    pending: false,
    result: null,
  });
  async function run(input: I): Promise<R> {
    setState({ pending: true, result: null });
    const result = await fn(input);
    setState({ pending: false, result });
    return result;
  }
  return { pending: state.pending, result: state.result, run };
}

/** Result line for a just-performed action (announced to screen readers). */
export function ActionOutcome({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  if (result.reauth) return <ReauthNotice message={result.error} />;
  return (
    <p
      role={result.ok ? 'status' : 'alert'}
      className={result.ok ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}

/**
 * Sensitive actions need a sign-in from the last 15 minutes. Rather than a
 * password prompt (which the client-callable session update could not
 * safely record), the user confirms through a fresh email sign-in link.
 */
export function ReauthNotice({ message }: { message?: string }) {
  const pathname = usePathname();
  const [sent, setSent] = useState<ActionResult | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Alert>
      <AlertDescription className="flex flex-col gap-2">
        <span>{sent?.ok ? sent.message : (sent?.error ?? message)}</span>
        {!sent?.ok ? (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setSent(await sendReauthLinkAction(pathname));
              setPending(false);
            }}
          >
            {pending ? 'Sending…' : 'Email me a confirmation link'}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function formatWhen(iso: string | Date | null): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(iso: string | Date | null): string {
  if (!iso) return 'never';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
